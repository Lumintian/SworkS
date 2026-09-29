/**
 * 开放 Markdown 导出：选定题目 → problem-<id>.md（或 安全标题-<id>.md）+ 实际引用的图片 + README.md。
 * 只打包所选题目实际引用的资源；源码中的公式与 callout 原样保留；不承诺无损回导。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ProblemDTO } from '../../shared/api.js';
import { assetRef, parseAssetRef } from '../../shared/assetRef.js';
import { MIME_EXTENSIONS, NOTE_TAB_ORDER, NOTE_TYPE_LABELS } from '../../shared/constants.js';
import type { AppContext } from '../context.js';
import { AppError } from '../errors.js';
import { timestampForFile } from '../fsutil.js';
import type { AssetRow } from './assetStore.js';
import { loadProblem } from './entities.js';
import { propertyDisplay } from './properties.js';
import { rewriteImageUrls } from './markdown.js';
import { writeZip, type ZipItem } from './zip.js';

const EXPORT_ROOT = 'sworks-export';

export function safeFileStem(title: string | null, id: string): string {
  if (!title) return `problem-${id}`;
  const cleaned = title
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 60)
    .trim();
  return cleaned ? `${cleaned}-${id}` : `problem-${id}`;
}

function yamlString(v: string | null): string {
  return v === null ? 'null' : JSON.stringify(v);
}

/** 用比内容中最长反引号串更长的围栏包住普通文字，避免被误解释为 Markdown。 */
export function fenceText(text: string, info = 'text'): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}${info}\n${text}${text.endsWith('\n') ? '' : '\n'}${fence}`;
}

interface ExportState {
  assets: Map<string, AssetRow>;
  warnings: string[];
}

function useAsset(ctx: AppContext, st: ExportState, assetId: string): string | null {
  const row = st.assets.get(assetId) ?? (ctx.db.prepare('SELECT * FROM assets WHERE id = ?').get(assetId) as AssetRow | undefined);
  if (!row) return null;
  st.assets.set(assetId, row);
  return assetRef(row.id, MIME_EXTENSIONS[row.mime]);
}

function rewriteMarkdown(ctx: AppContext, st: ExportState, p: ProblemDTO, md: string, where: string): string {
  return rewriteImageUrls(md, (ref) => {
    if (ref.kind === 'asset') {
      const id = parseAssetRef(ref.url)!;
      const local = useAsset(ctx, st, id);
      if (!local) {
        st.warnings.push(`${where}：引用的本地图片不存在（${ref.url}）`);
        return null;
      }
      return local;
    }
    if (ref.kind === 'remote') {
      const remoteId = p.remoteImageUrls[ref.url.trim()];
      const remote = remoteId ? p.remoteImages[remoteId] : undefined;
      if (remote?.status === 'archived' && remote.assetId) {
        const local = useAsset(ctx, st, remote.assetId);
        if (local) return local;
      }
      st.warnings.push(`${where}：远程图片未归档，保留原 URL（${ref.url}）`);
      return null;
    }
    st.warnings.push(`${where}：图片引用不是系统管理的附件（${ref.url}），导出后可能无法显示`);
    return null;
  });
}

export function renderProblemMarkdown(ctx: AppContext, p: ProblemDTO, st: ExportState): string {
  const label = p.title ?? `未命名题目（${p.id}）`;
  const lines: string[] = [];
  lines.push('---');
  lines.push(`id: ${p.id}`);
  lines.push(`title: ${yamlString(p.title)}`);
  lines.push(`subject: ${yamlString(p.subject)}`);
  lines.push(`stage: ${yamlString(p.stage)}`);
  lines.push(`tags: [${p.tags.map((t) => JSON.stringify(t)).join(', ')}]`);
  // 自定义属性：键为属性名；多选写成列表，层级选项写成路径（例如 数学/函数/单调性）
  for (const prop of propertyDisplay(ctx.db, { kind: 'problem', id: p.id })) {
    const key = JSON.stringify(prop.name);
    if (prop.type === 'multiselect') lines.push(`${key}: [${prop.values.map((v) => JSON.stringify(v)).join(', ')}]`);
    else if (prop.type === 'checkbox') lines.push(`${key}: true`);
    else if (prop.type === 'number') lines.push(`${key}: ${prop.values[0]}`);
    else lines.push(`${key}: ${yamlString(prop.values[0] ?? null)}`);
  }
  lines.push(`created_at: ${p.createdAt}`);
  lines.push(`updated_at: ${p.updatedAt}`);
  lines.push(`source_note: ${yamlString(p.sourceNote)}`);
  if (p.sources.length > 0) {
    lines.push('sources:');
    for (const s of p.sources) {
      lines.push(`  - material_id: ${s.materialId}`);
      lines.push(`    material_title: ${yamlString(s.materialTitle)}`);
      lines.push(`    note: ${yamlString(s.note)}`);
    }
  } else {
    lines.push('sources: []');
  }
  lines.push('exported_by: SworkS');
  lines.push('---');
  lines.push('');
  lines.push('## 题目');
  lines.push('');
  p.blocks.forEach((b, i) => {
    const where = `${label} 第 ${i + 1} 块`;
    if (b.kind === 'markdown') {
      lines.push(rewriteMarkdown(ctx, st, p, b.body ?? '', where));
    } else if (b.kind === 'text') {
      lines.push(fenceText(b.body ?? ''));
    } else {
      const alt = (b.caption ?? '').replace(/[[\]\\]/g, '\\$&');
      let ref: string | null = null;
      if (b.assetId) ref = useAsset(ctx, st, b.assetId);
      else if (b.remoteImageId) {
        const remote = p.remoteImages[b.remoteImageId];
        if (remote?.status === 'archived' && remote.assetId) ref = useAsset(ctx, st, remote.assetId);
        if (!ref && remote) {
          st.warnings.push(`${where}：远程图片未归档，保留原 URL（${remote.url}）`);
          lines.push(`![${alt}](<${remote.url}>)`);
          lines.push('');
          lines.push(`> [!warning] 图片未归档`);
          lines.push(`> 原始地址：<${remote.url}>`);
          lines.push('');
          return;
        }
      }
      if (ref) lines.push(`![${alt}](${ref})`);
      else {
        st.warnings.push(`${where}：图片附件缺失`);
        lines.push('> [!warning] 图片附件缺失');
      }
      if (b.caption) {
        lines.push('');
        lines.push(`*${b.caption.replace(/[*_\\]/g, '\\$&')}*`);
      }
    }
    lines.push('');
  });
  // 笔记按类型分节（笔记 → 解析 → 答案），节内按显示顺序；带序号的标题写成“解析 (1)：标题”
  NOTE_TAB_ORDER.forEach((type) => {
    const group = p.notes.filter((n) => n.type === type);
    if (group.length === 0) return;
    lines.push(`## ${NOTE_TYPE_LABELS[type]}`);
    lines.push('');
    group.forEach((n, i) => {
      const heading = `${NOTE_TYPE_LABELS[type]}${n.seq !== null ? ` (${n.seq})` : ''}${n.title ? `：${n.title}` : ''}`;
      lines.push(`### ${heading}`);
      lines.push('');
      lines.push(`<!-- sworks-note id=${n.id} type=${n.type}${n.seq !== null ? ` seq=${n.seq}` : ''} -->`);
      lines.push('');
      lines.push(rewriteMarkdown(ctx, st, p, n.bodyMd, `${label} 第 ${i + 1} 条${NOTE_TYPE_LABELS[type]}`));
      lines.push('');
    });
  });
  return `${lines.join('\n').replace(/\n{3,}$/g, '\n\n').trimEnd()}\n`;
}

