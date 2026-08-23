const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './test/e2e',
  workers: 1,
  timeout: 30_000,
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' }
});
