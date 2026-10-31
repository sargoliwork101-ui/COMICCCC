import httpx
import pytest
from support_client import scoped_client
from comic_studio.main import create_app
from comic_studio.translation import TranslationService, TranslationError
from test_context_run import make_project


def test_free_page_packs_small_blocks_without_crossing_page(tmp_path, monkeypatch):
    monkeypatch.setenv('COMIC_STUDIO_DATA', str(tmp_path))
    seen = []
    def fake(self, request, text, sources, language, policy):
        seen.append((text, sources))
        return '\n'.join('ترجمه' for _ in text.split('\n'))
    monkeypatch.setattr(TranslationService, 'translate_free_batch', fake)
    with scoped_client(create_app()) as client:
        route, project = make_project(client)
        for i, image in enumerate(project['images']):
            image['blocks'] = [{'id': n, 'text': text, 'tr':'old','enabled':True} for n, text in enumerate([str(i)*300,'ABCD','Z'*100,'Y'*120])]
        client.put(route+'/state',json={'state':project})
        req = {'image_ids':[i['id'] for i in project['images']], 'provider':'free','skill':'','summary':'','reuse_repeated':False}
        p = client.post(route+'/context-preview', json=req); assert p.status_code == 200, p.text
        assert 'ABCD' in p.json()['requests'][0]['text'] and len(p.json()['requests'][0]['text']) > 4
        shown = p.json()['requests'][0]['text']
        assert p.json()['budget']['sourceChars'] == len(shown)
        assert p.json()['budget']['sourceBytes'] == len(shown.encode('utf-8')) and p.json()['budget']['byteLimit'] == 500
        start = client.post(route+'/context-start',json={**req,'confirmation':p.json()['signature']}).json()
        done = False; n = 0
        while not done:
            r = client.post(route+'/context-step',json={'run_id':start['runId'],'completed':n,'skill':''})
            assert r.status_code == 200, r.text
            done = r.json()['done']; n += 1
        assert len(seen) == 4 and all(text != 'ABCD' for text,_ in seen)
        assert all(len(text) <= 500 and len(text.encode()) <= 500 for text,_ in seen)
        assert all(not ('0'*300 in text and '1'*300 in text) for text,_ in seen)


def test_ai_short_bubble_combines_with_safe_prefix_of_next_bubble():
    from comic_studio.context_run import create_run, next_request
    from comic_studio.context_budget import ContextBudget, build_context_request
    import copy
    base = build_context_request(ContextBudget(1000), 'English', '', '')
    line = 'A' * (base.source_capacity - 20) + '.'
    state = {'images':[{'id':'p','order':0,'blocks':[{'id':1,'text':'Hey!'}, {'id':2,'text':line+'\n'+'B'*50+'.'}]}]}
    run = create_run(copy.deepcopy(state), ['p'], 'openai','eng','','',1000,15,15,False,{})
    request, chosen = next_request(run, '')
    assert [entry['text'] for entry in chosen] == ['Hey!',line]
    assert request.fits('Hey!\n'+line)


def test_free_provider_retry_then_fallback_and_500_byte_constraint(tmp_path, monkeypatch):
    from comic_studio.context_budget import FreeRequest
    from comic_studio.context_run import provider_policy
    monkeypatch.setenv('COMIC_STUDIO_DATA',str(tmp_path))
    service = TranslationService()
    settings = service.save_settings({'provider':'free','free_services':{'google':{'retry_count':1,'retry_wait_seconds':0}, 'mymemory':{'retry_count':1,'retry_wait_seconds':0}}})
    calls = []
    class FakeClient:
        def __init__(self, **kwargs): self.timeout=kwargs['timeout']
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def get(self,url,params):
            calls.append((url,params,self.timeout))
            if 'googleapis' in url:
                return httpx.Response(503,json={'error':'google unavailable'},request=httpx.Request('GET',url))
            return httpx.Response(200,json={'responseStatus':200,'responseData':{'translatedText':'سلام'}},request=httpx.Request('GET',url))
    monkeypatch.setattr(httpx, 'Client',FakeClient)
    req = FreeRequest(500)
    assert service.translate_free_batch(req,'hello',['hello'],'eng',provider_policy(settings,'free')) == 'سلام'
    assert len(calls)==3 and [x[2] for x in calls] == [90,90,90]
    with pytest.raises(TranslationError):
        service.translate_free_batch(req,'آ'*251,['آ'*251],'eng',provider_policy(settings,'free'))
    assert len(calls)==3


