"""Durable, private results awaiting conflict resolution.

The caller holds the project store lock during inspection and mutation. Pending
files are deliberately separate from project backups and contain no API keys.
"""
from __future__ import annotations

import copy
import hashlib
import os
import re
import uuid
from pathlib import Path
from typing import Any

from .context_run import RUN_KEY, apply_response, apply_translated_block_defaults, digest
from .paths import project_root
from .store import ProjectChangedError, ProjectStore, atomic_json, read_json, utc_now
from .translation import distribute_translation
from .translation_plan import AI_PARTS_KEY, AI_REUSE_KEY, target_snapshot


def _directory(project_id: str) -> Path:
    return project_root(project_id) / '.pending-results'


def _path(project_id: str, token: str) -> Path:
    if not re.fullmatch(r'[0-9a-f]{32}', token):
        raise KeyError(token)
    return _directory(project_id) / (token + '.json')


def stage(store: ProjectStore, project_id: str, kind: str, payload: dict[str, Any]) -> dict[str, Any]:
    with store._lock:
        store.get(project_id)  # Do not recreate a deleted project.
        directory = _directory(project_id)
        directory.mkdir(mode=0o700, exist_ok=True)
        try: os.chmod(directory, 0o700)
        except OSError: pass
        entry = {'id': uuid.uuid4().hex, 'kind': kind, 'createdAt': utc_now(), **payload}
        atomic_json(_path(project_id, entry['id']), entry)
        return entry


def load(store: ProjectStore, project_id: str, token: str, *, include_committed: bool = False) -> dict[str, Any]:
    state = store.get(project_id)
    path = _path(project_id, token)
    value = read_json(path, None)
    if not isinstance(value, dict) or value.get('id') != token or value.get('kind') not in {'ocr', 'translation'}:
        raise KeyError(token)
    if not include_committed:
        marker = state.get('_lastPendingOcr')
        committed_ocr = value['kind'] == 'ocr' and isinstance(marker, dict) and marker.get('id') == token
        committed_translation = value['kind'] == 'translation' and state.get(RUN_KEY, {}).get('lastPendingResult') == token
        if committed_ocr or committed_translation:
            # A new preview after the commit is a user edit and must survive.
            if committed_ocr:
                images = {image['id']: image for image in state['images']}
                for image_id in marker.get('affected', []):
                    if image_id in images and not images[image_id].get('edited'):
                        (project_root(project_id) / 'images' / f'{image_id}-edited.png').unlink(missing_ok=True)
            path.unlink(missing_ok=True)
            raise KeyError(token)
    return value


def remove(store: ProjectStore, project_id: str, token: str) -> None:
    load(store, project_id, token, include_committed=True)
    _path(project_id, token).unlink()


def list_pending(store: ProjectStore, project_id: str) -> list[dict[str, Any]]:
    with store._lock:
        store.get(project_id)
        result = []
        for path in _directory(project_id).glob('*.json'):
            try:
                entry = load(store, project_id, path.stem)
            except (KeyError, ValueError):
                continue
            result.append({'id': entry['id'], 'kind': entry['kind'], 'createdAt': entry['createdAt']})
        return sorted(result, key=lambda item: item['createdAt'])


def ocr_signature(store: ProjectStore, state: dict[str, Any], image_id: str) -> str | None:
    item = next((image for image in state['images'] if image['id'] == image_id), None)
    if not item: return None
    path = project_root(state['id']) / 'images' / f'{image_id}-edited.png'
    try:
        with path.open('rb') as fh:
            h = hashlib.sha256()
            for chunk in iter(lambda: fh.read(1024 * 1024), b''): h.update(chunk)
            rendered = h.hexdigest()
    except FileNotFoundError:
        rendered = None
    return digest({'file':item.get('file'), 'blocks':item.get('blocks', []), 'ocrCompleted':item.get('ocrCompleted'),
                   'rendered':rendered, 'eraseOriginal':state.get('settings', {}).get('eraseOriginal', True),
                   'watermark':item.get('watermark')})


def _lookup(state: dict[str, Any]) -> dict[tuple[str, str], dict[str, Any]]:
    result = {}
    for item in state['images']:
        for block in item.get('blocks', []):
            key = (str(item['id']), str(block.get('id')))
            if key in result: raise ProjectChangedError('شناسهٔ کادرها یکتا نیست؛ نتیجهٔ ذخیره‌شده حفظ شد.')
            result[key] = block
    return result