export async function exportProblemsMarkdown(
  ctx: AppContext,
  problemIds: string[],
): Promise<{ zipPath: string; fileName: string; warnings: string[] }> {
  const st: ExportState = { assets: new Map(), warnings: [] };
  const files: { name: string; content: string }[] = [];
  const usedNames = new Set<string>();
  for (const id of [...new Set(problemIds)]) {
    const p = loadProblem(ctx.db, id);
    if (!p || p.deletedAt) throw new AppError('NOT_FOUND', `题目不存在或已删除：${id}`);
    let stem = safeFileStem(p.title, p.id);
    if (usedNames.has(stem.toLowerCase())) stem = `problem-${p.id}`;
    usedNames.add(stem.toLowerCase());
    files.push({ name: `${stem}.md`, content: renderProblemMarkdown(ctx, p, st) });
  }
  const readme = [
    '# SworkS Markdown 导出',
    '',
    `导出时间：${new Date().toISOString()}`,
    `题目数量：${files.length}`,
    `图片文件：${st.assets.size}`,
    '',
    '- 每道题一个 Markdown 文件，图片位于 `assets/` 目录，使用相对路径引用。',
    '- 公式（`$...$`、`$$...$$`）与 callout（`> [!type]`）保留源码，显示效果取决于阅读器。',
    '- 普通文字块用 ```text 围栏保存，避免被误解释为 Markdown。',
    '- 这是开放阅读格式，不承诺无损回导；完整数据请使用 SworkS 全库备份。',
    '',
    st.warnings.length > 0 ? '## 警告（导出结果并非完全离线）' : '## 警告',
    '',
    ...(st.warnings.length > 0 ? st.warnings.map((w) => `- ${w}`) : ['无。所有图片均已包含在导出中。']),
    '',
  ].join('\n');
  const items: ZipItem[] = [
    ...files.map((f) => ({ name: `${EXPORT_ROOT}/${f.name}`, buffer: Buffer.from(f.content, 'utf8') })),
    ...[...st.assets.values()].map((a) => ({
      name: `${EXPORT_ROOT}/assets/${a.id}.${MIME_EXTENSIONS[a.mime]}`,
      file: ctx.store.absolutePath(a.rel_path),
      compress: false,
    })),
    { name: `${EXPORT_ROOT}/README.md`, buffer: Buffer.from(readme, 'utf8') },
  ];
  await fsp.mkdir(ctx.paths.tmp, { recursive: true });
  const fileName = `sworks-export-${timestampForFile()}.zip`;
  const zipPath = path.join(ctx.paths.tmp, `${process.pid}-${Date.now()}-${fileName}`);
  await writeZip(zipPath, items);
  return { zipPath, fileName, warnings: st.warnings };
}
