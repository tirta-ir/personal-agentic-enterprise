// Real native Codex / MCP / SQLite / browser acceptance; never use the owner's org.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";

const org=path.resolve(process.env.AE_TEST_ORG||"../../org/verification-questions-20260920");
assert.notEqual(org,path.resolve("../../org"));
const base=process.env.AE_TEST_URL||"http://10.69.0.102:8766", phase=process.argv[2]||"local";
const dir=path.join(org,".state/verification");await fs.mkdir(dir,{recursive:true});
const proofFile=path.join(dir,"questions-proof.json");
let proof={};try{proof=JSON.parse(await fs.readFile(proofFile,"utf8"));}catch(e){if(e.code!=="ENOENT")throw e;}
const browser=await chromium.launch({channel:"msedge",headless:true});
const context=await browser.newContext({baseURL:base,viewport:{width:1440,height:1000}});
const page=await context.newPage();page.setDefaultTimeout(20000);
const errors=[];page.on("pageerror",e=>errors.push(e.message));
async function call(route,data,method=data===undefined?"GET":"POST"){
 const response=await context.request.fetch(`/api${route}`,{method,...(data===undefined?{}:{data})});
 assert(response.ok(),`${route}: ${response.status()} ${await response.text()}`);return response.json();
}
const state=()=>call("/state"), active=r=>["queued","starting","running","waiting"].includes(r.status);
async function until(read,timeout=180000){const start=Date.now();while(Date.now()-start<timeout){const value=await read();if(value)return value;await new Promise(resolve=>setTimeout(resolve,500));}throw Error("Native question flow timed out");}
const send=(agent,body,recipients=[agent.id])=>call("/messages",{id:crypto.randomUUID(),group_id:"general",side_chat_id:null,body,recipients,reply_to:null,artifacts:[]});
const questionFor=message=>until(async()=>{const s=await state();const runs=s.runs.filter(r=>r.message_id===message.id);const question=s.questions.find(q=>runs.some(r=>r.id===q.run_id));if(runs.length&&runs.every(r=>!active(r)))throw Error(`Run finished before asking: ${runs.map(r=>r.error||r.output).join(" ")}`);return question;});
const finished=id=>until(async()=>{const run=await call(`/runs/${id}`);return !active(run)&&run;});
const form=q=>page.locator(`.question-card[data-question-id="${q.id}"]`);
async function openQuestion(q){await page.goto(`/groups/general/chat${q.side_chat_id?`?side=${q.side_chat_id}`:""}`);await expect(page.locator(`[data-question-id="${q.id}"] [data-question-field="${q.questions[0].id}"]`)).toBeVisible();}
async function answer(q,text){await openQuestion(q);for(const field of q.questions)await page.locator(`[data-question-id="${q.id}"] [data-question-field="${field.id}"]`).fill(text);await form(q).getByRole("button",{name:"Send answer",exact:true}).click();await until(async()=>(await call(`/questions/${q.id}`)).status==="answered");}
try{
 await call("/login",{token:(await fs.readFile(path.join(org,".state/owner.key"),"utf8")).trim()});
 const folder=path.join(org,"workspaces/questions");await fs.mkdir(folder,{recursive:true});
 const workspace=(await call("/workspaces/probe",{path:folder})).workspace;
 let ceo=(await state()).agents.find(a=>a.id==="ceo");
 if(phase==="local"){
  ceo=await call("/agents/ceo",{...ceo,workdir:workspace,permission:"danger-full-access",model:"gpt-5.6-luna",reasoning:"low",timeout_seconds:60,instructions:"Follow the exact task. Ask only when explicitly requested. Use enterprise tools for questions. Do not delegate or create extra work."},"PUT");
  const main=await send(ceo,'Call enterprise.ask_user with request_id=report-format and exactly two separate question objects: {id:"format",header:"Format",question:"Which report format?",options:[{label:"Markdown",description:"Formatted text"},{label:"Plain text",description:"Simple text"}]} and {id:"extra",header:"Extra requirement",question:"What extra requirement should I include?",options:[]}. Do not combine them into one question. Wait for my answers. After receiving them, write question-result.txt in your current workdir containing both answers, then report done. Do not assume the choices.');
  const q=await questionFor(main), began=Date.now();assert.equal(q.questions.length,2);assert.equal(q.side_chat_id,null);
  assert.equal((await fetch(`${base}/api/questions/${q.id}`)).status,401);
  assert.equal((await fetch(`${base}/api/questions/${q.id}/answer`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({answers:{}})})).status,401);
  assert.equal((await context.request.post(`/api/questions/${q.id}/answer`,{data:{answers:{}}})).status(),400);
  await openQuestion(q);await expect(page.getByRole("button",{name:/Chat activity: Needs your answer/})).toBeVisible();
  await page.reload();await expect(page.locator(`[data-question-id="${q.id}"] [data-question-field="${q.questions[0].id}"]`)).toBeVisible();
  await page.screenshot({path:path.join(dir,"question-desktop.png")});
  await page.goto("/organization");await expect(page.locator(".question-notice")).toContainText("needs your answer");
  await page.locator(".question-notice button").click();await expect(page.locator(`[data-question-id="${q.id}"] [data-question-field="${q.questions[0].id}"]`)).toBeVisible();
  const queued=await send(ceo,"Reply exactly QUEUE_RESUMED. Do not ask a question or use tools.");
  await until(async()=>(await state()).runs.some(r=>r.message_id===queued.id&&r.status==="queued"));
  const side=await send(ceo,"/btw Ask me one question: which side-chat label should you use? Do not use tools other than the question tool. After I answer, repeat that label and finish.");
  const sq=await questionFor(side);assert(sq.side_chat_id);assert.notEqual(sq.run_id,q.run_id);
  await answer(sq,"SIDE_ANSWER_ONLY");const sideRun=await finished(sq.run_id);assert.equal(sideRun.status,"succeeded",sideRun.error);assert.match(sideRun.output,/SIDE_ANSWER_ONLY/);
  assert.equal((await call(`/questions/${q.id}`)).status,"pending");
  await new Promise(resolve=>setTimeout(resolve,Math.max(0,65000-(Date.now()-began))));
  assert.equal((await call(`/runs/${q.run_id}`)).status,"running","Question wait does not consume the 60s execution budget");
  await openQuestion(q);const card=form(q);const choice=card.getByRole("button",{name:/^Markdown/});await choice.click();
  const selected=q.questions.find(item=>item.options.some(option=>option.label.startsWith("Markdown")));assert(selected);
  const extra=q.questions.find(item=>item.id!==selected.id);await page.locator(`[data-question-id="${q.id}"] [data-question-field="${extra.id}"]`).fill("OWNER_REQUIREMENT_731");
  await card.getByRole("button",{name:"Send answer",exact:true}).click();
  const run=await finished(q.run_id);assert.equal(run.status,"succeeded",run.error);
  const result=await fs.readFile(path.join(folder,"question-result.txt"),"utf8");assert.match(result,/Markdown/);assert.match(result,/OWNER_REQUIREMENT_731/);
  const saved=await call(`/questions/${q.id}`);assert.equal(saved.status,"answered");
  assert.equal((await call(`/questions/${q.id}/answer`,{answers:saved.answers})).answered_at,saved.answered_at);
  const changed=structuredClone(saved.answers);changed[extra.id].answers=["Changed"];
  assert.equal((await context.request.post(`/api/questions/${q.id}/answer`,{data:{answers:changed}})).status(),400);
  const queuedRun=await until(async()=>(await state()).runs.find(r=>r.message_id===queued.id&&!active(r)));assert.equal(queuedRun.status,"succeeded");
  assert.equal(run.native_session_id,queuedRun.native_session_id);assert.notEqual(run.native_session_id,sideRun.native_session_id);
  await page.reload();await expect(page.getByText("Answered · returned to the agent",{exact:true})).toBeVisible();
  proof.local={main_run:run.id,main_session:run.native_session_id,side_run:sideRun.id,side_session:sideRun.native_session_id,queue_run:queuedRun.id,question_id:q.id,wait_ms:Date.now()-began,output_file:path.join(folder,"question-result.txt")};
  console.log("LOCAL_OK: native ask/answer, options/free text, reload, auth/validation, >60s wait, independent side, queue resumes in same session");
 }
 if(phase==="cancel"||phase==="restart-prepare"){
  const message=await send(ceo,"Ask me one question asking which label to use and wait. After answering repeat the answer. Do not use other tools.");const q=await questionFor(message);
  if(phase==="restart-prepare"){proof.restart={question:q.id,run:q.run_id};console.log(`RESTART_READY: ${q.id}`);}
  else{
   await page.setViewportSize({width:390,height:844});await openQuestion(q);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
   await page.screenshot({path:path.join(dir,"question-mobile.png")});await form(q).getByRole("button",{name:"Stop run",exact:true}).click();
   assert.equal((await finished(q.run_id)).status,"cancelled");await until(async()=>(await call(`/questions/${q.id}`)).status!=="pending");
   const answers=Object.fromEntries(q.questions.map(item=>[item.id,{answers:["Too late"]}]));assert.equal((await context.request.post(`/api/questions/${q.id}/answer`,{data:{answers}})).status(),400);
   proof.cancel={question:q.id,run:q.run_id};console.log("CANCEL_OK: mobile question, stopped native run, stale answer rejected");
  }
 }
 if(phase==="restart-check"){
  const q=await call(`/questions/${proof.restart.question}`),run=await call(`/runs/${proof.restart.run}`);
  assert.equal(q.status,"interrupted");assert.equal(run.status,"interrupted");await page.goto("/groups/general/chat");await expect(page.getByText("Service restarted. Send a new message to continue this task.",{exact:true})).toBeVisible();
  assert.equal((await context.request.post(`/api/questions/${q.id}/answer`,{data:{answers:{}}})).status(),400);console.log("RESTART_OK: saved question interrupted, no replay or stale answer");
 }
 if(phase==="delegate"){
  const worker=await call("/agents",{...ceo,id:"",name:"Question Delegate",reports_to:ceo.id,workdir:workspace});
  const group=(await state()).groups.find(g=>g.id==="general");await call("/groups",{...group,scope_levels:[1],chat_lead_id:ceo.id});
  const item=await call("/actions",{id:crypto.randomUUID(),revision:0,group_id:"general",title:"Delegated clarification",body:"Ask the owner which delegated report label to use. After receiving the answer repeat it and finish. Do not do other work.",assignee_id:worker.id,planned_start:null});
  const action=await call(`/actions/${item.id}/invoke`,{});
  const q=await until(async()=>(await state()).questions.find(q=>q.agent_id===worker.id&&q.status==="pending"));
  assert(!(await state()).group_access.general.participant_ids.includes(worker.id));
  await answer(q,"DELEGATE_OWNER_ANSWER");const run=await finished(q.run_id);assert.equal(run.kind,"delegate");assert.equal(run.status,"succeeded",run.error);assert.match(run.output,/DELEGATE_OWNER_ANSWER/);
  await until(async()=>(await state()).actions.find(a=>a.id===item.id)?.status==="completed");
  const messages=await call("/groups/general/messages");assert(messages.some(m=>m.id===q.id&&m.sender==="system"));assert(!messages.some(m=>m.sender===worker.id));
  const ownerMessage=await send(ceo,"Ask me one question about which coordinator label to use. After answering, repeat the label. Do not delegate.",[]);
  const cq=await questionFor(ownerMessage);await answer(cq,"COORDINATOR_OWNER_ANSWER");const coordinator=await finished(cq.run_id);assert.equal(coordinator.kind,"coordinator");assert.equal(coordinator.status,"succeeded",coordinator.error);assert.match(coordinator.output,/COORDINATOR_OWNER_ANSWER/);
  proof.delegate={question:q.id,run:run.id,action:item.id,parent:action.run_id,coordinator:coordinator.id};console.log("DELEGATE_OK: private worker question and owner answer; no worker chat publication; untagged coordinator question");
 }
 if(phase==="remote"){
  proof.remote=[];
  for(const host of ["tencent-personal","mac-personal"]){
   const priorOrg=path.resolve("../../org/verification-collaboration-20260920/.state/verification/collaboration-proof.json");
   const remote=JSON.parse(await fs.readFile(priorOrg,"utf8")).remote.find(item=>item.host===host);
   const workdir=(await call("/workspaces/probe",{path:remote.cwd,ssh_host:host})).workspace;
   const agent=await call("/agents",{...ceo,id:"",name:`Question ${host}`,workdir,timeout_seconds:60});
   const message=await send(agent,"Ask me one free-text question asking which report label to use. Wait for my answer, then repeat it exactly and finish. Do not run shell commands or other tools.");const q=await questionFor(message);
   const began=Date.now();if(host==="tencent-personal")await new Promise(resolve=>setTimeout(resolve,65000));
   await answer(q,`ANSWER_${host}`);const run=await finished(q.run_id);assert.equal(run.status,"succeeded",run.error);assert.match(run.output,new RegExp(`ANSWER_${host}`));assert(run.remote_pid);
   proof.remote.push({host,run:run.id,question:q.id,remote_pid:run.remote_pid,native_session:run.native_session_id,wait_ms:Date.now()-began});console.log(`REMOTE_OK: ${host} native question and answer`);
  }
 }
 assert.deepEqual(errors,[]);proof.browser_errors=errors;await fs.writeFile(proofFile,JSON.stringify(proof,null,2));
}finally{await browser.close();}
