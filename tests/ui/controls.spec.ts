import { test, expect } from '@playwright/test';
test('Escape closes only the innermost dialog and restores focus', async ({ page }) => {
  await page.goto('/ui.html');
  await page.getByRole('button', { name: '打开对话框' }).click();
  await expect(page.getByRole('textbox', { name: '弹窗名称' })).toBeFocused();
  await page.getByRole('button', { name: '打开内层' }).click();
  await expect(page.getByRole('button', { name: '关闭内层' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: '关闭内层' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: '内层示例' })).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: '外层示例' })).toBeVisible();
  await expect(page.getByRole('button', { name: '打开内层' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '打开对话框' })).toBeFocused();
});

test('non-search Select exposes the active option on the focused listbox', async ({ page }) => {
  await page.goto('/ui.html');
  const trigger = page.getByRole('combobox', { name: '无搜索选项' });
  await trigger.click();
  const list = page.getByRole('listbox', { name: '无搜索选项' });
  await expect(list).toBeFocused();
  await list.press('ArrowDown');
  const active = await list.getAttribute('aria-activedescendant');
  await expect(page.locator(`[id="${active}"]`)).toHaveText('第二项');
  await list.press('Enter');
  await expect(trigger).toHaveAttribute('data-value', 'two');
  await expect(trigger).toBeFocused();
});

test('a Select inside a dialog owns selection and Escape before its dialog', async ({page}) => {
  await page.goto('/ui.html');
  await page.getByRole('button',{name:'打开对话框'}).click();
  const dialog=page.getByRole('dialog',{name:'外层示例'});
  const select=dialog.getByRole('combobox',{name:'弹窗选项'});
  await select.click();
  await page.getByRole('searchbox',{name:/弹窗选项/}).press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(select).toHaveAttribute('data-value','two');
  await expect(dialog).toBeVisible();
  await select.click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listbox',{name:'弹窗选项'})).toHaveCount(0);
  await expect(select).toBeFocused();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});


test('Select retains searching by model ID and custom entries',async({page})=>{
 await page.goto('/ui.html');
 const select=page.getByRole('combobox',{name:'自定义模型'});
 await select.click();await page.getByRole('searchbox').fill('model-123');
 await expect(page.getByRole('option',{name:'模型名称'})).toBeVisible();
 await page.getByRole('searchbox').fill('custom-v2');
 await page.getByRole('option',{name:'custom-v2',exact:true}).click();
 await expect(select).toHaveAttribute('data-value','custom-v2');
 await expect(select).toContainText('custom-v2');
});


test('native form semantics and field descriptions survive shared controls',async({page})=>{
 await page.goto('/ui.html');
 await expect(page.getByRole('textbox',{name:'名称',exact:true})).toHaveAccessibleDescription('可使用中文或英文。');
 await expect(page.getByRole('textbox',{name:'验证错误'})).toHaveAttribute('aria-invalid','true');
 await expect(page.getByRole('textbox',{name:'验证错误'})).toHaveAccessibleDescription('请填写有效的名称。');
 await expect(page.getByRole('combobox',{name:'选择字段'})).toHaveAttribute('id','catalog-selection');
 await expect(page.getByRole('combobox',{name:'选择字段'})).toHaveAccessibleDescription('已关联的提示');
 await page.getByRole('button',{name:'表单内操作'}).click();
 await expect(page.getByLabel('提交次数')).toHaveText('0');
 await page.keyboard.press('Escape');
 await page.getByRole('button',{name:'提交示例'}).click();
 await expect(page.getByLabel('提交次数')).toHaveText('1');
 await expect(page.getByRole('button',{name:'处理中'})).toBeDisabled();
});

test('tabs and radios skip disabled choices, wrap and label the active panel',async({page})=>{
 await page.goto('/ui.html');
 const first=page.getByRole('tab',{name:'基础控件'}),last=page.getByRole('tab',{name:'反馈与内容'});
 await first.focus();await page.keyboard.press('ArrowRight');
 await expect(last).toBeFocused();await expect(last).toHaveAttribute('aria-selected','true');
 await expect(first).toHaveAttribute('tabindex','-1');
 await expect(page.getByRole('tabpanel',{name:'反馈与内容'})).toBeVisible();
 await page.keyboard.press('Home');await expect(first).toBeFocused();
 await page.keyboard.press('End');await expect(last).toBeFocused();
 const comfortable=page.getByRole('radio',{name:'舒适'}),compact=page.getByRole('radio',{name:'紧凑'});
 await comfortable.focus();await page.keyboard.press('ArrowDown');
 await expect(compact).toBeFocused();await expect(compact).toBeChecked();
 await page.keyboard.press('ArrowRight');await expect(comfortable).toBeFocused();
});

test('controls retain their current theme, narrow layout and visible focus',async({page})=>{
 await page.setViewportSize({width:390,height:844});await page.goto('/ui.html');
 for(const theme of ['浅色','深色']){
  await page.getByRole('button',{name:theme,exact:true}).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme',theme==='浅色'?'light':'dark');
  const tab=page.getByRole('tab',{name:'基础控件'});await tab.focus();await page.keyboard.press('End');await page.keyboard.press('Home');
  await expect(tab).toBeFocused();
  const geometry=await tab.evaluate(el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return {left:r.left,right:r.right,outline:s.outlineStyle};});
  expect(geometry.left).toBeGreaterThanOrEqual(0);expect(geometry.right).toBeLessThanOrEqual(390);expect(geometry.outline).not.toBe('none');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
 }
 await page.screenshot({path:'test-results-ui/shared-controls-dark-390.png',fullPage:true});
});

