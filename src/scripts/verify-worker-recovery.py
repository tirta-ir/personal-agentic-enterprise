"""Real Docker worker restart, host bind mount, cancellation and persistence check."""
import argparse
import json
import pathlib
import subprocess
import time
import urllib.request
import uuid


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--url', required=True)
    p.add_argument('--owner-key', type=pathlib.Path, required=True)
    p.add_argument('--proof', type=pathlib.Path, required=True)
    p.add_argument('--host-workdir', type=pathlib.Path, required=True)
    p.add_argument('--compose-project', required=True)
    args = p.parse_args()
    headers = {'Authorization': 'Bearer '+args.owner_key.read_text().strip(), 'Content-Type':'application/json'}

    def call(path, data=None, method=None):
        request = urllib.request.Request(args.url+'/api'+path, headers=headers, method=method,
            data=json.dumps(data).encode() if data is not None else None)
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)

    def restart(service):
        subprocess.run(['docker','compose','-p',args.compose_project,'restart',service],check=True)
        for _ in range(60):
            try:
                if call('/health')['status']=='ok' and any(r['online'] for r in call('/runtimes')):
                    return
            except (OSError, ValueError):
                pass
            time.sleep(1)
        raise AssertionError('Deployment did not recover')

    proof=json.loads(args.proof.read_text())
    state=call('/state')
    previous=next(r for r in state['runs'] if r['id']==proof['worker']['id'])
    agent=next(a for a in state['agents'] if a['id']==previous['agent_id'])
    if agent['permission']!='workspace-write':
        agent['permission']='workspace-write'
        call('/agents/'+agent['id'],agent,'PUT')
    count=len(state['runs'])
    restart('worker')
    restart('platform')
    assert len(call('/state')['runs'])==count, 'Restart replayed a run'
    name='bind-proof-'+uuid.uuid4().hex+'.txt'
    body=f'Use your shell tool to write exactly HOST_MOUNT_OK into {name} in the current workdir. Then reply exactly HOST_MOUNT_OK.'
    message=call('/messages',{'id':uuid.uuid4().hex,'group_id':previous['group_id'],'recipients':[previous['agent_id']],'body':body})

    def run_for(message_id):
        return next((r for r in call('/state')['runs'] if r['message_id']==message_id),None)

    for _ in range(120):
        run=run_for(message['id'])
        if run and run['status'] not in ('queued','starting','running','waiting'):
            break
        time.sleep(1)
    assert run['status']=='succeeded', run
    assert (args.host_workdir/name).read_text().strip()=='HOST_MOUNT_OK'
    assert run['native_session_id']==previous['native_session_id'], 'Native conversation did not resume'
    proof['restart']={'no_replay':True,'resumed_session':run['native_session_id'],'run':run['id'],'host_file':str(args.host_workdir/name)}

    marker='cancel-proof-'+uuid.uuid4().hex
    task=call('/messages',{'id':uuid.uuid4().hex,'group_id':previous['group_id'],'recipients':[previous['agent_id']],
        'body':f'Run this exact shell command in the current workdir: printf started > {marker}; sleep 90; printf finished > {marker}.finished. Wait for it. Do not perform other actions.'})
    for _ in range(90):
        run=run_for(task['id'])
        if (args.host_workdir/marker).exists():
            break
        if run and run['status'] not in ('queued','starting','running','waiting'):
            raise AssertionError(run)
        time.sleep(1)
    assert (args.host_workdir/marker).exists(), 'Native shell never started'
    call('/runs/'+run['id']+'/cancel',{})
    for _ in range(30):
        run=run_for(task['id'])
        if run['status']=='cancelled':break
        time.sleep(1)
    assert run['status']=='cancelled',run
    processes=subprocess.check_output(['docker','compose','-p',args.compose_project,'top','worker'],text=True)
    assert 'sleep 90' not in processes, processes
    assert not (args.host_workdir/(marker+'.finished')).exists()
    proof['cancellation']={'run':run['id'],'status':run['status'],'sleep_process_absent':True}
    args.proof.write_text(json.dumps(proof,indent=2))
    print(json.dumps(proof,indent=2))


if __name__=='__main__':
    main()
