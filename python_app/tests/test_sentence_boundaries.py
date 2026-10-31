"""Regression tests for source-line-safe splitting, with mocked providers."""
import pytest

from support_client import scoped_client
from test_context_run import make_project
from comic_studio.main import create_app
from comic_studio.translation import TranslationError, TranslationService
from comic_studio.translation_plan import safe_line_boundaries, split_ai_paragraph
from comic_studio.context_run import safe_prefix, matching_source_lines


@pytest.mark.parametrize('closing', ['」', '』', '】', '》', '〉', '］', '｝', '”'])
def test_japanese_and_chinese_end_quotes_are_safe_only_at_line_end(closing):
    left = '「文章です。' + closing
    text = left + '\n続きです。'
    assert safe_prefix(text, lambda value: len(value) <= len(left)) == (left, '続きです。', '\n')
    # Sentence endings inside an OCR line must not be treated as a line break.
    assert safe_prefix(left + ' 続きです。', lambda value: len(value) <= len(left)) is None


def test_ocr_whitespace_changes_keep_verified_line_offsets_and_exact_separators():
    lines = [{'text':'FIRST line.」'}, {'text':'SECOND line.』'}, {'text':'THIRD line.'}]
    text = 'FIRST\tline.」   \tSECOND  line.』\t  THIRD line.'
    cut, end = safe_line_boundaries(text, lines)[0]
    assert text[:cut] == 'FIRST\tline.」'
    assert text[cut:end] == '   \t'
    assert text[end:] == 'SECOND  line.』\t  THIRD line.'
    rest_lines = matching_source_lines(lines, text[end:])
    assert rest_lines == lines[1:]
    parts, joins = split_ai_paragraph(text, 15, lines)
    assert parts == ['FIRST\tline.」', 'SECOND  line.』', 'THIRD line.']
    assert ''.join(part + (joins[i] if i < len(joins) else '') for i, part in enumerate(parts)) == text


@pytest.mark.parametrize('tampered', ['FIRST altered. SECOND line.', 'FIRST line! SECOND line.', 'SECOND line. FIRST line.'])
def test_stale_ocr_metadata_never_guesses_boundaries(tampered):
    lines = [{'text':'FIRST line.'}, {'text':'SECOND line.'}]
    assert safe_line_boundaries(tampered, lines) == []
    assert safe_prefix(tampered, lambda value: len(value) <= 12, lines) is None
    with pytest.raises(TranslationError): split_ai_paragraph(tampered, 12, lines)


@pytest.mark.parametrize('provider', ['openai', 'free'])
def test_project_whole_ocr_lines_are_sent_page_by_page_and_resumed(provider, tmp_path, monkeypatch):
    monkeypatch.setenv('COMIC_STUDIO_DATA', str(tmp_path))
    seen = []
    def ai(self, request, text, sources, selected_provider, policy):
        assert request.character_count(text) <= 650
        seen.append(text)
        return 'translated', 'context'
    def free(self, request, text, sources, language, policy):
        assert len(text) <= 500 and len(text.encode('utf8')) <= 500
        seen.append(text)
        return 'translated'
    monkeypatch.setattr(TranslationService, 'translate_context', ai)
    monkeypatch.setattr(TranslationService, 'translate_free_batch', free)
    with scoped_client(create_app()) as client:
        route, project = make_project(client)
        lines = [{'text':chr(0x6f22+i)*140+'。'+closer} for i,closer in enumerate(['」','』','】'])]
        source = '  \t'.join(line['text'] for line in lines)
        project['images'][0]['blocks'] = [{'id':17, 'text':source, 'sourceLines':lines, 'tr':'old', 'enabled':True}]
        project['images'][1]['blocks'] = [{'id':18, 'text':'another page', 'tr':'old', 'enabled':True}]
        assert client.put(route+'/state', json={'state':project}).status_code == 200
        if provider == 'openai':
            settings = {'provider':'openai', 'providers':{'openai':{'profiles':[{'id':'key','api_key':'key','source_limit':650}]}}}
            assert client.put('/api/ai-settings', json=settings).status_code == 200
        req = {'image_ids':[image['id'] for image in project['images']], 'provider':provider,
               'skill':'x' if provider != 'free' else '', 'summary':'', 'source_language':'jpn', 'reuse_repeated':False}
        preview = client.post(route+'/context-preview', json=req)
        assert preview.status_code == 200, preview.text
        assert seen == []  # Preview never calls a provider.
        start = client.post(route+'/context-start', json={**req, 'confirmation':preview.json()['signature']}).json()
        for completed in range(10):
            result = client.post(route+'/context-step', json={'run_id':start['runId'], 'completed':completed, 'skill':req['skill']})
            assert result.status_code == 200, result.text
            if result.json()['done']: break
        assert result.json()['done']
        assert len(seen) >= 3 and seen[-1] == 'another page'
        # Reassemble the sent source allowing only the preserved join whitespace.
        assert ' '.join(' '.join(seen[:-1]).split()) == ' '.join(source.split())
        assert all('another page' not in chunk for chunk in seen[:-1])
        assert result.json()['project']['images'][0]['blocks'][0]['tr'] != 'old'
        assert result.json()['project']['images'][1]['blocks'][0]['tr'] == 'translated'


