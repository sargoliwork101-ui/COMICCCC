"""Incremental page-local translation plans with a bounded rolling summary."""
from __future__ import annotations

import hashlib
import json
from typing import Any

from .context_budget import ContextBudget, ContextRequest, build_context_request
from .ocr import LANGUAGES
from .store import ProjectChangedError
from .translation import TranslationError, combine_translation_texts, distribute_translation
from .translation_plan import split_ai_paragraph, target_snapshot

RUN_KEY = '_aiContextRun'
SUMMARY_KEY = '_aiStorySummary'


def digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def provider_policy(settings: dict[str, Any], provider: str) -> dict[str, Any]:
    config = settings.get('providers', {}).get(provider, {})
    return {'model': config.get('model', ''), 'base_url': config.get('base_url', ''),
            'profiles': [{'id': p.get('id', ''), 'hasApiKey': bool(p.get('hasApiKey', p.get('api_key', ''))),
                          'timeout_seconds': p.get('timeout_seconds', 90), 'retry_count': p.get('retry_count', 0),
                          'retry_wait_seconds': p.get('retry_wait_seconds', 20), 'source_limit': p.get('source_limit', 1000)}
                         for p in config.get('profiles', [])]}


def source_layout(state: dict[str, Any], image_ids: list[str]) -> str:
    chosen = set(image_ids)
    items = [item for item in sorted(state.get('images', []), key=lambda item: item.get('order', 0)) if item['id'] in chosen]
    return digest([{'id': item['id'], 'blocks': [{'id': block.get('id'), 'text': block.get('text'),
                    'enabled': block.get('enabled', True), 'sourceLines': block.get('sourceLines')}
                   for block in item.get('blocks', [])]} for item in items])


def create_run(state: dict[str, Any], image_ids: list[str], provider: str, language: str,
               skill: str, context: str, limit: int, context_percent: int,
               skill_percent: int, reuse: bool, policy: dict[str, Any]) -> dict[str, Any]:
    """Snapshot source and target references; no secret or skill is persisted."""
    budget = ContextBudget(limit, context_percent, skill_percent)
    build_context_request(budget, LANGUAGES.get(language, LANGUAGES['eng'])['name'], skill, context)
    selected = set(image_ids)
    items = [i for i in sorted(state.get('images', []), key=lambda i: i.get('order', 0)) if i['id'] in selected]
    jobs: list[dict[str, Any]] = []
    by_text: dict[str, dict[str, Any]] = {}
    seen: set[tuple[str, str]] = set()
    for item in items:
        for block in item.get('blocks', []):
            source = str(block.get('text') or '').replace('\r\n', '\n').replace('\r', '\n').strip()
            if not block.get('enabled', True) or not source:
                continue
            if block.get('id') is None:
                raise TranslationError('شناسهٔ یکی از کادرها وجود ندارد؛ ابتدا آن را ویرایش و ذخیره کنید.')
            key = (str(item['id']), str(block['id']))
            if key in seen:
                raise TranslationError('شناسهٔ کادرها یکتا نیست؛ ابتدا آن‌ها را اصلاح کنید.')
            seen.add(key)
            ref = {'imageId': item['id'], 'blockId': block['id'], 'snapshot': target_snapshot(block)}
            if reuse and source in by_text:
                by_text[source]['refs'].append(ref)
                continue
            job = {'imageId': item['id'], 'imageName': item.get('name', ''), 'source': source,
                   'sourceLines': block.get('sourceLines'), 'remaining': source, 'accumulated': '', 'refs': [ref]}
            jobs.append(job)
            if reuse:
                by_text[source] = job
    # Reject a line that cannot fit even with an empty summary before sending
    # any text. Later requests are recalculated with their actual summary; if
    # that makes a line too large, stop and let the user shorten the summary.
    maximum = build_context_request(budget, LANGUAGES.get(language, LANGUAGES['eng'])['name'], skill, '').source_capacity
    for job in jobs:
        if len(job['source']) > maximum:
            split_ai_paragraph(job['source'], maximum, job.get('sourceLines'))
    return {'provider': provider, 'language': language, 'skillHash': digest(skill), 'context': context,
            'limit': limit, 'contextPercent': context_percent, 'skillPercent': skill_percent,
            'reuse': reuse, 'policyHash': digest(policy), 'imageIds': [i['id'] for i in items], 'sourceLayout': source_layout(state, [i['id'] for i in items]), 'jobs': jobs,
            'completed': 0}


