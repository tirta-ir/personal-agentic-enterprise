"""Live Tencent verification: one Luna turn, real worker, real MCP authorization. No mocks.
Usage: python src/scripts/verify-luna-human-btw.py credentials.json output-dir workspace-id runtime-id workdir
Requires SSH alias tencent-personal and passwordless sudo for its platform DB read.
"""
import http.cookiejar,json,shlex,subprocess,sys,time,urllib.request,uuid
from pathlib import Path
credentials,output,tenant,runtime,workdir=sys.argv[1:]
config=json.loads(Path(credentials).read_text(encoding='utf-8'));out=Path(output);out.mkdir(parents=True,exist_ok=True)
jar=http.cookiejar.CookieJar();http=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
def api(path,body=None,method=None):
 headers={'Content-Type':'application/json','x-ae-workspace':tenant}
 with http.open(urllib.request.Request(config['url']+'/api'+path,data=json.dumps(body).encode() if body is not None else None,method=method,headers=headers),timeout=90) as r:return json.load(r)
def wait_for(check,seconds=180):
 until=time.monotonic()+seconds
 while time.monotonic()<until:
  result=check(api('/state'))
  if result:return result
  time.sleep(1)
 raise AssertionError('Live verification timed out')
agent=None;groups=[];complete=False;probe=None
try:
 api('/login',{'username':config['username'],'password':config['password']})
 before=api('/state');catalog=api('/harness/settings?runtime_id='+runtime+'&harness=codex')
 assert any(m['slug']=='gpt-5.6-luna' for m in catalog['models'])
 workspace=api('/workspaces/probe',{'runtime_id':runtime,'path':workdir})['workspace']
 agent=api('/agents',{**before['agents'][0],'id':uuid.uuid4().hex,'name':'LunaBtwVerifier','position':'Verification','reports_to':None,'project_id':None,'runtime_id':runtime,'workdir':workspace,'model':'gpt-5.6-luna','reasoning':'low','permission':'read-only','enabled':True,'deleted_at':None,'revision':1,'timeout_seconds':180,'instructions':'Perform only this verification. No file changes, delegation, actions or additional tasks.','agents_md':''})
 for suffix in ['source','destination']:
  groups.append(api('/groups',{'id':uuid.uuid4().hex,'name':'Luna human btw verification '+suffix,'description':'Temporary live verification','member_ids':[agent['id']]}))
 (out/'ids.json').write_text(json.dumps({'agent':agent['id'],'groups':[g['id'] for g in groups]}))
 # Use only this live verification run's scoped lease. The token never leaves the server or appears in output.
 remote=f'''
import json,sqlite3,urllib.request,time
path='/var/lib/docker/volumes/agentic-enterprise_platform-data/_data/org/workspaces/{tenant}/.state/app.sqlite3'
with sqlite3.connect('file:'+path+'?mode=ro',uri=True) as db:
 print('READY',flush=True)
 until=time.monotonic()+120
 row=None
 while time.monotonic()<until:
  row=db.execute("SELECT request FROM fleet_jobs WHERE json_extract(request,'$.run_id') IN (SELECT id FROM runs WHERE json_extract(data,'$.group_id')=?)",({groups[0]['id']!r},)).fetchone()
  if row:break
  time.sleep(.1)
 assert row,'No verification worker job appeared'
 request=json.loads(row[0]);token=request['tool_token']
 def mcp(method,params={{}}):
  data=json.dumps({{'jsonrpc':'2.0','id':1,'method':method,'params':params}}).encode()
  with urllib.request.urlopen(urllib.request.Request({(config['url']+'/mcp')!r},data=data,headers={{'Content-Type':'application/json','Authorization':'Bearer '+token}}),timeout=30) as r:return json.load(r)['result']
 assert 'chat_btw' not in [t['name'] for t in mcp('tools/list')['tools']]
 for name,args in [('chat_btw',{{'request_id':'verify-direct-btw','task':'verification'}}),('cross_chat_invoke',{{'request_id':'verify-cross-btw','group_id':{groups[1]['id']!r},'agent_id':{agent['id']!r},'task':'/btw forbidden'}})]:
  result=mcp('tools/call',{{'name':name,'arguments':args}})
  assert result['isError'] is True,result
  assert 'Only humans' in result['content'][0]['text'],result
 assert db.execute("SELECT count(*) FROM messages WHERE json_extract(data,'$.group_id')=?",({groups[1]['id']!r},)).fetchone()[0]==0
print('Live MCP: tool absent, direct call rejected, cross-chat bypass rejected, no side effects')
'''
 probe=subprocess.Popen(['ssh','tencent-personal','sudo -n python3 -c '+shlex.quote(remote)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 assert probe.stdout.readline().strip()=='READY','Remote probe did not become ready'
 message=api('/messages',{'id':uuid.uuid4().hex,'group_id':groups[0]['id'],'body':'Reply with exactly LUNA_VERIFIED. Do not use tools or modify files.','recipients':[agent['id']]})
 stdout,stderr=probe.communicate(timeout=150)
 assert probe.returncode==0,stderr;print(stdout.strip())
 run=wait_for(lambda state:next((r for r in state['runs'] if r['message_id']==message['id'] and r['status'] not in ['queued','starting','running','waiting']),None));runid=run['id']
 assert run['status']=='succeeded',run.get('error');assert 'LUNA_VERIFIED' in run['output'];assert run['remote_pid']
 assert any('model_catalog_json=' in arg and 'models_with_luna.json' in arg for arg in run['arguments'])
 # An authenticated human can still open a side chat without dispatching any work.
 side=api('/messages',{'id':uuid.uuid4().hex,'group_id':groups[0]['id'],'body':'/btw','recipients':[]})
 assert side['command']=='btw' and side['side_chat_id']==side['id'];assert side['sender'].startswith('@')
 state=api('/state');assert not any(r['message_id']==side['id'] for r in state['runs'])
 proof={'luna_run':runid,'status':run['status'],'remote_pid':run['remote_pid'],'model':'gpt-5.6-luna','model_display_name':run.get('model_display_name'),'native_catalog_override_passed':True,'agent_btw_hidden':True,'agent_btw_rejected':True,'cross_chat_bypass_rejected':True,'human_btw_works':True,'mocks':False}
 (out/'proof.json').write_text(json.dumps(proof,indent=2),encoding='utf-8');print(json.dumps(proof));complete=True
finally:
 if probe and probe.poll() is None:probe.terminate();probe.communicate(timeout=10)
 if complete:
  for group in groups:api('/groups/'+group['id'],method='DELETE')
  if agent:api('/agents/'+agent['id'],method='DELETE')
  after=api('/state');assert after['agents']==before['agents']
  originals={g['id'] for g in before['groups']}
  assert [g for g in after['groups'] if g['id'] in originals]==before['groups']
  assert all(g['deleted_at'] for g in after['groups'] if g['id'] not in originals)
 else:print('Verification incomplete; test entity IDs retained for inspection in output directory')
 api('/logout',{})
