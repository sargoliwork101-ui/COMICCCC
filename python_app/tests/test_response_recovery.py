import json

import httpx
import pytest

from comic_studio.context_budget import ContextBudget, build_context_request, parse_context_response
from comic_studio.context_run import provider_policy
from comic_studio.main import create_app
from comic_studio.translation import InvalidContextResponse, TranslationError, TranslationService
from support_client import scoped_client
from test_context_run import make_project


def encoded(translation='سلام', summary='خلاصه'):
    return json.dumps({'translation': translation, 'summary': summary}, ensure_ascii=False)


@pytest.mark.parametrize('text', [
    encoded(), '```json\n' + encoded() + '\n```', '`````\n' + encoded() + '\n`````',
    'Here is the answer:\n' + encoded() + '\nDone.',
])
def test_parse_common_envelopes_without_model_request(text):
    assert parse_context_response(text, ['hello'], 100) == ('سلام', 'خلاصه')


@pytest.mark.parametrize('text', [
    encoded() + '\n' + encoded('دیگر'),
    encoded() + '\n{"translation":"partial"',
    '{"translation":"اول","translation":"دوم","summary":"خلاصه"}',
    'begin {"translation":"اول","translation":"دوم","summary":"خلاصه"} end',
    encoded(translation=''),
    '{' * 257, 'x' * 200001,
])
def test_reject_ambiguous_duplicate_or_invalid_response(text):
    with pytest.raises(TranslationError):
        parse_context_response(text, ['hello'], 100)


def configured(service, provider='openai', **extra):
    return service.save_settings({'provider':provider, 'providers':{provider:{'profiles':[
        {'id':'a','api_key':'key-a','retry_count':2,'retry_wait_seconds':0},
        {'id':'b','api_key':'key-b','retry_count':2,'retry_wait_seconds':0}], **extra}}})


def test_invalid_ai_output_uses_configured_retries_and_logs_each_retry(tmp_path, monkeypatch):
    monkeypatch.setenv('COMIC_STUDIO_DATA', str(tmp_path))
    service=TranslationService(); settings=configured(service)
    calls=[]; logs=[]; responses=['unusable private output', encoded('سلام','خلاصه')]
    def post(url, **kwargs):
        calls.append(kwargs)
        content=responses.pop(0)
        return httpx.Response(200,json={'choices':[{'message':{'content':content}}]},request=httpx.Request('POST',url))
    monkeypatch.setattr(httpx,'post',post)
    monkeypatch.setattr('comic_studio.translation.emit',lambda message,kind='info':logs.append((message,kind)))
    plan=build_context_request(ContextBudget(1000),'English','','')
    assert service.translate_context(plan,'hello',['hello'],'openai',provider_policy(settings,'openai')) == ('سلام','خلاصه')
    assert len(calls)==2
    assert all(call['headers']['Authorization']=='Bearer key-a' for call in calls)
    assert 'همان API دوباره امتحان می‌شود (1 از 2)' in logs[1][0] and 'ممکن است هزینه داشته باشد' in logs[1][0]
    assert all('unusable private output' not in message for message,_ in logs)
    assert calls[0]['json']['response_format']=={'type':'json_object'}


