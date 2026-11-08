import {defineConfig} from '@playwright/test';
import base from './playwright.config';
// Empty-primary lifecycle needs a fresh HOME, separate from coordination scenarios.
export default defineConfig({...base,testDir:'./tests/mandala-welcome-ui'});
