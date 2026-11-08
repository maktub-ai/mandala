import {chooseOption} from "./helpers/select";
import { test, expect } from "@playwright/test";

test.beforeEach(async ({ request, page }) => {
 const sources=await (await request.get("/api/market/sources")).json();
 await request.put("/api/market/sources",{data:{revision:sources.revision,sources:[],enabled:["clawhub","anthropic","mcp-registry"]}});
 const {revision,config:current}=await(await request.get("/api/config")).json();
 const response=await request.put("/api/config",{data:{revision,config:{...current,version:2,skillLibrary:[],connections:[],marketInstallations:[],agents:[...current.agents.filter((agent:{systemRole?:string})=>agent.systemRole),{id:"market-reader",name:"Market reader",defaultCli:"codex",instructions:"",models:{},mcp:[],skills:[]}],projects:[]}}});
 expect(response.ok(),await response.text()).toBe(true);
 await page.addInitScript(()=>localStorage.setItem("mana-language","en"));
});

test("source draft cancels cleanly, saved GitHub source browses and installs after refresh", async ({page,request})=>{
 const originalSources=(await(await request.get("/api/market/sources")).json()).sources;
 await page.goto("/market");
 const manage=()=>page.getByRole("button",{name:"Manage sources",exact:true});
 await manage().click();
 let dialog=page.getByRole("dialog",{name:"Manage sources",exact:true});
 await dialog.getByRole("button",{name:"Add source",exact:true}).click();
 await dialog.getByRole("textbox",{name:"Source name",exact:true}).fill("Reading repository");
 await dialog.getByRole("textbox",{name:"Repository URL",exact:true}).fill("https://github.com/example/reading-skills");
 await dialog.getByRole("button",{name:"Add to draft",exact:true}).click();
 await expect(dialog.getByRole("checkbox",{name:"Reading repository",exact:true})).toBeChecked();
 await dialog.getByRole("button",{name:"Cancel",exact:true}).click();
 expect((await(await request.get("/api/market/sources")).json()).sources).toEqual(originalSources);
 await manage().click();
 await dialog.getByRole("button",{name:"Add source",exact:true}).click();
 await dialog.getByRole("textbox",{name:"Source name",exact:true}).fill("Reading repository");
 await dialog.getByRole("textbox",{name:"Repository URL",exact:true}).fill("https://github.com/example/reading-skills");
 await dialog.getByRole("button",{name:"Add to draft",exact:true}).click();
 await dialog.getByRole("button",{name:"Save",exact:true}).click();
 await expect(dialog).toHaveCount(0);
 await page.reload();
 await chooseOption(page,page.getByRole("combobox",{name:"Market sources",exact:true}),"github:example/reading-skills");
 await page.getByRole("button",{name:"View details synthetic-reading",exact:true}).click();
 const details=page.getByRole("dialog",{name:"Capability details",exact:true});
 await expect(details.getByRole("link",{name:"View source listing",exact:true})).toHaveAttribute("href",/github.com\/example\/reading-skills\/tree\/a{40}/);
 await details.getByRole("button",{name:"Install",exact:true}).click();
 await details.getByRole("checkbox",{name:"Agent · Market reader",exact:true}).check();
 await details.getByRole("button",{name:"Install and link",exact:true}).click();
 await expect(page.getByRole("status")).toContainText("Installed and linked");
 expect((await(await request.get("/api/config")).json()).config.marketInstallations[0].catalogId).toBe("skill:github:example/reading-skills/synthetic-reading");
});

test("fast catalogs remain usable while another source is pending; failed-source retry preserves successful cards", async({page})=>{
 let release!:()=>void;const pending=new Promise<void>(resolve=>release=resolve);let fail=true;
 await page.route("**/api/market/search?*source=anthropic*",async route=>{await pending; if(fail)await route.fulfill({status:502,json:{error:"Market source HTTP 503"}});else await route.continue();});
 await page.goto("/market");
 await expect(page.getByRole("button",{name:"View details synthetic-claw",exact:true})).toBeVisible();
 expect(await page.getByRole("button",{name:"View details synthetic-reading",exact:true}).count()).toBe(0);
 release();
 await expect(page.getByRole("alert")).toContainText("Anthropic");
 fail=false;
 await page.getByRole("button",{name:"Retry Anthropic",exact:true}).click();
 await expect(page.getByRole("button",{name:"View details synthetic-claw",exact:true})).toBeVisible();
 await expect(page.getByRole("button",{name:"View details synthetic-reading",exact:true})).toBeVisible();
 await expect(page.getByRole("alert")).toHaveCount(0);
});