def test_provider_modes_preserve_compatibility_and_policy(tmp_path, monkeypatch):
    monkeypatch.setenv('COMIC_STUDIO_DATA',str(tmp_path)); service=TranslationService(); calls=[]
    def post(url, **kwargs):
        calls.append(kwargs['json'])
        value=encoded(); payload={'candidates':[{'content':{'parts':[{'text':value}]}}]} if ':generateContent' in url else {'choices':[{'message':{'content':value}}]}
        return httpx.Response(200,json=payload,request=httpx.Request('POST',url))
    monkeypatch.setattr(httpx,'post',post)
    plan=build_context_request(ContextBudget(1000),'English','','')
    for provider, opts in [('gemini',{}),('openai',{}),('openai',{'base_url':'http://localhost:1234/v1'}),('openrouter',{}),('openrouter',{'response_mode':'json'}),('gemini',{'response_mode':'text'})]:
        settings=configured(service,provider,**opts)
        assert service.translate_context(plan,'hello',['hello'],provider,provider_policy(settings,provider)) == ('سلام','خلاصه')
    assert calls[0]['generationConfig']['responseMimeType']=='application/json'
    assert calls[1]['response_format']=={'type':'json_object'}
    assert 'response_format' not in calls[2] and 'response_format' not in calls[3]
    assert calls[4]['response_format']=={'type':'json_object'}
    assert 'responseMimeType' not in calls[5]['generationConfig']
    assert settings['providers']['gemini']['response_mode']=='text'


def test_rejected_json_mode_does_not_switch_keys(tmp_path, monkeypatch):
    monkeypatch.setenv('COMIC_STUDIO_DATA',str(tmp_path)); service=TranslationService(); settings=configured(service)
    calls=[]
    def post(url, **kwargs):
        calls.append(1); return httpx.Response(400,json={'error':{'message':'unknown response_format'}},request=httpx.Request('POST',url))
    monkeypatch.setattr(httpx,'post',post)
    with pytest.raises(TranslationError, match='متن معمولی'):
        service.translate_context(build_context_request(ContextBudget(1000),'English','',''),'hello',['hello'],'openai',provider_policy(settings,'openai'))
    assert len(calls)==1


def test_project_response_can_be_repaired_locally_once(tmp_path, monkeypatch):
    monkeypatch.setenv('COMIC_STUDIO_DATA',str(tmp_path)); calls=[]
    raw=encoded('خصوصی یک\nخصوصی دو\nخط اضافی','x'*151)
    def post(url,**kwargs):
        calls.append(1)
        return httpx.Response(200,json={'choices':[{'message':{'content':raw}}]},request=httpx.Request('POST',url))
    monkeypatch.setattr(httpx,'post',post)
    with scoped_client(create_app()) as client:
        route,project=make_project(client)
        client.put('/api/ai-settings',json={'provider':'openai','providers':{'openai':{'profiles':[{'id':'a','api_key':'key','retry_count':0,'retry_wait_seconds':0},{'id':'b','api_key':'key2','retry_count':0,'retry_wait_seconds':0}]}}})
        req={'image_ids':[i['id'] for i in project['images']],'provider':'openai','skill':'','summary':''}
        preview=client.post(route+'/context-preview',json=req).json()
        start=client.post(route+'/context-start',json={**req,'confirmation':preview['signature']}).json()
        step={'run_id':start['runId'],'completed':0,'skill':''}
        before=client.get(route).json()
        failure=client.post(route+'/context-step',json=step)
        assert failure.status_code==422 and failure.headers['cache-control']=='no-store'
        error=failure.json(); assert error['response_text']==raw and error['recovery_token'] and len(calls)==1
        assert client.get(route).json()==before
        assert 'خصوصی یک' not in json.dumps(client.get('/api/activity').json(),ensure_ascii=False)
        repair={**step,'recovery_token':error['recovery_token'],'corrected_response':encoded('اول\nدوم','خلاصه')}
        invalid=client.post(route+'/context-step',json={**repair,'corrected_response':'{}'})
        assert invalid.status_code==422 and invalid.json()['recovery_token']==error['recovery_token'] and len(calls)==1
        good=client.post(route+'/context-step',json=repair)
        assert good.status_code==200, good.text
        assert good.json()['completed']==1 and good.json()['project']['images'][0]['blocks'][0]['tr']=='اول'
        assert len(calls)==1 and client.post(route+'/context-step',json=repair).status_code==409


