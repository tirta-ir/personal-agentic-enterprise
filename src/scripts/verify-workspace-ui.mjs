import { createRequire } from 'node:module';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const require=createRequire(new URL('../frontend/package.json',import.meta.url));
const {chromium}=require('@playwright/test');
const [url,keyFile,output,usersFile]=process.argv.slice(2);
assert(url&&keyFile&&output,'Usage: node verify-workspace-ui.mjs URL OWNER_KEY OUTPUT_DIR');
await mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true,channel:process.platform==='win32'?'msedge':undefined});
const page=await browser.newPage({viewport:{width:1440,height:1000}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
try {
  await page.goto(url);
  await page.getByRole('button',{name:'Sign in',exact:true}).waitFor();
  const administrator=page.getByRole('button',{name:'Administrator sign in',exact:true});
  if(await administrator.isVisible())await administrator.click();
  await page.getByLabel('Owner key',{exact:true}).fill((await readFile(keyFile,'utf8')).trim());
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  const mention=page.getByRole('button',{name:'Mention an agent',exact:true});
  await mention.waitFor();await mention.click();
  const picker=page.getByRole('dialog',{name:'Mention an agent'});
  await picker.getByRole('button',{name:/CEO/}).click();
  assert((await page.getByRole('textbox',{name:'Message',exact:true}).inputValue()).includes('@ceo '));
  await page.screenshot({path:resolve(output,'mention-picker.png'),fullPage:true,animations:"disabled"});
  await page.getByRole('button',{name:'Manage workspaces'}).click();
  await page.screenshot({path:resolve(output,'owner-workspaces.png'),fullPage:true,animations:'disabled'});
  const name='Browser workspace '+Date.now();
  await page.getByLabel('New workspace',{exact:true}).fill(name);
  await page.getByRole('button',{name:'Create workspace',exact:true}).click();
  await page.waitForFunction(expected=>document.querySelector('select[aria-label="Workspace"]')?.selectedOptions[0]?.text===expected,name);
  await page.getByRole('button',{name:'Mention an agent',exact:true}).waitFor();
  await page.screenshot({path:resolve(output,'workspace-created.png'),fullPage:true,animations:"disabled"});
  const snapshot=await (await page.request.get(`${url}/api/state`)).json();
  const parent=snapshot.agents[0];
  for(const id of ['included-team','excluded-team']) {
    const response=await page.request.post(`${url}/api/agents`,{data:{...parent,id,name:id,model:'',reasoning:'',reports_to:parent.id,workdir:null}});
    assert.equal(response.status(),200);
  }
  await page.reload();
  await page.getByRole('button',{name:'Manage group',exact:true}).click();
  await page.getByLabel('excluded-team · Chief Executive Officer',{exact:true}).uncheck();
  await page.getByRole('button',{name:'Save group',exact:true}).click();
  await page.getByRole('dialog').waitFor({state:'hidden'});
  const scoped=await (await page.request.get(`${url}/api/state`)).json();
  assert.deepEqual(new Set(scoped.group_access.general.participant_ids),new Set(['ceo','included-team']));
  await page.getByRole('button',{name:'User settings',exact:true}).click();
  await page.getByLabel('Runtime name',{exact:true}).fill('Browser runtime');
  await page.getByRole('button',{name:'Register runtime',exact:true}).click();
  await page.getByLabel('Enrollment token',{exact:true}).waitFor();
  await page.getByText('Not connected',{exact:true}).waitFor();
  await page.screenshot({path:resolve(output,'runtime-enrollment.png'),fullPage:true,animations:'disabled'});
  await page.getByRole('button',{name:'Revoke',exact:true}).click();
  await page.getByRole('button',{name:'Confirm revoke',exact:true}).click();
  await page.getByRole('button',{name:'Revoke',exact:true}).waitFor({state:'hidden'});
  await page.getByRole('button',{name:'Hide token',exact:true}).click();
  await page.screenshot({path:resolve(output,'runtime-revoked.png'),fullPage:true,animations:"disabled"});
  for (const width of [1440,705,375]) {
    await page.setViewportSize({width,height:900});
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.screenshot({path:resolve(output,`runtime-settings-${width}.png`),fullPage:true,animations:"disabled"});
  }
  if(usersFile) {
    await page.setViewportSize({width:1440,height:1000});
    await page.getByRole('button',{name:'Sign out',exact:true}).click();
    await page.getByLabel('Username',{exact:true}).fill('alice');
    await page.getByLabel('Password',{exact:true}).fill(JSON.parse(await readFile(usersFile,'utf8')).alice);
    await page.getByRole('button',{name:'Sign in',exact:true}).click();
    await page.getByRole('button',{name:'User settings',exact:true}).click();
    await page.getByRole('heading',{name:'Workspace access',exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Register runtime',exact:true}).count(),0);
    assert.equal(await page.getByRole('alert').count(),0);
    await page.getByRole('button',{name:'Manage workspaces',exact:true}).click();
    await page.getByRole('dialog').waitFor();
    assert.equal(await page.getByRole('button',{name:'Invite',exact:true}).count(),0);
    await page.screenshot({path:resolve(output,'member-workspaces.png'),fullPage:true,animations:"disabled"});
    await page.getByRole('button',{name:'Back to workspace',exact:true}).click();
    for (const width of [1440,705,375]) {
      await page.setViewportSize({width,height:900});
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      await page.screenshot({path:resolve(output,`member-settings-${width}.png`),fullPage:true,animations:"disabled"});
    }
  }
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({login:true,mentionInserted:'@ceo',workspaceCreated:name,selectiveTeam:true,runtimeRegisteredAndRevoked:true,consoleErrors:errors,memberAccessChecked:!!usersFile,responsiveWidths:[1440,705,375],screenshots:output}));
} finally {await browser.close();}
