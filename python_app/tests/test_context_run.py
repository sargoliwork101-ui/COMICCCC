import io
import json
from PIL import Image
from support_client import scoped_client
from comic_studio.main import create_app
from comic_studio.context_run import safe_prefix
from comic_studio.translation import TranslationService


def png():
    data = io.BytesIO(); Image.new('RGB', (100, 100), 'white').save(data, 'PNG'); return data.getvalue()


def make_project(client):
    project = client.post('/api/projects', json={'name':'context'}).json()
    route = f"/api/projects/{project['id']}"
    project = client.post(route + '/files', files=[('files', ('a.png', png(), 'image/png')), ('files', ('b.png', png(), 'image/png'))]).json()
    for n, image in enumerate(project['images']):
        image['blocks'] = [{'id':1, 'text':'repeated title', 'tr':'old', 'enabled':True}, {'id':2, 'text':'page ' + str(n), 'tr':'old', 'enabled':True}]
    assert client.put(route + '/state', json={'state': project}).status_code == 200
    return route, project


def test_safe_prefix_splits_sentence_boundaries_inside_one_ocr_line():
    first = 'This is a complete first sentence.'
    second = 'This is a complete second sentence.'
    source = first + ' ' + second
    part, rest, separator = safe_prefix(source, lambda value: len(value) <= len(first))
    assert part == first and rest == second and separator == ' '


def test_sequential_context_persists_and_reuses_with_one_approval(tmp_path, monkeypatch):
    monkeypatch.setenv('COMIC_STUDIO_DATA', str(tmp_path))
    captured = []
    def fake(self, request, text, sources, provider, policy):
        captured.append((request.system, request.user_message(text), request.character_count(text), list(sources)))
        return '\n'.join('ترجمه' for _ in text.split('\n')), 'نام: جان' if len(captured) == 1 else 'جان به خانه رفت'
    monkeypatch.setattr(TranslationService, 'translate_context', fake)
    with scoped_client(create_app()) as client:
        route, project = make_project(client)
        settings = client.put('/api/ai-settings', json={'provider':'openai','api_key':'key'}).json()
        assert settings['context_percent'] == settings['skill_percent'] == 15
        req = {'image_ids':[i['id'] for i in project['images']], 'provider':'openai', 'skill':'لحن دوستانه', 'summary':'', 'reuse_repeated':True}
        preview = client.post(route + '/context-preview', json=req)
        assert preview.status_code == 200, preview.text
        p = preview.json(); assert p['skillLimit'] == p['contextLimit'] == 150
        assert 'Context:' not in p['requests'][0]['text']
        assert p['requests'][0]['characters'] <= 1000
        start = client.post(route + '/context-start', json={**req, 'confirmation':p['signature']}).json()
        step = {'run_id':start['runId'], 'completed':0, 'skill':req['skill']}
        first = client.post(route + '/context-step', json=step)
        assert first.status_code == 200, first.text
        one = first.json(); assert not one['done']
        assert one['project']['_aiStorySummary'] == 'نام: جان'
        assert one['project']['images'][0]['blocks'][0]['tr'] == one['project']['images'][1]['blocks'][0]['tr'] == 'ترجمه'
        assert client.post(route + '/context-step', json=step).status_code == 409
        resume = client.post(route + '/context-preview', json={**req, 'resume':True, 'summary':'نام: جان'})
        assert resume.status_code == 200, resume.text
        assert 'نام: جان' in resume.json()['requests'][0]['text']
        second = client.post(route + '/context-step', json={**step, 'completed':1})
        assert second.status_code == 200, second.text
        two = second.json(); assert two['done'] and two['project']['_aiStorySummary'] == 'جان به خانه رفت'
        assert all(n <= 1000 for _, _, n, _ in captured)
        assert 'Context:' not in captured[0][1] and 'نام: جان' in captured[1][1]
        assert captured[0][3] == ['repeated title', 'page 0'] and captured[1][3] == ['page 1']


