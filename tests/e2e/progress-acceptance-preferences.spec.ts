// spec: specs/progress-acceptance-plan.md
// seed: tests/e2e/seed.spec.ts
import {mkdirSync} from 'node:fs';
import {test,expect} from '@playwright/test';
import {chooseOption} from './helpers/select';
test.describe('Progress 用户目标验收',()=>{test('P06 full Progress filter context survives Task navigation return and refresh',async({page,request})=>{

 const d=await(await request.post('/__test__/progress-fixture')).json();await page.goto('/tasks');await page.getByRole('button',{name:'筛选',exact:true}).click();
 // Every dimension is intentional; choosing another filter must not reset it.
 await chooseOption(page,'显示类型','all');await chooseOption(page,'进度项目','progress-demo');await chooseOption(page,'可见范围','all');await chooseOption(page,'最近使用窗口','240');await chooseOption(page,'任务状态','all');await chooseOption(page,'任务排序','oldest');
 await page.getByRole('searchbox',{name:'搜索任务与对话',exact:true}).fill('发布');
 await page.locator('[data-task-id="'+d.task+'"] .task-work-heading > a').click();await expect(page.locator('.task-detail')).toBeVisible();await page.locator('.task-breadcrumb a').click();
 mkdirSync('/tmp/mandala-task-compat/audit/2026-10-23-progress-acceptance',{recursive:true});await page.screenshot({path:'/tmp/mandala-task-compat/audit/2026-10-23-progress-acceptance/after-filter-return.png',fullPage:true});
 for(const [name,value] of [['显示类型','all'],['进度项目','progress-demo'],['可见范围','all'],['最近使用窗口','240'],['任务状态','all'],['任务排序','oldest']])await expect(page.getByRole('combobox',{name,exact:true})).toHaveAttribute('data-value',value);
 await expect(page.getByRole('searchbox',{name:'搜索任务与对话',exact:true})).toHaveValue('发布');await page.reload();const filterToggle=page.getByRole('button',{name:'筛选',exact:true});if(await filterToggle.getAttribute('aria-expanded')!=='true')await filterToggle.click();
 await expect(page.getByRole('searchbox',{name:'搜索任务与对话',exact:true})).toHaveValue('发布');await expect(page.getByRole('combobox',{name:'可见范围',exact:true})).toHaveAttribute('data-value','all');await expect(page.getByRole('combobox',{name:'最近使用窗口',exact:true})).toHaveAttribute('data-value','240');
 expect((await(await request.get('/api/v2/tasks/'+d.task)).json()).runs).toHaveLength(0);

});});
