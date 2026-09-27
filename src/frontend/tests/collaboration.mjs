// Real native application, SQLite, filesystem, Codex account and MCP integration.
// Use the isolated organization only; no mock provider or browser API interception.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";

const org=path.resolve(process.env.AE_TEST_ORG||"../../org/verification-collaboration-20260920");
assert.notEqual(org,path.resolve("../../org"));
const base=process.env.AE_TEST_URL||"http://127.0.0.1:8766";
const dir=path.join(org,".state/verification");await fs.mkdir(dir,{recursive:true});
const browser=await chromium.launch({channel:"msedge",headless:true});
const context=await browser.newContext({baseURL:base,viewport:{width:1440,height:1000}});
const page=await context.newPage();page.setDefaultTimeout(20000);
const errors=[];page.on("pageerror",e=>errors.push(e.message));
const request=context.request;
const proofFile=path.join(dir,"collaboration-proof.json");
let proof={};try{proof=JSON.parse(await fs.readFile(proofFile,"utf8"));}catch(e){if(e.code!=="ENOENT")throw e;}
const save=()=>fs.writeFile(proofFile,JSON.stringify(proof,null,2));
async function call(route,data,method=data===undefined?"GET":"POST"){
 const r=await request.fetch(`/api${route}`,{method,...(data===undefined?{}:{data})});
 assert(r.ok(),`${method} ${route}: ${r.status()} ${await r.text()}`);return r.json();
}
async function until(read,ms=240000){const started=Date.now();while(Date.now()-started<ms){const v=await read();if(v)return v;await new Promise(r=>setTimeout(r,1000));}throw Error("Real execution did not finish within deadline");}
const active=r=>["queued","starting","running","waiting"].includes(r.status);
const state=()=>call("/state");
async function finished(message){return until(async()=>{const s=await state();const run=s.runs.find(r=>r.message_id===message.id&&r.kind!=="summary");return run&&!active(run)?run:null;});}
const send=(group,agent,body,side=null)=>call("/messages",{id:crypto.randomUUID(),group_id:group,recipients:[agent],body,side_chat_id:side,reply_to:null,artifacts:[]});
async function workspace(name){const p=path.join(org,"workspaces",name);await fs.mkdir(p,{recursive:true});return (await call("/workspaces/probe",{path:p})).workspace;}
const phase=process.argv[2]||"setup";
try{
 assert.equal((await request.post("/mcp",{data:{jsonrpc:"2.0",id:1,method:"tools/list"}})).status(),401);
 await call("/login",{token:(await fs.readFile(path.join(org,".state/owner.key"),"utf8")).trim()});
 if(phase==="setup"){
  let s=await state();
  const ceo=await call("/agents/ceo",{...s.agents.find(a=>a.id==="ceo"),model:"gpt-5.6-luna",reasoning:"low",permission:"danger-full-access",workdir:await workspace("default"),timeout_seconds:240,instructions:"Follow the owner's requested verification steps exactly. Use enterprise MCP tools when requested. Do not perform unrequested work, create extra actions, or delegate except when explicitly requested."},"PUT");
  const worker=s.agents.find(a=>a.name==="Collaboration Worker")||await call("/agents",{...ceo,id:"",name:"Collaboration Worker",position:"Engineer",reports_to:ceo.id,workdir:await workspace("worker-default")});
  proof.ceo=ceo.id;proof.worker=worker.id;proof.projectWorkspace=await workspace("project-alpha");proof.destWorkspace=await workspace("project-beta");
  await page.goto("/organization");
  await page.getByRole("button",{name:"Add group or section",exact:true}).click();
  await page.getByRole("menuitem",{name:"Create project",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Create a project"})).toBeVisible();
  await page.getByLabel("Name",{exact:true}).fill("Collaboration Alpha");
  await page.getByLabel("Project workdir",{exact:true}).fill(proof.projectWorkspace.path);
  await page.getByRole("button",{name:"Browse",exact:true}).click();
  await expect(page.getByRole("dialog").last()).toContainText("project-alpha");
  await page.getByRole("dialog").last().getByRole("button",{name:"Close",exact:true}).click();
  await page.getByLabel("Include CEO",{exact:true}).check();
  await page.getByLabel("Include Collaboration Worker",{exact:true}).check();
  await page.getByLabel("Project manager for Collaboration Worker").selectOption(ceo.id);
  await page.getByRole("button",{name:"Save project",exact:true}).click();
  await expect(page).toHaveURL(/\/projects\/collaboration-alpha--/);
  s=await state();const project=s.groups.find(g=>g.name==="Collaboration Alpha");assert(project.project);proof.project=project.id;
  const destination=await call("/groups",{id:"",name:"Collaboration Beta",description:"Shared destination",project:{workdir:proof.destWorkspace,members:[{agent_id:ceo.id,manager_id:null},{agent_id:worker.id,manager_id:ceo.id}]}});proof.destination=destination.id;
  const privateGroup=await call("/groups",{id:"",name:"Restricted Project",description:"Excluded sender",project:{workdir:proof.destWorkspace,members:[{agent_id:worker.id,manager_id:null}]}});proof.privateGroup=privateGroup.id;
  const dedicated=await call("/agents",{...ceo,id:"",name:"Project Specialist",project_id:project.id,reports_to:ceo.id,workdir:null});proof.dedicated=dedicated.id;
  const junior=await call("/agents",{...dedicated,id:"",name:"Project Junior"});proof.junior=junior.id;
  s=await state();let p=s.groups.find(g=>g.id===project.id);p.project.members=p.project.members.map(m=>({...m,manager_id:m.agent_id===dedicated.id?ceo.id:m.agent_id===junior.id?dedicated.id:m.manager_id}));await call("/groups",p);
  s=await state();assert.equal(s.agents.find(a=>a.id===dedicated.id).reports_to,ceo.id);assert.equal(s.agents.find(a=>a.id===junior.id).reports_to,null);
  assert(!s.group_access.general.participant_ids.includes(dedicated.id));assert(s.group_access[project.id].participant_ids.includes(junior.id));
  assert.equal((await call("/sessions")).length,0,"No eager sessions");
  const cycle=structuredClone(p);cycle.project.members.find(m=>m.agent_id===ceo.id).manager_id=junior.id;
  assert.equal((await request.post("/api/groups",{data:cycle})).status(),400,"Reject project reporting cycle");
  await page.getByRole("button",{name:"Structure",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Collaboration Alpha · Structure"})).toBeVisible();
  await page.screenshot({path:path.join(dir,"project-structure.png")});
  proof.setup=true;await save();console.log("SETUP_OK: project UI, folder picker, scoped team, global reporting, no eager sessions, cycle rejection");
 }
 if(phase==="tools"){
  proof.backlogId=crypto.randomUUID();await save();
  const task=`Use the enterprise MCP tools (not shell HTTP). First workspace_list, then action_save exactly with request_id=backlog-create, id=${proof.backlogId}, revision=0, group_id=${proof.project}, title=Agent-created backlog, body=Use a shell command to write project-result.txt in the current project directory containing exactly PROJECT_OVERRIDE_OK, assignee_id=${proof.dedicated}, planned_start=null. Then action_list and chat_usage. Do not invoke the action, create a schedule, or open a side chat. Report the saved action ID and whether usage was available.`;
  const run=await finished(await send(proof.project,proof.ceo,task));assert.equal(run.status,"succeeded",run.error);
  const s=await state();const item=s.actions.find(a=>a.id===proof.backlogId);assert(item,"Real model must use action_save");assert.equal(item.status,"backlog");assert.equal(item.run_id,null);assert.equal(item.created_by,proof.ceo);
  const events=await call(`/runs/${run.id}/events`);assert(events.some(e=>e.kind==="agent.tool"&&e.payload.tool==="action_save"));
  proof.tools={run_id:run.id,native_session:run.native_session_id,action_id:item.id};await save();console.log("TOOLS_OK: real Codex MCP created unscheduled action and read usage");
 }
 if(phase==="board"){
  await page.goto("/actions");await expect(page.getByRole("heading",{name:"Action board",exact:true})).toBeVisible();
  await page.getByRole("row").filter({hasText:"Agent-created backlog"}).getByRole("button",{name:"Run now",exact:true}).click();
  const item=await until(async()=>{const a=(await state()).actions.find(a=>a.id===proof.backlogId);return a?.status==="completed"?a:a?.status==="failed"?Promise.reject(Error(a.error)):null;});
  assert.equal((await fs.readFile(path.join(proof.projectWorkspace.path,"project-result.txt"),"utf8")).trim(),"PROJECT_OVERRIDE_OK");
  const run=await call(`/runs/${item.run_id}`);assert.equal(run.cwd,proof.projectWorkspace.path);assert.equal(run.profile.workdir.path,proof.projectWorkspace.path);
  const s=await state();assert.equal(s.agents.find(a=>a.id===proof.dedicated).workdir,null);
  const scheduled=await call("/actions",{id:crypto.randomUUID(),revision:0,group_id:proof.project,title:"Scheduled verification",body:"Reply exactly SCHEDULED_OK. Do not use tools.",assignee_id:proof.ceo,planned_start:new Date(Date.now()+12000).toISOString()});
  const queued=await until(async()=>{const a=(await state()).actions.find(a=>a.id===scheduled.id);return a?.run_id?a:null;});
  const done=await until(async()=>{const a=(await state()).actions.find(a=>a.id===scheduled.id);return a?.status==="completed"?a:null;});
  assert.equal(done.run_id,queued.run_id);assert.equal((await state()).runs.filter(r=>r.id===done.run_id).length,1);
  await page.getByRole("button",{name:"Calendar",exact:true}).click();await expect(page.getByText("Unscheduled backlog",{exact:true})).toBeVisible();await page.screenshot({path:path.join(dir,"action-calendar.png")});
  await page.getByRole("button",{name:"Table",exact:true}).click();await page.screenshot({path:path.join(dir,"action-table.png")});
  const mobile=await browser.newContext({baseURL:base,viewport:{width:390,height:844}});await mobile.addCookies(await context.cookies());const phone=await mobile.newPage();await phone.goto("/actions");await expect(phone.getByRole("heading",{name:"Action board",exact:true})).toBeVisible();assert(await phone.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await phone.screenshot({path:path.join(dir,"action-mobile.png")});await mobile.close();
  proof.board={manual_run:run.id,scheduled_run:done.run_id,project_override:true};await save();console.log("BOARD_OK: human invocation, real project file, scheduling once, calendar/table/mobile");
 }
 if(phase==="handoff"){
  const before=await call(`/groups/${proof.privateGroup}/messages`);
  const body=`Use enterprise cross_chat_invoke for this bounded verification. First attempt group_id=${proof.privateGroup}, agent_id=${proof.worker}, task=Reply DENIED_TEST, request_id=denial-check. This is an authorization test and must be denied because you are not a member. Do not work around the denial. Then call cross_chat_invoke group_id=${proof.destination}, agent_id=${proof.worker}, task=Reply exactly CROSS_CHAT_OK and do not invoke any other agents, request_id=valid-handoff. Repeat that exact same valid call once with identical arguments and request_id to verify idempotency. Do not copy this source-chat instruction into the destination. Finish with the receipt; do not poll.`;
  const run=await finished(await send(proof.project,proof.ceo,body));assert.equal(run.status,"succeeded",run.error);
  await until(async()=>{const s=await state();return s.runs.find(r=>r.kind==="summary"&&r.parent_run_id===run.id&&r.status==="succeeded");});
  const s=await state();const targets=s.runs.filter(r=>r.group_id===proof.destination);assert.equal(targets.length,1,"Idempotent invocation must create one destination run");assert.equal(targets[0].status,"succeeded",targets[0].error);assert(targets[0].output.includes("CROSS_CHAT_OK"));
  assert.equal((await call(`/groups/${proof.privateGroup}/messages`)).length,before.length);
  const targetMessages=await call(`/groups/${proof.destination}/messages`);assert(!targetMessages.some(m=>m.body.includes("denial-check")));assert.equal(targetMessages[0].sender,proof.ceo);
  const source=await call(`/groups/${proof.project}/messages`);assert(source.some(m=>m.sender==="system"&&m.body.includes("Cross-chat result")));
  assert.notEqual(run.native_session_id,targets[0].native_session_id);
  proof.handoff={source_run:run.id,target_run:targets[0].id,denied:true,idempotent:true};await save();console.log("HANDOFF_OK: native cross-chat invocation, denial, no copied history, one receipt and return summary");
 }
 if(phase==="side-reset"){
  const main=await finished(await send(proof.project,proof.ceo,"Use enterprise chat_btw once with request_id=side-create and task=Reply exactly SIDE_TOOLS_OK without invoking other tools. Then report the side_chat_id. Do not call reset yet."));assert.equal(main.status,"succeeded",main.error);
  const side=await until(async()=>{const s=await state();return s.runs.find(r=>r.group_id===proof.project&&r.side_chat_id&&r.status==="succeeded");});
  assert.notEqual(side.native_session_id,main.native_session_id);
  const before=await call("/sessions");
  const reset=await finished(await send(proof.project,proof.ceo,"Use enterprise chat_reset once with request_id=side-reset. It defers until this turn finishes. Reply briefly and finish immediately.",side.side_chat_id));assert.equal(reset.status,"succeeded",reset.error);
  await until(async()=>{const sessions=await call("/sessions");return sessions.filter(s=>s.group_id===proof.project&&s.side_chat_id===side.side_chat_id).every(s=>!s.active);});
  const after=await call("/sessions");for(const s of before.filter(s=>s.active&&s.side_chat_id!==side.side_chat_id)){assert(after.find(a=>a.id===s.id)?.active,"Side reset must preserve all other sessions");}
  const next=await finished(await send(proof.project,proof.ceo,"Reply FRESH_SIDE only. No tools.",side.side_chat_id));assert.notEqual(next.native_session_id,side.native_session_id);
  proof.side={main:main.native_session_id,side:side.native_session_id,fresh_side:next.native_session_id,reset_run:reset.id};await save();console.log("SIDE_OK: agent-created side session, deferred independent reset, main untouched");
 }
 if(phase==="scoped-action"){
  let s=await state();let group=s.groups.find(g=>g.id===proof.project);
  await call("/groups",{...group,scope_levels:[1],chat_lead_id:proof.ceo});
  const action=s.actions.find(a=>a.title==="Private PIC result")||await call("/actions",{id:crypto.randomUUID(),revision:0,group_id:proof.project,title:"Private PIC result",body:"Reply exactly PRIVATE_PIC_OK. Do not use tools.",assignee_id:proof.junior,planned_start:null});
  if(action.status!=="completed")await call(`/actions/${action.id}/invoke`,{});
  const done=await until(async()=>{const a=(await state()).actions.find(a=>a.id===action.id);if(a?.status==="failed")throw Error(a.error);return a?.status==="completed"?a:null;});
  s=await state();const children=s.runs.filter(r=>r.parent_run_id===done.run_id);assert(children.some(r=>r.kind==="delegate"&&r.agent_id===proof.junior&&r.status==="succeeded"));assert(children.some(r=>r.kind==="summary"&&r.status==="succeeded"));
  const messages=await call(`/groups/${proof.project}/messages`);assert(!messages.some(m=>m.sender===proof.junior));assert(messages.some(m=>m.sender===proof.ceo&&m.body.includes("PRIVATE_PIC_OK")));
  group=(await state()).groups.find(g=>g.id===proof.project);await call("/groups",{...group,scope_levels:null});
  const terminal=await call(`/agents/${proof.dedicated}/terminal`,{id:crypto.randomUUID(),command:"Get-Location",timeout_seconds:20});
  const result=await until(async()=>{const t=await call(`/agents/${proof.dedicated}/terminal/${terminal.id}`);return t.status!=="running"?t:null;});assert.equal(result.status,"completed",result.error);assert.equal(result.cwd,proof.projectWorkspace.path);
  proof.scoped_action={id:action.id,root:done.run_id,children:children.map(r=>({id:r.id,kind:r.kind})),project_terminal:result.id};await save();console.log("SCOPED_OK: lower-level PIC stays private; lead reports; profile terminal inherits project workdir");
 }
 if(phase==="remote"){
  proof.remote=[];
  for(const [host,root]of[["linux-example","/home/test-user"],["macos-example","/Users/test-user"]]){
   const ws=(await call("/workspaces/probe",{ssh_host:host,path:`${root}/.local/share/agentic-enterprise/workspaces/connection-demo`})).workspace;
   const group=await call("/groups",{id:"",name:`Remote project ${host}`,description:"Remote project tools acceptance",project:{workdir:ws,members:[]}});
   const ceo=(await state()).agents.find(a=>a.id===proof.ceo);
   const agent=await call("/agents",{...ceo,id:"",name:`Project ${host}`,project_id:group.id,reports_to:null,workdir:null,model:"gpt-5.6-luna",reasoning:"low"});
   const message=await send(group.id,agent.id,"Use enterprise workspace_list and action_list. Report your project workdir from the returned data. Do not create work or invoke another agent. Finish with REMOTE_PROJECT_TOOLS_OK.");
   const run=await finished(message);assert.equal(run.status,"succeeded",run.error);assert(run.remote_pid>0);assert.equal(run.cwd,ws.path);assert(run.output.includes("REMOTE_PROJECT_TOOLS_OK"));
   const events=await call(`/runs/${run.id}/events`);assert(events.some(e=>e.kind==="run.output"&&String(e.payload.line).includes("workspace_list")),"Native remote CLI must call MCP");
   proof.remote.push({host,run_id:run.id,remote_pid:run.remote_pid,cwd:run.cwd,native_session:run.native_session_id});await save();console.log(`REMOTE_OK: ${host} native Codex, project workdir, scoped MCP`);
  }
 }
 if(phase==="lifecycle"){
  const s=await state();const group=await call("/groups",{id:"",name:"Archive schedule proof",description:"Lifecycle test",project:{workdir:proof.projectWorkspace,members:[{agent_id:proof.ceo,manager_id:null}]}});
  const a=await call("/actions",{id:crypto.randomUUID(),revision:0,group_id:group.id,title:"Paused by archive",body:"Must not run without re-planning",assignee_id:proof.ceo,planned_start:new Date(Date.now()+3600000).toISOString()});
  await call(`/groups/${group.id}/archive`,{});await call(`/groups/${group.id}/restore`,{});
  const after=(await state()).actions.find(i=>i.id===a.id);assert.equal(after.status,"backlog");assert.equal(after.planned_start,null);assert.equal(after.run_id,null);
  assert.equal((await request.post("/api/actions",{data:{id:a.id,revision:0,group_id:group.id,title:"stale",body:"stale",assignee_id:proof.ceo,planned_start:null}})).status(),400);
  const ownerToken=(await fs.readFile(path.join(org,".state/owner.key"),"utf8")).trim();assert.equal((await request.post("/mcp",{headers:{Authorization:`Bearer ${ownerToken}`},data:{jsonrpc:"2.0",id:1,method:"tools/list"}})).status(),401);
  const before=await call("/sessions");const main=await finished(await send(proof.project,proof.ceo,"Use enterprise chat_reset with request_id=main-reset. Report it is pending and finish immediately. No other tools."));assert.equal(main.status,"succeeded",main.error);
  await until(async()=>{const sessions=await call("/sessions");return sessions.filter(i=>i.group_id===proof.project).every(i=>!i.active);});
  const sessions=await call("/sessions");for(const other of before.filter(i=>i.active&&i.group_id!==proof.project)){assert(sessions.find(i=>i.id===other.id)?.active);}
  const projectAgent=s.agents.find(a=>a.id===proof.junior);await request.delete(`/api/agents/${projectAgent.id}`);await call(`/agents/${projectAgent.id}/restore`,{});assert((await state()).groups.find(g=>g.id===proof.project).project.members.some(m=>m.agent_id===projectAgent.id));
  proof.lifecycle={archived_action:a.id,main_reset:main.id,other_sessions_preserved:true,project_agent_restored:true};await save();console.log("LIFECYCLE_OK: archive unschedules, stale edits denied, MCP rejects owner token, group reset isolation, project-agent restore");
 }
 if(phase==="auto-tools"){
  const actionId=crypto.randomUUID();
  const message=await call("/messages",{id:crypto.randomUUID(),group_id:proof.project,recipients:[],body:`Handle this yourself using enterprise MCP. Create one action with action_save: request_id=auto-save, id=${actionId}, revision=0, group_id=${proof.project}, title=Agent invokes action, body=Reply exactly AGENT_INVOKED_OK. No tools., assignee_id=${proof.dedicated}, planned_start=null. Then invoke it using action_invoke request_id=auto-invoke, id=${actionId}. Return your required routing JSON with delegations empty; this work was already assigned by the tool.`,reply_to:null,artifacts:[]});
  const run=await finished(message);assert.equal(run.kind,"coordinator");assert.equal(run.status,"succeeded",run.error);
  const done=await until(async()=>{const item=(await state()).actions.find(a=>a.id===actionId);if(item?.status==="failed")throw Error(item.error);return item?.status==="completed"?item:null;});
  assert.equal(done.created_by,proof.ceo);proof.auto_tools={coordinator:run.id,action:actionId,worker:done.run_id};await save();console.log("AUTO_TOOLS_OK: untagged owner chat → coordinator MCP → assigned agent action completed");
 }
 if(phase==="failure"){
  const ws=await workspace(`failure-${crypto.randomUUID()}`);
  const group=await call("/groups",{id:"",name:"Missing project directory proof",description:"Failure handling",project:{workdir:ws,members:[{agent_id:proof.ceo,manager_id:null}]}});
  const action=await call("/actions",{id:crypto.randomUUID(),revision:0,group_id:group.id,title:"Missing directory",body:"Must not execute after the directory disappears",assignee_id:proof.ceo,planned_start:new Date(Date.now()+4000).toISOString()});
  await fs.rmdir(ws.path); // This is the empty directory created by this test.
  const failure=await until(async()=>{const a=(await state()).actions.find(a=>a.id===action.id);return a?.status==="failed"?a:null;});
  assert.match(failure.error,/does not exist|directory/i);assert.equal(failure.run_id,null);
  await fs.mkdir(ws.path);await call(`/groups/${group.id}/archive`,{});
  proof.failure={action:action.id,error:failure.error,no_run_created:true};await save();console.log("FAILURE_OK: missing project directory fails visibly without creating a run");
 }
 if(phase==="screens"){
  await page.goto(`/projects/${proof.project}/structure`);await expect(page.locator(`.org-card[data-agent-id="${proof.dedicated}"]`).getByText("Project Specialist",{exact:true})).toBeVisible();await page.screenshot({path:path.join(dir,"project-structure.png")});
  await page.goto("/actions");await expect(page.getByRole("heading",{name:"Action board",exact:true})).toBeVisible();await page.screenshot({path:path.join(dir,"action-table.png")});
  await page.getByRole("button",{name:"Calendar",exact:true}).click();await expect(page.locator(".action-calendar")).toBeVisible();await page.waitForTimeout(250);await page.screenshot({path:path.join(dir,"action-calendar.png")});
  const mobile=await browser.newContext({baseURL:base,viewport:{width:390,height:844}});await mobile.addCookies(await context.cookies());const phone=await mobile.newPage();await phone.goto("/actions");await expect(phone.getByRole("heading",{name:"Action board",exact:true})).toBeVisible();assert(await phone.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await phone.screenshot({path:path.join(dir,"action-mobile.png")});await mobile.close();
  console.log("SCREENS_OK: desktop structure and board, readable mobile action cards");
 }
 assert.deepEqual(errors,[]);proof.browser_errors=errors;await save();
}catch(e){await page.screenshot({path:path.join(dir,`failure-${phase}.png`)});throw e;}
finally{await browser.close();}