def test_oversized_source_still_returns_editable_budget_preview(tmp_path, monkeypatch):
    monkeypatch.setenv('COMIC_STUDIO_DATA', str(tmp_path))
    with scoped_client(create_app()) as client:
        route, project = make_project(client)
        project['images'][0]['blocks'][0]['text'] = 'x' * 715
        client.put(route + '/state', json={'state': project})
        client.put('/api/ai-settings', json={'provider':'openai','context_percent':15,'skill_percent':15,
                                             'providers':{'openai':{'profiles':[{'id':'main','api_key':'key','source_limit':900}]}}})
        req = {'image_ids':[project['images'][0]['id']], 'provider':'openai', 'skill':'ترجمه روان', 'summary':''}
        response = client.post(route + '/context-preview', json=req)
        assert response.status_code == 200, response.text
        preview = response.json()
        assert preview['previewError'] and not preview['requests']
        assert preview['skill'] == req['skill'] and preview['summary'] == ''
        assert preview['totalLimit'] == 900 and preview['skillPercent'] == 15 and preview['contextPercent'] == 15


def test_rejects_stale_skill_and_changed_blocks_before_send(tmp_path, monkeypatch):
    monkeypatch.setenv('COMIC_STUDIO_DATA', str(tmp_path))
    called = []
    monkeypatch.setattr(TranslationService, 'translate_context', lambda *args: called.append(args) or ('ok','summary'))
    with scoped_client(create_app()) as client:
        route, project = make_project(client)
        client.put('/api/ai-settings', json={'provider':'openai','api_key':'key'})
        req = {'image_ids':[i['id'] for i in project['images']], 'provider':'openai', 'skill':'a'*151, 'summary':''}
        assert client.post(route + '/context-preview', json=req).status_code == 502
        req['skill'] = 'ok'
        preview = client.post(route + '/context-preview', json=req).json()
        started = client.post(route + '/context-start', json={**req, 'confirmation':preview['signature']}).json()
        stored = client.get(route).json(); stored['images'][0]['blocks'][0]['tr'] = 'changed'
        client.put(route + '/state', json={'state':stored})
        result = client.post(route + '/context-step', json={'run_id':started['runId'], 'completed':0, 'skill':'ok'})
        assert result.status_code == 409 and not called


def test_actual_openai_and_gemini_payload_are_bounded_and_summary_is_validated(tmp_path, monkeypatch):
    import httpx
    from comic_studio.context_budget import ContextBudget, build_context_request
    from comic_studio.context_run import provider_policy
    from comic_studio.translation import TranslationError
    monkeypatch.setenv('COMIC_STUDIO_DATA', str(tmp_path))
    service = TranslationService()
    captured = []
    response_summary = ['one']
    def fake_post(url, **kwargs):
        captured.append((url, kwargs))
        content = json.dumps({'translation':'سلام', 'summary':response_summary[0]}, ensure_ascii=False)
        payload = {'candidates':[{'content':{'parts':[{'text':content}]}}]} if ':generateContent' in url else {'choices':[{'message':{'content':content}}]}
        return httpx.Response(200, json=payload, request=httpx.Request('POST', url))
    monkeypatch.setattr(httpx, 'post', fake_post)
    for provider in ('openai', 'gemini'):
        public = service.save_settings({'provider':provider, 'api_key':'key'})
        plan = build_context_request(ContextBudget(1000), 'English', 'brief', 'before')
        assert service.translate_context(plan, 'hello', ['hello'], provider, provider_policy(public, provider)) == ('سلام','one')
        data = captured[-1][1]['json']
        if provider == 'gemini':
            system = data['systemInstruction']['parts'][0]['text']; user = data['contents'][0]['parts'][0]['text']
        else:
            system, user = [entry['content'] for entry in data['messages']]
        assert system == plan.system and user == plan.user_message('hello') and len(system) + len(user) <= 1000
        assert 'before' in user
    response_summary[0] = 'x' * 151
    import pytest
    with pytest.raises(TranslationError, match='خلاصه'):
        service.translate_context(plan, 'hello', ['hello'], 'gemini', provider_policy(public, 'gemini'))