@pytest.mark.parametrize('provider', ['openai', 'free'])
def test_unsplittable_text_reports_page_block_and_provider_limit_before_send(provider, tmp_path, monkeypatch):
    monkeypatch.setenv('COMIC_STUDIO_DATA', str(tmp_path))
    seen = []
    monkeypatch.setattr(TranslationService, 'translate_context', lambda *a: seen.append(1))
    monkeypatch.setattr(TranslationService, 'translate_free_batch', lambda *a: seen.append(1))
    with scoped_client(create_app()) as client:
        route, project = make_project(client)
        project['images'][0]['name'] = 'long-page.png'
        project['images'][0]['blocks'] = [{'id':42, 'text':'漢'*700, 'tr':'old', 'enabled':True}]
        # Names are server-owned; set explicitly in store for the diagnostic.
        from comic_studio.store import ProjectStore
        store = ProjectStore(); current = store.get(project['id']); current['images'][0]['name'] = 'long-page.png'; store.save(current)
        assert client.put(route+'/state', json={'state':project}).status_code == 200
        if provider == 'openai': client.put('/api/ai-settings', json={'provider':'openai','api_key':'key'})
        req = {'image_ids':[project['images'][0]['id']], 'provider':provider, 'skill':'','summary':''}
        result = client.post(route+'/context-preview', json=req)
        assert result.status_code == 502 and not seen
        message = result.json()['detail']
        assert 'long-page.png' in message and '42' in message and 'هیچ متنی ارسال نشد' in message
        assert ('۵۰۰ بایت' in message) == (provider == 'free')
        assert ('سقف کل' in message) == (provider == 'openai')


def test_default_ai_budget_has_more_room_for_a_whole_ocr_line(tmp_path, monkeypatch):
    from comic_studio.context_budget import ContextBudget, build_context_request
    from comic_studio.translation import DEFAULT_AI_SKILL
    old = build_context_request(ContextBudget(1000), 'English', DEFAULT_AI_SKILL, '', prompt_version=1)
    new = build_context_request(ContextBudget(1000), 'English', DEFAULT_AI_SKILL, '')
    assert old.source_capacity < 540 <= new.source_capacity
    seen = []
    monkeypatch.setenv('COMIC_STUDIO_DATA', str(tmp_path))
    def fake(self, request, text, sources, provider, policy):
        seen.append((request, text)); return 'ترجمه', 'خلاصه'
    monkeypatch.setattr(TranslationService, 'translate_context', fake)
    with scoped_client(create_app()) as client:
        route, project = make_project(client)
        project['images'][0]['blocks'] = [{'id':1, 'text':'A'*540, 'tr':'old', 'enabled':True}]
        client.put(route+'/state', json={'state':project})
        client.put('/api/ai-settings', json={'provider':'openai','api_key':'key'})
        req = {'image_ids':[project['images'][0]['id']], 'provider':'openai', 'skill':DEFAULT_AI_SKILL, 'summary':''}
        preview = client.post(route+'/context-preview', json=req)
        assert preview.status_code == 200, preview.text
        assert not seen
        start = client.post(route+'/context-start', json={**req,'confirmation':preview.json()['signature']}).json()
        step = client.post(route+'/context-step', json={'run_id':start['runId'], 'completed':0, 'skill':DEFAULT_AI_SKILL})
        assert step.status_code == 200 and step.json()['done'] and len(seen) == 1
        assert seen[0][1] == 'A'*540 and seen[0][0].character_count(seen[0][1]) <= 1000


