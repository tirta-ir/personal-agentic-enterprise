import { createRequire } from 'node:module';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
const require=createRequire(new URL('../frontend/package.json',import.meta.url));
const {chromium,expect}=require('@playwright/test');
if (!process.argv[2] || !process.argv[3]) throw new Error('Usage: node src/scripts/verify-group-invites.mjs credentials.json output-directory');
const dir=resolve(process.argv[3]);
await mkdir(dir,{recursive:true});
const creds=JSON.parse(await readFile(resolve(process.argv[2]),'utf8'));
const browser=await chromium.launch({headless:true,channel:'msedge'});
let tenant,ctx;
try {
 ctx=await browser.newContext({viewport:{width:1440,height:1000}});
 const page=await ctx.newPage(),errors=[]; page.setDefaultTimeout(20000); page.on('pageerror',e=>errors.push(e.message));
 await page.goto(creds.url);
 await page.getByLabel('Username',{exact:true}).fill(creds.username);
 await page.getByLabel('Password',{exact:true}).fill(creds.password);
 await page.getByRole('button',{name:'Sign in',exact:true}).click();
 await page.getByRole('combobox',{name:'Workspace',exact:true}).waitFor();
 async function api(path,body,method='POST') {
  const response=await ctx.request.fetch(creds.url+'/api'+path,{method,headers:tenant?{'x-ae-workspace':tenant.id}:{},data:body});
  assert.equal(response.status(),200,await response.text());return response.json();
 }
 tenant=await api('/tenants',{name:'Invite verification '+randomUUID().slice(0,6)});
 await writeFile(resolve(dir,'tenant.json'),JSON.stringify(tenant));
 const state=await api('/state',undefined,'GET'),root=state.agents[0];
 const manager=await api('/agents/ceo',{...root,name:'Avery',position:'Director'},'PUT');
 const team=await api('/agents',{...root,id:randomUUID(),name:'Blair',position:'Engineering lead',reports_to:manager.id});
 const child=await api('/agents',{...root,id:randomUUID(),name:'Drew',position:'Engineer',reports_to:team.id});
 const sibling=await api('/agents',{...root,id:randomUUID(),name:'Casey',position:'Operations',reports_to:manager.id});
 const group=await api('/groups',{id:randomUUID(),name:'Invitation browser smoke',description:'Real invite interaction verification',member_ids:[],human_ids:[]});
 await page.reload();
 await page.getByRole('combobox',{name:'Workspace',exact:true}).selectOption(tenant.id);
 await page.goto(creds.url+'/groups/'+group.id+'/chat');
 await page.getByRole('button',{name:'Manage group',exact:true}).click();
 const dialog=page.getByRole('dialog'), search=dialog.getByRole('combobox',{name:'Invite people, agents, or teams',exact:true});
 await expect(dialog.locator('input[type=checkbox]')).toHaveCount(0);
 await search.fill('blai');
 await expect(dialog.getByRole('listbox',{name:'Invitation suggestions'}).getByRole('option')).toHaveCount(1);
 await mkdir(resolve(dir,'screenshots'),{recursive:true});
 await page.screenshot({path:resolve(dir,'screenshots/search.png')});
 await search.press('Enter');
 await expect(dialog.getByRole('button',{name:"Remove pending Blair's team",exact:true})).toBeVisible();
 await dialog.getByRole('button',{name:'Invite',exact:true}).click();
 const members=dialog.locator('.invite-members');
 await expect(members.getByText('Avery',{exact:true})).toBeVisible();
 await expect(members.getByText('Blair',{exact:true})).toBeVisible();
 await expect(members.getByText('Drew',{exact:true})).toBeVisible();
 await expect(members.getByText('Casey',{exact:true})).toHaveCount(0);
 await expect(members.getByText('Included manager',{exact:true})).toBeVisible();
 await expect(members.getByText('Owner',{exact:true})).toBeVisible();
 await search.fill('missing-person');await expect(dialog.getByText('No matches. Try another name.')).toBeVisible();
 await search.press('Escape');await expect(dialog).toBeVisible();await expect(search).toHaveAttribute('aria-expanded','false');
 await search.fill('Blair');await expect(dialog.getByRole('listbox',{name:'Invitation suggestions'}).getByRole('option')).toHaveCount(0);await search.press('Escape');await search.fill('');await search.press('Escape');
 await page.screenshot({path:resolve(dir,'screenshots/access.png')});
 await dialog.getByRole('button',{name:'Save group',exact:true}).click();await expect(dialog).toHaveCount(0);
 let saved=await api('/state',undefined,'GET');
 assert.deepEqual([...saved.group_access[group.id].participant_ids].sort(),[manager.id,team.id,child.id].sort());
 assert(!saved.group_access[group.id].participant_ids.includes(sibling.id));
 await page.reload();await page.getByRole('button',{name:'Manage group',exact:true}).click();
 await dialog.getByRole('button',{name:'Remove Blair and their team',exact:true}).click();
 await expect(members.getByText('Blair',{exact:true})).toHaveCount(0);await expect(members.getByText('Drew',{exact:true})).toHaveCount(0);await expect(members.getByText('Avery',{exact:true})).toHaveCount(0);
 await search.fill('Casey');await search.press('Enter');await dialog.getByRole('button',{name:'Invite',exact:true}).click();
 await dialog.getByRole('combobox',{name:'Human access',exact:true}).selectOption('everyone');
 await page.setViewportSize({width:390,height:844});
 await page.screenshot({path:resolve(dir,'screenshots/mobile.png')});
 const bounds=await dialog.boundingBox();assert(bounds && bounds.x>=0 && bounds.x+bounds.width<=391);
 await dialog.getByRole('button',{name:'Save group',exact:true}).click();await expect(dialog).toHaveCount(0);
 saved=await api('/state',undefined,'GET');assert.deepEqual([...saved.group_access[group.id].participant_ids].sort(),[manager.id,sibling.id].sort());
 assert(saved.groups.find(g=>g.id===group.id).human_ids==null);
 assert.deepEqual(errors,[]);
 const proof={searchAndKeyboard:true,noCheckboxes:true,chips:true,teamAndAncestorInclusion:true,siblingExcluded:true,branchRemoval:true,ownerAccess:true,duplicatePrevention:true,emptyResults:true,escapeKeepsDialog:true,persistenceAfterReload:true,mobile390px:true,browserErrors:errors};
 await writeFile(resolve(dir,'proof.json'),JSON.stringify(proof,null,2));console.log(JSON.stringify(proof));
}finally{
 try {
  if(tenant&&ctx) {
   const removed=await ctx.request.delete(creds.url+'/api/tenants/'+tenant.id,{data:{}});
   assert.equal(removed.status(),200,'Could not remove verification workspace');
   await ctx.request.post(creds.url+'/api/logout',{data:{}});
  }
 }finally{await browser.close();}
}