def test_long_block_resume_recalculates_actual_capacity_and_retains_old_until_complete(tmp_path, monkeypatch):
    monkeypatch.setenv('COMIC_STUDIO_DATA', str(tmp_path))
    captured = []
    def fake(self, request, text, sources, provider, policy):
        captured.append((request.source_capacity, text, request.user_prefix))
        return 'ترجمه' + str(len(captured)), 'x' * (60 if len(captured) == 1 else 5)
    monkeypatch.setattr(TranslationService, 'translate_context', fake)
    with scoped_client(create_app()) as client:
        route, project = make_project(client)
        project['images'][0]['blocks'] = [{'id':1, 'text':('A'*400)+'.\n'+('B'*400)+'.\n'+('C'*400)+'.', 'tr':'old', 'enabled':True}]
        project['images'][1]['blocks'] = []
        client.put(route + '/state', json={'state':project})
        client.put('/api/ai-settings', json={'provider':'openai','api_key':'key'})
        req = {'image_ids':[i['id'] for i in project['images']], 'provider':'openai', 'skill':'x', 'summary':''}
        p = client.post(route + '/context-preview', json=req); assert p.status_code == 200, p.text
        start = client.post(route + '/context-start', json={**req, 'confirmation':p.json()['signature']}).json()
        for n in range(3):
            result = client.post(route + '/context-step', json={'run_id':start['runId'], 'completed':n, 'skill':'x'})
            assert result.status_code == 200, result.text
            state = result.json()['project']; block = state['images'][0]['blocks'][0]
            if n < 2: assert block['tr'] == 'old'
        assert result.json()['done']
        assert block['tr'] == 'ترجمه1\nترجمه2\nترجمه3'
        assert captured[0][0] > captured[1][0] and captured[2][0] > captured[1][0]
        assert all(len(text) <= capacity for capacity, text, _ in captured)


def test_bad_summary_does_not_commit_and_retry_resumes_same_payload(tmp_path, monkeypatch):
    import httpx
    monkeypatch.setenv('COMIC_STUDIO_DATA', str(tmp_path))
    responses = [json.dumps({'translation':'اول\nدوم', 'summary':'x'*151}), json.dumps({'translation':'اول\nدوم', 'summary':'کوتاه'})]
    sent = []
    def fake_post(url, **kwargs):
        sent.append(kwargs['json']['messages'])
        return httpx.Response(200, json={'choices':[{'message':{'content':responses.pop(0)}}]}, request=httpx.Request('POST',url))
    monkeypatch.setattr(httpx, 'post', fake_post)
    with scoped_client(create_app()) as client:
        route, project = make_project(client)
        client.put('/api/ai-settings', json={'provider':'openai','api_key':'secret'})
        req = {'image_ids':[i['id'] for i in project['images']], 'provider':'openai', 'skill':'کوتاه', 'summary':''}
        preview = client.post(route + '/context-preview',json=req).json()
        start = client.post(route + '/context-start',json={**req,'confirmation':preview['signature']}).json()
        step = {'run_id':start['runId'],'completed':0,'skill':req['skill']}
        before = client.get(route).json()
        failed = client.post(route + '/context-step',json=step)
        assert failed.status_code == 422 and 'خلاصه' in failed.text
        assert client.get(route).json() == before
        good = client.post(route + '/context-step',json=step)
        assert good.status_code == 200, good.text
        assert len(sent) == 2 and sent[0] == sent[1]
        assert good.json()['project']['_aiStorySummary'] == 'کوتاه'


