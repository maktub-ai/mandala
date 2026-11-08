import {test,expect} from "@playwright/test";
import {chooseOption} from "./helpers/select";

test("conversation rows distinguish projects with Default groups and show named groups without changing history",async({page,request})=>{
  const {revision}=await(await request.get("/api/config")).json();
  const config={version:2,projects:[
    {id:"location-a",name:"Garden",cwd:"/tmp",agentIds:["shared"],resources:[],mcp:[],skills:[],workspaces:[{id:"default",name:"Default",cwd:"/tmp",resources:[]}]},
    {id:"location-b",name:"Studio",cwd:"/tmp",agentIds:["shared"],resources:[],mcp:[],skills:[],workspaces:[{id:"default",name:"Default",cwd:"/tmp",resources:[]},{id:"server",name:"Backend",cwd:"/tmp",resources:[]}]},
  ],agents:[{id:"shared",name:"Maker",instructions:"Synthetic only",defaultCli:"codex",models:{},mcp:[],skills:[]}]};
  expect((await request.put("/api/config",{data:{revision,config}})).ok()).toBe(true);
  const create=async(projectId:string,workspaceId:string,title:string)=>{
    const c=await(await request.post("/api/conversations",{data:{projectId,agentId:"shared",cli:"codex",workspaceId}})).json();
    expect((await request.patch(`/api/conversations/${c.id}`,{data:{title}})).ok()).toBe(true);return c;
  };
  const a=await create("location-a","default","Location garden");
  await create("location-b","default","Location studio");
  await create("location-b","server","Location backend");
  await page.goto(`/?project=location-a&conversation=${a.id}`);
  const row=(title:string)=>page.getByRole("navigation",{name:"会话列表",exact:true}).getByRole("button",{name:title,exact:true});
  await expect(row("Location garden").locator(".library-context-text")).toHaveText("Maker · Garden");
  await expect(row("Location studio").locator(".library-context-text")).toHaveText("Maker · Studio");
  await expect(row("Location backend").locator(".library-context-text")).toHaveText("Maker · Studio · Backend");
  await expect(row("Location garden")).toHaveAttribute("title",/\/tmp/);
  await page.reload();
  await chooseOption(page,page.getByLabel("会话视图",{exact:true}),"agents");
  await expect(row("Location garden").locator(".library-context-text")).toHaveText("Maker · Garden");
  expect((await(await request.get(`/api/conversations/${a.id}`)).json()).conversation.workspaceName).toBe("Default");
});

test('legacy completed history remains recent and archive is the only management action',async({page,request})=>{
 const chat=await(await request.post('/api/conversations',{data:{projectId:'',agentId:'',cli:'codex'}})).json();
 expect((await request.patch('/api/conversations/'+chat.id,{data:{title:'Legacy completed history'}})).ok()).toBe(true);
 expect((await request.post('/api/conversations/'+chat.id+'/completion',{data:{completed:true}})).ok()).toBe(true);
 await page.goto('/?conversation='+chat.id+'&project=');
 const library=page.locator('#navigation-chat');
 await chooseOption(page,'会话视图','recent');
 const row=library.locator('.library-item').filter({has:page.getByRole('button',{name:'Legacy completed history',exact:true})});
 await expect(row).toBeVisible();await row.hover();await row.getByRole('button',{name:'更多操作 · Legacy completed history',exact:true}).click();
 const menu=page.getByRole('menu',{name:'对话操作 · Legacy completed history',exact:true});
 await expect(menu.getByRole('menuitem')).toHaveText(['归档对话']);await menu.getByRole('menuitem').click();
 await expect(row).toHaveCount(0);await chooseOption(page,'会话视图','archived');await expect(row).toBeVisible();
 await row.hover();await row.getByRole('button',{name:'更多操作 · Legacy completed history',exact:true}).click();await menu.getByRole('menuitem',{name:'取消归档 · Legacy completed history',exact:true}).click();
 await chooseOption(page,'会话视图','recent');await expect(row).toBeVisible();
 expect((await(await request.get('/api/conversations/'+chat.id)).json()).conversation.completedAt).toEqual(expect.any(String));
});
