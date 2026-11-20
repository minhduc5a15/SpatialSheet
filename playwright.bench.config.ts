import {defineConfig} from '@playwright/test';
import config from './playwright.config';
export default defineConfig(config, {
  testMatch: '**/*.bench.ts',
  testIgnore: [],
  workers: 1,
  retries: 0,
  timeout: 180_000,
  reporter: [['list']],
  outputDir: 'benchmark-results',
  use: {trace: 'off', screenshot: 'only-on-failure'},
});
