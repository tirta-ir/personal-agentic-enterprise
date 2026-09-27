import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { chromium, expect } from "@playwright/test";

const org = path.resolve(process.env.AE_TEST_ORG || "../../org/verification-remote-20260920");
const base = process.env.AE_TEST_URL || "http://127.0.0.1:8766";
const directory = path.join(org, ".state/verification");
await fs.mkdir(directory, { recursive: true });
const browser = await chromium.launch({channel:"msedge",headless:true});
const context = await browser.newContext({baseURL:base,viewport:{width:1440,height:1000}});
const page = await context.newPage();
const errors=[];
page.on("pageerror",e=>errors.push(e.message));
const request=context.request;
async function call(route,data,method="POST") {
  const response=await request.fetch(`/api${route}`,{method,...(data===undefined?{}:{data})});
  assert(response.ok(),`${route}: ${response.status()} ${await response.text()}`);
  return response.json();
}
async function until(read,limit=240000) {
  const start=Date.now();
  while(Date.now()-start<limit) { const result=await read(); if(result)return result; await new Promise(r=>setTimeout(r,1000)); }
  throw new Error("Timed out waiting for real remote execution");
}
const proof={machines:[],errors};
try {
  assert.equal((await request.get("/api/codex/settings?ssh_host=linux-example")).status(),401);
  await call("/login",{token:(await fs.readFile(path.join(org,".state/owner.key"),"utf8")).trim()});
  assert.equal((await request.post("/api/workspaces/probe",{data:{ssh_host:"-oProxyCommand=whoami",path:"/tmp"}})).status(),400);
  const initial=await call("/state",undefined,"GET");
  for(const [host,home] of [["linux-example","/home/test-user"],["macos-example","/Users/test-user"]]) {
    const workdir=`${home}/.local/share/agentic-enterprise/workspaces/connection-demo`;
    const catalog=await call(`/codex/settings?ssh_host=${host}`,undefined,"GET");
    const validated=await call("/workspaces/probe",{ssh_host:host,path:workdir});
    assert.equal(validated.connection.status,"online",validated.connection.message);
    let agent=initial.agents.find(a=>a.name===host);
    if(!agent) agent=await call("/agents",{...initial.agents[0],id:"",name:host,position:"Remote Engineer",reports_to:null,workdir:validated.workspace,permission:"danger-full-access",model:"gpt-5.6-luna",reasoning:"low",agents_md:"",instructions:"Work only in the attached connection-demo folder. Follow the requested verification steps exactly. Do not touch other projects.",deleted_at:null});
    await page.goto(`/organization/agents/${host}--${agent.id}/workdir`);
    await expect(page.getByLabel("SSH host alias")).toHaveValue(host);
    await page.getByRole("button",{name:"Browse folders",exact:true}).click();
    await expect(page.getByRole("dialog")).toContainText(workdir);
    await page.getByRole("dialog").getByRole("button",{name:"Close",exact:true}).click();
    const text=`Use a shell command to write remote-proof.txt in the current directory containing exactly '${host} verified'. Then report uname, pwd and read back remote-proof.txt. Include [Evidence](remote-proof.txt) in your reply.`;
    const message=await call("/messages",{id:crypto.randomUUID(),group_id:"general",body:text,recipients:[agent.id],reply_to:null,artifacts:[]});
    const run=await until(async()=>{const s=await call("/state",undefined,"GET");const r=s.runs.find(r=>r.message_id===message.id);return r&&!['queued','starting','running','waiting'].includes(r.status)?r:null;});
    assert.equal(run.status,"succeeded",run.error);
    assert(run.remote_pid>0);
    assert(run.native_session_id);
    const file=await request.get(`/api/runs/${run.id}/files?path=remote-proof.txt`);
    assert.equal(file.status(),200);
    assert.equal((await file.text()).trim(),`${host} verified`);
    assert.equal((await request.get(`/api/runs/${run.id}/files?path=${encodeURIComponent(home+'/.codex/auth.json')}`)).status(),400);
    const second=await call("/messages",{id:crypto.randomUUID(),group_id:"general",body:"What exact string did you just write to remote-proof.txt? Answer from this conversation without a tool call.",recipients:[agent.id],reply_to:null,artifacts:[]});
    const resumed=await until(async()=>{const s=await call("/state",undefined,"GET");const r=s.runs.find(r=>r.message_id===second.id);return r&&!['queued','starting','running','waiting'].includes(r.status)?r:null;});
    assert.equal(resumed.status,"succeeded",resumed.error);
    assert.equal(resumed.native_session_id,run.native_session_id);
    assert(resumed.arguments.includes("resume"));
    await page.goto(`/organization/agents/${host}--${agent.id}/terminal`);
    await page.getByLabel("Shell command").fill("pwd; uname -s; printf terminal-ok");
    await page.getByRole("button",{name:"Run command",exact:true}).click();
    await expect(page.locator(".terminal-output")).toContainText("terminal-ok",{timeout:40000});
    await expect(page.locator(".terminal-output")).toContainText(workdir);
    await until(async()=>!(await call(`/agents/${agent.id}/terminal`,undefined,"GET")).some(r=>r.status==="running"));
    const skills=await call(`/agents/${agent.id}/skills`,undefined,"GET");
    const skill=skills.skills.find(s=>s.name==="connection-check");
    assert(skill,"Remote project skill was not discovered by Codex");
    const preview=await call(`/agents/${agent.id}/skills?path=${encodeURIComponent(skill.path)}`,undefined,"GET");
    assert.match(preview.text,/Run uname -s and pwd/);
    const envCommand=await call(`/agents/${agent.id}/terminal`,{id:crypto.randomUUID(),command:'printf "%s" "$AE_REMOTE_PROBE"'});
    const envResult=await until(async()=>{const r=await call(`/agents/${agent.id}/terminal/${envCommand.id}`,undefined,"GET");return r.status!=="running"?r:null;});
    assert.equal(envResult.status,"completed",envResult.error);
    assert.equal(envResult.output,"[REDACTED]");
    const commandId=crypto.randomUUID();
    const pidFile=`${workdir}/cancel-${commandId}.pid`;
    const command=await call(`/agents/${agent.id}/terminal`,{id:commandId,command:`echo $$ > '${pidFile}'; sleep 120`});
    const remotePid=await until(async()=>{try{return Number(execFileSync("ssh",[host,`cat '${pidFile}'`],{encoding:"utf8",stdio:["ignore","pipe","ignore"]}).trim())||null;}catch{return null;}});
    await call(`/agents/${agent.id}/terminal/${command.id}/stop`);
    const cancelled=await until(async()=>{const r=await call(`/agents/${agent.id}/terminal/${command.id}`,undefined,"GET");return r.status!=="running"?r:null;});
    assert.equal(cancelled.status,"cancelled",cancelled.error);
    const stopped=execFileSync("ssh",[host,`if kill -0 ${remotePid} 2>/dev/null; then echo alive; else echo stopped; fi`],{encoding:"utf8"}).trim();
    assert.equal(stopped,"stopped");
    const failed=await call(`/agents/${agent.id}/terminal`,{id:crypto.randomUUID(),command:"exit 7"});
    const failure=await until(async()=>{const r=await call(`/agents/${agent.id}/terminal/${failed.id}`,undefined,"GET");return r.status!=="running"?r:null;});
    assert.equal(failure.status,"failed"); assert.equal(failure.exit_code,7);
    proof.machines.push({host,agent:agent.id,os:validated.connection.os,version:validated.connection.version,workdir,run:run.id,remote_pid:run.remote_pid,native_session_id:run.native_session_id,resume:resumed.id,catalog:catalog.models.map(m=>m.display_name),file:(await file.text()).trim(),terminal:true,skills:skills.skills.length,cancellation:{id:command.id,status:cancelled.status,remotePid,process:stopped},failedCommand:{id:failed.id,status:failure.status,exit:failure.exit_code}});
    await fs.writeFile(path.join(directory,"remote-proof.json"),JSON.stringify(proof,null,2));
    console.log(`${host}: real Codex run and native session resume passed`);
  }
  await page.goto("/organization");
  await expect(page.locator(".org-card .workstation-online")).toHaveCount(2);
  await page.screenshot({path:path.join(directory,"remote-organization.png"),fullPage:true});
  let snapshot=await call("/state",undefined,"GET");
  const localPath=path.join(org,"coordinator-workdir");
  await fs.mkdir(localPath,{recursive:true});
  const local=await call("/workspaces/probe",{path:localPath});
  await call("/agents/ceo",{...snapshot.agents.find(a=>a.id==="ceo"),workdir:local.workspace,permission:"danger-full-access",model:"gpt-5.6-luna",reasoning:"low",instructions:"Coordinate the two remote reports. Delegate remote inspection to the matching workstation agent. Summarize their verified results.",agents_md:""},"PUT");
  for(const machine of proof.machines) {
    const agent=snapshot.agents.find(a=>a.id===machine.agent);
    await call(`/agents/${agent.id}`,{...agent,reports_to:"ceo"},"PUT");
  }
  const group=await call("/groups",{id:crypto.randomUUID(),name:"Remote coordination",description:"Real local lead and remote delegates",scope_levels:[1],chat_lead_id:"ceo",archived_at:null,deleted_at:null});
  const message=await call("/messages",{id:crypto.randomUUID(),group_id:group.id,body:"Delegate one task to linux-example and one task to macos-example. Each must run uname -s, pwd, and read remote-proof.txt in its attached folder. Wait for both and summarize their verified results. Do not run SSH yourself; use platform delegation.",recipients:[],reply_to:null,artifacts:[]});
  const delegated=await until(async()=>{const runs=(await call("/state",undefined,"GET")).runs.filter(r=>r.message_id===message.id);return runs.length&&runs.every(r=>!['queued','starting','running','waiting'].includes(r.status))?runs:null;});
  const workers=delegated.filter(r=>r.kind==="delegate");
  assert.equal(workers.length,2,JSON.stringify(delegated.map(r=>({status:r.status,kind:r.kind,error:r.error}))));
  assert(workers.every(r=>r.status==="succeeded"&&r.remote_pid>0));
  assert(delegated.some(r=>r.kind==="summary"&&r.status==="succeeded"));
  const messages=await call(`/groups/${group.id}/messages`,undefined,"GET");
  assert(!messages.some(m=>proof.machines.some(machine=>machine.agent===m.sender)),"Delegation-only workers posted into Level 1 chat");
  proof.delegation={group:group.id,runs:delegated.map(r=>({id:r.id,kind:r.kind,status:r.status,agent:r.agent_id,host:r.profile.workdir.ssh_host})),scopedReplies:true};
  console.log("Local lead -> Linux and Mac delegates -> private results -> group summary passed");
  assert.deepEqual(errors,[]);
} finally {
  await fs.writeFile(path.join(directory,"remote-proof.json"),JSON.stringify(proof,null,2));
  await browser.close();
}