def test_resume_can_edit_summary_and_budget_without_resending_successes(tmp_path, monkeypatch):
    monkeypatch.setenv('COMIC_STUDIO_DATA', str(tmp_path))
    seen = []
    def fake(self, request, text, sources, provider, policy):
        seen.append((text, request.user_prefix, request.system))
        return '\n'.join('متن' for _ in text.split('\n')), 'خلاصه'
    monkeypatch.setattr(TranslationService, 'translate_context', fake)
    with scoped_client(create_app()) as client:
        route, project = make_project(client)
        client.put('/api/ai-settings', json={'provider':'openai','api_key':'key'})
        req = {'image_ids':[i['id'] for i in project['images']], 'provider':'openai', 'skill':'x', 'summary':''}
        preview = client.post(route+'/context-preview',json=req).json()
        start = client.post(route+'/context-start',json={**req,'confirmation':preview['signature']}).json()
        first = client.post(route+'/context-step',json={'run_id':start['runId'],'completed':0,'skill':'x'})
        assert first.status_code == 200
        client.put('/api/ai-settings', json={'provider':'openai','context_percent':20,'skill_percent':10})
        resumed = {**req,'resume':True,'skill':'راهنمای تازه','summary':'خلاصهٔ اصلاح‌شده'}
        second_preview = client.post(route+'/context-preview',json=resumed)
        assert second_preview.status_code == 200, second_preview.text
        assert 'خلاصهٔ اصلاح‌شده' in second_preview.json()['requests'][0]['text']
        restarted = client.post(route+'/context-start',json={**resumed,'confirmation':second_preview.json()['signature']})
        assert restarted.status_code == 200, restarted.text
        result = client.post(route+'/context-step',json={'run_id':start['runId'],'completed':1,'skill':'راهنمای تازه'})
        assert result.status_code == 200 and result.json()['done']
        assert len(seen) == 2 and 'page 0' in seen[0][0] and 'page 1' in seen[1][0]
        assert 'خلاصهٔ اصلاح‌شده' in seen[1][1] and 'راهنمای تازه' in seen[1][2]


def test_preflight_checks_later_unbreakable_line_before_any_send(tmp_path, monkeypatch):
    monkeypatch.setenv('COMIC_STUDIO_DATA', str(tmp_path))
    seen = []
    monkeypatch.setattr(TranslationService, 'translate_context', lambda *a: seen.append(a))
    with scoped_client(create_app()) as client:
        route, project = make_project(client)
        project['images'][1]['blocks'][0]['text'] = 'x'*999
        client.put(route+'/state',json={'state':project})
        client.put('/api/ai-settings',json={'provider':'openai','api_key':'key'})
        result = client.post(route+'/context-preview',json={'image_ids':[i['id'] for i in project['images']], 'provider':'openai','skill':'', 'summary':''})
        assert result.status_code == 200 and not seen
        assert result.json()['previewError'] and not result.json()['requests']


def test_merged_ocr_boundaries_survive_repeated_dynamic_splitting(tmp_path, monkeypatch):
    monkeypatch.setenv('COMIC_STUDIO_DATA', str(tmp_path))
    seen = []
    def fake(self, request, text, sources, provider, policy):
        seen.append(text)
        return 'ترجمه', 'short'
    monkeypatch.setattr(TranslationService, 'translate_context', fake)
    with scoped_client(create_app()) as client:
        route, project = make_project(client)
        lines = [{'text':letter*400+'.'} for letter in 'ABC']
        project['images'][0]['blocks'] = [{'id':1,'text':' '.join(x['text'] for x in lines), 'sourceLines':lines,'tr':'old','enabled':True}]
        project['images'][1]['blocks'] = []
        client.put(route+'/state',json={'state':project})
        client.put('/api/ai-settings',json={'provider':'openai','api_key':'key'})
        req = {'image_ids':[i['id'] for i in project['images']], 'provider':'openai','skill':'x','summary':''}
        p = client.post(route+'/context-preview',json=req); assert p.status_code == 200, p.text
        start = client.post(route+'/context-start',json={**req,'confirmation':p.json()['signature']}).json()
        for n in range(3):
            r = client.post(route+'/context-step',json={'run_id':start['runId'],'completed':n,'skill':'x'})
            assert r.status_code == 200, r.text
        assert r.json()['done'] and seen == [x['text'] for x in lines]
        assert r.json()['project']['images'][0]['blocks'][0]['tr'] == 'ترجمه ترجمه ترجمه'