def inspect(store: ProjectStore, project_id: str, entry: dict[str, Any]) -> dict[str, Any]:
    state = store.get(project_id)
    rows = []
    can_apply = True
    if entry['kind'] == 'ocr':
        items = {item['id']: item for item in state['images']}
        for output in entry['outputs']:
            image_id = output['id']; item = items.get(image_id)
            current = ocr_signature(store, state, image_id)
            rows.append({'key': image_id, 'name': output['name'], 'missing': item is None,
                         'conflict': current != entry['baseline'][image_id],
                         'original': entry.get('originals', {}).get(image_id, ''),
                         'current': '\n'.join(str(b.get('text') or '') for b in (item or {}).get('blocks', [])),
                         'result': '\n'.join(str(b.get('text') or '') for b in output['blocks'])})
    else:
        current_run = state.get(RUN_KEY)
        can_apply = isinstance(current_run, dict) and digest(current_run) == entry['runDigest']
        blocks = _lookup(state)
        results = distribute_translation([part['text'] for part in entry['chosen']], entry['translated'])
        for part, result in zip(entry['chosen'], results):
            job = entry['run']['jobs'][part['job']]
            for ref in job['refs']:
                key = f"{ref['imageId']}:{ref['blockId']}"
                block = blocks.get((str(ref['imageId']), str(ref['blockId'])))
                rows.append({'key': key, 'name': job['imageName'], 'missing': block is None,
                             'conflict': block is None or target_snapshot(block) != ref['snapshot'],
                             'source': part['text'], 'original': entry.get('originals', {}).get(key, {}).get('tr', ''), 'currentSource': str((block or {}).get('text') or ''),
                             'current': str((block or {}).get('tr') or ''), 'result': job.get('accumulated', '') + result + part.get('join', '')})
    # v4.46: tell the user in plain language why this result waits for
    # approval instead of having been applied silently.
    reasons: list[str] = []
    conflicts = any(row.get('conflict') for row in rows)
    missing = any(row.get('missing') for row in rows)
    if entry['kind'] == 'ocr':
        if conflicts:
            reasons.append('در فاصلهٔ اجرای OCR روی متن یا کادرهای این صفحه‌ها تغییراتی ثبت شده است؛ برای اینکه ویرایش شما بی‌صدا با نتیجهٔ تازه بازنویسی نشود، نتیجه برای تأیید شما نگه داشته شده است.')
        if missing:
            reasons.append('برخی صفحه‌های این نتیجه پس از پایان OCR از پروژه حذف شده‌اند؛ آن بخش‌ها قابل اعمال نیستند.')
        if not rows:
            reasons.append('این نتیجه برای جلوگیری از از دست رفتن پاسخ دریافتی نگهداری شده است.')
    else:
        if not can_apply:
            reasons.append('پس از آماده‌شدن این نتیجه، نوبت ترجمه تغییر کرده است؛ برای همین اعمال خودکار غیرفعال است. با دکمهٔ «تأیید و اعمال دستی» فقط متن نتیجه روی کادرهای موجود نوشته می‌شود و نوبت ترجمه و خلاصهٔ داستان دست‌نخورده می‌مانند؛ بدون آن دکمه فقط کپی یا حذف ممکن است.')
        if conflicts:
            reasons.append('در فاصلهٔ انتظار برای پاسخ سرویس، متن یا ترجمهٔ برخی کادرها تغییر کرده است؛ برای هر تعارض «حفظ ویرایش فعلی» یا «استفاده از نتیجهٔ آماده» را انتخاب کنید و سپس آن را تأیید کنید.')
        if missing:
            reasons.append('برخی کادرها یا صفحه‌های این نتیجه پس از آماده‌شدن آن حذف شده‌اند؛ آن بخش‌ها قابل اعمال نیستند.')
    if not reasons:
        reasons.append('این نتیجهٔ ذخیره‌شده با وضعیت فعلی پروژه سازگار است؛ با زدن «ثبت انتخاب‌ها» مستقیماً اعمال می‌شود.')
    return {'id': entry['id'], 'kind': entry['kind'], 'createdAt': entry['createdAt'], 'revision': state.get('updatedAt', ''),
            'canApply': can_apply, 'rows': rows, 'summary': entry.get('summary', ''), 'reasons': reasons}


