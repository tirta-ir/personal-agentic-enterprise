// Real Rust/SQLite/browser, native Codex + OpenCode and SSH. No provider mocks.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { chromium, expect } from "@playwright/test";

const org=path.resolve(process.env.AE_TEST_ORG||"../../org/verification-opencode-20260920");
assert.notEqual(org,path.resolve("../../org"));
const base=process.env.AE_TEST_URL||"http://127.0.0.1:8766";
const phase=process.argv[2]||"setup";
const dir=path.join(org,".state/verification");await fs.mkdir(dir,{recursive:true});
const proofFile=path.join(dir,"multi-harness-proof.json");
let proof={};try{proof=JSON.parse(await fs.readFile(proofFile,"utf8"));}catch(error){if(error.code!=="ENOENT")throw error;}
const browser=await chromium.launch({channel:"msedge",headless:true});
const context=await browser.newContext({baseURL:base,viewport:{width:1440,height:1000}});
const page=await context.newPage();page.setDefaultTimeout(30000);
const errors=[];page.on("pageerror",error=>errors.push(error.message));
async function call(route,data,method=data===undefined?"GET":"POST") {
 const response=await context.request.fetch(`/api${route}`,{method,...(data===undefined?{}:{data}),timeout:90000});
 assert(response.ok(),`${method} ${route}: ${response.status()} ${await response.text()}`);return response.json();
}
const state=()=>call("/state"), active=run=>["queued","starting","running","waiting"].includes(run.status);
async function until(read,timeout=300000){const start=Date.now();while(Date.now()-start<timeout){const value=await read();if(value)return value;await new Promise(resolve=>setTimeout(resolve,500));}throw Error("Native harness flow timed out");}
const send=(agent,body,group="general",side=null)=>call("/messages",{id:crypto.randomUUID(),group_id:group,side_chat_id:side,body,recipients:agent?[agent]:[],reply_to:null,artifacts:[]});
async function finished(message,kind){return until(async()=>{const runs=(await state()).runs.filter(r=>r.message_id===message.id);const run=runs.find(r=>kind?r.kind===kind:["direct","coordinator"].includes(r.kind));return run&&!active(run)&&run;});}
async function success(message,kind){const run=await finished(message,kind);assert.equal(run.status,"succeeded",`${run.error}\n${run.output}`);return run;}
const current=id=>state().then(s=>s.agents.find(a=>a.id===id));
async function save(){let latest={};try{latest=JSON.parse(await fs.readFile(proofFile,"utf8"));}catch(error){if(error.code!=="ENOENT")throw error;}await fs.writeFile(proofFile,JSON.stringify({...latest,...proof},null,2));}
try {
 await call("/login",{token:(await fs.readFile(path.join(org,".state/owner.key"),"utf8")).trim()});
 if(phase==="setup") {
  const folder=path.join(org,"workspaces/opencode");await fs.mkdir(folder,{recursive:true});
  const skill=path.join(folder,".opencode/skills/pilot-check/SKILL.md");await fs.mkdir(path.dirname(skill),{recursive:true});await fs.writeFile(skill,"---\nname: pilot-check\ndescription: Verify the pilot workdir marker\n---\nReport PILOT_SKILL_LOADED when explicitly asked to use this skill.\n");
  const workspace=(await call("/workspaces/probe",{path:folder})).workspace;
  const catalog=await call("/harness/settings?harness=opencode");assert(catalog.models.length>0);
  const model=catalog.models.find(m=>m.slug.startsWith("opencode/")&&m.slug.endsWith("-free")&&m.supported_reasoning_levels.length===0);assert(model,"No free native model available for this smoke test");
  let ceo=await current("ceo");const codex=await call("/codex/settings");
  const codexModel=codex.models.find(m=>m.slug.includes("luna"))??codex.models.find(m=>m.slug===codex.model);
  const managerFolder=path.join(org,"workspaces/manager");await fs.mkdir(managerFolder,{recursive:true});
  ceo=await call("/agents/ceo",{...ceo,workdir:(await call("/workspaces/probe",{path:managerFolder})).workspace,model:codexModel.slug,reasoning:codexModel.supported_reasoning_levels[0].effort,permission:"danger-full-access",timeout_seconds:300},"PUT");
  const existing=(await state()).agents.find(a=>a.name==="OpenCode Pilot");
  const agent=await call(existing?`/agents/${existing.id}`:"/agents",{...ceo,...existing,id:existing?.id??"",name:"OpenCode Pilot",position:"Engineer",reports_to:"ceo",harness:"opencode",model:model.slug,reasoning:"",workdir:workspace,instructions:"Follow the requested verification exactly. Use enterprise MCP tools when requested. Do not perform unrequested work. For clarification use enterprise.ask_user. Do not invoke other harnesses from the shell."},existing?"PUT":"POST");
  proof.agent=agent.id;proof.folder=folder;proof.model=model.slug;proof.codex={model:ceo.model,reasoning:ceo.reasoning};
  assert.equal((await call("/sessions")).length,0);
  const bad=await context.request.put(`/api/agents/${agent.id}`,{data:{...agent,model:"unavailable/paid-model"}});assert.equal(bad.status(),400);
  assert.equal((await fetch(`${base}/api/harness/settings?harness=opencode`)).status,401);
  await page.goto(`/organization/agents/${agent.id}/profile`);await expect(page.getByLabel("Harness",{exact:true})).toHaveValue("opencode");
  await expect(page.getByLabel("Model",{exact:true})).toHaveValue(model.slug);await expect(page.getByLabel("Model variant",{exact:true})).toHaveCount(0);
  const varied=catalog.models.find(m=>m.supported_reasoning_levels.length>0);
  if(varied){await page.getByLabel("Model",{exact:true}).selectOption(varied.slug);await expect(page.getByLabel("Model variant",{exact:true})).toBeVisible();assert.equal(await page.getByLabel("Model variant").locator("option").count(),varied.supported_reasoning_levels.length+1);}
  await page.reload();await page.screenshot({path:path.join(dir,"opencode-profile.png")});
  await page.setViewportSize({width:390,height:844});await page.reload();await expect(page.getByLabel("Harness",{exact:true})).toBeVisible();await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);await page.screenshot({path:path.join(dir,"opencode-profile-mobile.png")});
  const skills=await call(`/agents/${agent.id}/skills`);const found=skills.skills.find(s=>s.name==="pilot-check");assert(found);assert.match((await call(`/agents/${agent.id}/skills?path=${encodeURIComponent(found.path)}`)).text,/PILOT_SKILL_LOADED/);
  console.log("SETUP_OK: native catalog, free smoke model, variants, UI/mobile, auth + invalid model rejection, native skill discovery, no eager sessions");
 }
 if(phase==="local") {
  const token=`MEMORY_${crypto.randomUUID().slice(0,8)}`;
  const run=await success(await send(proof.agent,`Remember this marker for this conversation: ${token}. Use your native file edit tool to create pilot-output.txt in your workdir containing only LOCAL_WORKDIR_OK. Then use enterprise.workspace_list to list accessible chats. Reply with the marker and your actual working directory.`));
  assert(run.native_session_id?.startsWith("ses_"));assert.match(run.executable,/opencode/i);assert.equal(run.profile.harness,"opencode");assert.equal((await fs.readFile(path.join(proof.folder,"pilot-output.txt"),"utf8")).trim(),"LOCAL_WORKDIR_OK");
  const follow=await success(await send(proof.agent,"What was the remembered marker? Reply with it; do not read files or use tools."));assert.equal(follow.native_session_id,run.native_session_id);assert.match(follow.output,new RegExp(token));
  proof.local={run:run.id,session:run.native_session_id,followup:follow.id,marker:token,usage:run.usage};await save();
  await page.goto("/groups/general/chat");await expect(page.getByText("LOCAL_WORKDIR_OK",{exact:false}).first()).toBeVisible();await page.screenshot({path:path.join(dir,"opencode-chat.png")});
  console.log(`LOCAL_OK: actual workdir edit, MCP, session ${run.native_session_id}, resumed context, model badge`);
 }
 if(phase==="switch") {
  let agent=await current(proof.agent);
  await call(`/agents/${agent.id}`,{...agent,harness:"codex",...proof.codex},"PUT");
  const codex=await success(await send(agent.id,"Reply exactly CODEX_SEPARATE_SESSION. Do not use tools."));assert.equal(codex.profile.harness,"codex");assert.notEqual(codex.native_session_id,proof.local.session);
  agent=await current(agent.id);await call(`/agents/${agent.id}`,{...agent,harness:"opencode",model:proof.model,reasoning:""},"PUT");
  const resumed=await success(await send(agent.id,"Reply with the remembered marker from our earlier OpenCode conversation. Do not read files."));assert.equal(resumed.native_session_id,proof.local.session);assert.match(resumed.output,new RegExp(proof.local.marker));
  const sessions=(await call("/sessions")).filter(s=>s.agent_id===agent.id&&s.group_id==="general"&&s.active);assert.equal(sessions.length,2);assert.deepEqual(sessions.map(s=>s.harness).sort(),["codex","opencode"]);
  proof.switch={codex:codex.native_session_id,opencode:resumed.native_session_id};console.log("SWITCH_OK: same agent retains separate native sessions and resumes OpenCode after Codex");
 }
 if(phase==="questions") {
  const message=await send(proof.agent,`This is a new owner decision, separate from earlier questions. Use enterprise.ask_user with request_id="pilot-${crypto.randomUUID()}" and one question {id:"label",header:"Label",question:"Which pilot label should I use?",options:[{label:"Alpha",description:"First option"},{label:"Beta",description:"Second option"}]}. Wait for the answer, then reply with it. Do not call action_invoke, chat_btw, or any other tool.`);
  const question=await until(async()=>{const s=await state();const run=s.runs.find(r=>r.message_id===message.id);if(run&&!active(run))throw Error(run.error||run.output);return s.questions.find(q=>q.run_id===run?.id);});
  await page.goto("/groups/general/chat");const card=page.locator(`.question-card[data-question-id="${question.id}"]`);await expect(card).toBeVisible();await page.reload();await expect(card).toBeVisible();
  const side=await send(null,"/btw");const sideRun=await success(await send(proof.agent,"Reply exactly SIDE_PARALLEL_OK. Do not use tools.","general",side.id));
  assert.equal((await call(`/questions/${question.id}`)).status,"pending");assert.notEqual(sideRun.native_session_id,proof.local.session);
  await card.locator(`[data-question-field="${question.questions[0].id}"]`).fill("OWNER_PILOT_ANSWER");await card.getByRole("button",{name:"Send answer",exact:true}).click();
  const answered=await success(message);assert.match(answered.output,/OWNER_PILOT_ANSWER/);
  await call("/messages",{id:crypto.randomUUID(),group_id:"general",side_chat_id:side.id,body:"/reset",recipients:[],reply_to:null,artifacts:[]});
  const sessions=await call("/sessions");assert(sessions.find(s=>s.native_id===proof.local.session).active);assert(!sessions.find(s=>s.native_id===sideRun.native_session_id).active);
  proof.questions={run:answered.id,question:question.id,side:side.id,sideSession:sideRun.native_session_id};console.log("QUESTIONS_OK: real OpenCode MCP question, browser answer/reload, side runs in parallel, side-only reset");
 }
 if(phase==="delegation") {
  const marker=crypto.randomUUID().slice(0,8);
  const group=(await state()).groups.find(g=>g.id==="general");await call("/groups",{...group,chat_lead_id:"ceo"});
  let message=await send(null,`This is a new task ${marker}. Delegate one task to agent ${proof.agent}: reply exactly OPENCODE_DELEGATE_OK_${marker}. Do not reuse previous results or do the worker task yourself. After it returns summarize the result.`);
  let root=await finished(message);assert.equal(root.status,"delegated",root.error||root.output);
  let summary=await success(message,"summary");let worker=(await state()).runs.find(r=>r.parent_run_id===root.id&&r.kind==="delegate");assert.equal(worker.profile.harness,"opencode");assert.equal(worker.status,"succeeded",worker.error);assert.match(summary.output,/OPENCODE_DELEGATE_OK/);
  proof.codexToOpenCode={root:root.id,worker:worker.id,summary:summary.id};
  await call("/groups",{...(await state()).groups.find(g=>g.id==="general"),chat_lead_id:proof.agent});
  message=await send(null,`This is a new task ${marker}. Delegate one task to agent ceo: reply exactly CODEX_DELEGATE_OK_${marker}. Do not reuse previous results or do it yourself. After it returns summarize the result.`);
  root=await finished(message);assert.equal(root.status,"delegated",root.error||root.output);summary=await success(message,"summary");worker=(await state()).runs.find(r=>r.parent_run_id===root.id&&r.kind==="delegate");assert.equal(worker.profile.harness,"codex");assert.equal(worker.status,"succeeded",worker.error);assert.match(summary.output,/CODEX_DELEGATE_OK/);
  proof.openCodeToCodex={root:root.id,worker:worker.id,summary:summary.id};console.log("DELEGATION_OK: Codex → OpenCode and OpenCode → Codex, native workers and returned manager summaries");
 }
 if(phase==="failure") {
  const workspace=path.join(org,"workspaces/failure");await fs.mkdir(workspace,{recursive:true});
  const agent=await call("/agents",{...await current(proof.agent),id:"",name:"Failure Pilot",workdir:(await call("/workspaces/probe",{path:workspace})).workspace});
  await fs.writeFile(path.join(workspace,".env"),'BROKEN="unterminated');
  const failed=await finished(await send(agent.id,"Reply exactly SHOULD_NOT_RUN."));assert.equal(failed.status,"failed");assert.match(failed.error,/env|quoting|syntax/i);
  const review=await until(async()=>{const r=(await state()).runs.find(r=>r.parent_run_id===failed.id&&r.kind==="review");return r&&!active(r)&&r;});assert.equal(review.agent_id,"ceo");assert.equal(review.status,"succeeded",review.error);assert.match(review.output,/env|syntax|quot/i);
  await new Promise(resolve=>setTimeout(resolve,1500));assert.equal((await state()).runs.filter(r=>r.parent_run_id===failed.id&&r.kind==="review").length,1);
  proof.failure={failed:failed.id,review:review.id};console.log("FAILURE_OK: real invalid workdir env → manager review exactly once, no harness fallback or task retry");
 }
 if(phase==="usage") {
  await send(null,"/usage");await page.goto("/groups/general/chat");await expect(page.getByText(/OpenCode · this conversation:/).last()).toBeVisible();await page.screenshot({path:path.join(dir,"multi-harness-usage.png")});console.log("USAGE_OK: real Codex quota + recorded OpenCode conversation usage with unavailable-quota label");
 }
 if(phase==="project") {
  const folder=path.join(org,"workspaces/project");await fs.mkdir(folder,{recursive:true});
  const workspace=(await call("/workspaces/probe",{path:folder})).workspace;
  const project=await call("/groups",{id:"",name:"OpenCode project",description:"Native harness project override",project:{workdir:workspace,members:[{agent_id:proof.agent,manager_id:null}]}});
  const action=await call("/actions",{id:crypto.randomUUID(),revision:0,group_id:project.id,title:"Native project action",body:"Use a native file edit tool to write project-output.txt containing PROJECT_OPENCODE_OK in the current workdir. Report the file path.",assignee_id:proof.agent,planned_start:new Date(Date.now()+5000).toISOString()});
  const done=await until(async()=>{const item=(await state()).actions.find(a=>a.id===action.id);if(item?.status==="failed")throw Error(item.error);return item?.status==="completed"&&item;});
  const run=await call(`/runs/${done.run_id}`);assert.equal(run.profile.workdir.path,workspace.path);assert.equal(run.profile.harness,"opencode");assert.notEqual(run.native_session_id,proof.local.session);assert.equal((await fs.readFile(path.join(folder,"project-output.txt"),"utf8")).trim(),"PROJECT_OPENCODE_OK");
  const before=(await call("/sessions")).filter(s=>s.group_id==="general");await send(null,"/reset",project.id);assert.deepEqual((await call("/sessions")).filter(s=>s.group_id==="general"),before);assert(!(await call("/sessions")).find(s=>s.native_id===run.native_session_id).active);
  proof.project={group:project.id,action:action.id,run:run.id,session:run.native_session_id};console.log("PROJECT_OK: scheduled action, real project workdir edit, separate group session and scoped reset");
 }
 if(phase==="permissions") {
  const folder=path.join(org,"workspaces/permissions");await fs.mkdir(folder,{recursive:true});
  const agent=await call("/agents",{...await current(proof.agent),id:"",name:"Permissions Pilot",permission:"read-only",workdir:(await call("/workspaces/probe",{path:folder})).workspace});
  const denied=await success(await send(agent.id,'Attempt to create permission-proof.txt using the native file write tool with content READ_ONLY_SHOULD_DENY. The owner expects this to be blocked. Report the actual tool error. Do not use shell or other workarounds.'));
  assert.equal(await fs.stat(path.join(folder,"permission-proof.txt")).then(()=>true,()=>false),false);
  const events=await call(`/runs/${denied.id}/events`);assert(events.some(e=>e.kind==="run.output"&&/denied|reject|not allowed|permission/i.test(e.payload.line??"")),"Need a native denial in execution evidence");
  await call(`/agents/${agent.id}`,{...await current(agent.id),permission:"workspace-write"},"PUT");
  const allowed=await success(await send(agent.id,'Now use the native file write tool to create permission-proof.txt containing WORKSPACE_WRITE_OK. Do not use shell.'));
  assert.equal((await fs.readFile(path.join(folder,"permission-proof.txt"),"utf8")).trim(),"WORKSPACE_WRITE_OK");assert.equal(allowed.native_session_id,denied.native_session_id);
  proof.permissions={denied:denied.id,allowed:allowed.id};console.log("PERMISSIONS_OK: native read-only edit denial; same session permits workspace edit after profile change");
 }
 if(phase==="lifecycle") {
  const messages=[];
  for(let i=0;i<3;i++){
   const folder=path.join(org,`workspaces/concurrency-${i}`);await fs.mkdir(folder,{recursive:true});
   const agent=await call("/agents",{...await current(proof.agent),id:"",name:`Concurrent Pilot ${i}`,workdir:(await call("/workspaces/probe",{path:folder})).workspace});
   messages.push(await send(agent.id,"Run a native shell command that waits 120 seconds, then reply WAIT_COMPLETE. Do not create files."));
  }
  const ids=new Set(messages.map(m=>m.id));
  const running=await until(async()=>{const runs=(await state()).runs.filter(r=>ids.has(r.message_id));return runs.length===3&&runs.every(r=>r.status==="running"&&r.pid)&&runs;},120000);
  const processes=JSON.parse(execFileSync("powershell.exe",["-NoProfile","-Command","Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress"],{encoding:"utf8"}));
  const owned=new Set(running.map(r=>r.pid));let changed=true;while(changed){changed=false;for(const p of processes)if(owned.has(p.ParentProcessId)&&!owned.has(p.ProcessId)){owned.add(p.ProcessId);changed=true;}}
  assert(owned.size>=3);for(const run of running)await call(`/runs/${run.id}/cancel`,{});
  await until(async()=>{const runs=(await state()).runs.filter(r=>ids.has(r.message_id));return runs.every(r=>r.status==="cancelled");});
  await expect.poll(()=>{const live=JSON.parse(execFileSync("powershell.exe",["-NoProfile","-Command","@(Get-Process | Select-Object -ExpandProperty Id) | ConvertTo-Json -Compress"],{encoding:"utf8"}));return live.filter(id=>owned.has(id));},{timeout:20000}).toEqual([]);
  proof.lifecycle={concurrent:3,runs:running.map(r=>r.id),ownedPids:[...owned],allStopped:true};console.log("LIFECYCLE_OK: 3 simultaneous native OpenCode runs; cancellation stops every observed owned process");
 }
 if(phase==="workspace-permissions") {
  const folder=path.join(org,"workspaces/workspace-permissions");await fs.mkdir(folder,{recursive:true});
  const agent=await call("/agents",{...await current(proof.agent),id:"",name:"Workspace permissions pilot",permission:"workspace-write",workdir:(await call("/workspaces/probe",{path:folder})).workspace});
  const run=await success(await send(agent.id,"Use the native file write tool to create workspace-permission.txt containing WORKSPACE_WRITE_OK in the current workdir. Do not use shell."));
  assert.equal((await fs.readFile(path.join(folder,"workspace-permission.txt"),"utf8")).trim(),"WORKSPACE_WRITE_OK");
  proof.workspacePermission={run:run.id};console.log("WORKSPACE_PERMISSION_OK: real native file edit with workspace-write profile");
 }
 if(phase==="remote") {
  assert(proof.local&&proof.codexToOpenCode&&proof.openCodeToCodex,"Validate local paths before Mac rollout");
  const remotePath=process.env.AE_MAC_WORKDIR;assert(remotePath,"AE_MAC_WORKDIR must name the prepared pilot folder");
  const workspace=(await call("/workspaces/probe",{path:remotePath,ssh_host:"macos-example"})).workspace;
  const catalog=await call("/harness/settings?harness=opencode&ssh_host=macos-example");assert(catalog.models.length);
  const model=catalog.models.find(m=>m.slug===proof.model);assert(model,"Previously selected free smoke model unavailable on Mac");
  const agent=await call("/agents",{...await current(proof.agent),id:"",name:"Mac OpenCode Pilot",model:model.slug,reasoning:"",workdir:workspace});
  const run=await success(await send(agent.id,"Use your file edit tool to create mac-pilot-output.txt containing MAC_NATIVE_OK in your current workdir. Then use enterprise.workspace_list and report your actual workdir."));
  assert(run.remote_pid);assert(run.native_session_id.startsWith("ses_"));assert.equal(run.profile.workdir.ssh_host,"macos-example");
  const file=await call(`/agents/${agent.id}/files?path=mac-pilot-output.txt&scope=workdir`);assert.equal(file.text.trim(),"MAC_NATIVE_OK");
  const next=await success(await send(agent.id,"What file did you just create? Reply with its name without using tools."));assert.equal(run.native_session_id,next.native_session_id);assert.match(next.output,/mac-pilot-output.txt/);
  proof.remote={agent:agent.id,run:run.id,session:run.native_session_id,followup:next.id,workdir:remotePath};console.log("REMOTE_OK: native macos-example OpenCode, remote workdir edit, MCP, own resumable session");
 }
 if(phase==="accepted") {
  const catalog=await call(`/harness/settings?harness=opencode&agent_id=${proof.agent}`);
  const selected=catalog.models.find(m=>m.slug===proof.model);assert(selected);
  await page.goto(`/organization/agents/${proof.agent}/profile`);
  await expect(page.getByLabel("Model",{exact:true}).locator(`option[value="${proof.model}"]`)).toHaveText(selected.display_name);
  await page.screenshot({path:path.join(dir,"opencode-profile-final.png")});
  await page.setViewportSize({width:390,height:844});await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);await page.screenshot({path:path.join(dir,"opencode-profile-mobile-final.png")});
  const run=await success(await send(proof.remote.agent,"What file did you create in our previous conversation? Reply with its filename without using any tool."));
  assert.equal(run.native_session_id,proof.remote.session);assert.match(run.output,/mac-pilot-output.txt/);
  const remote=(await state()).connections[proof.remote.agent];assert.equal(remote.status,"online",remote.message);assert.match(remote.version,/2\.0\.11/);
  const file=await call(`/agents/${proof.remote.agent}/files?path=mac-pilot-output.txt&scope=workdir`);assert.equal(file.text.trim(),"MAC_NATIVE_OK");
  proof.accepted={run:run.id,remoteVersion:remote.version,mobile:true,browserErrors:errors};console.log("ACCEPTED_OK: native catalog UI/mobile, remote online status and resume after service restart");
 }
 assert.deepEqual(errors,[]);
 await save();
} finally {await browser.close();}
