from __future__ import annotations

import base64
import concurrent.futures
import json
import os
import stat

import pytest
from support_client import scoped_client

from comic_studio.main import create_app
from comic_studio import store as store_module
from comic_studio.store import atomic_json


def auth(username, password):
    return 'Basic ' + base64.b64encode(f'{username}:{password}'.encode()).decode()


def test_remote_is_denied_without_password_even_for_static_and_settings(tmp_path, monkeypatch):
    monkeypatch.setenv('COMIC_STUDIO_DATA', str(tmp_path))
    monkeypatch.delenv('COMIC_STUDIO_ACCESS_PASSWORD', raising=False)
    app = create_app()
    with scoped_client(app, peer=('127.0.0.1', 1234)) as local:
        assert local.get('/api/health').status_code == 200
        assert local.get('/').status_code == 200
    with scoped_client(app, peer=('192.0.2.10', 1234)) as remote:
        for method, path in [('GET','/'), ('GET','/api/health'), ('GET','/api/ai-settings'), ('POST','/api/projects')]:
            r = remote.request(method, path, json={'name':'forbidden'})
            assert r.status_code == 403 and 'Remote access is disabled' in r.text
    with scoped_client(app, peer=('::ffff:127.0.0.1', 1234)) as local_v6:
        assert local_v6.get('/api/health').status_code == 200


def test_password_protects_every_client_and_unknown_clients(tmp_path, monkeypatch):
    monkeypatch.setenv('COMIC_STUDIO_DATA', str(tmp_path))
    password = 'a-random-and-long-example-password'
    monkeypatch.setenv('COMIC_STUDIO_ACCESS_PASSWORD', password)
    app = create_app()
    for peer in [('127.0.0.1',1), ('192.0.2.3',2), ('testclient',3)]:
        with scoped_client(app, peer=peer) as client:
            for header in ['', 'Basic !invalid', auth('wrong', password), auth('comic', 'wrong')]:
                result=client.get('/api/ai-settings',headers={'Authorization':header})
                assert result.status_code == 401 and result.headers['www-authenticate'].startswith('Basic')
                assert password not in result.text
            assert client.get('/',headers={'Authorization':auth('comic',password)}).status_code == 200
            assert client.get('/api/health',headers={'Authorization':auth('comic',password)}).status_code == 200
    monkeypatch.setenv('COMIC_STUDIO_ACCESS_PASSWORD','short')
    with scoped_client(app, peer=('127.0.0.1',1)) as client:
        assert client.get('/api/health').status_code == 503


def test_origin_checks_deny_foreign_mutation_not_same_origin_or_cli(tmp_path, monkeypatch):
    monkeypatch.setenv('COMIC_STUDIO_DATA',str(tmp_path))
    monkeypatch.delenv('COMIC_STUDIO_ACCESS_PASSWORD',raising=False)
    with scoped_client(create_app(), peer=('127.0.0.1',1)) as client:
        for origin in ('https://evil.example', 'null', 'http://testserver.evil.example', 'https://127.0.0.1', 'http://user@127.0.0.1'):
            r=client.post('/api/projects', json={'name':'bad'}, headers={'Origin':origin})
            assert r.status_code == 403, (origin,r.text)
        assert client.post('/api/projects',json={'name':'ok'},headers={'Origin':'http://127.0.0.1'}).status_code == 201
        assert client.post('/api/projects',json={'name':'local cli'}).status_code == 201


def test_atomic_file_is_private_during_write_and_after_replacement(tmp_path, monkeypatch):
    if os.name != 'posix': pytest.skip('POSIX mode bits are not equivalent to Windows ACLs')
    path=tmp_path/'settings.json'; path.write_text('old')
    old_replace=os.replace; observed=[]
    def inspect_replace(source, dest):
        observed.append((stat.S_IMODE(os.stat(source).st_mode), json.loads(open(source,encoding='utf-8').read())))
        old_replace(source,dest)
    monkeypatch.setattr(os,'replace',inspect_replace)
    atomic_json(path, {'api_key':'secret'})
    assert observed == [(0o600, {'api_key':'secret'})]
    assert stat.S_IMODE(path.stat().st_mode)==0o600
    assert json.loads(path.read_text()) == {'api_key':'secret'}
    assert list(tmp_path.glob('*.tmp')) == []