def _block_lookup(state: dict[str, Any]) -> dict[tuple[str, str], dict[str, Any]]:
    result: dict[tuple[str, str], dict[str, Any]] = {}
    for item in state.get('images', []):
        for block in item.get('blocks', []):
            key = (str(item['id']), str(block.get('id')))
            if key in result:
                raise ProjectChangedError('شناسهٔ کادرهای تصویر یکتا نیست؛ برای جلوگیری از بازنویسی ترجمه متوقف شد.')
            result[key] = block
    return result


def verify_run(state: dict[str, Any], run: dict[str, Any], skill: str, policy: dict[str, Any] | None) -> None:
    if run['skillHash'] != digest(skill) or (policy is not None and run['policyHash'] != digest(policy)):
        raise ProjectChangedError('راهنما یا تنظیمات API تغییر کرده است؛ پیش‌نمایش تازه را بررسی کنید.')
    if source_layout(state, run['imageIds']) != run['sourceLayout']:
        raise ProjectChangedError('متن یا ترتیب صفحه‌ها تغییر کرده است؛ پیش‌نمایش تازه لازم است.')
    lookup = _block_lookup(state)
    for job in run['jobs']:
        for ref in job['refs']:
            block = lookup.get((str(ref['imageId']), str(ref['blockId'])))
            if block is None or target_snapshot(block) != ref['snapshot']:
                raise ProjectChangedError('متن یا ترجمهٔ پروژه از زمان تأیید تغییر کرده است؛ برای جلوگیری از بازنویسی، ترجمه متوقف شد.')


def next_request(run: dict[str, Any], skill: str) -> tuple[ContextRequest, list[dict[str, Any]]]:
    budget = ContextBudget(run['limit'], run['contextPercent'], run['skillPercent'])
    request = build_context_request(budget, LANGUAGES.get(run['language'], LANGUAGES['eng'])['name'], skill, run['context'])
    pending = [(i, job) for i, job in enumerate(run['jobs']) if job['remaining']]
    if not pending:
        return request, []
    image_id = pending[0][1]['imageId']
    chosen: list[dict[str, Any]] = []
    for index, job in pending:
        if job['imageId'] != image_id:
            break
        remaining = job['remaining']
        proposed = combine_translation_texts([c['text'] for c in chosen] + [remaining])
        if len(proposed) <= request.source_capacity:
            chosen.append({'job': index, 'text': remaining, 'rest': '', 'join': ''})
            continue
        if chosen:
            break
        try:
            parts, joins = split_ai_paragraph(remaining, request.source_capacity, job.get('sourceLines'))
        except TranslationError as exc:
            message = str(exc).replace('هیچ متنی ارسال نشد.', 'این درخواست ارسال نشد.')
            raise TranslationError(message + ' می‌توانید خلاصهٔ قبلی را کوتاه‌تر کنید و با پیش‌نمایش تازه ادامه دهید.') from exc
        first = parts[0]
        rest = ''.join((joins[i - 1] if i > 1 else '') + part for i, part in enumerate(parts[1:], start=1))
        chosen.append({'job': index, 'text': first, 'rest': rest, 'join': joins[0]})
        break
    return request, chosen


def apply_response(state: dict[str, Any], run: dict[str, Any], chosen: list[dict[str, Any]],
                   translated: str, summary: str) -> list[str]:
    results = distribute_translation([entry['text'] for entry in chosen], translated)
    lookup = _block_lookup(state)
    affected: set[str] = set()
    for entry, result in zip(chosen, results):
        job = run['jobs'][entry['job']]
        job['accumulated'] += result + entry['join']
        job['remaining'] = entry['rest']
        if job['remaining']:
            # Preserve the still-valid original OCR line boundaries after a
            # split of a merged, space-joined OCR block.
            lines = job.get('sourceLines')
            if isinstance(lines, list) and all(isinstance(line, dict) for line in lines):
                for index in range(len(lines)):
                    suffix = ' '.join(' '.join(str(line.get('text') or '').split()) for line in lines[index:] if str(line.get('text') or '').strip())
                    if suffix == job['remaining']:
                        job['sourceLines'] = lines[index:]
                        break
            continue
        for ref in job['refs']:
            block = lookup[(str(ref['imageId']), str(ref['blockId']))]
            block['tr'] = job['accumulated']; block['richHtml'] = ''
            # Old checkpoints describe different payloads, not this context run.
            block.pop('_aiTranslationParts', None); block.pop('_aiReusedTranslation', None)
            ref['snapshot'] = target_snapshot(block)
            affected.add(ref['imageId'])
    run['context'] = summary
    run['completed'] += 1
    state[SUMMARY_KEY] = summary
    return sorted(affected)