def resolve(store: ProjectStore, project_id: str, token: str, revision: str,
            choices: dict[str, str], *, force: bool = False) -> dict[str, Any]:
    with store._lock:
        entry = load(store, project_id, token)
        state = store.get(project_id)
        if state.get('updatedAt') != revision:
            raise ProjectChangedError('پروژه پس از نمایش تعارض تغییر کرده است؛ دوباره مقایسه کنید.')
        view = inspect(store, project_id, entry)
        # v4.46: when the translation run changed after this result arrived, the
        # user can still explicitly approve it. Without that explicit flag the
        # result stays stored and nothing is applied.
        stale_translation = entry['kind'] == 'translation' and not view['canApply']
        if stale_translation and not force:
            raise ProjectChangedError('نوبت ترجمه تغییر کرده است. نتیجه هنوز نگهداری شده و قابل کپی است؛ اگر می‌خواهید همین نتیجه روی کادرهای موجود نوشته شود، در پنجرهٔ «نتیجه‌های منتظر بررسی» دکمهٔ «تأیید و اعمال دستی» را بزنید.')
        for row in view['rows']:
            if row['conflict'] and choices.get(row['key']) not in {'keep', 'apply'}:
                raise ValueError('برای هر تعارض باید یک گزینه انتخاب شود.')
            if row['missing'] and choices.get(row['key']) == 'apply':
                raise ValueError('تصویر یا کادر حذف‌شده را نمی‌توان بازنویسی کرد.')
        if entry['kind'] == 'ocr':
            images = {item['id']: item for item in state['images']}
            replace = []
            for row, output in zip(view['rows'], entry['outputs']):
                if row['missing'] or (row['conflict'] and choices[row['key']] == 'keep'): continue
                item = images[output['id']]
                item['blocks'] = copy.deepcopy(output['blocks']); item['ocrCompleted'] = True; item['edited'] = False; item['approved'] = False
                if output.get('pageMode') in {'comic', 'document'}:
                    item['pageMode'] = output['pageMode']
                replace.append(output['id'])
            if replace and state.get('settings', {}).get('overlayMode') == entry.get('overlayMode'):
                state['settings']['overlayMode'] = 'ocr'
            # Marker makes a committed result distinguishable after a crash.
            state['_lastPendingOcr'] = {'id': token, 'affected': replace}
            store.save(state)
            for image_id in replace:
                (project_root(project_id) / 'images' / f'{image_id}-edited.png').unlink(missing_ok=True)
            done = True; affected = replace
        elif stale_translation:
            # v4.46 manual approval: the old run's bookkeeping is stale, so
            # only the durable block payloads are written. The story summary
            # and the run counters/progress are deliberately left untouched;
            # the marker still records this token as committed for cleanup.
            blocks = _lookup(state)
            rows_by_key = {row['key']: row for row in view['rows']}
            staged_run = entry['run']
            target_lang = staged_run.get('targetLanguage', 'fa')
            provider = staged_run.get('provider')
            affected_ids: set[str] = set()
            for part in entry['chosen']:
                job = staged_run['jobs'][part['job']]
                for ref in job['refs']:
                    key = f"{ref['imageId']}:{ref['blockId']}"
                    row = rows_by_key.get(key)
                    if row is None or row['missing']:
                        continue
                    if row['conflict'] and choices.get(key) == 'keep':
                        continue
                    block = blocks.get((str(ref['imageId']), str(ref['blockId'])))
                    if block is None:
                        continue
                    block['tr'] = row['result']; block['richHtml'] = ''
                    block['aiTranslated'] = provider not in {'free', 'local'}
                    apply_translated_block_defaults(block, target_language=target_lang)
                    block.pop(AI_PARTS_KEY, None); block.pop(AI_REUSE_KEY, None)
                    affected_ids.add(str(ref['imageId']))
            affected = sorted(affected_ids)
            if affected_ids:
                for image in state.get('images', []):
                    if str(image.get('id')) in affected_ids:
                        image['approved'] = False
            current_run = state.get(RUN_KEY)
            if isinstance(current_run, dict):
                current_run['lastPendingResult'] = token
            if state.get('settings', {}).get('overlayMode') == entry.get('overlayMode'):
                state['settings']['overlayMode'] = 'translation'
            store.save(state)
            done = isinstance(current_run, dict) and not any(
                job.get('remaining') for job in current_run.get('jobs', []) if isinstance(job, dict)
            )
        else:
            run = state[RUN_KEY]; blocks = _lookup(state)
            rows_by_key = {row['key']: row for row in view['rows']}
            for part in entry['chosen']:
                job = run['jobs'][part['job']]; kept = []
                for ref in job['refs']:
                    key = f"{ref['imageId']}:{ref['blockId']}"
                    block = blocks.get((str(ref['imageId']), str(ref['blockId'])))
                    row = rows_by_key.get(key)
                    if row is None:
                        # The row disappeared between preview and apply: keep the
                        # block untouched instead of failing the whole request.
                        continue
                    if block is None or (row['conflict'] and choices.get(key) == 'keep'):
                        continue
                    ref['snapshot'] = target_snapshot(block)
                    kept.append(ref)
                job['refs'] = kept
            skipped = any(row['missing'] or (row['conflict'] and choices.get(row['key']) == 'keep') for row in view['rows'])
            # A summary produced from skipped/changed material must not silently
            # replace the user's existing story context.
            summary = run['context'] if skipped else entry['summary']
            affected = apply_response(state, run, entry['chosen'], entry['translated'], summary)
            for part in entry['chosen']:
                job = run['jobs'][part['job']]
                if not job['refs']: job['remaining'] = ''
            run['lastPendingResult'] = token
            if state.get('settings', {}).get('overlayMode') == entry.get('overlayMode'):
                state['settings']['overlayMode'] = 'translation'
            store.save(state)
            done = not any(job['remaining'] for job in run['jobs'])
        remove(store, project_id, token)
        return {'project': state, 'done': done, 'affectedImageIds': affected,
                'completed': state.get(RUN_KEY, {}).get('completed', 0), 'kind': entry['kind']}
