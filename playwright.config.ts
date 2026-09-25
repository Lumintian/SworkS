import { defineConfig, devices } from '@playwright/test';

/** 端到端测试针对构建产物运行：先执行 pnpm build。每个用例自行启动/重启服务进程。 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  outputDir: './test-results',
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 1360, height: 900 },
    locale: 'zh-CN',
    trace: 'retain-on-failure',
    acceptDownloads: true,
  },
});
