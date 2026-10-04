/**
 * 疑似重复的提示：同一层级下、按检索的规范化（全角半角、大小写、空白）后相同的名称，
 * 例如“C语言”与“Ｃ语言”。每组给一个“合并”按钮，合并到用得最多的那一个（经调用方的确认与撤销流程）。
 */
import { Merge } from 'lucide-react';
import type { UsageDTO } from '@shared/api';
import { normText } from '@shared/query/normalize';
import { usage } from './usage';

export interface DupItem {
  id: string;
  /** 同一层级才算重复：上级的 ID（顶层为 null） */
  parentId: string | null;
  label: string;
  usage: UsageDTO;
}

/** 找出重复组；每组按用量从多到少排列（第一个是合并目标）。 */
export function findDuplicates<T extends DupItem>(items: readonly T[]): T[][] {
  const groups = new Map<string, T[]>();
  for (const x of items) {
    const k = `${x.parentId ?? ''}\u0000${normText(x.label)}`;
    const g = groups.get(k);
    if (g) g.push(x);
    else groups.set(k, [x]);
  }
  const total = (u: UsageDTO) => u.problems + u.materials + u.trashed;
  return [...groups.values()].filter((g) => g.length > 1).map((g) => [...g].sort((a, b) => total(b.usage) - total(a.usage)));
}

export function DuplicateHint<T extends DupItem>({ groups, describe, onMerge }: { groups: T[][]; describe: (x: T) => string; onMerge: (sources: T[], target: T) => void }) {
  if (groups.length === 0) return null;
  return (
    <div className="space-y-1.5 border border-line bg-sunken px-3 py-2 text-sm" style={{ borderRadius: 'var(--radius-organic-sm)' }} role="note" aria-label="疑似重复">
      <p className="text-ink-soft">
        {groups.length} 组名称疑似重复（只差全角/半角、大小写或空格），可以合并成一个：
      </p>
      <ul className="space-y-1">
        {groups.map((g) => (
          <li key={g[0]!.id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {g.map((x, i) => (
              <span key={x.id} className="text-ink">
                {i > 0 ? <span className="mr-2 text-ink-faint">·</span> : null}“{describe(x)}”<span className="ml-1 text-xs text-ink-faint">{usage(x.usage)}</span>
              </span>
            ))}
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => onMerge(g.slice(1), g[0]!)}>
              <Merge size={13} /> 合并为“{describe(g[0]!)}”
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