test('Chinese composition does not select an option or dismiss its dialog', async ({ page }) => {
  await page.goto('/ui.html');
  await page.getByRole('button', { name: '打开对话框', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '外层示例' });
  const trigger = dialog.getByRole('combobox', { name: '弹窗选项' });
  await trigger.click();
  const input = page.getByRole('searchbox', { name: /弹窗选项/ });
  await input.dispatchEvent('compositionstart', { data: '第' });
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, keyCode: 229 });
  await expect(trigger).toHaveAttribute('data-value', 'one');
  await expect(input).toBeVisible();
  await input.dispatchEvent('keydown', { key: 'Escape', code: 'Escape', isComposing: true, keyCode: 229 });
  await expect(input).toBeVisible();
  await expect(dialog).toBeVisible();
  await input.dispatchEvent('compositionend', { data: '第' });
  await input.press('Escape');
  await expect(input).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('a locked dialog keeps protected focus until explicitly unlocked', async ({ page }) => {
  await page.goto('/ui.html');
  const opener = page.getByRole('button', { name: '打开锁定对话框' });
  await opener.click();
  const dialog = page.getByRole('dialog', { name: '锁定示例' });
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await page.mouse.click(4, 4);
  await expect(dialog).toBeVisible();
  await page.getByRole('button', { name: '解除锁定' }).click();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test('long Select content stays in the viewport and keyboard skips disabled options', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/ui.html');
  const trigger = page.getByRole('combobox', { name: '长选项与禁用状态' });
  await trigger.click();
  const list = page.getByRole('listbox', { name: '长选项与禁用状态' });
  await list.press('ArrowDown');
  await list.press('Enter');
  await expect(trigger).toHaveAttribute('data-value', 'two');
  await trigger.click();
  const long = page.getByRole('option').filter({ hasText: /long bilingual/ });
  await expect(long).toBeVisible();
  const bounds = await page.locator('.ui-select-popup').boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(844);
  await list.press('End');
  await list.press('Enter');
  await expect(trigger).toHaveAttribute('data-value', 'long');
  await expect(trigger).toBeFocused();
});

test('tab selection ignores composition navigation keys', async ({ page }) => {
  await page.goto('/ui.html');
  const first = page.getByRole('tab', { name: '基础控件' });
  await first.focus();
  await first.dispatchEvent('keydown', { key: 'ArrowRight', isComposing: true, keyCode: 229 });
  await expect(first).toHaveAttribute('aria-selected', 'true');
  await expect(first).toBeFocused();
});

test('Select Tab and outside clicks return control to the surrounding form', async ({ page }) => {
  await page.goto('/ui.html');
  const select = page.getByRole('combobox', { name: '选择字段' });
  await select.click();
  await page.getByRole('searchbox', { name: /选择字段/ }).press('Tab');
  await expect(select).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('button', { name: '提交示例' })).toBeFocused();
  await select.click();
  const name = page.getByRole('textbox', { name: '名称', exact: true });
  await name.click();
  await expect(select).toHaveAttribute('aria-expanded', 'false');
  await expect(name).toBeFocused();
});

test('focusing an unselected segmented choice does not change its value', async ({ page }) => {
  await page.goto('/ui.html');
  const comfortable = page.getByRole('radio', { name: '舒适' });
  const compact = page.getByRole('radio', { name: '紧凑' });
  await compact.focus();
  await expect(compact).toBeFocused();
  await expect(compact).not.toBeChecked();
  await expect(comfortable).toBeChecked();
  await page.keyboard.press('ArrowRight');
  await expect(comfortable).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(compact).toBeFocused();
  await expect(compact).toBeChecked();
});


test('rapid nested dialog and Select openings route each Escape to one current scope', async ({ page }) => {
  await page.goto('/ui.html');
  await page.getByRole('button', { name: '打开对话框', exact: true }).click();
  const outer = page.getByRole('dialog', { name: '外层示例' });
  const select = outer.getByRole('combobox', { name: '弹窗选项' });
  for (let attempt = 0; attempt < 12; attempt++) {
    await page.getByRole('button', { name: '打开内层' }).click();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: '内层示例' })).toHaveCount(0);
    await expect(outer).toBeVisible();
    await expect(page.getByRole('button', { name: '打开内层' })).toBeFocused();
    await select.click();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('listbox', { name: '弹窗选项' })).toHaveCount(0);
    await expect(outer).toBeVisible();
    await expect(select).toBeFocused();
  }
  await page.keyboard.press('Escape');
  await expect(outer).toHaveCount(0);
  await expect(page.getByRole('button', { name: '打开对话框', exact: true })).toBeFocused();
});


test('rapid DropdownMenu Escape leaves its containing dialog open', async ({ page }) => {
  await page.goto('/ui.html');
  await page.getByRole('button', { name: '打开对话框', exact: true }).click();
  const outer = page.getByRole('dialog', { name: '外层示例' });
  const trigger = outer.getByRole('button', { name: '弹窗菜单' });
  for (let attempt = 0; attempt < 20; attempt++) {
    await trigger.click();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu', { name: '弹窗操作' })).not.toBeVisible();
    await expect(outer).toBeVisible();
    await expect(trigger).toBeFocused();
  }
  await page.keyboard.press('Escape');
  await expect(outer).toHaveCount(0);
});
