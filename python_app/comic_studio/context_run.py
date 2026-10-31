"""Incremental page-local translation plans with a bounded rolling summary."""
from __future__ import annotations

import hashlib
import json
from typing import Any

from .context_budget import ContextBudget, ContextRequest, FreeRequest, build_context_request, request_budget
from .ocr import LANGUAGES
from .store import ProjectChangedError
from .translation import ContextCapacityError, TranslationError, combine_translation_texts, distribute_translation
from .translation_plan import safe_line_boundaries, target_snapshot

RUN_KEY = '_aiContextRun'
SUMMARY_KEY = '_aiStorySummary'
PLANNING_REVISION = 2


def digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def provider_policy(settings: dict[str, Any], provider: str) -> dict[str, Any]:
    if provider == 'free':
        return {'services': settings.get('free_services', {})}
    config = settings.get('providers', {}).get(provider, {})
    mode = config.get('response_mode', 'auto')
    return {**({'response_mode': mode} if mode != 'auto' else {}), 'model': config.get('model', ''), 'base_url': config.get('base_url', ''),
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


def build_run_request(run: dict[str, Any], skill: str) -> ContextRequest | FreeRequest:
    if run['provider'] == 'free':
        return FreeRequest(run['limit'])
    budget = ContextBudget(run['limit'], run['contextPercent'], run['skillPercent'])
    return build_context_request(budget, LANGUAGES.get(run['language'], LANGUAGES['eng'])['name'], skill, run['context'], prompt_version=run.get('promptVersion', 1))


def safe_prefix(text: str, fits: Any, source_lines: Any = None) -> tuple[str, str, str] | None:
    """Find the latest whole-sentence or paragraph line boundary that fits.

    Return the first part, remainder and intervening whitespace. The remainder
    need not fit the current space: it will be planned again next request.
    """
    candidates = safe_line_boundaries(text, source_lines)
    valid = [(cut, end) for cut, end in candidates if cut > 0 and end < len(text) and fits(text[:cut])]
    if not valid:
        return None
    cut, end = max(valid)
    return text[:cut], text[end:], text[cut:end]


def create_run(state: dict[str, Any], image_ids: list[str], provider: str, language: str,
               skill: str, context: str, limit: int, context_percent: int,
               skill_percent: int, reuse: bool, policy: dict[str, Any]) -> dict[str, Any]:
    """Snapshot source and target references; no secret or skill is persisted."""
    if provider == 'free':
        if skill or context:
            raise TranslationError('مترجم رایگان از اسکیل یا خلاصهٔ AI پشتیبانی نمی‌کند.')
        current_request = maximum_request = FreeRequest(limit)
    else:
        budget = ContextBudget(limit, context_percent, skill_percent)
        current_request = build_context_request(budget, LANGUAGES.get(language, LANGUAGES['eng'])['name'], skill, context)
        maximum_request = build_context_request(budget, LANGUAGES.get(language, LANGUAGES['eng'])['name'], skill, '')
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
    for job in jobs:
        remaining = job['source']; lines = job.get('sourceLines')
        while not maximum_request.fits(remaining):
            chunk = safe_prefix(remaining, maximum_request.fits, lines)
            if not chunk:
                candidates = safe_line_boundaries(remaining, lines)
                first = remaining[:candidates[0][0]] if candidates else remaining
                image_name = str(job['imageName'] or job['imageId'])[:120]
                block_id = str(job['refs'][0]['blockId'])[:80]
                if provider == 'free':
                    detail = (f"بخش کامل بعدی {len(first)} نویسه و {len(first.encode('utf-8'))} بایت است؛ "
                              f"سقف مؤثر {maximum_request.source_capacity} نویسه و ۵۰۰ بایت است.")
                else:
                    detail = (f"بخش کامل بعدی {len(first)} نویسه است؛ فضای متن با دستور و اسکیل و بدون خلاصه "
                              f"{maximum_request.source_capacity} نویسه از سقف کل {limit} است.")
                counts = ({'totalLimit':limit, 'textCapacity':maximum_request.source_capacity, 'byteLimit':500}
                          if provider == 'free' else request_budget(current_request, skill, context))
                counts['emptySummaryCapacity'] = maximum_request.source_capacity
                counts['requiredSourceChars'] = len(first)
                if provider != 'free':
                    counts['estimatedTotalForCurrent'] = limit + max(0, len(first) - current_request.source_capacity)
                    detail += (f" خلاصهٔ فعلی {counts['summaryChars']}، اسکیل {counts['skillChars']}، "
                               f"دستور ثابت {counts['systemChars']} و برچسب‌ها {counts['labelChars']} نویسه‌اند. "
                               f"سقف تقریبی لازم با مقادیر فعلی {counts['estimatedTotalForCurrent']} نویسه است؛ بعد از تغییر دوباره بررسی کنید.")
                raise ContextCapacityError(f"در صفحهٔ «{image_name}»، کادر {block_id}: {detail} "
                                           'مرز امن در سقف پیدا نشد؛ سقف را تغییر دهید یا متن را بررسی کنید. هیچ متنی ارسال نشد.', counts, getattr(current_request, 'system', ''))
            _, remaining, _ = chunk
            lines = matching_source_lines(lines, remaining)
    return {'provider': provider, 'language': language, 'planningRevision': PLANNING_REVISION, **({'promptVersion': 2} if provider != 'free' else {}),
            'skillHash': digest(skill), 'context': context,
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


def matching_source_lines(lines: Any, remaining: str) -> Any:
    if isinstance(lines, list) and all(isinstance(line, dict) for line in lines):
        for index in range(len(lines)):
            suffix = ' '.join(' '.join(str(line.get('text') or '').split()) for line in lines[index:] if str(line.get('text') or '').strip())
            if suffix == ' '.join(remaining.split()):
                return lines[index:]
    return None


def next_request(run: dict[str, Any], skill: str) -> tuple[ContextRequest | FreeRequest, list[dict[str, Any]]]:
    request = build_run_request(run, skill)
    pending = [(i, job) for i, job in enumerate(run['jobs']) if job['remaining']]
    if not pending:
        return request, []
    image_id = pending[0][1]['imageId']
    chosen: list[dict[str, Any]] = []
    for index, job in pending:
        if job['imageId'] != image_id:
            break
        remaining = job['remaining']
        prefix = combine_translation_texts([c['text'] for c in chosen])
        def fits_next(part: str) -> bool:
            return request.fits((prefix + '\n' if prefix else '') + part)
        if fits_next(remaining):
            chosen.append({'job': index, 'text': remaining, 'rest': '', 'join': ''})
            continue
        # If the next bubble has a safe sentence/line boundary, fill the
        # current request with that whole prefix rather than sending a tiny
        # previous bubble alone. Never cross a page or cut a line.
        split = safe_prefix(remaining, fits_next, job.get('sourceLines'))
        if split:
            first, rest, join = split
            chosen.append({'job': index, 'text': first, 'rest': rest, 'join': join})
        elif not chosen:
            job = run['jobs'][pending[0][0]]
            image_name = str(job.get('imageName') or job['imageId'])[:120]
            block_id = str(job['refs'][0]['blockId'])[:80] if job['refs'] else '—'
            capacity = (f"{request.source_capacity} نویسه و ۵۰۰ بایت" if run['provider'] == 'free'
                        else f"{request.source_capacity} نویسه")
            counts = ({'totalLimit':run['limit'], 'textCapacity':request.source_capacity, 'byteLimit':500}
                      if run['provider'] == 'free' else request_budget(request, skill, run['context']))
            raise ContextCapacityError(f"در صفحهٔ «{image_name}»، کادر {block_id}: خط یا جمله در فضای فعلی {capacity} جا نمی‌شود؛ "
                                       'خلاصه، سقف یا متن OCR را بررسی کنید. این درخواست ارسال نشد.', counts, getattr(request, 'system', ''))
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
            job['sourceLines'] = matching_source_lines(job.get('sourceLines'), job['remaining'])
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
    if run['provider'] != 'free':
        state[SUMMARY_KEY] = summary
    return sorted(affected)