def test_context_backup_excludes_api_key_and_endpoint_and_resume_works(tmp_path, monkeypatch):
    import zipfile
    monkeypatch.setenv('COMIC_STUDIO_DATA', str(tmp_path))
    def fake(self, request, text, sources, provider, policy):
        return '\n'.join('متن' for _ in text.split('\n')), 'خلاصهٔ محفوظ'
    monkeypatch.setattr(TranslationService, 'translate_context', fake)
    with scoped_client(create_app()) as client:
        route, project = make_project(client)
        client.put('/api/ai-settings',json={'provider':'openai','api_key':'private-secret','base_url':'https://user:pass@local.test/v1'})
        req = {'image_ids':[i['id'] for i in project['images']], 'provider':'openai','skill':'روان','summary':''}
        p = client.post(route+'/context-preview',json=req).json()
        start = client.post(route+'/context-start',json={**req,'confirmation':p['signature']}).json()
        first = client.post(route+'/context-step',json={'run_id':start['runId'],'completed':0,'skill':'روان'}).json()['project']
        backup = client.post(route+'/backup',json={'expected_updated_at':first['updatedAt'],'drafts':[]})
        assert backup.status_code == 200, backup.text
        with zipfile.ZipFile(io.BytesIO(backup.content)) as z:
            data = z.read('project.json').decode()
            assert 'private-secret' not in data and 'user:pass@' not in data and 'روان' not in data
            assert 'خلاصهٔ محفوظ' in data
        restored = client.post('/api/projects/restore',files={'file':('backup.zip',backup.content,'application/zip')})
        assert restored.status_code == 201, restored.text
        new = restored.json()['project']; new_route = '/api/projects/' + new['id']
        resume = {**req,'resume':True,'summary':'خلاصهٔ محفوظ'}
        next_preview = client.post(new_route+'/context-preview',json=resume)
        assert next_preview.status_code == 200, next_preview.text
        re = client.post(new_route+'/context-start',json={**resume,'confirmation':next_preview.json()['signature']}).json()
        finished = client.post(new_route+'/context-step',json={'run_id':re['runId'],'completed':re['completed'],'skill':'روان'})
        assert finished.status_code == 200 and finished.json()['done']


def test_single_context_retranslation_does_not_mutate_project_memory(tmp_path, monkeypatch):
    monkeypatch.setenv('COMIC_STUDIO_DATA', str(tmp_path))
    seen = []
    def fake(self, request, text, sources, provider, policy):
        seen.append(request.user_prefix)
        return 'سلام', 'خلاصهٔ موقت'
    monkeypatch.setattr(TranslationService, 'translate_context', fake)
    with scoped_client(create_app()) as client:
        route, project = make_project(client)
        client.put('/api/ai-settings',json={'provider':'openai','api_key':'key'})
        req = {'text':'hello','provider':'openai','skill':'روان','summary':'جان'}
        p = client.post('/api/translate-text/context-preview',json=req)
        assert p.status_code == 200 and p.json()['singleContext']
        result = client.post('/api/translate-text/context',json={**req,'confirmation':p.json()['signature']})
        assert result.status_code == 200 and result.json()['text'] == 'سلام'
        assert 'جان' in seen[0] and '_aiStorySummary' not in client.get(route).json()