def test_windows_replace_retries_transient_access_denied(tmp_path, monkeypatch):
    source = tmp_path / '.project.json.test.tmp'
    destination = tmp_path / 'project.json'
    source.write_text('{"updated": true}')
    real_replace = os.replace
    attempts = 0

    def intermittently_locked(src, dst):
        nonlocal attempts
        attempts += 1
        if attempts < 3:
            raise PermissionError(5, 'Access is denied')
        real_replace(src, dst)

    monkeypatch.setattr(os, 'replace', intermittently_locked)
    monkeypatch.setattr(store_module.time, 'sleep', lambda _delay: None)
    store_module._replace_with_retry(source, destination, windows=True)
    assert attempts == 3
    assert json.loads(destination.read_text()) == {'updated': True}
    assert not source.exists()


def test_atomic_json_failure_and_concurrent_writes_never_leave_temp_files(tmp_path, monkeypatch):
    path=tmp_path/'settings.json'; path.write_text('{"old": true}')
    real_replace=os.replace
    def fail(*args): raise OSError('failed replace')
    monkeypatch.setattr(os,'replace',fail)
    with pytest.raises(OSError): atomic_json(path, {'api_key':'secret'})
    assert json.loads(path.read_text()) == {'old':True}
    assert list(tmp_path.iterdir()) == [path]
    monkeypatch.setattr(os,'replace',real_replace)
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(lambda i: atomic_json(path, {'value':i}), range(40)))
    assert json.loads(path.read_text())['value'] in range(40)
    assert list(tmp_path.iterdir()) == [path]


def test_loopback_host_blocks_dns_rebinding_and_allows_named_localhost(tmp_path, monkeypatch):
    monkeypatch.setenv('COMIC_STUDIO_DATA', str(tmp_path))
    monkeypatch.delenv('COMIC_STUDIO_ACCESS_PASSWORD', raising=False)
    with scoped_client(create_app(), peer=('127.0.0.1',1)) as client:
        for host in ('evil.example:8765', 'localhost.evil.example', 'user@127.0.0.1', 'localhost:bad'):
            assert client.get('/api/health',headers={'Host':host}).status_code == 403
        assert client.get('/api/health',headers={'Host':'localhost:8765'}).status_code == 200
        assert client.get('/api/health',headers={'Host':'[::1]:8765'}).status_code == 200


def test_authenticated_preview_hostname_and_same_origin_work(tmp_path, monkeypatch):
    monkeypatch.setenv('COMIC_STUDIO_DATA',str(tmp_path))
    password='preview-long-password-do-not-use'
    monkeypatch.setenv('COMIC_STUDIO_ACCESS_PASSWORD',password)
    # Real preview hosts are external hostnames; configured authentication
    # deliberately permits them while still enforcing matching Origin.
    with scoped_client(create_app(),base_url='https://8765-example.e2b.app',peer=('192.0.2.42',1)) as client:
        headers={'Authorization':auth('comic',password),'Origin':'https://8765-example.e2b.app'}
        assert client.get('/',headers=headers).status_code == 200
        assert client.post('/api/projects',json={'name':'test'},headers=headers).status_code == 201
        assert client.post('/api/projects',json={'name':'bad'},headers={**headers,'Origin':'https://attacker.example'}).status_code == 403


def test_existing_settings_and_legacy_temp_are_hardened_without_following_symlink(tmp_path, monkeypatch):
    if os.name != 'posix' or not hasattr(os, 'O_NOFOLLOW'):
        pytest.skip('Requires POSIX mode bits and O_NOFOLLOW')
    from comic_studio.translation import TranslationService
    monkeypatch.setenv('COMIC_STUDIO_DATA',str(tmp_path))
    existing=tmp_path/'ai-settings.json'; existing.write_text('{"api_key":"old"}'); existing.chmod(0o644)
    legacy=tmp_path/'ai-settings.json.tmp'; legacy.write_text('{"api_key":"temp"}'); legacy.chmod(0o644)
    TranslationService()
    assert stat.S_IMODE(existing.stat().st_mode) == 0o600
    assert stat.S_IMODE(legacy.stat().st_mode) == 0o600
    assert json.loads(existing.read_text())['api_key'] == 'old'
    target=tmp_path/'another-file'; target.write_text('other'); target.chmod(0o644)
    legacy.unlink(); legacy.symlink_to(target)
    TranslationService()
    assert stat.S_IMODE(target.stat().st_mode) == 0o644
    assert legacy.is_symlink()
