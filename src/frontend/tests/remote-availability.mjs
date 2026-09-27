import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
const org=path.resolve(process.env.AE_TEST_ORG||"../../org/verification-remote-20260920");
const base=process.env.AE_TEST_URL||"http://127.0.0.1:8766";
const token=(await fs.readFile(path.join(org,".state/owner.key"),"utf8")).trim();
async function call(route,data,method="POST") {
 const r=await fetch(base+"/api"+route,{method,headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},...(data===undefined?{}:{body:JSON.stringify(data)})});
 assert(r.ok,`${route}: ${await r.clone().text()}`); return r.json();
}
const host="linux-example";
const directory=`/home/test-user/.local/share/agentic-enterprise/workspaces/availability-${crypto.randomUUID()}`;
let agent;
execFileSync("ssh",[host,`mkdir '${directory}'`]);
try {
 const probe=await call("/workspaces/probe",{ssh_host:host,path:directory});
 assert.equal(probe.connection.status,"online");
 const template=(await call("/state",undefined,"GET")).agents.find(a=>a.workdir?.ssh_host===host);
 agent=await call("/agents",{...template,id:"",name:"Availability verification",workdir:probe.workspace,reports_to:null});
 execFileSync("ssh",[host,`rmdir '${directory}'`]);
 const unavailable=await call(`/agents/${agent.id}/probe`);
 assert.equal(unavailable.ready,false);
 const state=await call("/state",undefined,"GET");
 assert.equal(state.connections[agent.id].status,"offline");
 const message=await call("/messages",{id:crypto.randomUUID(),group_id:"general",body:"Inspect this workdir.",recipients:[agent.id],reply_to:null,artifacts:[]});
 let run;
 for(let i=0;i<45;i++) {run=(await call("/state",undefined,"GET")).runs.find(r=>r.message_id===message.id);if(run?.status==="failed")break;await new Promise(r=>setTimeout(r,1000));}
 assert.equal(run.status,"failed"); assert.equal(run.remote_pid,null);
 execFileSync("ssh",[host,`mkdir '${directory}'`]);
 assert.equal((await call(`/agents/${agent.id}/probe`)).ready,true);
 assert.equal((await call("/state",undefined,"GET")).connections[agent.id].status,"online");
 const proof={host,transitions:["online","offline","online"],failedRun:run.id,noRemoteProcessStarted:run.remote_pid===null,mocks:false};
 await fs.writeFile(path.join(org,".state/verification/remote-availability.json"),JSON.stringify(proof,null,2));
 console.log(JSON.stringify(proof));
} finally {
 if(agent) await call(`/agents/${agent.id}`,undefined,"DELETE");
 execFileSync("ssh",[host,`if test -d '${directory}'; then rmdir '${directory}'; fi`]);
}