def test_old_checkpoint_requires_new_preview_without_resending_completed_pages(tmp_path, monkeypatch):
    from comic_studio.store import ProjectStore
    monkeypatch.setenv('COMIC_STUDIO_DATA', str(tmp_path))
    seen = []
    def fake(self, request, text, sources, provider, policy):
        seen.append((request.system, text))
        return '\n'.join('ترجمه' for _ in text.split('\n')), 'خلاصه'
    monkeypatch.setattr(TranslationService, 'translate_context', fake)
    with scoped_client(create_app()) as client:
        route, project = make_project(client)
        client.put('/api/ai-settings', json={'provider':'openai','api_key':'key'})
        req = {'image_ids':[i['id'] for i in project['images']], 'provider':'openai', 'skill':'ok', 'summary':'', 'reuse_repeated':False}
        preview = client.post(route+'/context-preview', json=req).json()
        start = client.post(route+'/context-start', json={**req, 'confirmation':preview['signature']}).json()
        step = {'run_id':start['runId'], 'completed':0, 'skill':'ok'}
        first = client.post(route+'/context-step', json=step)
        assert first.status_code == 200 and not first.json()['done'] and len(seen) == 1
        store = ProjectStore(); state = store.get(project['id'])
        state['_aiContextRun'].pop('planningRevision'); state['_aiContextRun'].pop('promptVersion')
        store.save(state)
        assert client.post(route+'/context-step', json={**step, 'completed':1}).status_code == 409
        assert len(seen) == 1
        resume_req = {**req, 'resume':True, 'summary':'خلاصه'}
        resumed_preview = client.post(route+'/context-preview', json=resume_req)
        assert resumed_preview.status_code == 200, resumed_preview.text
        assert 'preserving names' in resumed_preview.json()['systemPrompt']  # Original, approved prompt.
        resumed = client.post(route+'/context-start', json={**resume_req, 'confirmation':resumed_preview.json()['signature']})
        assert resumed.status_code == 200 and resumed.json()['completed'] == 1
        result = client.post(route+'/context-step', json={**step, 'completed':1})
        assert result.status_code == 200 and result.json()['done'] and len(seen) == 2
        assert 'preserving names' in seen[-1][0] and 'page 1' in seen[-1][1]


@pytest.mark.parametrize('provider', ['openai', 'free'])
def test_single_box_retranslation_uses_same_safe_ocr_boundaries(provider, tmp_path, monkeypatch):
    monkeypatch.setenv('COMIC_STUDIO_DATA', str(tmp_path)); seen = []
    def ai(self, request, text, sources, selected_provider, policy):
        seen.append(text); return 'ترجمه', 'short'
    def free(self, request, text, sources, language, policy):
        seen.append(text); return 'ترجمه'
    monkeypatch.setattr(TranslationService, 'translate_context', ai)
    monkeypatch.setattr(TranslationService, 'translate_free_batch', free)
    with scoped_client(create_app()) as client:
        if provider == 'openai':
            client.put('/api/ai-settings', json={'provider':'openai', 'providers':{'openai':{'profiles':[{'id':'key','api_key':'key','source_limit':650}]}}})
        lines = [{'text':chr(0x6f22+i)*140+'。」'} for i in range(3)]
        text = '\t  '.join(item['text'] for item in lines)
        req = {'text':text, 'source_lines':lines, 'provider':provider, 'source_language':'jpn', 'skill':'x' if provider == 'openai' else '', 'summary':''}
        preview = client.post('/api/translate-text/context-preview', json=req)
        assert preview.status_code == 200, preview.text
        assert not seen
        result = client.post('/api/translate-text/context', json={**req, 'confirmation':preview.json()['signature']})
        assert result.status_code == 200, result.text
        assert len(seen) >= 2 and ' '.join(' '.join(seen).split()) == ' '.join(text.split())
        assert result.json()['text'].count('ترجمه') == len(seen)