def test_single_block_split_recovers_failed_part_without_resending_previous(tmp_path,monkeypatch):
    monkeypatch.setenv('COMIC_STUDIO_DATA',str(tmp_path)); calls=[]
    def post(url,**kwargs):
        calls.append(kwargs['json']['messages'][-1]['content'])
        value = encoded('اول', 'خلاصه') if len(calls)==1 else 'not JSON'
        return httpx.Response(200,json={'choices':[{'message':{'content':value}}]},request=httpx.Request('POST',url))
    monkeypatch.setattr(httpx,'post',post)
    with scoped_client(create_app()) as client:
        client.put('/api/ai-settings',json={'provider':'openai','providers':{'openai':{'profiles':[{'id':'a','api_key':'key','source_limit':500,'retry_count':0,'retry_wait_seconds':0}]}}})
        req={'text':'First '+ 'a'*53 + '.\nSecond '+ 'b'*53 + '.', 'provider':'openai','skill':'','summary':''}
        preview=client.post('/api/translate-text/context-preview',json=req)
        assert preview.status_code==200, preview.text
        payload={**req,'confirmation':preview.json()['signature']}
        failed=client.post('/api/translate-text/context',json=payload)
        assert failed.status_code==422,failed.text
        assert len(calls)==2
        repair={**payload,'recovery_token':failed.json()['recovery_token'],'corrected_response':encoded('دوم','خلاصه')}
        assert client.post('/api/translate-text/context',json={**repair,'text':'modified'}).status_code==409
        result=client.post('/api/translate-text/context',json=repair)
        assert result.status_code==200, result.text
        assert result.json()['text']=='اول\nدوم' and len(calls)==2
        assert client.post('/api/translate-text/context',json=repair).status_code==409


def test_project_repair_cannot_overwrite_edits_made_after_response(tmp_path, monkeypatch):
    monkeypatch.setenv('COMIC_STUDIO_DATA',str(tmp_path)); calls=[]
    def post(url,**kwargs):
        calls.append(1)
        return httpx.Response(200,json={'choices':[{'message':{'content':'not JSON'}}]},request=httpx.Request('POST',url))
    monkeypatch.setattr(httpx,'post',post)
    with scoped_client(create_app()) as client:
        route,project=make_project(client)
        client.put('/api/ai-settings',json={'provider':'openai','api_key':'key'})
        req={'image_ids':[item['id'] for item in project['images']],'provider':'openai','skill':'','summary':''}
        preview=client.post(route+'/context-preview',json=req).json()
        started=client.post(route+'/context-start',json={**req,'confirmation':preview['signature']}).json()
        step={'run_id':started['runId'],'completed':0,'skill':''}
        failed=client.post(route+'/context-step',json=step)
        current=client.get(route).json(); current['images'][0]['blocks'][0]['tr']='my edit'
        client.put(route+'/state',json={'state':current})
        result=client.post(route+'/context-step',json={**step,'recovery_token':failed.json()['recovery_token'],'corrected_response':encoded('اول\nدوم','خلاصه')})
        assert result.status_code==409 and len(calls)==1
        assert client.get(route).json()['images'][0]['blocks'][0]['tr']=='my edit'


def test_invalid_http_200_envelope_is_not_retried(tmp_path, monkeypatch):
    monkeypatch.setenv('COMIC_STUDIO_DATA',str(tmp_path)); service=TranslationService(); calls=[]
    settings=service.save_settings({'provider':'openai','providers':{'openai':{'profiles':[{'id':'a','api_key':'key','retry_count':0,'retry_wait_seconds':0}]}}})
    def post(url,**kwargs):
        calls.append(1)
        return httpx.Response(200,text='unparseable upstream result',request=httpx.Request('POST',url))
    monkeypatch.setattr(httpx,'post',post)
    with pytest.raises(InvalidContextResponse) as error:
        service.translate_context(build_context_request(ContextBudget(1000),'English','',''),'hello',['hello'],'openai',provider_policy(settings,'openai'))
    assert error.value.response_text=='unparseable upstream result' and len(calls)==1
