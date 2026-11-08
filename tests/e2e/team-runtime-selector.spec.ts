import {enterModelId} from './helpers/select';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import type { Cli, Config } from '../../shared/types';
import { chooseOption } from './helpers/select';
import { waitForAutosave } from './helpers/settings';

async function fixture(page: Page, request: APIRequestContext, runtimes: Cli[] = ['codex', 'omp']) {
  const { revision } = await (await request.get('/api/config')).json();
  const config: Config = {
    version: 2, projects: [], runtimes,
    agents: [{
      id: 'team-runtime-agent', name: 'Runtime selection fixture', instructions: '', defaultCli: 'codex',
      models: { codex: 'codex-original', omp: 'omp-original' }, mcp: [], skills: [],
      runtime: {
        codex: { args: ['--profile', 'original'], env: { SERVICE_TOKEN: '${CODEX_SOURCE}' }, approvalMode: 'default', fullAccess: true },
        omp: { args: ['--thinking', 'medium'], env: { SERVICE_TOKEN: '${OMP_SOURCE}' }, approvalMode: 'default' },
      },
    }],
  };
  expect((await request.put('/api/config', { data: { config, revision } })).ok()).toBe(true);
  await page.route('**/api/models?*', route => {
    const cli = new URL(route.request().url()).searchParams.get('cli');
    return route.fulfill({ json: [{ id: `${cli}-candidate`, label: `${cli} candidate` }] });
  });
  await page.goto('/agents?agent=team-runtime-agent&tab=execution');
}

for (const width of [1280, 390]) {
  test(`runtime selection preserves independent parameters through autosave and reload at ${width}px`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 844 });
    await fixture(page, request);
    const runtime = page.getByRole('combobox', { name: '默认执行端', exact: true });
    await expect(runtime).toHaveAttribute('data-value', 'codex');
    await expect(page.getByLabel('Codex 默认模型', { exact: true })).toHaveAttribute('data-value','codex-original');
    await expect(page.getByLabel('OMP 默认模型', { exact: true })).toHaveCount(0);
    await chooseOption(page, 'Codex 默认模型', 'codex-candidate');
    await page.getByText('启动参数与环境变量', { exact: true }).click();
    const codex = page.getByRole('group', { name: 'Codex 运行参数', exact: true });
    await expect(page.getByRole('group', { name: 'OMP 运行参数', exact: true })).toHaveCount(0);
    await codex.getByLabel('启动参数（每行一个）', { exact: true }).fill('--profile\nteam-codex');
    await codex.getByLabel('环境变量来源名称', { exact: true }).fill('TEAM_CODEX_SOURCE');
    await chooseOption(page, page.getByRole('combobox', { name: '默认审批模式', exact: true }), 'auto');
    await chooseOption(page, codex.getByRole('combobox', { name: '文件和网络权限', exact: true }), 'native');

    await chooseOption(page, runtime, 'omp');
    await expect(page.getByLabel('Codex 默认模型', { exact: true })).toHaveCount(0);
    await expect(page.getByLabel('OMP 默认模型', { exact: true })).toHaveAttribute('data-value','omp-original');
    await enterModelId(page,page.getByLabel('OMP 默认模型', { exact: true }),'omp-custom');
    const omp = page.getByRole('group', { name: 'OMP 运行参数', exact: true });
    await expect(codex).toHaveCount(0);
    await expect(omp.getByLabel('启动参数（每行一个）', { exact: true })).toHaveValue('--thinking\nmedium');
    await omp.getByLabel('启动参数（每行一个）', { exact: true }).fill('--thinking\nhigh');
    await omp.getByLabel('环境变量来源名称', { exact: true }).fill('TEAM_OMP_SOURCE');
    await waitForAutosave(page);
    const saved = (await (await request.get('/api/config')).json()).config.agents[0];
    expect(saved.defaultCli).toBe('omp');
    expect(saved.models).toEqual({ codex: 'codex-candidate', omp: 'omp-custom' });
    expect(saved.runtime).toEqual({
      codex: { args: ['--profile', 'team-codex'], env: { SERVICE_TOKEN: '${TEAM_CODEX_SOURCE}' }, approvalMode: 'auto', fullAccess: false },
      omp: { args: ['--thinking', 'high'], env: { SERVICE_TOKEN: '${TEAM_OMP_SOURCE}' }, approvalMode: 'default' },
    });

    await page.reload();
    await expect(runtime).toHaveAttribute('data-value', 'omp');
    await expect(page.getByLabel('OMP 默认模型', { exact: true })).toHaveAttribute('data-value','omp-custom');
    await page.getByText('启动参数与环境变量', { exact: true }).click();
    await expect(omp.getByLabel('启动参数（每行一个）', { exact: true })).toHaveValue('--thinking\nhigh');
    await chooseOption(page, runtime, 'codex');
    await expect(page.getByLabel('Codex 默认模型', { exact: true })).toHaveAttribute('data-value','codex-candidate');
    await expect(codex.getByLabel('启动参数（每行一个）', { exact: true })).toHaveValue('--profile\nteam-codex');
    await expect(codex.getByLabel('环境变量来源名称', { exact: true })).toHaveValue('TEAM_CODEX_SOURCE');
    await expect(page.getByRole('combobox', { name: '默认审批模式', exact: true })).toHaveAttribute('data-value', 'auto');
    await expect(codex.getByRole('combobox', { name: '文件和网络权限', exact: true })).toHaveAttribute('data-value', 'native');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await waitForAutosave(page);
  });
}

test('a disabled default runtime is preserved until an enabled runtime is selected', async ({ page, request }) => {
  await fixture(page, request, ['omp']);
  const runtime = page.getByRole('combobox', { name: '默认执行端', exact: true });
  await expect(runtime).toHaveAttribute('data-value', 'codex');
  await expect(page.getByText('所选执行端已停用；请在执行端接入中启用，或选择其他执行端。', { exact: true })).toBeVisible();
  await runtime.click();
  await expect(page.getByRole('option', { name: 'Codex', exact: true })).toHaveAttribute('aria-disabled', 'true');
  await page.getByRole('option', { name: 'OMP', exact: true }).click();
  await expect(runtime).toHaveAttribute('data-value', 'omp');
  await expect(page.getByLabel('OMP 默认模型', { exact: true })).toHaveAttribute('data-value','omp-original');
  await waitForAutosave(page);
  const saved = (await (await request.get('/api/config')).json()).config.agents[0];
  expect(saved.defaultCli).toBe('omp');
  expect(saved.runtime.codex.args).toEqual(['--profile', 'original']);
});

test('no enabled runtime keeps stored configuration visible without changing the default', async ({ page, request }) => {
  await fixture(page, request, []);
  await expect(page.getByRole('combobox', { name: '默认执行端', exact: true })).toBeDisabled();
  await expect(page.getByLabel('Codex 默认模型', { exact: true })).toHaveAttribute('data-value','codex-original');
  await expect(page.getByLabel('OMP 默认模型', { exact: true })).toHaveCount(0);
  const saved = (await (await request.get('/api/config')).json()).config.agents[0];
  expect(saved.defaultCli).toBe('codex');
  expect(saved.runtime.omp.args).toEqual(['--thinking', 'medium']);
});
