import { expect, type Locator, type Page } from "@playwright/test";

/** Use the visible picker, including its portal, rather than a hidden native select. */
export async function chooseOption(page: Page, control: string | Locator, value: string) {
  const trigger = typeof control === "string"
    ? page.getByRole("combobox", { name: control, exact: true })
      .or(page.getByRole("radiogroup", { name: control, exact: true })) : control;
  const settings = page.getByRole('button', { name: /^(输入区设置|Composer settings)$/, exact: true });
  if (!await trigger.isVisible() && await settings.isVisible()) await settings.click();
  await expect(trigger).toBeVisible();
  if (await trigger.getAttribute("role") === "radiogroup") {
    await trigger.locator(`[role="radio"][data-value=${JSON.stringify(value)}]`).click();
    await expectSelection(trigger, value);
    return;
  }
  await trigger.click();
  // The option itself carries the stable ID; its visible label can be duplicated.
  await page.getByRole("listbox").locator(`[role="option"][data-value=${JSON.stringify(value)}]`).click();
  await expect(trigger).toHaveAttribute("data-value", value);
}

export async function expectSelection(control: Locator, value: string) {
  await expect(control).toBeVisible();
  if (await control.getAttribute("role") === "radiogroup") {
    await expect(control.locator(`[role="radio"][data-value=${JSON.stringify(value)}]`))
      .toHaveAttribute("aria-checked", "true");
  } else await expect(control).toHaveAttribute("data-value", value);
}

export async function interruptSend(page: Page) {
  await page.getByRole('button', { name: /^(发送选项|Send options)$/, exact: true }).click();
  await page.getByRole('menuitem', { name: /^(打断并发送|Interrupt and send)$/, exact: true }).click();
}

/** Enter a custom model through the same searchable field a user edits. */
export async function enterModelId(page:Page, control:string|Locator, value:string){
 const trigger=typeof control==='string'?page.getByRole('combobox',{name:control,exact:true}):control;
 await trigger.click();await page.getByRole('searchbox').last().fill(value);
 await page.getByRole('listbox').locator('[role="option"][data-value='+JSON.stringify(value)+']').click();
 await expect(trigger).toHaveAttribute('data-value',value);
}
