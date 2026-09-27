/** 学生与作答流水：新建学生、在题目页记录作答、学生页看到错题与薄弱考点、列表按学生筛选、批量记录。 */
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { apiGet, startServer, tempDir, type Server } from './helpers';

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
  return (await res.json()) as any;
}

test('记录作答 → 学生页看到当前错题 → 列表按学生筛选 → 批量记录做对后错题消失', async ({ page }) => {
  server = await startServer(path.join(tempDir(), 'data'));
  const ids: string[] = [];
  for (const title of ['二次函数最值', '数列通项', '立体几何体积']) {
    const id = crypto.randomUUID();
    await apiSend(server, 'POST', '/api/problems', { id, title, blocks: [{ id: crypto.randomUUID(), kind: 'markdown', body: `${title}题干` }] });
    ids.push(id);
  }
  const before = await apiGet(server, `/api/problems/${ids[0]}`);

  // 1. 新建学生
  await page.goto(`${server.url}/students`);
  await page.getByLabel('姓名').fill('小明');
  await page.getByRole('button', { name: '添加学生' }).click();
  await expect(page.getByTestId('student-page')).toBeVisible();

  // 2. 在题目页快速记录作答（立即保存，不影响题目版本）
  await page.goto(`${server.url}/problems/${ids[0]}`);
  const form = page.getByRole('form', { name: '记录作答' });
  await expect(form.getByLabel('学生')).toHaveValue(/.+/);
  await form.getByRole('group', { name: '作答结果' }).getByRole('button', { name: '错', exact: true }).click();
  await form.getByRole('group', { name: '主观难度' }).getByRole('button', { name: '难', exact: true }).click();
  await form.getByLabel('作答备注').fill('配方时符号错');
  await page.getByTestId('record-attempt').click();
  await expect(page.getByTestId('attempt-saved')).toBeVisible();
  await expect(page.getByRole('list', { name: '作答记录' })).toContainText('配方时符号错');
  await expect(page.getByTestId('save-button')).toBeDisabled();
  const after = await apiGet(server, `/api/problems/${ids[0]}`);
  expect(after.version).toBe(before.version);

  // 3. 学生页：当前错题
  await page.getByRole('list', { name: '作答记录' }).getByRole('link', { name: '小明' }).click();
  await expect(page.getByTestId('student-page')).toContainText('当前错题');
  await expect(page.getByRole('region', { name: '当前错题' })).toContainText('二次函数最值');

  // 4. 列表按学生查看：最近一次没做对
  await page.getByRole('link', { name: '在题目列表中查看' }).click();
  await expect(page.getByTestId('list-item')).toHaveCount(1);
  await expect(page.getByTestId('attempt-badge')).toContainText('错 1 次');
  await page.getByRole('group', { name: '作答状态' }).getByRole('button', { name: '未做过' }).click();
  await expect(page.getByTestId('list-item')).toHaveCount(2);

  // 5. 全部题目里全选，批量记录“对”
  await page.getByRole('group', { name: '作答状态' }).getByRole('button', { name: '全部' }).click();
  await expect(page.getByTestId('list-item')).toHaveCount(3);
  await page.getByRole('checkbox', { name: '全选已加载的项' }).check();
  await page.getByTestId('batch-bar').getByRole('button', { name: '记录作答' }).click();
  const batch = page.getByRole('form', { name: '记录作答' });
  await batch.getByRole('group', { name: '作答结果' }).getByRole('button', { name: '对', exact: true }).click();
  await batch.getByRole('button', { name: '给 3 道题记录' }).click();
  await expect(page.getByText('已记录 3 条作答')).toBeVisible();
  await page.getByRole('group', { name: '作答状态' }).getByRole('button', { name: '最近一次没做对' }).click();
  await expect(page.getByText('没有符合条件的内容')).toBeVisible();
  const students = await apiGet(server, '/api/students');
  expect(students[0].stats).toMatchObject({ problems: 3, attempts: 4, openMistakes: 0 });
});
