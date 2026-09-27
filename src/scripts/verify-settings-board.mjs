import { createRequire } from 'node:module';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(new URL('../frontend/package.json', import.meta.url));
const { chromium, expect } = require('@playwright/test');
const [base,keyFile,usersFile,output] = process.argv.slice(2);
assert(base&&keyFile&&usersFile&&output, 'Usage: node verify-settings-board.mjs BASE OWNER_KEY USERS_JSON OUTPUT_DIR');
await mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true,channel:process.platform==='win32'?'msedge':undefined});
let tenant,admin;
try {
  admin=await browser.newContext();
  assert.equal((await admin.request.post(`${base}/api/login`,{data:{token:(await readFile(keyFile,'utf8')).trim()}})).status(),200);
  const created=await admin.request.post(`${base}/api/tenants`,{data:{name:`Settings board proof ${Date.now()}`}});
  assert.equal(created.status(),200);tenant=await created.json();
  assert.equal((await admin.request.post(`${base}/api/tenants/${tenant.id}/members`,{data:{user:'@alice:agentic.local',role:'owner'}})).status(),200);
  const users=JSON.parse(await readFile(usersFile,'utf8'));
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  assert.equal((await context.request.post(`${base}/api/login`,{data:{username:'alice',password:users.alice}})).status(),200);
  await context.addCookies([{name:'ae_workspace',value:tenant.id,url:base}]);
  const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`${base}/settings/profile`);
  await page.getByRole('heading',{name:'Profile',exact:true}).waitFor();
  await page.getByRole('button',{name:'User settings',exact:true}).click();
  assert.equal(await page.locator('.owner-settings small').count(),0);
  const sidebar=page.getByRole('complementary');
  for(const name of ['Action board','Organization']) await expect(sidebar.getByRole('button',{name,exact:true})).toBeVisible();
  for(const name of ['Profile','Runtime','Workspace']) {
    assert.equal(await sidebar.getByRole('button',{name,exact:true}).count(),0);
    await expect(page.getByRole('navigation',{name:'User settings sections',exact:true}).getByRole('button',{name,exact:true})).toBeVisible();
  }
  const alignment=await page.locator('.owner-settings').evaluate(el=>{const box=el.getBoundingClientRect(),text=el.querySelector('strong').getBoundingClientRect();return {x:Math.abs((box.left+box.right-text.left-text.right)/2),y:Math.abs((box.top+box.bottom-text.top-text.bottom)/2)};});
  assert(alignment.x<1&&alignment.y<1,JSON.stringify(alignment));
  await page.screenshot({path:resolve(output,'user-settings-profile.png'),fullPage:true});
  for(const width of [705,375]) {
    await page.setViewportSize({width,height:900});
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    for(const name of ['Profile','Runtime','Workspace']) {const box=await page.getByRole('navigation',{name:'User settings sections',exact:true}).getByRole('button',{name,exact:true}).boundingBox();assert(box&&box.x>=0&&box.x+box.width<=width);}
    await page.screenshot({path:resolve(output,`user-settings-${width}.png`),fullPage:true});
  }
  await page.setViewportSize({width:1440,height:1000});

  assert.equal(await page.locator('.owner-settings').evaluate(el=>getComputedStyle(el).outlineStyle),'none');
  await page.getByRole('button',{name:'Runtime',exact:true}).click();
  await page.getByRole('heading',{name:'Connected machines',exact:true}).waitFor();
  await page.getByRole('button',{name:'Workspace',exact:true}).click();
  await page.getByRole('heading',{name:'Workspace',exact:true}).waitFor();
  assert.equal(await page.getByRole('dialog').count(),0);
  await page.getByLabel('Invite Matrix user',{exact:true}).fill('@bob:agentic.local');
  await page.getByRole('button',{name:'Invite',exact:true}).click();
  const role=page.getByLabel('Role for @bob:agentic.local',{exact:true});await role.waitFor();
  const bob=await browser.newContext();
  assert.equal((await bob.request.post(`${base}/api/login`,{data:{username:'bob',password:users.bob}})).status(),200);
  await bob.addCookies([{name:'ae_workspace',value:tenant.id,url:base}]);
  assert.equal((await bob.request.put(`${base}/api/tenants/${tenant.id}/members`,{data:{user:'@alice:agentic.local',role:'member'}})).status(),403);
  await role.selectOption('owner');await expect(role).toBeEnabled();
  assert.equal((await bob.request.get(`${base}/api/tenants/${tenant.id}/members`)).status(),200);
  assert.equal((await context.request.put(`${base}/api/tenants/${tenant.id}/members`,{data:{user:'@alice:agentic.local',role:'member'}})).ok(),false);
  assert.equal((await context.request.put(`${base}/api/tenants/${tenant.id}/members`,{data:{user:'@bob:agentic.local',role:'admin'}})).ok(),false);
  assert.equal((await context.request.put(`${base}/api/tenants/${tenant.id}/members`,{data:{user:'@bob:agentic.local'}})).ok(),false);
  await role.selectOption('member');await expect(role).toBeEnabled();
  assert.equal((await bob.request.get(`${base}/api/tenants/${tenant.id}/members`)).status(),403);
  const memberPage=await bob.newPage();await memberPage.goto(`${base}/settings/workspace`);
  await memberPage.getByRole('heading',{name:'Workspace',exact:true}).waitFor();
  assert.equal(await memberPage.getByRole('button',{name:'Invite',exact:true}).count(),0);
  assert.equal(await memberPage.getByRole('button',{name:'Action board',exact:true}).count(),0);
  await memberPage.getByRole('button',{name:'Profile',exact:true}).click();await memberPage.getByRole('heading',{name:'Profile',exact:true}).waitFor();
  await memberPage.close();
  await page.reload();await expect(page.getByLabel('Role for @bob:agentic.local')).toHaveValue('member');
  await page.screenshot({path:resolve(output,'workspace-roles.png'),fullPage:true});
  await page.getByRole('button',{name:'Action board',exact:true}).click();
  for(const title of ['Zulu task','Alpha task','Mike task']) {
    await page.getByRole('button',{name:'New action',exact:true}).click();
    await page.getByLabel('Title',{exact:true}).fill(title);
    await page.getByLabel('Task / instructions',{exact:true}).fill('UI verification backlog only.');
    await page.getByLabel('Person in charge (PIC)',{exact:true}).selectOption('ceo');
    if(title!=='Zulu task') await page.getByLabel('Planned start (optional, your local time)',{exact:true}).fill(new Date(Date.now()+(title==='Alpha task'?3:4)*86400000).toISOString().slice(0,16));
    await page.getByRole('button',{name:title==='Zulu task'?'Save to backlog':'Schedule action',exact:true}).click();
    await page.getByRole('dialog').waitFor({state:'hidden'});
  }
  const titleHeader=page.getByRole('columnheader').filter({has:page.getByRole('button',{name:'Action',exact:true})});
  await titleHeader.getByRole('button').click();
  assert.deepEqual(await page.locator('tbody td[data-label="Action"] > button').allTextContents(),['Alpha task','Mike task','Zulu task']);
  await expect(titleHeader).toHaveAttribute('aria-sort','ascending');
  await titleHeader.getByRole('button').click();
  assert.deepEqual(await page.locator('tbody td[data-label="Action"] > button').allTextContents(),['Zulu task','Mike task','Alpha task']);
  await expect(titleHeader).toHaveAttribute('aria-sort','descending');
  for(const label of ['Project / group','PIC','Planned start','Status']) {
    const header=page.getByRole('columnheader').filter({has:page.getByRole('button',{name:label,exact:true})});
    await header.getByRole('button').click();await expect(header).toHaveAttribute('aria-sort','ascending');
    await header.getByRole('button').click();await expect(header).toHaveAttribute('aria-sort','descending');
  }
  await page.getByRole('button',{name:'Planned start',exact:true}).click();
  assert.deepEqual(await page.locator('tbody td[data-label="Action"] > button').allTextContents(),['Alpha task','Mike task','Zulu task']);
  await page.getByRole('button',{name:'Planned start',exact:true}).click();
  assert.deepEqual(await page.locator('tbody td[data-label="Action"] > button').allTextContents(),['Mike task','Alpha task','Zulu task']);
  const handle=page.getByRole('separator',{name:'Resize Action column',exact:true});
  const box=await handle.boundingBox();const before=Number(await handle.getAttribute('aria-valuenow'));
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2+90,box.y+box.height/2);await page.mouse.up();
  assert.equal(Number(await handle.getAttribute('aria-valuenow')),before+90);
  await handle.focus();await handle.press('ArrowLeft');assert.equal(Number(await handle.getAttribute('aria-valuenow')),before+74);
  await page.getByRole('button',{name:'Edit Alpha task',exact:true}).click();await page.getByLabel('Title',{exact:true}).fill('Alpha edited');await page.getByRole('button',{name:'Schedule action',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
  const state=await (await context.request.get(`${base}/api/state`)).json();const action=state.actions.find(a=>a.title==='Alpha edited');assert(action);
  assert.equal((await bob.request.delete(`${base}/api/actions/${action.id}`)).status(),403);
  await expect(page.getByRole('button',{name:'Run Alpha edited',exact:true})).toBeEnabled();
  assert.equal(await page.getByRole('button',{name:'Run Alpha edited',exact:true}).evaluate(el=>getComputedStyle(el).color),'rgb(22, 128, 61)');
  await page.screenshot({path:resolve(output,'action-board.png'),fullPage:true});
  await page.getByRole('button',{name:'Delete Alpha edited',exact:true}).click();await page.getByRole('button',{name:'Keep action',exact:true}).click();
  await expect(page.getByRole('button',{name:'Edit Alpha edited',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Delete Alpha edited',exact:true}).click();await page.getByRole('button',{name:'Delete action',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
  await page.reload();await page.getByRole('heading',{name:'Action board',exact:true}).waitFor();
  await expect(page.locator('tbody tr')).toHaveCount(2);
  assert.equal((await context.request.post(`${base}/api/actions/${action.id}/invoke`)).ok(),false);
  assert.equal((await context.request.post(`${base}/api/actions/${action.id}/cancel`)).ok(),false);
  for(const width of [705,375]) {await page.setViewportSize({width,height:900});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:resolve(output,`board-${width}.png`),fullPage:true});}
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({settingsNavigation:true,settingsNestedUnderAccount:true,usernameCenterOffset:alignment,rolePromotionAndDemotion:true,unauthorized403:true,selfDemotionBlocked:true,sortAscendingDescending:true,pointerResize:90,keyboardResize:-16,editAndDeletePersisted:true,deletedActionCannotInvoke:true,consoleErrors:errors,screenshots:output}));
} finally {
  if(tenant&&admin) {
    assert.equal((await admin.request.put(`${base}/api/tenants/${tenant.id}/members`,{data:{user:'@alice:agentic.local',role:'member'}})).status(),200);
    for(const user of ['@alice:agentic.local','@bob:agentic.local']) assert.equal((await admin.request.delete(`${base}/api/tenants/${tenant.id}/members`,{data:{user}})).status(),200);
    assert.equal((await admin.request.delete(`${base}/api/tenants/${tenant.id}`,{data:{}})).status(),200);
  }
  await browser.close();
}
