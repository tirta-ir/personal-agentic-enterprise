import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
const org=path.resolve(process.env.AE_TEST_ORG||"../../org");
const base=process.env.AE_TEST_URL||"http://127.0.0.1:8765";
const directory=path.join(org,".state/verification");
const browser=await chromium.launch({channel:"msedge",headless:true});
const context=await browser.newContext({baseURL:base,viewport:{width:1440,height:1000}});
const page=await context.newPage();
const errors=[]; page.on("pageerror",e=>errors.push(e.message));
try {
 const login=await context.request.post("/api/login",{data:{token:(await fs.readFile(path.join(org,".state/owner.key"),"utf8")).trim()}});assert(login.ok());
 const before=await(await context.request.get("/api/state")).json();
 const examples=before.agents.filter(a=>["linux-example","macos-example"].includes(a.name)&&a.workdir?.ssh_host===a.name);
 assert.equal(examples.length,2);
 await page.goto("/organization");
 for(const agent of examples) await expect(page.locator(`[data-agent-id="${agent.id}"] .workstation-online`)).toContainText(agent.name,{timeout:45000});
 await page.screenshot({path:path.join(directory,"live-remote-organization.png"),fullPage:true});
 for(const agent of examples) {
  const settings=await(await context.request.get(`/api/codex/settings?ssh_host=${encodeURIComponent(agent.name)}`)).json();
  await page.goto(`/organization/agents/${agent.name}--${agent.id}/profile`);
  await expect(page.getByLabel("Model",{exact:true})).toContainText(settings.model);
  await expect(page.getByLabel("Reasoning effort",{exact:true})).toContainText(settings.reasoning);
  await page.goto(`/organization/agents/${agent.name}--${agent.id}/workdir`);
  await expect(page.getByLabel("SSH host alias")).toHaveValue(agent.name);
  await expect(page.getByLabel("Absolute directory path")).toHaveValue(agent.workdir.path);
  await page.getByRole("button",{name:"Browse folders",exact:true}).click();
  await expect(page.getByRole("dialog")).toContainText(agent.workdir.path);
  await page.getByRole("dialog").getByRole("button",{name:"Close",exact:true}).click();
 }
 await page.screenshot({path:path.join(directory,"live-remote-workdir.png"),fullPage:true});
 await page.setViewportSize({width:390,height:844});
 await expect(page.getByLabel("SSH host alias")).toBeVisible();
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.screenshot({path:path.join(directory,"live-remote-mobile.png"),fullPage:true});
 const after=await(await context.request.get("/api/state")).json();
 assert.deepEqual(after.agents,before.agents);
 assert.deepEqual(errors,[]);
 const proof={url:base,agents:examples.map(a=>({id:a.id,name:a.name,status:after.connections[a.id].status})),profilesUnchanged:true,remoteFolderBrowser:true,mobileWidth:390,noHorizontalOverflow:true,errors};
 await fs.writeFile(path.join(directory,"live-remote-ui-proof.json"),JSON.stringify(proof,null,2));
 console.log(JSON.stringify(proof));
} finally { await browser.close(); }
