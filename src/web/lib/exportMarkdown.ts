import { errorMessage, postForBlob, saveBlob } from './api';

/** 导出题目为 Markdown 压缩包并触发下载；返回给用户看的提示文字与语气。 */
export async function exportProblems(ids: string[]): Promise<{ message: string; tone: 'success' | 'warn' | 'error' }> {
  try {
    const r = await postForBlob('/api/export/markdown', { problemIds: ids });
    saveBlob(r.blob, r.fileName);
    const w = Number(r.headers.get('x-sworks-export-warnings') ?? 0);
    const what = ids.length === 1 ? '已导出 Markdown' : `已导出 ${ids.length} 道题`;
    return w > 0 ? { message: `${what}，有 ${w} 条警告（见压缩包内 README）`, tone: 'warn' } : { message: what, tone: 'success' };
  } catch (err) {
    return { message: errorMessage(err), tone: 'error' };
  }
}
