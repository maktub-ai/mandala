import { existsSync } from 'node:fs';
import { test, expect } from './helpers/execution-fixture';

let previousDirectory = '';
test.describe.serial('server-owned execution fixture directory lifetime', () => {
  test('allocates a distinct directory for a behavior scenario', async ({ executionDirectory }) => {
    previousDirectory = executionDirectory;
    expect(existsSync(executionDirectory)).toBe(true);
  });
  test('retains the previous scenario directory while the server may still own asynchronous work', async ({ request, executionDirectory }) => {
    expect(executionDirectory).not.toBe(previousDirectory);
    expect(existsSync(previousDirectory)).toBe(true);
    expect((await request.get('/api/config')).ok()).toBe(true);
  });
});