def test_legacy_partial_progress_requires_explicit_restart_confirmation(tmp_path, monkeypatch):
    monkeypatch.setenv('COMIC_STUDIO_DATA', str(tmp_path))
    with scoped_client(create_app()) as client:
        route, project = make_project(client)
        project['images'][0]['blocks'][0]['_aiTranslationParts'] = {'fingerprint':'old', 'parts':{'0':'partial'}}
        client.put(route+'/state', json={'state':project})
        client.put('/api/ai-settings',json={'provider':'openai','api_key':'key'})
        req = {'image_ids':[i['id'] for i in project['images']], 'provider':'openai','skill':'x','summary':''}
        assert client.post(route+'/context-preview',json=req).status_code == 409
        assert client.get(route).json()['images'][0]['blocks'][0]['_aiTranslationParts']
        p = client.post(route+'/context-preview',json={**req,'restart_legacy':True})
        assert p.status_code == 200
        assert client.post(route+'/context-start',json={**req,'confirmation':p.json()['signature']}).status_code == 409
        started = client.post(route+'/context-start',json={**req,'restart_legacy':True,'confirmation':p.json()['signature']})
        assert started.status_code == 200
        assert '_aiTranslationParts' not in started.json()['project']['images'][0]['blocks'][0]


def test_percentage_settings_and_mixed_key_limits(tmp_path, monkeypatch):
    monkeypatch.setenv('COMIC_STUDIO_DATA', str(tmp_path))
    with scoped_client(create_app()) as client:
        route, project = make_project(client)
        settings = client.put('/api/ai-settings',json={'provider':'openai','context_percent':20,'skill_percent':10,'providers':{'openai':{'profiles':[{'id':'a','api_key':'one','source_limit':900},{'id':'b','api_key':'two','source_limit':800}]}}})
        assert settings.status_code == 200, settings.text
        assert client.get('/api/ai-settings').json()['context_percent'] == 20
        req = {'image_ids':[i['id'] for i in project['images']], 'provider':'openai', 'skill':'x', 'summary':''}
        preview = client.post(route+'/context-preview',json=req)
        assert preview.status_code == 200, preview.text
        p = preview.json(); assert (p['totalLimit'],p['contextLimit'],p['skillLimit']) == (800,160,80)
        assert p['requests'][0]['characters'] <= 800
        assert client.put('/api/ai-settings',json={'provider':'openai','context_percent':90,'skill_percent':20}).status_code == 400
        assert client.get('/api/ai-settings').json()['context_percent'] == 20


def test_dynamic_exact_payloads_are_visible_in_activity_without_headers(tmp_path, monkeypatch):
    monkeypatch.setenv('COMIC_STUDIO_DATA', str(tmp_path))
    monkeypatch.setattr(TranslationService, 'translate_context', lambda self, request, text, sources, provider, policy: ('\n'.join('متن' for _ in text.split('\n')), 'خلاصهٔ قبلی'))
    with scoped_client(create_app()) as client:
        route, project = make_project(client)
        client.put('/api/ai-settings',json={'provider':'openai','api_key':'private-key'})
        req = {'image_ids':[i['id'] for i in project['images']], 'provider':'openai','skill':'دستور','summary':''}
        p = client.post(route+'/context-preview',json=req).json()
        start = client.post(route+'/context-start',json={**req,'confirmation':p['signature']}).json()
        for count in range(2):
            assert client.post(route+'/context-step',json={'run_id':start['runId'],'completed':count,'skill':'دستور'}).status_code == 200
        entries = [e['message'] for e in client.get('/api/activity').json()['entries'] if 'متن دقیق درخواست' in e['message']]
        assert len(entries) == 2 and '\nContext:' not in entries[0] and 'خلاصهٔ قبلی' in entries[1]
        assert all('private-key' not in entry for entry in entries)