def test_capacity_error_reports_actual_budget_and_first_summary_zero(tmp_path, monkeypatch):
    monkeypatch.setenv('COMIC_STUDIO_DATA', str(tmp_path)); calls = []
    monkeypatch.setattr(TranslationService, 'translate_context', lambda *a: calls.append(1))
    with scoped_client(create_app()) as client:
        route, project = make_project(client)
        project['images'][0]['blocks'] = [{'id':34, 'text':'A'*715, 'tr':'old', 'enabled':True}]
        client.put(route+'/state', json={'state':project})
        client.put('/api/ai-settings', json={'provider':'openai', 'providers':{'openai':{'profiles':[{'id':'key','api_key':'key','source_limit':900}]}}})
        req = {'image_ids':[project['images'][0]['id']], 'provider':'openai', 'skill':'راهنمای نمونه', 'summary':''}
        result = client.post(route+'/context-preview', json=req)
        assert result.status_code == 502 and not calls
        data = result.json(); counts = data['budget']
        assert data['kind'] == 'translation_capacity' and result.headers['cache-control'] == 'no-store'
        assert counts['summaryChars'] == 0 and counts['skillChars'] == len(req['skill'])
        assert sum(counts[key] for key in ('systemChars','skillChars','summaryChars','labelChars','textCapacity')) == 900
        assert counts['emptySummaryCapacity'] == counts['textCapacity'] and counts['requiredSourceChars'] == 715
        assert counts['requiredSourceBytes'] == 715 and counts['imageId'] == project['images'][0]['id']
        assert counts['imageName'] == 'a.png' and counts['blockId'] == '34'
        assert counts['estimatedTotalForCurrent'] == 900 + 715 - counts['textCapacity']
        assert 'راهنمای نمونه' in data['system_prompt'] and 'خلاصهٔ فعلی 0' in data['detail']
        with_summary = client.post(route+'/context-preview', json={**req,'summary':'یک خلاصه'})
        assert with_summary.status_code == 502 and not calls
        newer = with_summary.json()['budget']
        assert newer['summaryChars'] == len('یک خلاصه')
        assert newer['textCapacity'] < counts['textCapacity']
        assert newer['emptySummaryCapacity'] == counts['textCapacity']



def test_exact_capacity_diagnostic_recalculates_summary_percent_at_new_total(tmp_path, monkeypatch):
    monkeypatch.setenv('COMIC_STUDIO_DATA', str(tmp_path))
    with scoped_client(create_app()) as client:
        route, project = make_project(client)
        project['images'][0]['blocks'] = [{'id':34, 'text':'A'*715, 'enabled':True}]
        client.put(route+'/state', json={'state':project})
        client.put('/api/ai-settings', json={'provider':'openai', 'context_percent':10, 'skill_percent':15, 'providers':{'openai':{'profiles':[{'id':'key','api_key':'key','source_limit':900}]}}})
        req = {'image_ids':[project['images'][0]['id']], 'provider':'openai', 'skill':'x'*84, 'summary':''}
        response = client.post(route+'/context-preview', json=req)
        assert response.status_code == 502
        b = response.json()['budget']
        assert (b['systemChars'], b['skillChars'], b['labelChars'], b['summaryChars'], b['textCapacity']) == (331, 84, 24, 0, 461)
        assert (b['skillLimit'], b['summaryLimit'], b['estimatedTotalForCurrent']) == (135, 90, 1155)
        assert '1155' in response.json()['detail']