test("source validation and all-source failures remain explicit at narrow viewport",async({page})=>{
 await page.setViewportSize({width:390,height:844});
 await page.route("**/api/market/search?*",route=>route.fulfill({status:502,json:{error:"Market source HTTP 503"}}));
 await page.goto("/market");
 await expect(page.getByRole("alert")).toHaveCount(1);
 await expect(page.getByText("No matching results.",{exact:true})).toHaveCount(0);
 await page.getByRole("button",{name:"Manage sources",exact:true}).click();
 const dialog=page.getByRole("dialog");
 await dialog.getByRole("button",{name:"Add source",exact:true}).click();
 await dialog.getByRole("textbox",{name:"Source name",exact:true}).fill("Private endpoint");
 await dialog.getByRole("textbox",{name:"Repository URL",exact:true}).fill("https://localhost/skills");
 await dialog.getByRole("button",{name:"Add to draft",exact:true}).click();
 await expect(dialog.getByRole("alert")).toContainText("canonical GitHub repository URL");
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:'/tmp/compact-market-sources/market-narrow-source-validation.png',fullPage:true});
});

test("source editor stays usable in light, dark and narrow layouts",async({page})=>{
 for(const [theme,width,height] of [["light",1280,850],["dark",1280,850],["light",390,844]] as const){
  await page.setViewportSize({width,height});
  await page.addInitScript(({theme})=>localStorage.setItem("mana-theme",theme),{theme});
  await page.goto("/market");
  await expect(page.locator(".market-card")).toHaveCount(3);
  await page.getByRole("button",{name:"Manage sources",exact:true}).click();
  const dialog=page.getByRole("dialog");
  await dialog.getByRole("button",{name:"Add source",exact:true}).click();
  await dialog.getByRole("textbox",{name:"Source name",exact:true}).fill("Research skills");
  await dialog.getByRole("textbox",{name:"Repository URL",exact:true}).fill("https://github.com/example/research-skills");
  await expect(dialog.getByRole("button",{name:"Save",exact:true})).toBeDisabled();
  await expect(dialog.getByRole("button",{name:"Add to draft",exact:true})).toBeVisible();
  const lastRow=await dialog.locator(".market-source-row").last().boundingBox(), heading=await dialog.getByRole("heading",{name:"Add GitHub repository",exact:true}).boundingBox();
  expect(heading!.y).toBeGreaterThanOrEqual(lastRow!.y+lastRow!.height);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:`/tmp/compact-market-sources/market-source-editor-${theme}-${width}.png`,fullPage:true});
 }
});

test('source revision conflicts preserve dirty input and reopen the current authoritative selection',async({page,request})=>{
 await page.goto('/market');await page.getByRole('button',{name:'Manage sources',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'Manage sources',exact:true});
 await dialog.getByRole('checkbox',{name:'ClawHub',exact:true}).uncheck();
 const current=await(await request.get('/api/market/sources')).json();
 expect((await request.put('/api/market/sources',{data:{revision:current.revision,sources:current.sources.filter((entry:{adapter?:string})=>entry.adapter==='github-skills'),enabled:['clawhub','mcp-registry']}})).ok()).toBe(true);
 await dialog.getByRole('button',{name:'Save',exact:true}).click();
 await expect(dialog.getByRole('alert')).toContainText('Sources changed elsewhere');
 await expect(dialog.getByRole('checkbox',{name:'ClawHub',exact:true})).not.toBeChecked();
 await expect(dialog.getByRole('checkbox',{name:'Anthropic',exact:true})).toBeChecked();
 expect((await(await request.get('/api/market/sources')).json()).enabled).toEqual(['clawhub','mcp-registry']);
 await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
 await page.getByRole('button',{name:'Manage sources',exact:true}).click();
 await expect(dialog.getByRole('checkbox',{name:'ClawHub',exact:true})).toBeChecked();
 await expect(dialog.getByRole('checkbox',{name:'Anthropic',exact:true})).not.toBeChecked();
 await dialog.getByRole('button',{name:'Save',exact:true}).click();
 await expect(dialog).toHaveCount(0);
 expect((await(await request.get('/api/market/sources')).json()).enabled).toEqual(['clawhub','mcp-registry']);
});

test('an unset authoritative source selection uses defaults instead of a stale browser preference',async({page})=>{
 await page.addInitScript(()=>localStorage.setItem('mana-market-sources','[]'));
 await page.route('**/api/market/sources',async route=>{
  if(route.request().method()!=='GET'){await route.continue();return;}
  const response=await route.fetch(),snapshot=await response.json();await route.fulfill({response,json:{...snapshot,enabled:null}});
 });
 await page.goto('/market');await page.getByRole('button',{name:'Manage sources',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'Manage sources',exact:true});
 for(const name of ['ClawHub','Anthropic','MCP Registry'])await expect(dialog.getByRole('checkbox',{name,exact:true})).toBeChecked();
 await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
});
