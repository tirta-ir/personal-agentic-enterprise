// Read-only production smoke: inspect both workstation catalogs and unsaved profile UI.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";

const org=path.resolve("../../org"), base="http://127.0.0.1:8765";
const directory=path.join(org,".state/verification/opencode-deployment-20260920");
const browser=await chromium.launch({channel:"msedge",headless:true});
const context=await browser.newContext({baseURL:base,viewport:{width:1440,height:1000}});
const page=await context.newPage();const errors=[];page.on("pageerror",e=>errors.push(e.message));
async function get(route){const response=await context.request.get(`/api${route}`,{timeout:60000});assert(response.ok(),await response.text());return response.json();}
try {
 const response=await context.request.post("/api/login",{data:{token:(await fs.readFile(path.join(org,".state/owner.key"),"utf8")).trim()}});assert(response.ok());
 const before=await get("/state"), catalogs=[];
 for(const remote of [false,true]){
  const agent=before.agents.find(a=>remote?a.workdir?.ssh_host==="macos-example":a.workdir&&!a.workdir.ssh_host);assert(agent);
  await page.goto(`/organization/agents/${agent.id}/profile`);await expect(page.getByLabel("Harness",{exact:true})).toHaveValue("codex");
  await page.getByLabel("Harness",{exact:true}).selectOption("opencode");
  const catalog=await get(`/harness/settings?harness=opencode&agent_id=${agent.id}`);assert(catalog.models.length);
  await expect(page.getByLabel("Model",{exact:true}).locator(`option[value="${catalog.models[0].slug}"]`)).toHaveText(`${catalog.models[0].display_name} · ${catalog.models[0].slug.split("/")[0]}`,{timeout:30000});
  await page.screenshot({path:path.join(directory,remote?"mac-harness-settings.png":"local-harness-settings.png")});
  catalogs.push({host:remote?"macos-example":"local",models:catalog.models.length});
  await page.reload();await expect(page.getByLabel("Harness",{exact:true})).toHaveValue("codex");
 }
 const after=await get("/state");assert.deepEqual(after.agents,before.agents);assert.deepEqual(after.groups,before.groups);assert.deepEqual(errors,[]);
 await fs.writeFile(path.join(directory,"live-ui-proof.json"),JSON.stringify({url:base,profilesPreserved:true,groupsPreserved:true,catalogs,browserErrors:errors},null,2));
 console.log("LIVE_OK: local + Mac native catalogs, unsaved harness UI, existing profiles/groups unchanged, zero browser errors");
} finally {await browser.close();}
