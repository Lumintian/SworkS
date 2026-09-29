import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { apiGet, pasteGeneratedImage, runRestore, saveAndWait, startServer, tempDir, typeInEditor, type Server } from './helpers';

let servers: Server[] = [];
test.afterEach(async () => {
  for (const s of servers) await s.stop();
  servers = [];
});

test('界面生成完整备份 → 下载 → 停服后 CLI 恢复到新目录 → 以恢复目录启动内容一致', async ({ page }) => {
  const work = tempDir();
  const dataDir = path.join(work, 'data');
  const server = await startServer(dataDir);
  servers.push(server);
  await page.goto(server.url);
  await page.getByTestId('new-problem').click();
  await page.getByTestId('paste-zone').focus();
  await pasteGeneratedImage(page, '[data-testid="paste-zone"]', { width: 640, height: 320, label: 'BACKUP' });
  await expect(page.getByTestId('content-block')).toHaveCount(1);
  await page.getByRole('tablist', { name: '笔记类型' }).getByRole('tab', { name: /^解析/ }).click();
  await page.getByRole('button', { name: '添加解析' }).click();
  await typeInEditor(page, page.getByTestId('note').first(), '> [!tip]+ 恢复后应当保留\n> $$x^2$$');
  await saveAndWait(page);
  const id = page.url().split('/').pop()!;
  const before = await apiGet(server, `/api/problems/${id}`);

  await page.goto(`${server.url}/backup`);
  await expect(page.getByTestId('last-backup')).toHaveText('尚未备份');
  await page.getByTestId('create-backup').click();
  await expect(page.getByTestId('backup-result')).toContainText('本地数据备份完整');
  await expect(page.getByTestId('last-backup')).not.toHaveText('尚未备份');
  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('backup-result').getByRole('link', { name: '下载这份备份' }).click();
  const download = await downloadPromise;
  const zip = path.join(work, download.suggestedFilename());
  await download.saveAs(zip);
  expect(download.suggestedFilename()).toMatch(/^SworkS-backup-.*\.sworks\.zip$/);

  // 服务运行中恢复到它正在使用的目录：拒绝
  const busy = runRestore(zip, dataDir);
  expect(busy.code).toBe(1);
  expect(busy.out).toContain('恢复失败');

  await server.stop();
  servers = [];
  // 非空目录：拒绝，且不改动
  const nonEmpty = path.join(work, 'non-empty');
  fs.mkdirSync(nonEmpty);
  fs.writeFileSync(path.join(nonEmpty, 'keep.txt'), 'x');
  expect(runRestore(zip, nonEmpty).code).toBe(1);
  expect(fs.readdirSync(nonEmpty)).toEqual(['keep.txt']);

  const restoredDir = path.join(work, 'restored');
  const ok = runRestore(zip, restoredDir);
  expect(ok.code, ok.out).toBe(0);
  expect(ok.out).toContain('恢复完成');

  const restored = await startServer(restoredDir);
  servers.push(restored);
  const after = await apiGet(restored, `/api/problems/${id}`);
  expect(after.notes).toEqual(before.notes);
  expect(after.blocks).toEqual(before.blocks);
  await page.goto(`${restored.url}/problems/${id}`);
  const img = page.locator('img.source-image');
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBe(640);
  await expect(page.locator('.callout[data-callout="tip"]')).toBeVisible();
});

test('外部网页不能修改本地库（跨源 fetch、表单提交、DNS 重绑定 Host）', async ({ page }) => {
  const dataDir = path.join(tempDir(), 'data');
  const server = await startServer(dataDir);
  servers.push(server);
  const target = server.url;
  // 另一个来源上的“恶意”页面
  const evil = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><body>
      <form id="f" method="POST" action="${target}/api/problems" enctype="text/plain">
        <input name='{"id":"11111111-1111-4111-8111-111111111111","blocks":[],"x":"' value='"}'>
      </form>
      <script>
        window.results = [];
        const body = JSON.stringify({ id: '22222222-2222-4222-8222-222222222222', blocks: [] });
        fetch('${target}/api/problems', { method: 'POST', mode: 'no-cors', headers: { 'content-type': 'text/plain' }, body })
          .then(r => results.push('no-cors:' + r.type)).catch(e => results.push('no-cors-error'));
        fetch('${target}/api/problems', { method: 'POST', headers: { 'content-type': 'application/json', 'x-sworks-csrf': 'guess' }, body })
          .then(r => results.push('cors:' + r.status)).catch(e => results.push('cors-error'));
        fetch('${target}/api/session').then(r => r.json()).then(j => results.push('read-token:' + j.csrfToken)).catch(() => results.push('read-token-blocked'));
      </script></body>`);
  });
  await new Promise<void>((r) => evil.listen(0, '127.0.0.1', r));
  const evilUrl = `http://127.0.0.1:${(evil.address() as AddressInfo).port}/`;
  await page.goto(evilUrl);
  await expect.poll(() => page.evaluate(() => (window as unknown as { results: string[] }).results.length)).toBe(3);
  const results = await page.evaluate(() => (window as unknown as { results: string[] }).results);
  expect(results).toContain('read-token-blocked');
  expect(results).toContain('cors-error');
  await page.evaluate(() => (document.getElementById('f') as HTMLFormElement).submit());
  await page.waitForLoadState();
  evil.close();
  const list = await apiGet(server, '/api/problems');
  expect(list.total).toBe(0);
  // DNS 重绑定：Host 不是本机时拒绝
  // （fetch 会丢弃自定义 Host 头，这里用 http.request 发送原始请求）
  const status = await new Promise<number>((resolve, reject) => {
    const req = http.request(`${target}/api/session`, { headers: { host: 'attacker.example' } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
  expect(status).toBe(403);
});

test('主题与布局：自然有机风配色、无外部字体、长公式不撑破布局', async ({ page }) => {
  const dataDir = path.join(tempDir(), 'data');
  const server = await startServer(dataDir);
  servers.push(server);
  await page.goto(server.url);
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).toBe('rgb(250, 246, 241)');
  const primary = await page.getByTestId('new-problem').evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(primary).toBe('rgb(92, 64, 51)');
  const bodyFont = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
  expect(bodyFont).not.toMatch(/Inter|Roboto|Geist/);
  const headingFont = await page.locator('h1').first().evaluate((el) => getComputedStyle(el).fontFamily);
  expect(headingFont).toContain('Lora');

  await page.getByTestId('new-problem').click();
  await page.getByRole('button', { name: 'Markdown', exact: true }).click();
  const long = `$$${Array.from({ length: 60 }, (_, i) => `x_{${i}}`).join('+')}$$`;
  await typeInEditor(page, page.getByTestId('content-block').first(), long);
  await saveAndWait(page);
  await page.reload();
  const display = page.locator('.katex-display').first();
  await expect(display).toBeVisible();
  const overflow = await display.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
  expect(overflow.sw).toBeGreaterThan(overflow.cw); // 公式区域内部可横向滚动
  const pageOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(pageOverflow).toBeLessThanOrEqual(0); // 页面本身没有被撑出横向滚动
  await page.setViewportSize({ width: 720, height: 900 });
  const narrowOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(narrowOverflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: path.join('test-results', 'theme-narrow.png'), fullPage: true });
});
