import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";

// Read-only acceptance on the owner's actual deployment. Do not create fixtures here.
const org=path.resolve("../../org"),base="http://127.0.0.1:8765";
const dir=path.join(org,".state/verification");
const browser=await chromium.launch({channel:"msedge",headless:true});
const context=await browser.newContext({baseURL:base,viewport:{width:1440,height:1000}});
const page=await context.newPage(),errors=[];page.on("pageerror",e=>errors.push(e.message));
try{
 await context.request.post("/api/login",{data:{token:(await fs.readFile(path.join(org,".state/owner.key"),"utf8")).trim()}});
 const response=await context.request.get("/api/state");assert.equal(response.status(),200);const state=await response.json();
 const before=JSON.parse((await fs.readFile(path.join(dir,"collaboration-agents-before.json"),"utf8")).replace(/^\uFEFF/,""));
 assert.equal(state.agents.length,before.length);
 for(const agent of before)assert.deepEqual(state.agents.find(a=>a.id===agent.id),{...agent,project_id:agent.project_id??null});
 await page.goto("/actions");await expect(page.getByRole("heading",{name:"Action board",exact:true})).toBeVisible();
 await page.getByRole("button",{name:"Calendar",exact:true}).click();await expect(page.locator(".action-calendar")).toBeVisible();
 await page.getByRole("button",{name:"Add group or section",exact:true}).click();await page.getByRole("menuitem",{name:"Create project",exact:true}).click();await expect(page.getByRole("heading",{name:"Create a project"})).toBeVisible();await expect(page.getByLabel("Project workdir",{exact:true})).toBeVisible();await page.getByRole("dialog").getByRole("button",{name:"Close",exact:true}).click();
 await page.screenshot({path:path.join(dir,"live-action-board.png")});
 await page.goto("/organization");await expect(page.locator(".org-card[data-agent-id]")).toHaveCount(before.length);await page.screenshot({path:path.join(dir,"live-collaboration-organization.png")});
 const phone=await context.newPage();await phone.setViewportSize({width:390,height:844});await phone.goto("/actions");await expect(phone.getByRole("heading",{name:"Action board",exact:true})).toBeVisible();assert(await phone.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await phone.screenshot({path:path.join(dir,"live-action-mobile.png")});
 assert.deepEqual(errors,[]);
 const health=await (await context.request.get("/api/health")).json();
 await fs.writeFile(path.join(dir,"collaboration-live-proof.json"),JSON.stringify({url:base,health,agents_preserved:before.length,actions:state.actions.length,projects:state.groups.filter(g=>g.project).length,checks:["owner sign-in","live board table/calendar","Create project modal","organization cards","mobile no page overflow"],browser_errors:errors},null,2));
 console.log(`LIVE_OK: HTTP 200; ${before.length} existing profiles preserved; board/project UI and mobile passed; no browser errors`);
}finally{await browser.close();}