def test_successful_first_preview_shows_no_context_then_generated_summary_is_used(tmp_path, monkeypatch):
    monkeypatch.setenv('COMIC_STUDIO_DATA', str(tmp_path)); sent=[]
    def fake(self, request, text, sources, provider, policy):
        sent.append(request.user_prefix)
        return '\n'.join('متن' for _ in sources), 'خلاصهٔ تولیدشده'
    monkeypatch.setattr(TranslationService, 'translate_context', fake)
    with scoped_client(create_app()) as client:
        route, project = make_project(client)
        client.put('/api/ai-settings', json={'provider':'openai','api_key':'key'})
        req={'image_ids':[i['id'] for i in project['images']], 'provider':'openai', 'skill':'راهنما', 'summary':'', 'reuse_repeated':False}
        preview=client.post(route+'/context-preview', json=req)
        assert preview.status_code == 200, preview.text
        assert preview.json()['budget']['summaryChars'] == 0
        assert preview.json()['budget']['sourceChars'] == len('repeated title\npage 0')
        assert preview.json()['budget']['sourceBytes'] == len('repeated title\npage 0'.encode())
        assert 'Context:' not in preview.json()['requests'][0]['text'] and not sent
        start=client.post(route+'/context-start', json={**req,'confirmation':preview.json()['signature']}).json()
        for n in range(2):
            response=client.post(route+'/context-step', json={'run_id':start['runId'],'completed':n,'skill':req['skill']})
            assert response.status_code==200, response.text
        assert len(sent)==2 and 'Context:' not in sent[0] and 'خلاصهٔ تولیدشده' in sent[1]


def test_later_summary_capacity_failure_is_visible_and_resume_does_not_repeat_paid_step(tmp_path, monkeypatch):
    from comic_studio.context_budget import ContextBudget, build_context_request
    from comic_studio.translation import DEFAULT_AI_SKILL
    monkeypatch.setenv('COMIC_STUDIO_DATA', str(tmp_path)); calls=[]
    def fake(self, request, text, sources, provider, policy):
        calls.append(text)
        return 'ترجمه', 's'*135
    monkeypatch.setattr(TranslationService, 'translate_context', fake)
    with scoped_client(create_app()) as client:
        route, project = make_project(client)
        empty = build_context_request(ContextBudget(900), 'English', DEFAULT_AI_SKILL, '')
        project['images'][0]['blocks']=[{'id':1,'text':'first page','tr':'old','enabled':True}]
        project['images'][1]['blocks']=[{'id':2,'text':'Z'*(empty.source_capacity-1),'tr':'old','enabled':True}]
        client.put(route+'/state',json={'state':project})
        client.put('/api/ai-settings',json={'provider':'openai','providers':{'openai':{'profiles':[{'id':'a','api_key':'key','source_limit':900}]}}})
        req={'image_ids':[i['id'] for i in project['images']],'provider':'openai','skill':DEFAULT_AI_SKILL,'summary':'','reuse_repeated':False}
        preview=client.post(route+'/context-preview',json=req).json()
        start=client.post(route+'/context-start',json={**req,'confirmation':preview['signature']}).json()
        step={'run_id':start['runId'],'completed':0,'skill':DEFAULT_AI_SKILL}
        first=client.post(route+'/context-step',json=step)
        assert first.status_code==200 and not first.json()['done'] and calls==['first page']
        blocked=client.post(route+'/context-step',json={**step,'completed':1})
        assert blocked.status_code==502 and blocked.json()['kind']=='translation_capacity'
        assert blocked.json()['budget']['summaryChars']==135 and calls==['first page']
        assert blocked.json()['budget']['requiredSourceChars'] == empty.source_capacity - 1
        assert blocked.json()['budget']['imageId'] == project['images'][1]['id'] and blocked.json()['budget']['blockId'] == '2'
        assert client.get(route).json()['_aiContextRun']['completed']==1
        resume={**req,'resume':True,'summary':''}
        preview=client.post(route+'/context-preview',json=resume)
        assert preview.status_code==200 and preview.json()['budget']['summaryChars']==0
        resumed=client.post(route+'/context-start',json={**resume,'confirmation':preview.json()['signature']})
        assert resumed.status_code==200 and resumed.json()['completed']==1
        final=client.post(route+'/context-step',json={**step,'completed':1})
        assert final.status_code==200 and final.json()['done']
        assert calls==['first page','Z'*(empty.source_capacity-1)]
