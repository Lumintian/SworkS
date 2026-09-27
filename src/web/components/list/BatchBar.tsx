/** 多选后的批量操作栏：标签、学科、学段、整理状态、导出、移到回收站；可撤销的操作在提示里提供“撤销”。 */
import { ChevronDown, ClipboardCheck, Download, GraduationCap, Hash, Layers, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import type { BatchAction, BatchResultDTO, ListItemDTO } from '@shared/api';
import { MATERIAL_STATUS_LABELS, MATERIAL_STATUSES } from '@shared/constants';
import { errorMessage, sendJSON } from '../../lib/api';
import { newId } from '../../lib/format';
import { invalidateWrites } from '../../lib/queryClient';
import { describeBatch, inverseAction, runBatch } from '../../lib/batch';
import { exportProblems } from '../../lib/exportMarkdown';
import type { Collection } from '../../lib/queries';
import { useCatalog } from '../../lib/useCatalog';
import { DropdownContent, DropdownItem, DropdownLabel, DropdownMenu, DropdownSeparator, DropdownTrigger, Popover, PopoverContent, PopoverTrigger } from '../Menu';
import { useConfirm, useToast } from '../ui';
import { TagLabel } from '../TagLabel';
import { AttemptForm, attemptPayload } from '../students/AttemptForm';
import { BatchProperty } from './BatchProperty';
import { TagPicker } from './TagPicker';

export function useBatchRunner(collection: Collection) {
  const toast = useToast();
  return async (ids: string[], action: BatchAction, verb: string, removedTagNames?: string[]): Promise<BatchResultDTO | null> => {
    try {
      const r = await runBatch(collection, ids, action);
      const inverse = inverseAction(action, r, removedTagNames);
      toast(
        describeBatch(r, verb),
        'success',
        inverse
          ? {
              label: '撤销',
              onClick: () => {
                runBatch(collection, r.changed, inverse).then(
                  () => toast('已撤销', 'info'),
                  (err: unknown) => toast(`撤销失败：${errorMessage(err)}`, 'error'),
                );
              },
            }
          : undefined,
      );
      return r;
    } catch (err) {
      toast(errorMessage(err), 'error');
      return null;
    }
  };
}

export function BatchBar({
  collection,
  ids,
  items,
  total,
  onSelectAllMatching,
  onClear,
}: {
  collection: Collection;
  ids: string[];
  /** 已加载的列表项，用于列出所选内容已有的标签 */
  items: ListItemDTO[];
  total: number;
  onSelectAllMatching?: (() => void) | undefined;
  onClear: () => void;
}) {
  const catalog = useCatalog();
  const toast = useToast();
  const confirm = useConfirm();
  const run = useBatchRunner(collection);
  const [tagOpen, setTagOpen] = useState(false);
  const [attemptOpen, setAttemptOpen] = useState(false);
  const noun = collection === 'problems' ? '题' : '份资料';

  const selectedSet = new Set(ids);
  const presentTags = new Map<string, number>();
  for (const it of items) if (selectedSet.has(it.id)) for (const t of it.tags) presentTags.set(t, (presentTags.get(t) ?? 0) + 1);
  const tagIdByName = new Map(catalog.tags.map((t) => [t.name, t.id]));

  const setValue = (kind: 'subject' | 'stage', value: string | null) =>
    void run(ids, { op: kind === 'subject' ? 'setSubject' : 'setStage', value }, value === null ? `已清除${kind === 'subject' ? '学科' : '学段'}：` : `已设为“${value}”：`);

  return (
    <div className="card-flat sticky top-2 z-10 flex flex-wrap items-center gap-2 bg-sage-soft px-4 py-2 text-sm shadow-[var(--shadow-soft)]" data-testid="batch-bar">
      <span className="font-semibold text-sage-deep">已选 {ids.length} 项</span>
      {onSelectAllMatching && ids.length < total ? (
        <button type="button" className="link-btn text-xs" onClick={onSelectAllMatching}>
          选择全部 {total} 项
        </button>
      ) : null}
      <span className="mx-1 h-5 w-px bg-line-strong" aria-hidden="true" />

      <Popover open={tagOpen} onOpenChange={setTagOpen}>
        <PopoverTrigger asChild>
          <button type="button" className="btn btn-sm">
            <Hash size={14} /> 加标签
          </button>
        </PopoverTrigger>
        <PopoverContent>
          <TagPicker
            tags={catalog.tags.map((t) => t.name)}
            onPick={(name) => {
              setTagOpen(false);
              void run(ids, { op: 'addTags', names: [name] }, `已加上“${name}”：`);
            }}
          />
        </PopoverContent>
      </Popover>

      <DropdownMenu>
        <DropdownTrigger asChild>
          <button type="button" className="btn btn-sm" disabled={presentTags.size === 0}>
            移除标签 <ChevronDown size={13} />
          </button>
        </DropdownTrigger>
        <DropdownContent>
          <DropdownLabel>所选内容中已有的标签</DropdownLabel>
          {[...presentTags].map(([name, n]) => (
            <DropdownItem
              key={name}
              disabled={!tagIdByName.has(name)}
              onSelect={() => void run(ids, { op: 'removeTags', tagIds: [tagIdByName.get(name)!] }, `已移除“${name}”：`, [name])}
            >
              <span className="flex-1 truncate">
                <TagLabel name={name} />
              </span>
              <span className="text-xs text-ink-faint">{n}</span>
            </DropdownItem>
          ))}
        </DropdownContent>
      </DropdownMenu>

      {(['subject', 'stage'] as const).map((kind) => (
        <DropdownMenu key={kind}>
          <DropdownTrigger asChild>
            <button type="button" className="btn btn-sm">
              {kind === 'subject' ? <Layers size={14} /> : <GraduationCap size={14} />}
              {kind === 'subject' ? '设学科' : '设学段'} <ChevronDown size={13} />
            </button>
          </DropdownTrigger>
          <DropdownContent>
            {(kind === 'subject' ? catalog.subjects : catalog.stages).map((v) => (
              <DropdownItem key={v} onSelect={() => setValue(kind, v)}>
                {v}
              </DropdownItem>
            ))}
            <DropdownSeparator />
            <DropdownItem onSelect={() => setValue(kind, null)}>清除{kind === 'subject' ? '学科' : '学段'}</DropdownItem>
          </DropdownContent>
        </DropdownMenu>
      ))}

      <BatchProperty collection={collection} ids={ids} run={run} />

      {collection === 'materials' ? (
        <DropdownMenu>
          <DropdownTrigger asChild>
            <button type="button" className="btn btn-sm">
              整理状态 <ChevronDown size={13} />
            </button>
          </DropdownTrigger>
          <DropdownContent>
            {MATERIAL_STATUSES.map((s) => (
              <DropdownItem key={s} onSelect={() => void run(ids, { op: 'setStatus', status: s }, `已标为${MATERIAL_STATUS_LABELS[s]}：`)}>
                标为{MATERIAL_STATUS_LABELS[s]}
              </DropdownItem>
            ))}
          </DropdownContent>
        </DropdownMenu>
      ) : null}

      {collection === 'problems' ? (
        <Popover open={attemptOpen} onOpenChange={setAttemptOpen}>
          <PopoverTrigger asChild>
            <button type="button" className="btn btn-sm">
              <ClipboardCheck size={14} /> 记录作答
            </button>
          </PopoverTrigger>
          <PopoverContent>
            <AttemptForm
              compact
              submitLabel={`给 ${ids.length} 道题记录`}
              onSubmit={async (v) => {
                try {
                  const r = await sendJSON<{ created: number }>('POST', '/api/attempts/batch', {
                    ...attemptPayload(v),
                    items: ids.map((problemId) => ({ id: newId(), problemId })),
                  });
                  invalidateWrites();
                  setAttemptOpen(false);
                  toast(`已记录 ${r.created} 条作答`, 'success');
                  return true;
                } catch (err) {
                  toast(errorMessage(err), 'error');
                  return false;
                }
              }}
            />
          </PopoverContent>
        </Popover>
      ) : null}

      {collection === 'problems' ? (
        <button
          type="button"
          className="btn btn-sage btn-sm"
          onClick={async () => {
            const r = await exportProblems(ids);
            toast(r.message, r.tone);
          }}
        >
          <Download size={15} /> 导出所选为 Markdown
        </button>
      ) : null}

      <button
        type="button"
        className="btn btn-ghost btn-sm hover:!text-terracotta"
        onClick={async () => {
          const ok = await confirm({
            title: '移到回收站',
            message: `把所选的 ${ids.length} ${noun}移到回收站？之后可以在回收站恢复。`,
            confirmLabel: '移到回收站',
            danger: true,
          });
          if (!ok) return;
          const r = await run(ids, { op: 'trash' }, '已移到回收站：');
          if (r) onClear();
        }}
      >
        <Trash2 size={15} /> 移到回收站
      </button>

      <button type="button" className="btn btn-ghost btn-sm ml-auto" onClick={onClear}>
        <X size={14} /> 取消选择
      </button>
    </div>
  );
}