def test_free_mymemory_http_200_error_is_not_accepted(tmp_path, monkeypatch):
    from comic_studio.context_budget import FreeRequest
    from comic_studio.context_run import provider_policy
    monkeypatch.setenv('COMIC_STUDIO_DATA',str(tmp_path))
    service=TranslationService(); settings=service.save_settings({'provider':'free','free_services':{'google':{'retry_wait_seconds':0},'mymemory':{'retry_wait_seconds':0}}})
    class FakeClient:
        def __init__(self,**kwargs): pass
        def __enter__(self): return self
        def __exit__(self,*a): pass
        def get(self,url,params):
            if 'googleapis' in url: return httpx.Response(403,json={},request=httpx.Request('GET',url))
            return httpx.Response(200,json={'responseStatus':429,'responseDetails':'quota exceeded','responseData':{'translatedText':'not valid'}},request=httpx.Request('GET',url))
    monkeypatch.setattr(httpx,'Client',FakeClient)
    with pytest.raises(TranslationError,match='quota exceeded'):
        service.translate_free_batch(FreeRequest(500),'hello',['hello'],'eng',provider_policy(settings,'free'))


def test_free_resume_preserves_success_and_requires_restart_consent(tmp_path, monkeypatch):
    monkeypatch.setenv('COMIC_STUDIO_DATA', str(tmp_path))
    calls = []
    def fake(self, request, text, sources, language, policy):
        calls.append(text)
        if text == 'SECOND' and calls.count('SECOND') == 1:
            raise TranslationError('service failure')
        return 'ترجمه ' + text
    monkeypatch.setattr(TranslationService, 'translate_free_batch', fake)
    with scoped_client(create_app()) as client:
        route, project = make_project(client)
        for image, text in zip(project['images'], ['FIRST', 'SECOND']):
            image['blocks'] = [{'id':1,'text':text,'tr':'old','enabled':True}]
        client.put(route+'/state',json={'state':project})
        from comic_studio.store import ProjectStore
        store = ProjectStore(); current = store.get(project['id']); current['_aiStorySummary'] = 'خلاصهٔ قبلی AI'; store.save(current)
        req = {'image_ids':[i['id'] for i in project['images']], 'provider':'free','skill':'','summary':'','reuse_repeated':True}
        prev = client.post(route+'/context-preview',json=req).json()
        start = client.post(route+'/context-start',json={**req,'confirmation':prev['signature']}).json()
        step = lambda n: client.post(route+'/context-step',json={'run_id':start['runId'],'completed':n,'skill':''})
        assert step(0).status_code == 200
        assert step(1).status_code == 502
        saved = client.get(route).json()
        assert saved['images'][0]['blocks'][0]['tr'] == 'ترجمه FIRST'
        assert saved['images'][1]['blocks'][0]['tr'] == 'old'
        assert saved['_aiStorySummary'] == 'خلاصهٔ قبلی AI'
        assert client.post(route+'/context-preview',json=req).status_code == 409
        fresh = client.post(route+'/context-preview',json={**req,'restart_existing':True})
        assert fresh.status_code == 200
        resumed = client.post(route+'/context-preview',json={**req,'resume':True})
        assert resumed.status_code == 200
        restart = client.post(route+'/context-start',json={**req,'resume':True,'confirmation':resumed.json()['signature']}).json()
        assert restart['runId'] == start['runId'] and restart['completed'] == 1
        assert step(1).json()['done']
        assert calls == ['FIRST','SECOND','SECOND']


def test_utf8_limits_use_complete_lines_and_fail_before_sending(tmp_path, monkeypatch):
    monkeypatch.setenv('COMIC_STUDIO_DATA', str(tmp_path))
    calls = []
    monkeypatch.setattr(TranslationService,'translate_free_batch', lambda self, req, text, sources, lang, policy: calls.append(text) or 'ترجمه')
    with scoped_client(create_app()) as client:
        route, project = make_project(client)
        project['images'][0]['blocks'] = [{'id':1,'text':'漢'*167,'tr':'old','enabled':True}]
        client.put(route+'/state',json={'state':project})
        req={'image_ids':[project['images'][0]['id']],'provider':'free','skill':'','summary':''}
        result=client.post(route+'/context-preview',json=req)
        assert result.status_code == 502 and calls == []
        project['images'][0]['blocks'][0]['text'] = '漢'*160 + '。\n' + '漢'*10
        client.put(route+'/state',json={'state':project})
        p=client.post(route+'/context-preview',json=req)
        assert p.status_code == 200 and len(p.json()['requests'][0]['text'].encode()) == 483
        start=client.post(route+'/context-start',json={**req,'confirmation':p.json()['signature']}).json()
        for n in range(2):
            r=client.post(route+'/context-step',json={'run_id':start['runId'],'completed':n,'skill':''})
            assert r.status_code==200, r.text
        assert r.json()['done'] and len(calls)==2 and all(len(q.encode())<=500 for q in calls)


