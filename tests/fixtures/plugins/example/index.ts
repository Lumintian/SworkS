/**
 * 示例插件（只参与 pnpm typecheck，保证插件接口与操作名、事件名一致；运行时在下一轮实现）。
 * - 命令“识别题图文字”：对所选题目的每张题图调用模型，把结果写成一条笔记；
 * - 钩子：新收录图片时，如果开启了自动识别，就放进任务队列；
 * - 定时任务：每天做一次完整备份。
 * 模型调用写在插件自己的代码里（这里只是示意），SworkS 不内置任何模型或密钥。
 */
import { z } from 'zod';
import type { SworksPlugin, SworksPluginAPI, TaskContext } from '../../../../src/server/plugins/api.js';

const settingsSchema = z.object({
  endpoint: z.url(),
  apiKey: z.string(),
  autoOnIngest: z.boolean(),
});

/** 插件自己调用模型（示意）：返回识别出的文字 */
async function recognize(endpoint: string, apiKey: string, image: { base64: string; mime: string }, signal: AbortSignal): Promise<string> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ image: `data:${image.mime};base64,${image.base64}`, task: 'ocr' }),
    signal,
  });
  if (!res.ok) throw new Error(`识别服务返回 HTTP ${res.status}`);
  return ((await res.json()) as { text: string }).text;
}

let api: SworksPluginAPI;

async function ocrProblem(problemId: string, t: TaskContext, settings: z.output<typeof settingsSchema>): Promise<void> {
  const p = await t.ops.invoke('get_problem', { id: problemId });
  const assetIds = p.blocks.flatMap((b) => (b.assetId ? [b.assetId] : []));
  for (const [i, assetId] of assetIds.entries()) {
    t.signal.throwIfAborted();
    t.progress({ done: i, total: assetIds.length, message: `识别第 ${i + 1} 张图` });
    const img = await t.assets.readForModel(assetId);
    const text = await recognize(settings.endpoint, settings.apiKey, img, t.signal);
    // 写入走整体保存：递增版本、重建检索投影；带 expectedVersion，老师刚改过就放弃而不是覆盖
    const r = await t.ops.invoke('add_note', { problemId, expectedVersion: p.version + i, type: 'note', title: `题图文字（第 ${i + 1} 张）`, bodyMd: text });
    t.log.info(`已写入笔记 ${r.noteId}，题目版本 ${r.version}`);
  }
}

const plugin: SworksPlugin = {
  activate(a) {
    api = a;
    const settings = api.registerSettings(settingsSchema, { endpoint: 'http://127.0.0.1:8080/ocr', apiKey: '', autoOnIngest: false });

    api.registerCommand({
      id: 'ocr-selected',
      title: '识别题图文字',
      target: 'problems',
      run: async (ids, t) => {
        for (const id of ids) await ocrProblem(id, t, settings.get());
      },
    });

    api.registerTool({
      name: 'ocr_problem',
      title: '识别题图文字',
      description: '把一道题的题图识别成文字，写成笔记。',
      input: z.object({ problemId: z.uuid() }),
      access: 'write',
      run: async (input, t) => {
        await ocrProblem(input.problemId, t, settings.get());
        return { ok: true };
      },
    });

    api.on('rawInputs.created', (e, h) => {
      if (!settings.get().autoOnIngest || e.assetIds.length === 0) return;
      // 原始输入此时还没有归属题目：等下一次保存后，再按题目处理（示意：只记录日志）
      h.enqueue('note-new-images', async (t) => {
        t.log.info(`收到 ${e.assetIds.length} 张新图片（来源：${e.origin.kind}）`);
      });
    });

    api.on('entities.changed', (e) => {
      if (e.origin.kind === 'plugin' && e.origin.pluginId === api.id) return; // 忽略自己的写入
    });

    api.registerJob({
      id: 'daily-backup',
      title: '每天完整备份',
      schedule: { everyMinutes: 24 * 60 },
      run: async (t) => {
        const b = await t.ops.invoke('create_backup', {});
        t.log.info(`已备份：${b.fileName}（${b.size} 字节）`);
      },
    });
  },
};

export default plugin;
