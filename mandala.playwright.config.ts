import { defineConfig } from '@playwright/test';
import base from './playwright.config';
// System identity is intentionally non-deletable: isolate this home from legacy config-reset scenarios.
export default defineConfig({ ...base, testDir: './tests/mandala-ui' });
