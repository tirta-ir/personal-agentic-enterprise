import {createRequire} from 'node:module';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
const require=createRequire(new URL('../frontend/package.json',import.meta.url));
const {chromium,expect}=require('@playwright/test');
const [credentials,output,workspace,runtime,workdir]=process.argv.slice(2);
const creds=JSON.parse(await readFile(credentials,'utf8')),dir=resolve(output);await mkdir(dir,{recursive:true});
const browser=await chromium.launch({headless:true,channel:'msedge'}),context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();
page.setDefaultTimeout(30000);const errors=[];page.on('pageerror',e=>errors.push(e.message));let agent,group;
async function api(path,data,method='GET'){const r=await context.request.fetch(creds.url+'/api'+path,{method,data,headers:{'x-ae-workspace':workspace}});assert.equal(r.status(),200,await r.text());return r.json();}
try {
 await page.goto(creds.url);await page.getByLabel('Username',{exact:true}).fill(creds.username);await page.getByLabel('Password',{exact:true}).fill(creds.password);await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.getByRole('combobox',{name:'Workspace',exact:true}).selectOption(workspace);
 const before=await api('/state');const attached=(await api('/workspaces/probe',{runtime_id:runtime,path:workdir},'POST')).workspace;
 agent=await api('/agents',{...before.agents[0],id:randomUUID(),name:'Mention Verifier',position:'Verification',reports_to:null,project_id:null,runtime_id:runtime,workdir:attached,model:'gpt-5.6-sol',reasoning:'low',permission:'read-only',enabled:true,deleted_at:null,revision:1,timeout_seconds:180,instructions:'Reply only MENTION_VERIFIED. Do not use tools or change files.',agents_md:''},'POST');
 group=await api('/groups',{id:randomUUID(),name:'Mention verification',description:'Temporary regression',member_ids:[agent.id]},'POST');await writeFile(resolve(dir,'ids.json'),JSON.stringify({agent:agent.id,group:group.id}));
 await page.goto(creds.url+'/groups/'+group.id+'/chat');const input=page.getByRole('textbox',{name:'Message',exact:true});
 await input.fill('@Mention');await page.getByRole('option',{name:/Mention Verifier/}).click();await expect(input).toHaveValue('@Mention Verifier ');assert(!(await input.inputValue()).includes(agent.id));
 await input.fill('@Mention');await input.press('Enter');await expect(input).toHaveValue('@Mention Verifier ');
 await input.fill('@Mention Verifier reply only MENTION_VERIFIED');await input.press('Enter');await expect(input).toHaveValue('');
 await expect.poll(async()=> (await api('/state')).runs.find(r=>r.group_id===group.id&&r.agent_id===agent.id)?.status,{timeout:180000,intervals:[1000]}).toBe('succeeded');
 const run=(await api('/state')).runs.find(r=>r.group_id===group.id&&r.agent_id===agent.id);assert.match(run.output,/MENTION_VERIFIED/);
 let mention=page.locator('.message-bubble a.agent-mention').first();await expect(mention).toHaveText('@Mention Verifier');assert.equal(await mention.evaluate(e=>getComputedStyle(e).color),'rgb(21, 87, 192)');await page.screenshot({path:resolve(dir,'named-mention.png')});
 await page.reload();mention=page.locator('.message-bubble a.agent-mention').first();await expect(mention).toHaveText('@Mention Verifier');await mention.click();await expect(page.locator('aside.inspector').getByLabel('Display name',{exact:true})).toHaveValue(agent.name);
 agent=await api('/agents/'+agent.id,{...agent,enabled:false},'PUT');
 const legacy=await api('/messages',{id:randomUUID(),group_id:group.id,body:'Legacy @'+agent.id+', code `@'+agent.id+'`, email@'+agent.id+' and @'+agent.id+'suffix. [Original link](https://example.com/@'+agent.id+')',recipients:[]},'POST');
 await page.goto(creds.url+'/groups/'+group.id+'/chat');const message=page.locator('[id="message-'+legacy.id+'"]');await expect(message.locator('a.agent-mention')).toHaveCount(1);await expect(message.locator('a.agent-mention')).toHaveText('@Mention Verifier');await expect(message.locator('code')).toHaveText('@'+agent.id);await expect(message.getByRole('link',{name:'Original link',exact:true})).toHaveAttribute('href','https://example.com/@'+agent.id);
 await page.screenshot({path:resolve(dir,'legacy-mention.png')});assert(!(await api('/state')).runs.some(r=>r.message_id===legacy.id));assert.deepEqual(errors,[]);
 await api('/groups/'+group.id,undefined,'DELETE');group=null;await api('/agents/'+agent.id,undefined,'DELETE');agent=null;
 const after=await api('/state');assert.deepEqual(after.agents,before.agents);const originals=new Set(before.groups.map(g=>g.id));assert.deepEqual(after.groups.filter(g=>originals.has(g.id)),before.groups);
 const proof={composerUsesAssignedName:true,mouseAndKeyboardSelection:true,namedMentionRouted:true,runId:run.id,status:run.status,blueProfileLink:true,clickOpensProfile:true,persistedAfterReload:true,legacyIdShowsName:true,codeEmailAndLinksUntouched:true,configurationPreserved:true,browserErrors:errors,mocks:false};await writeFile(resolve(dir,'proof.json'),JSON.stringify(proof,null,2));console.log(JSON.stringify(proof));
} catch(e){await page.screenshot({path:resolve(dir,'failure.png')});throw e;} finally {await context.request.post(creds.url+'/api/logout',{data:{}});await browser.close();}
