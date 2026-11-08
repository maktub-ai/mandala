import { test as base } from '@playwright/test';

// Independent behavior scenarios must not inherit an earlier unconfirmed writer.
// Same-directory serialization remains covered by the durable/resource tests.
export const test = base.extend<{ executionDirectory: string }>({
  executionDirectory: async ({ request }, use) => {
    const response = await request.post('/__test__/execution-directory');
    if (!response.ok()) throw new Error('Failed to allocate test execution directory');
    const { directory } = await response.json();
    // The server owns cleanup after manager.close(), including work accepted near teardown.
    await use(directory);
  },
});
export { expect } from '@playwright/test';
