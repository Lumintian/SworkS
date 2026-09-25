#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { APP_VERSION } from '../../shared/constants.js';
import { restoreBackup } from '../services/restore.js';

const HELP = `SworkS ${APP_VERSION} — 从完整备份恢复

用法（请先停止 SworkS 服务）：
  pnpm restore -- --input <备份.sworks.zip> --data-dir <新的空目录>

说明：
  - 目标目录必须不存在或为空；不支持合并到已有库。
  - 恢复先在临时目录完成并校验，全部通过后才发布到目标目录；失败不会改动任何已有数据。
`;

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((a) => a !== '--'),
    options: {
      input: { type: 'string', short: 'i' },
      'data-dir': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  if (values.help || !values.input || !values['data-dir']) {
    console.log(HELP);
    return values.help ? 0 : 2;
  }
  const result = await restoreBackup(values.input, values['data-dir'], { log: (m) => console.log(`  ${m}`) });
  const m = result.manifest;
  console.log('恢复完成。');
  console.log(`  数据目录：${result.dataDir}`);
  console.log(`  库 ID：${m.libraryId}（备份时间 ${m.createdAt}，备份程序版本 ${m.appVersion}）`);
  console.log(
    `  题目 ${result.counts.problems ?? 0}，资料 ${result.counts.materials ?? 0}，笔记 ${result.counts.notes ?? 0}，附件记录 ${result.counts.assets ?? 0}（文件 ${result.assetFiles}）`,
  );
  console.log('  本地数据完整性：已校验（记录数量、引用与附件哈希一致）');
  if (m.remoteImages.unarchived.length > 0) {
    console.log(`  注意：有 ${m.remoteImages.unarchived.length} 张远程图片在备份时尚未归档，只保留了 URL，无法离线显示：`);
    for (const u of m.remoteImages.unarchived.slice(0, 10)) console.log(`    - ${u.url}`);
  } else {
    console.log('  远程图片：全部已归档');
  }
  console.log(`启动：pnpm start -- --data-dir "${result.dataDir}"`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`恢复失败：${err instanceof Error ? err.message : String(err)}`);
    console.error('已有数据未被改动。');
    process.exit(1);
  },
);
