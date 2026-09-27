// Real browser, SQLite, native SSH and Codex acceptance. Never use the owner's org.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { chromium, expect } from "@playwright/test";

const org=path.resolve(process.env.AE_TEST_ORG||"../../org/verification-settings-20260920");
assert.notEqual(org,path.resolve("../../org"));
const base=process.env.AE_TEST_URL||"http://127.0.0.1:8766", phase=process.argv[2]||"project";
const dir=path.join(org,".state/verification");await fs.mkdir(dir,{recursive:true});
let proof={};try{proof=JSON.parse(await fs.readFile(path.join(dir,"settings-proof.json"),"utf8"));}catch(e){if(e.code!=="ENOENT")throw e;}
const browser=await chromium.launch({channel:"msedge",headless:true});
const context=await browser.newContext({baseURL:base,viewport:{width:1440,height:1000}});
const page=await context.newPage();page.setDefaultTimeout(30000);const errors=[];page.on("pageerror",e=>errors.push(e.message));
async function call(route,data,method=data===undefined?"GET":"POST") {const r=await context.request.fetch(`/api${route}`,{method,...(data===undefined?{}:{data}),timeout:90000});assert(r.ok(),`${route}: ${r.status()} ${await r.text()}`);return r.json();}
const state=()=>call("/state");
async function until(read,timeout=120000){const start=Date.now();while(Date.now()-start<timeout){const value=await read();if(value)return value;await new Promise(r=>setTimeout(r,400));}throw Error("Live flow timed out");}
try {
 await call("/login",{token:(await fs.readFile(path.join(org,".state/owner.key"),"utf8")).trim()});
 if(phase==="project"){
  const folder=path.join(org,"workspaces/project");await fs.mkdir(folder,{recursive:true});
  await page.goto("/");await page.getByRole("button",{name:"Add group or section",exact:true}).click();await page.getByRole("menuitem",{name:"Create project",exact:true}).click();
  const modal=page.getByRole("dialog");await expect(modal.getByRole("heading",{name:"Create a project"})).toBeVisible();
  assert.equal(await modal.getByRole("checkbox").count(),0);assert.equal(await modal.getByText("Project team and reporting structure",{exact:true}).count(),0);
  await modal.getByLabel("Name",{exact:true}).fill(`Structure acceptance ${Date.now()}`);await modal.getByLabel("Project workdir",{exact:true}).fill(folder);await modal.getByRole("button",{name:"Create project",exact:true}).click();
  await expect(page).toHaveURL(/\/projects\/.*\/structure$/);await expect(page.getByText("No agents yet. Add your first team member to begin.")).toBeVisible();
  const project=(await state()).groups.filter(g=>g.project&&g.name.startsWith("Structure acceptance")).at(-1);assert(project);assert.deepEqual(project.project.members,[]);assert.equal(project.chat_lead_id,null);
  await page.screenshot({path:path.join(dir,"project-empty-structure.png")});
  await page.getByLabel("Organization agent",{exact:true}).selectOption("ceo");await page.getByRole("button",{name:"Add to team",exact:true}).click();await page.getByRole("button",{name:"Save team",exact:true}).click();
  await until(async()=>(await state()).groups.find(g=>g.id===project.id).project.members.length===1);
  await page.getByRole("button",{name:"Create project agent",exact:true}).click();await page.getByLabel("Name",{exact:true}).fill("Project Specialist");await page.getByLabel("Position",{exact:true}).fill("Engineer");await page.getByRole("button",{name:"Create agent",exact:true}).click();
  await expect(page).toHaveURL(/\/projects\/.*\/structure\?agent=/);await page.getByRole("button",{name:"Close agent settings"}).click();await expect(page).toHaveURL(/\/projects\/.*\/structure$/);
  await page.getByLabel("Project manager for Project Specialist").selectOption("ceo");await page.getByRole("button",{name:"Save team",exact:true}).click();
  const specialist=await until(async()=>{const s=await state();return s.agents.find(a=>a.name==="Project Specialist"&&a.project_id===project.id&&a.reports_to==="ceo");});assert.equal(specialist.project_id,project.id);
  await page.reload();await expect(page.getByLabel("Project manager for Project Specialist")).toHaveValue("ceo");
  await page.getByLabel("Project manager for CEO").selectOption(specialist.id);await page.getByRole("button",{name:"Save team",exact:true}).click();await expect(page.getByRole("alert")).toContainText("cycle");await page.reload();
  await page.getByRole("button",{name:"Manage project",exact:true}).click();assert.equal(await page.getByRole("dialog").getByRole("checkbox").count(),0);await page.keyboard.press("Escape");
  await page.screenshot({path:path.join(dir,"project-team-desktop.png")});
  await page.locator(".org-chart-canvas").scrollIntoViewIfNeeded();await expect(page.locator(".react-flow__node")).toHaveCount(3);
  assert(await page.locator(".react-flow").evaluate(el=>el.getBoundingClientRect().height>250));await page.screenshot({path:path.join(dir,"project-chart.png")});
  await page.setViewportSize({width:390,height:844});await page.reload();await page.waitForLoadState("networkidle");assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:path.join(dir,"project-team-mobile.png")});
  proof.project={id:project.id,specialist:specialist.id,empty_on_create:true,structure_redirect:true,reporting_persisted:true,cycle_rejected:true};console.log("PROJECT_OK: empty create, Structure redirect, inline membership/reporting, project agent, reload, cycle error, mobile");
 }
 if(phase==="remote"){
  await page.goto("/settings/workstations");
  for(const alias of ["linux-example","macos-example"]){
   if(!(await state()).workstations.some(h=>h.id===alias)){await page.getByLabel("Import existing SSH alias").fill(alias);await page.getByRole("button",{name:"Import alias",exact:true}).click();await expect(page.getByLabel("Display name",{exact:true})).toHaveValue(alias);}
   else await page.getByRole("navigation",{name:"Saved workstations"}).getByRole("button",{name:new RegExp(alias)}).click();
   await page.getByRole("button",{name:"Test connection",exact:true}).click();await expect(page.getByRole("status").filter({hasText:"Connected"})).toBeVisible({timeout:60000});
  }
  await page.screenshot({path:path.join(dir,"workstation-settings-desktop.png")});
  await page.goto("/organization/agents/ceo/workdir");await page.getByLabel("Workstation",{exact:true}).selectOption("linux-example");assert.equal(await page.getByLabel("SSH host alias",{exact:true}).count(),0);
  await page.getByRole("button",{name:"Browse folders",exact:true}).click();await page.getByRole("button",{name:"Select folder",exact:true}).click();await page.getByRole("button",{name:/^(Attach|Change) workdir$/}).click();
  const ceo=await until(async()=>(await state()).agents.find(a=>a.id==="ceo"&&a.workdir?.ssh_host==="linux-example"));assert(ceo.workdir.path.startsWith("/"));
  const terminal=await call("/agents/ceo/terminal",{id:crypto.randomUUID(),command:"pwd"});const result=await until(async()=>{const r=await call(`/agents/ceo/terminal/${terminal.id}`);return r.status!=="running"&&r;});assert.equal(result.status,"completed",result.error);assert(result.output.includes(ceo.workdir.path));
  const response=await context.request.delete("/api/workstations/linux-example");assert.equal(response.status(),400);assert.match(await response.text(),/Detach/);
  await page.setViewportSize({width:390,height:844});await page.goto("/settings/workstations");await page.getByRole("navigation",{name:"Saved workstations"}).getByRole("button",{name:/linux-example/}).click();await page.waitForLoadState("networkidle");assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:path.join(dir,"workstation-settings-mobile.png")});
  proof.remote={hosts:["linux-example","macos-example"],agent:ceo.id,workdir:ceo.workdir.path,terminal:terminal.id};console.log("REMOTE_OK: import + SSH/Codex checks on both hosts, saved dropdown, remote folder picker, real pwd, in-use deletion blocked, mobile");
 }
 if(phase==="encrypted-key"){
  const config=execFileSync("ssh",["-G","linux-example"],{encoding:"utf8",stdio:["ignore","pipe","pipe"]});
  const first=key=>config.split(/\r?\n/).find(line=>line.startsWith(key+" ")).slice(key.length+1);
  const identities=config.split(/\r?\n/).filter(line=>line.startsWith("identityfile ")).map(line=>line.slice(13).replace(/^~/,process.env.USERPROFILE));
  let original;for(const file of identities){try{await fs.access(file);original=file;break;}catch(e){if(e.code!=="ENOENT")throw e;}}assert(original,"Existing identity file required for real encrypted-key acceptance");
  const key=path.join(org,".state/encrypted-test-key");await fs.copyFile(original,key);
  if(process.platform==="win32")execFileSync("icacls",[key,"/inheritance:r","/grant:r",`${process.env.USERDOMAIN}\\${process.env.USERNAME}:(F)`],{stdio:"pipe"});
  const secret=crypto.randomUUID();execFileSync("ssh-keygen",["-p","-q","-P","","-N",secret,"-f",key],{stdio:"pipe",timeout:10000});
  await page.goto("/settings/workstations");await page.getByRole("button",{name:"Add workstation",exact:true}).click();
  await page.getByLabel("Display name",{exact:true}).fill("Encrypted key acceptance");await page.getByLabel("Hostname",{exact:true}).fill(first("hostname"));await page.getByLabel("SSH port",{exact:true}).fill(first("port"));await page.getByLabel("Username",{exact:true}).fill(first("user"));await page.getByLabel("SSH private-key path",{exact:true}).fill(key);await page.getByLabel("Key passphrase (optional)",{exact:true}).fill(secret);await page.getByRole("button",{name:"Save workstation",exact:true}).click();
  const host=await until(async()=>(await state()).workstations.find(h=>h.name==="Encrypted key acceptance"));assert(host.secret_saved);
  assert(!(await fs.readFile(path.join(org,".state/ssh-secrets",`${host.id}.dpapi`))).includes(Buffer.from(secret)));assert(!JSON.stringify(await state()).includes(secret));
  await page.reload();await page.getByRole("navigation",{name:"Saved workstations"}).getByRole("button",{name:/Encrypted key acceptance/}).click();await expect(page.getByLabel("Key passphrase (optional)",{exact:true})).toHaveValue("");
  await page.getByRole("button",{name:"Test connection",exact:true}).click();await expect(page.getByRole("status").filter({hasText:"Connected"})).toBeVisible({timeout:60000});
  const bad=await context.request.post("/api/workstations",{data:{workstation:{...host,hostname:"host;whoami"},secret:null}});assert.equal(bad.status(),400);
  assert.equal((await fetch(`${base}/api/workstations`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({workstation:host})})).status,401);
  proof.encrypted_key={id:host.id,secret_encrypted:true,api_secret_free:true,native_askpass_connected:true};console.log("KEY_OK: real encrypted SSH key authenticates using saved DPAPI passphrase; no secret in state/form; invalid input and unauthenticated writes rejected");
 }
 if(phase==="password"){
  const fixture=path.join(org,".state/password-fixture.json");await fs.rm(fixture,{force:true});
  const server=spawn("python",["-X","utf8","../backend/tests/ssh_password_server.py",fixture],{stdio:"ignore",windowsHide:true});
  let host;
  try{
   const credential=await until(async()=>{try{return JSON.parse(await fs.readFile(fixture,"utf8"));}catch(e){if(e.code==="ENOENT")return null;throw e;}});
   await page.goto("/settings/workstations");await page.getByRole("button",{name:"Add workstation",exact:true}).click();
   await page.getByLabel("Display name",{exact:true}).fill("Password acceptance");await page.getByLabel("Hostname",{exact:true}).fill("localhost");await page.getByLabel("Host IP (optional)",{exact:true}).fill("127.0.0.1");await page.getByLabel("SSH port",{exact:true}).fill(String(credential.port));await page.getByLabel("Username",{exact:true}).fill("acceptance");await page.getByLabel("Authentication",{exact:true}).selectOption("password");await page.getByLabel("Password",{exact:true}).fill(credential.password);await page.getByRole("button",{name:"Save workstation",exact:true}).click();
   host=await until(async()=>(await state()).workstations.find(h=>h.name==="Password acceptance"));assert(host.secret_saved);
   const untrusted=await context.request.post(`/api/workstations/${host.id}/test`);assert.equal(untrusted.status(),400);assert.match(await untrusted.text(),/Host key verification failed|No .*host key.*known/);
   await page.getByRole("button",{name:"Review host keys",exact:true}).click();await expect(page.getByRole("button",{name:"Trust these host keys",exact:true})).toBeVisible({timeout:30000});
   const refused=await context.request.post(`/api/workstations/${host.id}/trust`,{data:{fingerprints:["wrong"]}});assert.equal(refused.status(),400);
   await page.getByRole("button",{name:"Trust these host keys",exact:true}).click();await expect(page.getByRole("status").filter({hasText:"Host keys trusted"})).toBeVisible({timeout:30000});
   await page.getByRole("button",{name:"Test connection",exact:true}).click();await expect(page.getByRole("status").filter({hasText:"Connected"})).toBeVisible({timeout:60000});
   await page.getByLabel("Password",{exact:true}).fill(crypto.randomUUID());await page.getByRole("button",{name:"Save workstation",exact:true}).click();await expect(page.getByLabel("Password",{exact:true})).toHaveValue("");await page.getByRole("button",{name:"Test connection",exact:true}).click();await expect(page.getByRole("alert")).toContainText("Permission denied",{timeout:60000});
   assert(!JSON.stringify(await state()).includes(credential.password));proof.password={real_ssh_password_auth:true,untrusted_host_rejected:true,review_and_trust:true,changed_fingerprint_rejected:true,wrong_password_rejected:true};
   console.log("PASSWORD_OK: real OpenSSH password authentication, actual forwarded workstation probe; host-key rejection/review/trust; changed fingerprint and wrong password rejected");
  }finally{if(host)await call(`/workstations/${host.id}`,undefined,"DELETE");server.kill();await fs.rm(fixture,{force:true});}
 }
 if(phase==="restart-native"){
  const s=await state(),host=s.workstations.find(h=>h.id===proof.encrypted_key.id);assert(host?.secret_saved);assert(s.groups.find(g=>g.id===proof.project.id).project.members.some(m=>m.agent_id===proof.project.specialist&&m.manager_id==="ceo"));
  const tested=await call(`/workstations/${host.id}/test`,{});assert.equal(tested.connection.status,"online");
  const workspace=(await call("/workspaces/probe",{path:tested.home,ssh_host:host.id})).workspace;
  const catalog=await call(`/codex/settings?ssh_host=${host.id}`);const model=catalog.models.find(m=>m.slug.includes("luna"));assert(model);
  const template=s.agents.find(a=>a.id==="ceo");const agent=await call("/agents",{...template,id:"",name:"Saved Workstation Native",workdir:workspace,model:model.slug,reasoning:"low",permission:"read-only"});
  const message=await call("/messages",{id:crypto.randomUUID(),group_id:"general",body:"Execute pwd once and reply with the absolute working directory plus SAVED_WORKSTATION_OK. Do not edit files or delegate.",recipients:[agent.id],reply_to:null,artifacts:[],side_chat_id:null});
  const active=await until(async()=>(await state()).runs.find(r=>r.message_id===message.id));
  const edit=await context.request.post("/api/workstations",{data:{workstation:host,secret:null}});assert.equal(edit.status(),400);assert.match(await edit.text(),/active runs/);
  const run=await until(async()=>{const r=await call(`/runs/${active.id}`);return !["queued","starting","running","waiting"].includes(r.status)&&r;},180000);assert.equal(run.status,"succeeded",run.error);assert.match(run.output,/SAVED_WORKSTATION_OK/);assert(run.output.includes(workspace.path));assert(run.native_session_id);assert.equal(run.profile.workdir.ssh_host,host.id);
  proof.native={agent:agent.id,host:host.id,run:run.id,session:run.native_session_id,active_edit_blocked:true};console.log("NATIVE_OK: saved encrypted connection survives restart; native Codex executes in chosen workdir; active connection edits blocked");
 }
 if(phase==="connection-lifecycle"){
  let host=(await state()).workstations.find(h=>h.id===proof.native.host);assert(host?.secret_saved);
  const session=()=>call("/sessions").then(rows=>rows.find(s=>s.native_id===proof.native.session));assert((await session()).active);
  host=await call("/workstations",{workstation:{...host,name:"Saved encrypted workstation"},secret:null});assert((await session()).active,"Renaming does not discard chat context");
  const tested=await call(`/workstations/${host.id}/test`,{});assert.equal(tested.connection.status,"online");
  host=await call("/workstations",{workstation:{...host,host_ip:host.hostname},secret:null});assert(!(await session()).active,"Changing the destination retires native sessions");
  const exported=await call("/export",{});const response=await context.request.get(exported.url);assert(response.ok());const file=path.join(dir,"export-proof.zip");await fs.writeFile(file,await response.body());
  execFileSync("python",["-X","utf8","-c","import zipfile,json,sys; z=zipfile.ZipFile(sys.argv[1]); assert not any('ssh-secrets' in p or p.endswith('.dpapi') or 'encrypted-test-key' in p for p in z.namelist()); assert json.loads(z.read('manifest.json'))['credentials_included'] is False",file],{stdio:"pipe"});
  proof.lifecycle={rename_preserves_session:true,destination_change_retires_session:true,export_excludes_credentials:true};console.log("LIFECYCLE_OK: restart retains encrypted credential; rename preserves session; destination edit resets session; real ZIP export excludes credentials");
 }
 assert.deepEqual(errors,[]);proof.browser_errors=errors;await fs.writeFile(path.join(dir,"settings-proof.json"),JSON.stringify(proof,null,2)+"\n");
}finally{await browser.close();}
