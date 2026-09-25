import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, type Page } from '@playwright/test';

export const ROOT = path.resolve(import.meta.dirname, '../..');

export function tempDir(prefix = 'sworks-e2e-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export interface Server {
  url: string;
  port: number;
  dataDir: string;
  proc: ChildProcess;
  output: () => string;
  stop: () => Promise<void>;
}

/** 以普通用户方式启动构建后的服务：node dist/node/server/cli/start.js --data-dir … */
export async function startServer(dataDir: string, port = 0): Promise<Server> {
  const proc = spawn(process.execPath, ['dist/node/server/cli/start.js', '--data-dir', dataDir, '--port', String(port)], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout!.on('data', (d) => (out += String(d)));
  proc.stderr!.on('data', (d) => (out += String(d)));
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 15_000);
    const check = () => {
      const m = /访问地址：(http:\/\/127\.0\.0\.1:\d+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]!);
      }
    };
    proc.stdout!.on('data', check);
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited with ${code}:\n${out}`));
    });
  });
  return {
    url,
    port: Number(new URL(url).port),
    dataDir,
    proc,
    output: () => out,
    stop: () =>
      new Promise<void>((resolve) => {
        if (proc.exitCode !== null) return resolve();
        proc.once('exit', () => resolve());
        proc.kill('SIGTERM');
      }),
  };
}

export function runRestore(input: string, dataDir: string) {
  const r = spawnSync(process.execPath, ['dist/node/server/cli/restore.js', '--input', input, '--data-dir', dataDir], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

/** 在页面里用 canvas 生成一张真实 PNG，并以剪贴板粘贴事件派发到目标元素。 */
export async function pasteGeneratedImage(page: Page, selector: string, opts: { width: number; height: number; label: string }) {
  await page.evaluate(
    async ({ selector, width, height, label }) => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const g = canvas.getContext('2d')!;
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, width, height);
      g.fillStyle = '#1d4ed8';
      g.fillRect(0, 0, width, 12);
      g.fillStyle = '#111111';
      g.font = '32px sans-serif';
      g.fillText(label, 24, height / 2);
      const blob = await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), 'image/png'));
      const file = new File([blob], `${label}.png`, { type: 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const target = document.querySelector(selector) ?? document.body;
      target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    },
    { selector, ...opts },
  );
}

export async function pasteText(page: Page, selector: string, text: string) {
  await page.evaluate(
    ({ selector, text }) => {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      document.querySelector(selector)!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    },
    { selector, text },
  );
}

/** 在 CodeMirror 编辑器中输入（逐行输入，避免编辑器的续行辅助把 “> ” 重复插入）。 */
export async function typeInEditor(page: Page, editor: ReturnType<Page['locator']>, text: string) {
  await editor.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  await editor.locator('.cm-content').evaluate((el, value) => {
    // 直接派发一次整段插入，等同于用户粘贴纯文本
    const dt = new DataTransfer();
    dt.setData('text/plain', value);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, text);
}

export async function saveAndWait(page: Page) {
  await page.getByTestId('save-button').click();
  await expect(page.getByTestId('saved-indicator')).toBeVisible();
}

export async function apiGet<T = any>(server: Server, url: string): Promise<T> {
  const res = await fetch(server.url + url);
  return (await res.json()) as T;
}
