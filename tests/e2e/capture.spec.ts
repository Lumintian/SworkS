import path from 'node:path';
import { expect, test } from '@playwright/test';
import { apiGet, pasteGeneratedImage, pasteText, saveAndWait, startServer, tempDir, typeInEditor, type Server } from './helpers';

let server: Server | undefined;
test.afterEach(async () => {
  await server?.stop();
  server = undefined;
});

const ANSWER_MD = ['> [!answer]- 展开参考答案', '> 由均值不等式 $a+b\\ge 2\\sqrt{ab}$，最小值为 $4$。', '>', '> > [!warning] 易漏条件', '> > 需要 $a,b>0$。'].join('\n');

test('粘贴截图即可保存；多块排序、类型化笔记、公式与 callout；重启后一致；笔记关键词可检索', async ({ page }) => {
  const dataDir = path.join(tempDir(), 'data');
  server = await startServer(dataDir);
  const nonLocal: string[] = [];
  page.on('request', (r) => {
    if (!r.url().startsWith(server!.url) && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) nonLocal.push(r.url());
  });

  await page.goto(server.url);
  await page.getByTestId('new-problem').click();
  await expect(page.getByTestId('problem-editor')).toBeVisible();

  // 1) 在收录区粘贴截图（不填标题/属性）
  await page.getByTestId('paste-zone').focus();
  await pasteGeneratedImage(page, '[data-testid="paste-zone"]', { width: 900, height: 240, label: 'IMG-A' });
  await expect(page.getByTestId('content-block')).toHaveCount(1);
  await saveAndWait(page);
  await expect(page).toHaveURL(/\/problems\/[0-9a-f-]{36}$/);
  const id = page.url().split('/').pop()!;
  let p = await apiGet(server, `/api/problems/${id}`);
  expect(p.title).toBeNull();
  expect(p.blocks).toHaveLength(1);

  // 2) 追加第二张图、Markdown 块、普通文字块，并调整顺序
  await page.getByTestId('paste-zone').focus();
  await pasteGeneratedImage(page, '[data-testid="paste-zone"]', { width: 300, height: 600, label: 'IMG-B' });
  await expect(page.getByTestId('content-block')).toHaveCount(2);
  await page.getByRole('button', { name: 'Markdown', exact: true }).click();
  const mdBlock = page.getByTestId('content-block').nth(2);
  await typeInEditor(page, mdBlock, '已知函数 $f(x)=x+\\frac{4}{x}$，求最小值。');
  await pasteText(page, '[data-testid="paste-zone"]', '**字面** # 不是标题');
  await expect(page.getByTestId('content-block')).toHaveCount(4);
  // 把 Markdown 块移到最前
  await page.getByRole('button', { name: '上移第 3 块' }).click();
  await page.getByRole('button', { name: '上移第 2 块' }).click();
  await expect(page.getByTestId('content-block').first()).toHaveAttribute('data-block-kind', 'markdown');

  // 3) 三类笔记
  await page.getByRole('button', { name: '答案', exact: true }).click();
  await typeInEditor(page, page.getByTestId('note').nth(0), ANSWER_MD);
  await page.getByRole('button', { name: '解析', exact: true }).click();
  await typeInEditor(page, page.getByTestId('note').nth(1), '令 $t=x^2$ 换元。');
  await page.getByTestId('note').nth(1).getByLabel('笔记标题').fill('我的解法');
  await page.getByRole('button', { name: '笔记', exact: true }).click();
  await typeInEditor(page, page.getByTestId('note').nth(2), '这道题的关键是对勾函数。');
  // 属性与标签（可选）
  await page.getByTestId('problem-editor').getByLabel('学科', { exact: true }).fill('数学');
  await page.getByLabel('添加标签').fill('函数');
  await page.getByLabel('添加标签').press('Enter');
  await saveAndWait(page);

  p = await apiGet(server, `/api/problems/${id}`);
  const kinds = p.blocks.map((b: { kind: string }) => b.kind);
  expect(kinds).toEqual(['markdown', 'image', 'image', 'text']);
  expect(p.blocks[3].body).toBe('**字面** # 不是标题');
  expect(p.notes.map((n: { type: string }) => n.type)).toEqual(['answer', 'solution', 'note']);
  expect(p.notes[0].bodyMd).toBe(ANSWER_MD);
  expect(p.title).toBeNull();

  // 4) 重启服务后重新打开：内容、顺序、图片都在
  const port = server.port;
  await server.stop();
  server = await startServer(dataDir, port);
  await page.reload();
  await expect(page.getByTestId('content-block')).toHaveCount(4);
  await expect(page.getByTestId('content-block').first()).toHaveAttribute('data-block-kind', 'markdown');
  const imgs = page.locator('img.source-image');
  await expect(imgs).toHaveCount(2);
  for (let i = 0; i < 2; i++) {
    await expect.poll(() => imgs.nth(i).evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBeGreaterThan(0);
  }
  // 原图不裁切：显示宽高比等于原始宽高比
  const ratio = await imgs.nth(1).evaluate((el: HTMLImageElement) => ({ shown: el.clientWidth / el.clientHeight, natural: el.naturalWidth / el.naturalHeight }));
  expect(Math.abs(ratio.shown - ratio.natural)).toBeLessThan(0.02);
  // 普通文字按字面显示
  await expect(page.getByTestId('content-block').nth(3)).toContainText('**字面** # 不是标题');
  // 公式与 callout 渲染；折叠的答案默认收起
  await expect(page.getByTestId('content-block').first().locator('.katex')).toHaveCount(1);
  const answer = page.getByTestId('note').first();
  const details = answer.locator('details.callout[data-callout="answer"]');
  await expect(details).toHaveCount(1);
  expect(await details.evaluate((el: HTMLDetailsElement) => el.open)).toBe(false);
  await details.locator('summary').click();
  await expect(details.locator('.callout[data-callout="warning"]')).toBeVisible();
  await expect(details.locator('.katex').first()).toBeVisible();

  // 5) 只出现在答案里的中文关键词可检索，并提示命中位置
  await page.goto(`${server.url}/problems`);
  await page.getByTestId('search-input').fill('易漏条件');
  await expect(page.getByTestId('result-count')).toContainText('共 1 项');
  await expect(page.getByTestId('hit-badges')).toContainText('命中答案');
  await expect(page.getByTestId('list-item')).toContainText('未命名题目');

  // 全程没有向本机以外的地址发请求（无 CDN、无外链）
  expect(nonLocal).toEqual([]);
});

test('服务不可用时保存失败不显示已保存，内容保留；服务恢复后重试成功', async ({ page }) => {
  const dataDir = path.join(tempDir(), 'data');
  server = await startServer(dataDir);
  await page.goto(server.url);
  await page.getByTestId('new-problem').click();
  await page.getByRole('button', { name: 'Markdown', exact: true }).click();
  await typeInEditor(page, page.getByTestId('content-block').first(), '服务中断时写下的内容');
  const port = server.port;
  await server.stop();
  await page.getByTestId('save-button').click();
  await expect(page.getByTestId('save-status')).toContainText('保存失败');
  await expect(page.getByTestId('saved-indicator')).toHaveCount(0);
  await expect(page.getByTestId('content-block').first()).toContainText('服务中断时写下的内容');
  // 服务重启（CSRF 令牌已变化），重试保存
  server = await startServer(dataDir, port);
  await page.getByTestId('save-button').click();
  await expect(page.getByTestId('saved-indicator')).toBeVisible();
  const list = await apiGet(server, '/api/problems');
  expect(list.total).toBe(1);
});

test('两个页面编辑同一题：后保存的一方得到冲突提示，不静默覆盖', async ({ browser }) => {
  const dataDir = path.join(tempDir(), 'data');
  server = await startServer(dataDir);
  const ctx = await browser.newContext();
  const a = await ctx.newPage();
  await a.goto(server.url);
  await a.getByTestId('new-problem').click();
  await a.getByRole('button', { name: 'Markdown', exact: true }).click();
  await typeInEditor(a, a.getByTestId('content-block').first(), '原始内容');
  await saveAndWait(a);
  const url = a.url();
  // 另一个浏览器上下文：收不到本浏览器的跨标签页通知，模拟陈旧页面
  const ctxB = await browser.newContext();
  const b = await ctxB.newPage();
  await b.goto(url);
  await expect(b.getByTestId('content-block')).toHaveCount(1);

  await a.getByLabel('标题（可选）').fill('A 页面的标题');
  await saveAndWait(a);
  await b.getByLabel('标题（可选）').fill('B 页面的标题');
  await b.getByTestId('save-button').click();
  await expect(b.getByRole('dialog', { name: '保存冲突' })).toBeVisible();
  await expect(b.getByLabel('标题（可选）')).toHaveValue('B 页面的标题');
  const p = await apiGet(server, `/api/problems/${url.split('/').pop()}`);
  expect(p.title).toBe('A 页面的标题');
  // 另存为新题目
  await b.getByRole('button', { name: '另存为新题目' }).click();
  await expect(b).not.toHaveURL(url);
  const list = await apiGet(server, '/api/problems');
  expect(list.total).toBe(2);
  await ctx.close();
  await ctxB.close();
});

test('同一浏览器的两个标签页：未修改的页面自动刷新，有未保存修改的页面提前提示', async ({ browser }) => {
  const dataDir = path.join(tempDir(), 'data');
  server = await startServer(dataDir);
  const ctx = await browser.newContext();
  const a = await ctx.newPage();
  await a.goto(server.url);
  await a.getByTestId('new-problem').click();
  await a.getByRole('button', { name: 'Markdown', exact: true }).click();
  await typeInEditor(a, a.getByTestId('content-block').first(), '原始内容');
  await saveAndWait(a);
  const url = a.url();
  const b = await ctx.newPage();
  await b.goto(url);
  await expect(b.getByTestId('content-block')).toHaveCount(1);

  // B 没有未保存修改：A 保存后 B 自动显示最新内容
  await a.getByLabel('标题（可选）').fill('第一次修改');
  await saveAndWait(a);
  await expect(b.getByLabel('标题（可选）')).toHaveValue('第一次修改');

  // B 有未保存修改：A 再保存时 B 立即看到提示，保存会得到冲突而不是覆盖
  await b.getByLabel('标题（可选）').fill('B 的草稿');
  await a.getByLabel('标题（可选）').fill('第二次修改');
  await saveAndWait(a);
  await expect(b.getByTestId('changed-elsewhere')).toBeVisible();
  await expect(b.getByLabel('标题（可选）')).toHaveValue('B 的草稿');
  await b.getByTestId('save-button').click();
  await expect(b.getByRole('dialog', { name: '保存冲突' })).toBeVisible();
  const p = await apiGet(server, `/api/problems/${url.split('/').pop()}`);
  expect(p.title).toBe('第二次修改');
  await ctx.close();
});

test('资料独立保存、收件箱视图、从资料建题后双方独立', async ({ page }) => {
  const dataDir = path.join(tempDir(), 'data');
  server = await startServer(dataDir);
  await page.goto(`${server.url}/inbox`);
  await page.getByRole('button', { name: '收进收件箱' }).click();
  await expect(page.getByTestId('material-editor')).toBeVisible();
  await page.getByLabel('标题（可选）').fill('数列专题摘录');
  await page.getByRole('button', { name: 'Markdown', exact: true }).click();
  await typeInEditor(page, page.getByTestId('content-block').first(), '第一题：求 $\\sum_{k=1}^n k$。');
  await page.getByTestId('paste-zone').focus();
  await pasteGeneratedImage(page, '[data-testid="paste-zone"]', { width: 500, height: 200, label: 'MAT' });
  await expect(page.getByTestId('content-block')).toHaveCount(2);
  await saveAndWait(page);
  await page.goto(`${server.url}/inbox`);
  await expect(page.getByTestId('list-item')).toHaveCount(1);
  await page.getByTestId('list-item').getByRole('link', { name: '数列专题摘录' }).click();
  await page.getByRole('button', { name: '从资料建题' }).click();
  await page.getByLabel('选择第 1 块').check();
  await page.getByRole('button', { name: '用所选内容建题' }).click();
  await expect(page.getByTestId('problem-editor')).toBeVisible();
  await expect(page.getByTestId('content-block')).toHaveCount(1);
  await expect(page.getByText('数列专题摘录')).toBeVisible();
  // 资料仍在，状态变为已整理，收件箱清空
  const mats = await apiGet(server, '/api/materials');
  expect(mats.total).toBe(1);
  expect(mats.items[0].status).toBe('active');
  expect((await apiGet(server, '/api/materials?status=inbox')).total).toBe(0);
});

test('打开/关闭预览、修改其他字段不会改写 Markdown 源码；不支持的公式不阻止保存', async ({ page }) => {
  const dataDir = path.join(tempDir(), 'data');
  server = await startServer(dataDir);
  const weird = '  缩进\t制表\n\n[[双链]] ![[嵌入]] <b>html</b>\n\n> [!Custom-Type]+ 未知类型\n> 内容 $\\unsupportedcmd{x}$\n\n$$\\begin{tikzpicture}\\end{tikzpicture}$$\n\n\n';
  const s = await apiGet(server, '/api/session');
  const id = crypto.randomUUID();
  const res = await fetch(`${server.url}/api/problems`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-sworks-csrf': s.csrfToken, origin: server.url },
    body: JSON.stringify({ id, blocks: [{ id: crypto.randomUUID(), kind: 'markdown', body: weird }], notes: [{ id: crypto.randomUUID(), type: 'note', bodyMd: weird }] }),
  });
  expect(res.status).toBe(201);
  await page.goto(`${server.url}/problems/${id}`);
  // 渲染出错误提示而不是崩溃；未知 callout 使用通用样式
  await expect(page.getByTestId('content-block').first().locator('.katex-error').first()).toBeVisible();
  await expect(page.getByTestId('content-block').first().locator('[data-callout="unknown-type"]')).toBeVisible();
  // 反复切换编辑/预览，不输入任何内容
  const block = page.getByTestId('content-block').first();
  await block.getByRole('button', { name: /编辑/ }).click();
  for (const v of ['预览', '源码', '分栏', '预览']) await block.getByRole('button', { name: v, exact: true }).click();
  await block.getByRole('button', { name: '完成' }).click();
  await expect(page.getByTestId('save-button')).toBeDisabled();
  // 只修改标题并保存
  await page.getByLabel('标题（可选）').fill('只改标题');
  await saveAndWait(page);
  const p = await apiGet(server, `/api/problems/${id}`);
  expect(p.title).toBe('只改标题');
  expect(p.blocks[0].body).toBe(weird);
  expect(p.notes[0].bodyMd).toBe(weird);
});

test('在列表中勾选题目导出 Markdown（含图片与 README）', async ({ page }) => {
  const dataDir = path.join(tempDir(), 'data');
  server = await startServer(dataDir);
  await page.goto(server.url);
  await page.getByTestId('new-problem').click();
  await page.getByTestId('paste-zone').focus();
  await pasteGeneratedImage(page, '[data-testid="paste-zone"]', { width: 320, height: 160, label: 'EXPORT' });
  await expect(page.getByTestId('content-block')).toHaveCount(1);
  await saveAndWait(page);
  const id = page.url().split('/').pop()!;
  await page.goto(`${server.url}/problems`);
  await page.getByTestId('list-item').getByRole('checkbox').check();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出所选为 Markdown' }).click();
  const download = await downloadPromise;
  const file = path.join(tempDir(), download.suggestedFilename());
  await download.saveAs(file);
  const { readZip } = await import('../helpers/zip');
  const names = (await readZip(file)).map((e: { name: string }) => e.name).sort();
  expect(names).toContain(`sworks-export/problem-${id}.md`);
  expect(names).toContain('sworks-export/README.md');
  expect(names.filter((n: string) => n.startsWith('sworks-export/assets/') && n.endsWith('.png'))).toHaveLength(1);
});
