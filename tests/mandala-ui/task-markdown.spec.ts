import {expect,test} from '@playwright/test';

// A task's structured criteria and receipt prose must remain readable without changing acceptance.
for(const mode of ['light','dark'])for(const width of [1440,390])test(`task criteria and receipts render Markdown ${mode} ${width}`,async({page,request},info)=>{
 const fixture=await(await request.post('/__test__/execution-results')).json();
 const path='/api/v2/tasks/'+fixture.taskId,read=async()=>await(await request.get(path)).json();
 const before=await read(),description='### 核对范围\n\n保留 **原始证据**，核对 `project_id`。';
 const criteria=[{id:'source',text:'**证据完整**，参见 [来源](https://example.com/evidence)',checkRef:null},{id:'display',text:'- [x] 仅为展示',checkRef:null}];
 expect((await request.patch(path,{headers:{'Idempotency-Key':crypto.randomUUID()},data:{expectedRevision:before.task.revision,goal:'账单核对\n\n'+description,criteria}})).ok()).toBe(true);
 const saved=await read();
 const summary='### 核对结果\n\n已检查 **两条记录**。\n\n- [证据链接](https://example.com/report)\n\n| 字段 | 结果 |\n| --- | --- |\n| project_id | 完整 |\n\n```sql\nSELECT project_id FROM billing;\n```\n\n<script>window.taskMarkdownUnsafe=true</script>\n\n[危险链接](javascript:alert(1))';
 // Keep the complete real receipt shape; vary only the output text at the API boundary.
 await page.route('**'+path,async route=>{
  const response=await route.fetch(),detail=await response.json();
  await route.fulfill({json:{...detail,receipts:detail.receipts.map((receipt:object,index:number)=>index?receipt:{...receipt,summary})}});
 });
 await page.addInitScript(mode=>localStorage.setItem('mana-theme',mode),mode);
 await page.setViewportSize({width,height:1000});await page.goto('/tasks/'+fixture.taskId+'?scope=all&view=list');
 const detail=page.locator('.task-detail'),body=detail.locator('.task-description'),items=detail.locator('.task-criteria > ul > li'),receipt=detail.locator('.task-receipt').first();
 await expect(body.getByRole('heading',{name:'核对范围',exact:true})).toBeVisible();
 await expect(body.locator('strong')).toHaveText('原始证据');await expect(body.locator('code')).toHaveText('project_id');
 await expect(items).toHaveCount(2);await expect(items.first().locator('strong')).toHaveText('证据完整');
 await expect(items.first().getByRole('link',{name:'来源',exact:true})).toHaveAttribute('href','https://example.com/evidence');
 await expect(items.nth(1).getByRole('checkbox')).toBeChecked();await expect(items.nth(1).getByRole('checkbox')).toBeDisabled();
 await expect(receipt.getByRole('heading',{name:'核对结果',exact:true})).toBeVisible();
 await expect(receipt.locator('strong')).toHaveText('两条记录');await expect(receipt.getByRole('table')).toContainText('project_id');
 await expect(receipt.locator('pre')).toContainText('SELECT project_id FROM billing;');
 await expect(receipt.getByRole('link',{name:'证据链接',exact:true})).toHaveAttribute('href','https://example.com/report');
 await expect(receipt.locator('script')).toHaveCount(0);await expect(receipt.getByRole('link',{name:'危险链接',exact:true})).toHaveCount(0);
 expect(await page.evaluate(()=>('taskMarkdownUnsafe' in window))).toBe(false);
 await receipt.scrollIntoViewIfNeeded();await page.screenshot({path:info.outputPath(`task-markdown-${mode}-${width}.png`),animations:'disabled'});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 expect((await read()).task).toEqual(saved.task);
 await page.goto('/tasks/'+fixture.taskId+'?scope=all&view=list&action=edit');
 await expect(page.getByRole('textbox',{name:'详细说明',exact:true})).toHaveValue(description);
 await expect(page.getByRole('textbox',{name:'完成要求',exact:true})).toHaveValue(criteria.map(item=>item.text).join('\n'));
});