def test_old_preview_does_not_replace_newer_story_summary(tmp_path, monkeypatch):
    monkeypatch.setenv('COMIC_STUDIO_DATA', str(tmp_path))
    with scoped_client(create_app()) as client:
        route, project = make_project(client)
        client.put('/api/ai-settings',json={'provider':'openai','api_key':'key'})
        req = {'image_ids':[i['id'] for i in project['images']], 'provider':'openai','skill':'x','summary':''}
        old = client.post(route+'/context-preview',json=req).json()
        other = {**req,'summary':'خلاصهٔ جدید'}
        fresh = client.post(route+'/context-preview',json=other).json()
        assert client.post(route+'/context-start',json={**other,'confirmation':fresh['signature']}).status_code == 200
        stale = client.post(route+'/context-start',json={**req,'confirmation':old['signature']})
        assert stale.status_code == 409
        assert client.get(route).json()['_aiStorySummary'] == 'خلاصهٔ جدید'


def _pending_setup(client):
    route, project = make_project(client)
    client.put('/api/ai-settings', json={'provider':'openai','api_key':'key'})
    req = {'image_ids':[i['id'] for i in project['images']], 'provider':'openai', 'skill':'ok', 'summary':'before', 'reuse_repeated':True}
    preview = client.post(route + '/context-preview', json=req).json()
    started = client.post(route + '/context-start', json={**req, 'confirmation':preview['signature']}).json()
    return route, project, {'run_id':started['runId'], 'completed':0, 'skill':'ok'}


def test_context_unrelated_edit_is_merged_without_second_call(tmp_path, monkeypatch):
    from comic_studio.store import ProjectStore
    monkeypatch.setenv('COMIC_STUDIO_DATA', str(tmp_path))
    calls = []
    with scoped_client(create_app()) as client:
        route, project, step = _pending_setup(client)
        def fake(self, request, text, sources, provider, policy):
            calls.append(text); other = ProjectStore(); state = other.get(project['id']); state['name'] = 'new name'; other.save(state)
            return '\n'.join('translated' for _ in sources), 'new summary'
        monkeypatch.setattr(TranslationService, 'translate_context', fake)
        response = client.post(route + '/context-step', json=step)
        assert response.status_code == 200, response.text
        assert response.json()['project']['name'] == 'new name'
        assert response.json()['project']['images'][0]['blocks'][0]['tr'] == 'translated'
        assert len(calls) == 1 and client.get(route+'/pending').json() == []


def test_context_conflicts_persist_restart_select_keep_and_apply(tmp_path, monkeypatch):
    import os
    from comic_studio.store import ProjectStore
    monkeypatch.setenv('COMIC_STUDIO_DATA', str(tmp_path))
    calls = []
    with scoped_client(create_app()) as client:
        route, project, step = _pending_setup(client)
        def fake(self, request, text, sources, provider, policy):
            calls.append(text); other = ProjectStore(); state = other.get(project['id'])
            state['images'][0]['blocks'][0]['tr'] = 'edited 1'
            state['images'][1]['blocks'][0]['tr'] = 'edited 2'
            other.save(state); return '\n'.join('generated' for _ in sources), 'new summary'
        monkeypatch.setattr(TranslationService, 'translate_context', fake)
        response = client.post(route + '/context-step', json=step)
        assert response.status_code == 409, response.text
        token = response.json()['pending_id']
        assert client.post(route + '/context-step', json=step).json()['pending_id'] == token
        assert len(calls) == 1
        path = tmp_path/'projects'/project['id']/'.pending-results'/f'{token}.json'
        assert path.exists()
        if os.name == 'posix':
            assert path.stat().st_mode & 0o777 == 0o600
            assert path.parent.stat().st_mode & 0o777 == 0o700
    with scoped_client(create_app()) as restarted:
        assert restarted.get(route+'/pending').json()[0]['id'] == token
        view = restarted.get(route+'/pending/'+token).json()
        conflicts = [r for r in view['rows'] if r['conflict']]
        assert len(conflicts) == 2
        choices = {conflicts[0]['key']:'keep', conflicts[1]['key']:'apply'}
        old_revision = view['revision']
        state = restarted.get(route).json(); state['name'] = 'more recent edit'
        assert restarted.put(route+'/state', json={'state':state}).status_code == 200
        assert restarted.post(route+'/pending/'+token+'/resolve', json={'revision':old_revision,'choices':choices}).status_code == 409
        view = restarted.get(route+'/pending/'+token).json()
        result = restarted.post(route+'/pending/'+token+'/resolve', json={'revision':view['revision'],'choices':choices})
        assert result.status_code == 200, result.text
        state = result.json()['project']
        assert state['name'] == 'more recent edit'
        assert state['images'][0]['blocks'][0]['tr'] == 'edited 1'
        assert state['images'][1]['blocks'][0]['tr'] == 'generated'
        assert state['_aiStorySummary'] == 'before'
        assert restarted.get(route+'/pending').json() == [] and not path.exists()
        assert restarted.post(route+'/pending/'+token+'/resolve', json={'revision':view['revision'],'choices':choices}).status_code == 404
        assert len(calls) == 1