def test_free_settings_are_independent_and_change_invalidates_confirmation(tmp_path, monkeypatch):
    monkeypatch.setenv('COMIC_STUDIO_DATA',str(tmp_path))
    calls=[]
    monkeypatch.setattr(TranslationService,'translate_free_batch', lambda *args: calls.append(args) or 'سلام')
    with scoped_client(create_app()) as client:
        route,project=make_project(client)
        project['images'][0]['blocks']=[{'id':1,'text':'hello','tr':'old','enabled':True}]
        client.put(route+'/state',json={'state':project})
        data={'provider':'free','free_services':{'google':{'source_limit':800,'retry_count':2,'retry_wait_seconds':1,'timeout_seconds':30},'mymemory':{'source_limit':200,'retry_count':1,'retry_wait_seconds':2,'timeout_seconds':40}}}
        saved=client.put('/api/ai-settings',json=data)
        assert saved.status_code==200 and saved.json()['free_services']==data['free_services']
        req={'image_ids':[project['images'][0]['id']],'provider':'free','skill':'','summary':''}
        prev=client.post(route+'/context-preview',json=req).json()
        assert prev['totalLimit']==200
        assert client.put('/api/ai-settings',json={'provider':'free','free_services':{'google':{'retry_count':0}}}).status_code==200
        assert client.post(route+'/context-start',json={**req,'confirmation':prev['signature']}).status_code==409
        assert calls == []
        assert client.put('/api/ai-settings',json={'provider':'free','free_services':{'mymemory':{'timeout_seconds':4}}}).status_code==400


def test_free_invalid_line_mapping_retries_before_fallback(tmp_path, monkeypatch):
    from comic_studio.context_budget import FreeRequest
    from comic_studio.context_run import provider_policy
    monkeypatch.setenv('COMIC_STUDIO_DATA', str(tmp_path))
    service = TranslationService()
    settings = service.save_settings({'provider':'free','free_services':{'google':{'retry_count':1,'retry_wait_seconds':3,'timeout_seconds':25}, 'mymemory':{'retry_count':0,'timeout_seconds':40}}})
    calls=[]; waits=[]
    class FakeClient:
        def __init__(self, **kwargs): self.timeout=kwargs['timeout']
        def __enter__(self): return self
        def __exit__(self,*a): pass
        def get(self,url,params):
            calls.append((url,self.timeout,params['q']))
            data = [[['فقط یک خط']]] if 'googleapis' in url else {'responseStatus':200,'responseData':{'translatedText':'اول\nدوم'}}
            return httpx.Response(200,json=data,request=httpx.Request('GET',url))
    monkeypatch.setattr(httpx,'Client',FakeClient)
    monkeypatch.setattr('comic_studio.translation.time.sleep',lambda seconds: waits.append(seconds))
    assert service.translate_free_batch(FreeRequest(500),'one\ntwo',['one','two'],'eng',provider_policy(settings,'free')) == 'اول\nدوم'
    assert [c[1] for c in calls] == [25,25,40]
    assert all(c[2]=='one\ntwo' for c in calls)
    assert waits == [3,3]


def test_free_capacity_error_reports_multibyte_segment_and_location(tmp_path, monkeypatch):
    monkeypatch.setenv('COMIC_STUDIO_DATA', str(tmp_path))
    with scoped_client(create_app()) as client:
        route, project = make_project(client)
        project['images'][0]['blocks'] = [{'id':34, 'text':'آ'*251, 'enabled':True}]
        client.put(route+'/state', json={'state':project})
        result = client.post(route+'/context-preview', json={'image_ids':[project['images'][0]['id']], 'provider':'free', 'skill':'', 'summary':''})
        assert result.status_code == 502
        budget = result.json()['budget']
        assert budget['requiredSourceChars'] == 251 and budget['requiredSourceBytes'] == 502
        assert budget['byteLimit'] == 500 and budget['imageName'] == 'a.png' and budget['blockId'] == '34'
        assert budget['imageId'] == project['images'][0]['id']
