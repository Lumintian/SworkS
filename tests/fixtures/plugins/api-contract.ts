/**
 * 插件接口的类型约束（只参与 pnpm typecheck）：操作名、输入与事件名写错时必须报错。
 * 这些函数从不调用。
 */
import type { OpInput, OpOutput, OpsClient, SworksPluginAPI } from '../../../src/server/plugins/api.js';

export async function contract(ops: OpsClient, api: SworksPluginAPI): Promise<void> {
  const found: OpOutput<'search'> = await ops.invoke('search', { query: '#函数' });
  void found.items[0]?.snippets;
  const input: OpInput<'set_properties'> = { problemId: '00000000-0000-4000-8000-000000000000', values: [{ property: '题型', value: '填空' }] };
  await ops.invoke('set_properties', input);
  // 插件注册的工具按名称调用，返回 unknown
  const other: unknown = await ops.invoke('example-ocr__ocr_problem', { problemId: 'x' });
  void other;

  // @ts-expect-error 输入字段写错
  await ops.invoke('add_note', { problem: 'x', type: 'note', bodyMd: 'x' });
  // @ts-expect-error 笔记类型只能是 note / answer / solution
  await ops.invoke('add_note', { problemId: 'x', type: 'comment', bodyMd: 'x' });
  // @ts-expect-error 不存在的事件
  api.on('entities.deleted', () => undefined);
  api.on('entities.changed', (e) => {
    // @ts-expect-error 事件载荷里没有内容，只有 ID 与版本
    void e.problems[0]?.title;
  });
}