def test_paid_response_storage_failure_is_exposed_without_retry(tmp_path, monkeypatch):
    from comic_studio import pending_results
    monkeypatch.setenv('COMIC_STUDIO_DATA', str(tmp_path))
    calls = []
    monkeypatch.setattr(TranslationService, 'translate_context', lambda *a: calls.append(1) or ('result to copy', 'summary'))
    with scoped_client(create_app()) as client:
        route, project, step = _pending_setup(client)
        monkeypatch.setattr(pending_results, 'stage', lambda *a, **kw: (_ for _ in ()).throw(OSError('disk full')))
        response = client.post(route+'/context-step', json=step)
        assert response.status_code == 507 and response.json()['translation'] == 'result to copy'
        assert response.headers['cache-control'] == 'no-store' and calls == [1]
        assert client.get(route).json()['_aiContextRun']['completed'] == 0


def test_commit_before_cleanup_never_reapplies_or_resends(tmp_path, monkeypatch):
    from comic_studio import pending_results
    monkeypatch.setenv('COMIC_STUDIO_DATA', str(tmp_path))
    calls = []
    monkeypatch.setattr(TranslationService, 'translate_context', lambda self, request, text, sources, *a: calls.append(1) or ('\n'.join('done' for _ in sources), 'summary'))
    with scoped_client(create_app()) as client:
        route, project, step = _pending_setup(client)
        original_remove = pending_results.remove
        monkeypatch.setattr(pending_results, 'remove', lambda *a: (_ for _ in ()).throw(OSError('crash after commit')))
        import pytest
        with pytest.raises(OSError): client.post(route+'/context-step', json=step)
        monkeypatch.setattr(pending_results, 'remove', original_remove)
        assert client.get(route).json()['_aiContextRun']['completed'] == 1
        files = list((tmp_path/'projects'/project['id']/'.pending-results').glob('*.json'))
        assert len(files) == 1
        assert client.get(route+'/pending/'+files[0].stem).status_code == 404
        assert client.get(route+'/pending').json() == []
        assert client.post(route+'/context-step', json=step).status_code == 409
        assert calls == [1]


def test_simultaneous_same_context_step_only_calls_provider_once(tmp_path, monkeypatch):
    import threading
    from concurrent.futures import ThreadPoolExecutor
    monkeypatch.setenv('COMIC_STUDIO_DATA', str(tmp_path))
    entered = threading.Event(); release = threading.Event(); calls = []
    def fake(self, request, text, sources, *args):
        calls.append(1); entered.set(); assert release.wait(10)
        return '\n'.join('done' for _ in sources), 'summary'
    monkeypatch.setattr(TranslationService, 'translate_context', fake)
    with scoped_client(create_app()) as client, ThreadPoolExecutor(max_workers=2) as pool:
        route, project, step = _pending_setup(client)
        first = pool.submit(client.post, route+'/context-step', json=step)
        assert entered.wait(10)
        second = pool.submit(client.post, route+'/context-step', json=step)
        release.set()
        assert first.result(timeout=10).status_code == 200
        assert second.result(timeout=10).status_code == 409
        assert calls == [1]
