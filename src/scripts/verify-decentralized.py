"""Real HTTP, Matrix and registered-worker smoke test. No mocks or copied credentials in output."""
import argparse
import http.cookiejar
import json
import pathlib
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--url', required=True)
    p.add_argument('--matrix-url', required=True)
    p.add_argument('--owner-key', type=pathlib.Path, required=True)
    p.add_argument('--users', type=pathlib.Path, required=True, help='Private JSON mapping alice/bob to test passwords')
    p.add_argument('--runtime', required=True)
    p.add_argument('--workdir', required=True)
    p.add_argument('--output', type=pathlib.Path, required=True)
    args = p.parse_args()
    key = args.owner_key.read_text().strip()
    users = json.loads(args.users.read_text())
    owner = urllib.request.build_opener()
    owner_headers = {'Authorization': 'Bearer ' + key}

    def call(client, path, data=None, method=None, headers=None, expected=200):
        req = urllib.request.Request(args.url.rstrip('/')+'/api'+path,
            data=json.dumps(data).encode() if data is not None else None,
            method=method, headers={'Content-Type': 'application/json', **(headers or {})})
        try:
            with client.open(req, timeout=45) as response:
                status, result = response.status, json.load(response)
        except urllib.error.HTTPError as error:
            status, result = error.code, json.loads(error.read())
        assert status == expected, (path, status, result)
        return result

    def admin(path, data=None, method=None, expected=200):
        return call(owner, path, data, method, owner_headers, expected)

    call(owner, '/state', expected=401)
    call(owner, '/login', {'token': 'invalid'}, expected=401)
    proof = {'unauthenticated': 401, 'invalid_login': 401}
    tenant = admin('/tenants', {'name': 'Smoke '+uuid.uuid4().hex[:8]})
    admin('/tenants/'+tenant['id'], {'name': 'Renamed verification'}, 'PUT')
    admin('/tenants/'+tenant['id'], {}, 'DELETE')
    call(owner, '/state', headers={**owner_headers, 'x-ae-workspace': tenant['id']}, expected=403)
    admin('/tenants/'+tenant['id'], {'deleted': False}, 'PUT')
    fresh = call(owner, '/state', headers={**owner_headers, 'x-ae-workspace': tenant['id']})
    assert len(fresh['agents']) == 1 and len(fresh['groups']) == 1 and not fresh['runs']
    proof['workspace_crud'] = tenant['id']
    call(owner, '/harness/settings?ssh_host=localhost', headers={**owner_headers, 'x-ae-workspace':tenant['id']}, expected=400)
    proof['controller_catalog_isolation'] = 400
    denied = call(owner, '/agents/ceo/probe', {}, headers={**owner_headers, 'x-ae-workspace':tenant['id']}, expected=400)
    assert 'registered runtime' in denied['error']
    invalid = dict(fresh['agents'][0], workdir={'path':'/tmp','canonical_path':'/tmp','git_root':None,'ssh_host':'invalid!not-a-host'})
    denied = call(owner, '/agents/'+invalid['id'], invalid, 'PUT', {**owner_headers, 'x-ae-workspace':tenant['id']}, expected=400)
    assert 'registered runtime' in denied['error']
    clients = {}
    for name in ('alice', 'bob'):
        client = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        me = call(client, '/login', {'username': name, 'password': users[name]})
        clients[name] = (client, me['user'])
        admin('/tenants/default/members', {'user': me['user']})
        call(client, '/state', headers={'x-ae-workspace': tenant['id']}, expected=403)
    proof['cross_tenant_access'] = 403
    # Registration is one-use and runtime credentials cannot authorize human APIs.
    temporary = admin('/runtimes', {'name':'Revocation verification'})
    enrollment = {'Authorization':'Bearer '+temporary['enrollment_token']}
    registered = call(owner, '/runtime/enroll', {}, headers=enrollment)
    call(owner, '/runtime/enroll', {}, headers=enrollment, expected=401)
    runtime_headers = {'Authorization':'Bearer '+registered['token']}
    call(owner, '/state', headers=runtime_headers, expected=401)
    admin('/runtimes/'+temporary['id'], method='DELETE')
    call(owner, '/runtime/poll', {}, headers=runtime_headers, expected=401)
    proof['runtime_auth'] = {'one_use_enrollment':True,'human_api_denied':401,'revoked':401}
    call(clients['bob'][0], '/logout', {})
    call(clients['bob'][0], '/state', expected=401)
    call(clients['bob'][0], '/login', {'username':'bob','password':users['bob']})
    proof['logout_revokes_session'] = True
    original = admin('/state')['agents'][0]
    agents = {}
    for name, parent in [('manager', None), ('selected', 'manager'), ('excluded', 'manager')]:
        a = dict(original, id=uuid.uuid4().hex, name=name, reports_to=agents[parent]['id'] if parent else None,
            model='', reasoning='', workdir=None, project_id=None)
        agents[name] = admin('/agents', a)
    g = admin('/groups', {'id':uuid.uuid4().hex, 'name':'Selective '+uuid.uuid4().hex[:8], 'description':'Real smoke test',
        'member_ids':[agents['selected']['id']], 'human_ids':[clients['alice'][1]]})
    state = admin('/state')
    assert set(state['group_access'][g['id']]['participant_ids']) == {agents['manager']['id'], agents['selected']['id']}
    admin('/messages', {'id':uuid.uuid4().hex,'group_id':g['id'],'body':'Excluded agent must not run','recipients':[agents['excluded']['id']]}, expected=400)
    before = len(state['runs'])
    message = call(clients['alice'][0], '/messages', {'id':uuid.uuid4().hex,'group_id':g['id'],'body':'Human room post','recipients':[]})
    assert message['sender'] == clients['alice'][1]
    call(clients['bob'][0], '/groups/'+g['id']+'/messages', expected=403)
    assert g['id'] not in [r['id'] for r in call(clients['bob'][0], '/state')['groups']]
    assert len(admin('/state')['runs']) == before
    proof['group_isolation'] = {'allowed':200,'excluded':403,'unmentioned_runs':0}

    # Use the real homeserver Client-Server API to represent a native Matrix client.
    def matrix(path, data=None, method=None, token=None):
        headers = {'Content-Type':'application/json'}
        if token: headers['Authorization']='Bearer '+token
        req=urllib.request.Request(args.matrix_url.rstrip('/')+'/_matrix/client/v3/'+path,
            data=json.dumps(data).encode() if data is not None else None,method=method,headers=headers)
        with urllib.request.urlopen(req,timeout=40) as response:return json.load(response)
    auth=matrix('login',{'type':'m.login.password','identifier':{'type':'m.id.user','user':'alice'},'password':users['alice']})
    token=auth['access_token']
    room=None
    since=None
    for _ in range(90):
        sync=matrix('sync?timeout=0'+('&since='+urllib.parse.quote(since,safe='') if since else ''),token=token)
        since=sync['next_batch']
        for rid, data in sync.get('rooms',{}).get('invite',{}).items():
            if any(e.get('content',{}).get('name')=='default · '+g['name'] for e in data.get('invite_state',{}).get('events',[])):
                room=rid; break
        if room:break
        time.sleep(1)
    assert room, 'Platform did not create/invite the Matrix room'
    encoded=urllib.parse.quote(room,safe='')
    matrix('join/'+encoded,{},token=token)
    try:
        matrix('rooms/'+encoded+'/invite', {'user_id':clients['bob'][1]},token=token)
    except urllib.error.HTTPError as denied:
        assert denied.code==403, denied.code
    else:
        raise AssertionError('Native Matrix invite bypassed platform membership')
    proof['matrix_invite_authority'] = 403
    unique='NATIVE_MATRIX_'+uuid.uuid4().hex
    event=matrix('rooms/'+encoded+'/send/m.room.message/'+uuid.uuid4().hex,{'msgtype':'m.text','body':unique},'PUT',token)
    for _ in range(90):
        messages=admin('/groups/'+g['id']+'/messages')
        if any(m['body']==unique for m in messages):break
        time.sleep(1)
    assert len([m for m in messages if m['body']==unique])==1, 'Missing or duplicate Matrix ingress'
    timeline=matrix('rooms/'+encoded+'/messages?dir=b&limit=100',token=token)
    assert any('Human room post' in e.get('content',{}).get('body','') for e in timeline['chunk']), 'Platform post did not reach Matrix'
    matrix('logout',{},token=token)
    proof['matrix']={'ingress_event':event['event_id'],'egress':True,'room':room}

    admin('/workspaces/probe',{'runtime_id':args.runtime,'path':'/' if args.workdir.startswith('/') else 'C:/Windows'},expected=400)
    proof['outside_worker_root'] = 400
    workspace=admin('/workspaces/probe',{'runtime_id':args.runtime,'path':args.workdir})['workspace']
    agent=agents['selected'];agent['workdir']=workspace;agent['permission']='workspace-write'
    agent=admin('/agents/'+agent['id'],agent,'PUT')
    assert admin('/agents/'+agent['id']+'/probe',{})['ready']
    proof['registered_connection_probe'] = True
    post=admin('/messages',{'id':uuid.uuid4().hex,'group_id':g['id'],'body':'Reply exactly DECENTRALIZED_SMOKE_OK. Do not call tools.','recipients':[agent['id']]})
    run=None
    for _ in range(120):
        run=next((r for r in admin('/state')['runs'] if r['message_id']==post['id']),None)
        if run and run['status'] not in ('queued','starting','running','waiting'):break
        time.sleep(1)
    assert run and run['status']=='succeeded' and run['output'].strip()=='DECENTRALIZED_SMOKE_OK', run
    proof['worker']={k:run[k] for k in ('id','status','native_session_id','remote_pid','output')}
    args.output.write_text(json.dumps(proof,indent=2),encoding='utf-8')
    print(json.dumps(proof,indent=2))


if __name__ == '__main__':
    main()
