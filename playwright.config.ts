import {defineConfig, devices} from '@playwright/test';
import {existsSync} from 'node:fs';

const containerChromiumPath = '/ms-playwright/chrome-headless-shell-linux64/chrome-headless-shell';
const executablePath =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
  (existsSync(containerChromiumPath) ? containerChromiumPath : undefined);

export default defineConfig({
  testDir: './e2e',
  testIgnore: '**/*.bench.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 2,
  timeout: 45_000,
  expect: {timeout: 10_000},
  reporter: [['list'], ['html', {open: 'never'}]],
  outputDir: 'test-results',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    viewport: {width: 1440, height: 900},
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    ...(executablePath
      ? {
          launchOptions: {
            executablePath,
            headless: true,
            chromiumSandbox: false,
            args: [
              '--use-gl=angle',
              '--use-angle=swiftshader',
              '--enable-unsafe-swiftshader',
            ],
          },
        }
      : {}),
  },
  projects: [{name: 'chromium', use: {...devices['Desktop Chrome'], viewport: {width: 1440, height: 900}}}],
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
