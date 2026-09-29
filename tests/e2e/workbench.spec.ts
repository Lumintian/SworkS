/** 家教工作台的整理交互：导航树筛选、多选与批量操作、命令面板、快速预览、数据管理。 */
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { apiGet, saveAndWait, startServer, tempDir, type Server } from './helpers';

let server: Server | undefined;
test.afterEach(async () => {
  await server?.stop();
  server = undefined;
});

async function apiSend(s: Server, method: string, url: string, body: unknown) {
  const session = (await apiGet(s, '/api/session')) as { csrfToken: string };
  const res = await fetch(`${s.url}${url}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-sworks-csrf': session.csrfToken, origin: s.url },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function seed(s: Server, title: string, extra: Record<string, unknown> = {}) {
  const id = crypto.randomUUID();
  const r = await apiSend(s, 'POST', '/api/problems', {
    id,
    title,
    blocks: [{ id: crypto.randomUUID(), kind: 'markdown', body: `${title} 的题干` }],
    ...extra,
  });
  expect(r.status).toBe(201);
  return id;
}

const rows = (page: Page) => page.getByTestId('list-item');

/**
 * 用键盘拖动一条笔记：空格拿起，按上方向键依次移到 targets 指定的位置（从 1 开始），再按空格放下。
 * 以读屏播报确认每一步：拿起后先等到“移到第 from 条”（此时已完成碰撞计算），再按方向键。
 */
async function keyboardDrag(page: Page, handleName: string, from: number, targets: number[]) {
  const handle = page.getByRole('button', { name: handleName });
  await handle.focus();
  await page.keyboard.press('Space');
  await expect(handle).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('status').filter({ hasText: `移到第 ${from} 条的位置` })).toHaveCount(1);
  for (const n of targets) {
    await page.keyboard.press('ArrowUp');
    await expect(page.getByRole('status').filter({ hasText: `移到第 ${n} 条的位置` })).toHaveCount(1);
  }
  await page.keyboard.press('Space');
  await expect(page.getByRole('status').filter({ hasText: '已放到' })).toHaveCount(1);
}

test('导航树按标签子树筛选；Shift 连选后批量加标签并可撤销', async ({ page }) => {
  server = await startServer(path.join(tempDir(), 'data'));
  await seed(server, '单调性一', { tags: ['数学/函数/单调性'], subject: '数学' });
  await seed(server, '几何一', { tags: ['数学/几何'], subject: '数学' });
  await seed(server, '受力分析', { tags: ['物理'], subject: '物理' });
  await seed(server, '未分类');

  await page.goto(`${server.url}/problems`);
  await expect(rows(page)).toHaveCount(4);
  const tree = page.getByRole('tree', { name: '题目标签树' });
  // 父节点计数包含子树
  await expect(tree.getByRole('treeitem', { name: '数学' })).toContainText('2');
  await tree.getByRole('treeitem', { name: '数学' }).click();
  // 点导航就是把条件写进搜索框（地址栏只有 q）
  await expect(page).toHaveURL(/q=/);
  await expect(page.getByTestId('search-input')).toHaveText('#数学');
  await expect(rows(page)).toHaveCount(2);
  await expect(page.getByTestId('result-count')).toContainText('共 2 项（已筛选）');
  // 再点一次取消筛选
  await tree.getByRole('treeitem', { name: '数学' }).click();
  await expect(rows(page)).toHaveCount(4);
  await tree.getByRole('treeitem', { name: '无标签' }).click();
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page)).toContainText('未分类');
  await page.getByRole('button', { name: '清除筛选' }).click();
  await expect(rows(page)).toHaveCount(4);

  // 勾选第 1 项，Shift+勾选第 3 项 → 连选 3 项
  await rows(page).nth(0).getByRole('checkbox').click();
  await rows(page).nth(2).getByRole('checkbox').click({ modifiers: ['Shift'] });
  const bar = page.getByTestId('batch-bar');
  await expect(bar).toContainText('已选 3 项');
  await bar.getByRole('button', { name: '加标签' }).click();
  await page.getByLabel('搜索或新建标签').fill('待讲评');
  await page.getByRole('option', { name: /新建并添加“待讲评”/ }).click();
  await expect(page.getByText('已加上“待讲评”：3 项')).toBeVisible();
  await expect.poll(async () => (await apiGet(server!, `/api/problems?tag=${encodeURIComponent('待讲评')}`)).total).toBe(3);
  // 撤销
  await page.getByRole('button', { name: '撤销' }).click();
  await expect.poll(async () => (await apiGet(server!, `/api/problems?tag=${encodeURIComponent('待讲评')}`)).total).toBe(0);
});

test('批量设学科、移到回收站；键盘多选与快速预览；命令面板跳转', async ({ page }) => {
  server = await startServer(path.join(tempDir(), 'data'));
  const a = await seed(server, '第一题', { notes: [{ id: crypto.randomUUID(), type: 'answer', bodyMd: '答案是 $42$' }] });
  await seed(server, '第二题');
  await seed(server, '第三题');

  await page.goto(`${server.url}/problems`);
  await expect(rows(page)).toHaveCount(3);
  // 键盘：j 移到第一行，空格快速预览（含答案）
  await page.keyboard.press('j');
  await page.keyboard.press('j');
  await page.keyboard.press('j');
  await page.keyboard.press(' ');
  const look = page.getByTestId('quick-look');
  await expect(look).toContainText('第一题 的题干');
  await expect(look).toContainText('答案');
  await page.keyboard.press('Escape');
  await expect(look).toHaveCount(0);
  // Ctrl+A 全选已加载的项，批量设学科
  await page.keyboard.press('Control+a');
  const bar = page.getByTestId('batch-bar');
  await expect(bar).toContainText('已选 3 项');
  await bar.getByRole('button', { name: '设学科' }).click();
  await page.getByRole('menuitem', { name: '数学' }).click();
  await expect.poll(async () => (await apiGet(server!, `/api/problems?subject=${encodeURIComponent('数学')}`)).total).toBe(3);
  // 导航树出现学科节点
  await expect(page.getByRole('tree', { name: '学科筛选树' }).getByRole('treeitem', { name: '数学' })).toContainText('3');
  // Esc 取消选择；x 选中当前行后移到回收站（确认对话框）
  await page.keyboard.press('Escape');
  await expect(bar).toHaveCount(0);
  await page.keyboard.press('x');
  await page.getByTestId('batch-bar').getByRole('button', { name: '移到回收站' }).click();
  await page.getByTestId('confirm-ok').click();
  await expect(rows(page)).toHaveCount(2);
  expect((await apiGet(server, `/api/problems/${a}`)).deletedAt).not.toBeNull();

  // 命令面板：Ctrl+K，按关键词跳转
  await page.keyboard.press('Control+k');
  await page.getByTestId('palette-input').fill('第二');
  await page.getByRole('option', { name: /第二题/ }).first().click();
  await expect(page.getByTestId('problem-editor')).toBeVisible();
  await expect(page.getByLabel('标题（可选）')).toHaveValue('第二题');
});

test('数据管理：标签改名同步到题目；批量操作后陈旧编辑页保存得到冲突', async ({ page, browser }) => {
  server = await startServer(path.join(tempDir(), 'data'));
  const id = await seed(server, '换元题', { tags: ['方法/换元'] });

  // 另一个浏览器上下文里先打开编辑页，并断开服务端推送（收不到任何通知，模拟陈旧页面）
  const other = await browser.newContext();
  await other.route('**/api/events', (r) => r.abort());
  const stale = await other.newPage();
  await stale.goto(`${server.url}/problems/${id}`);
  await expect(stale.getByTestId('problem-editor')).toBeVisible();

  await page.goto(`${server.url}/manage?tab=tags`);
  const tree = page.getByRole('tree', { name: '标签树', exact: true });
  await expect(tree.getByRole('treeitem').filter({ hasText: '换元' })).toHaveCount(1);
  await tree.getByRole('button', { name: '换元 的操作' }).click();
  await page.getByRole('menuitem', { name: '改名/移动' }).click();
  await page.getByLabel('标签新路径').fill('技巧/换元法');
  await page.getByLabel('标签新路径').press('Enter');
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByText(/已改名 1 个/)).toBeVisible();
  expect((await apiGet(server, `/api/problems/${id}`)).tags).toEqual(['技巧/换元法']);

  // 陈旧页面带着旧标签保存：得到冲突，旧标签不会写回
  await stale.getByLabel('标题（可选）').fill('陈旧页面的标题');
  await stale.getByTestId('save-button').click();
  await expect(stale.getByRole('dialog', { name: '保存冲突' })).toBeVisible();
  expect((await apiGet(server, `/api/problems/${id}`)).tags).toEqual(['技巧/换元法']);
  await other.close();
});

test('笔记分栏：键盘拖动排序、填序号自动归位、按序号重排；快速预览按命中打开对应栏', async ({ page }) => {
  server = await startServer(path.join(tempDir(), 'data'));
  const [a, b, c, sol] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  const id = await seed(server, '多问题', {
    notes: [
      { id: a, type: 'answer', bodyMd: '第一问答案' },
      { id: sol, type: 'solution', bodyMd: '对勾函数的解析' },
      { id: b, type: 'answer', bodyMd: '第二问答案' },
      { id: c, type: 'answer', bodyMd: '第三问答案' },
    ],
  });
  await page.goto(`${server.url}/problems/${id}`);
  const tabs = page.getByRole('tablist', { name: '笔记类型' });
  await tabs.getByRole('tab', { name: /^答案/ }).click();
  const notes = page.getByTestId('note');
  await expect(notes).toHaveCount(3);

  // 键盘拖动：第 3 条移到最前（只在答案之间重排，解析的位置不变）
  await keyboardDrag(page, '拖动排序：第 3 条答案（共 3 条）', 3, [2, 1]);
  await expect(notes.first()).toContainText('第三问答案');
  await saveAndWait(page);
  expect((await apiGet(server, `/api/problems/${id}`)).notes.map((n: { id: string }) => n.id)).toEqual([c, sol, a, b]);

  // 序号：第 3 条（第二问）填 2 → 不动；第 1 条（第三问）填 3 → 自动排到 (2) 之后
  await page.getByLabel('第 3 条答案的序号').fill('2');
  await page.keyboard.press('Enter');
  await page.getByLabel('第 1 条答案的序号').fill('3');
  await page.keyboard.press('Enter');
  await expect(notes.nth(0)).toContainText('第一问答案');
  await expect(notes.nth(1)).toContainText('第二问答案');
  await expect(notes.nth(2)).toContainText('第三问答案');
  await expect(page.getByRole('button', { name: '按序号重排' })).toHaveCount(0);

  // 拖乱后出现“按序号重排”，点一下恢复
  await keyboardDrag(page, '拖动排序：第 3 条答案（共 3 条）', 3, [2]);
  await expect(notes.nth(1)).toContainText('第三问答案');
  await page.getByRole('button', { name: '按序号重排' }).click();
  await expect(notes.nth(1)).toContainText('第二问答案');
  await expect(notes.nth(2)).toContainText('第三问答案');
  await saveAndWait(page);
  const saved = await apiGet(server, `/api/problems/${id}`);
  expect(saved.notes.map((n: { id: string; seq: number | null }) => [n.id, n.seq])).toEqual([
    [a, null],
    [sol, null],
    [b, 2],
    [c, 3],
  ]);

  // 快速预览：命中解析时默认打开“解析”栏；答案栏的标题带序号
  await page.goto(`${server.url}/problems?q=${encodeURIComponent('对勾')}`);
  await expect(rows(page)).toHaveCount(1);
  await page.keyboard.press('j');
  await page.keyboard.press(' ');
  const look = page.getByTestId('quick-look');
  await expect(look.getByRole('tab', { name: /^解析/ })).toHaveAttribute('aria-selected', 'true');
  await expect(look).toContainText('对勾函数的解析');
  await look.getByRole('tab', { name: /^答案/ }).click();
  await expect(look).toContainText('(2) 答案');
  await expect(look).not.toContainText('对勾函数的解析');
});

test('服务端推送：外部写入（不带页面 ID）即时刷新打开着的编辑页与列表', async ({ page, browser }) => {
  server = await startServer(path.join(tempDir(), 'data'));
  const id = await seed(server, '原标题');

  const other = await browser.newContext();
  const list = await other.newPage();
  await list.goto(`${server.url}/problems`);
  await expect(rows(list)).toHaveCount(1);

  await page.goto(`${server.url}/problems/${id}`);
  await expect(page.getByLabel('标题（可选）')).toHaveValue('原标题');

  const current = await apiGet(server, `/api/problems/${id}`);
  const r = await apiSend(server, 'PUT', `/api/problems/${id}`, {
    expectedVersion: current.version,
    title: '外部修改的标题',
    blocks: current.blocks.map((b: { id: string; kind: string; body: string }) => ({ id: b.id, kind: b.kind, body: b.body })),
  });
  expect(r.status).toBe(200);
  // 编辑页没有未保存修改：自动刷新
  await expect(page.getByLabel('标题（可选）')).toHaveValue('外部修改的标题');
  await expect(page.getByTestId('save-button')).toBeDisabled();

  // 另一个浏览器上下文里的列表同样刷新
  await seed(server, '外部新建的题');
  await expect(rows(list)).toHaveCount(2);
  await other.close();
});
