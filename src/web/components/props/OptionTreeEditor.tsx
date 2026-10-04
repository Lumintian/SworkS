/**
 * 选项树编辑（基于 ManageTree / headless-tree）：多选、右键菜单、拖动排序与改变上级、F2 或双击改名、Delete 删除；
 * 工具栏新建同级/下级、删除（含子树）、合并到其他选项、导入大纲（带预览）、复制为大纲（可粘贴到别的库或属性里导入）。
 * “分层”不单独让用户勾选：第一次建下级（新建下级、拖到别的选项上、导入带层级的大纲）时说明后果并确认。
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ArrowUpToLine, ClipboardCopy, Eye, FileInput, GitMerge, Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { OutlineImportResultDTO, PropertyDefDTO, PropertyOptionDTO, UsageDTO } from '@shared/api';
import { errorMessage, getJSON, sendJSON } from '../../lib/api';
import { newId } from '../../lib/format';
import { CATALOG_ONLY, invalidateWrites } from '../../lib/queryClient';
import { useRouter } from '../../lib/router';
import { DuplicateHint, findDuplicates } from '../manage/DuplicateHint';
import { ManageHelp, treeTips } from '../manage/ManageHelp';
import { ManageTree, type ManageNode } from '../manage/ManageTree';
import { NO_USAGE, scopeText, UNDO_HINT, usage } from '../manage/usage';
import { useUndoToast } from '../manage/useUndoToast';
import { Popover, PopoverContent, PopoverTrigger } from '../Menu';
import { Dialog, useConfirm, useToast } from '../ui';
import { OptionPicker } from './OptionPicker';

/** 分层的后果：确认框与说明共用。 */
export function nestingConsequence(def: PropertyDefDTO): string {
  return `之后按“${def.name}”筛选或检索时，选上级会包含它的全部下级${
    def.type === 'select' ? `；“${def.name}”不能再用 >、< 按先后比较（例如“${def.name}:>=某个选项”）` : ''
  }。没有下级选项时可以改回来。`;
}

/** 大纲里有没有层级：缩进的行或 # 标题 */
const hasHierarchy = (text: string) => text.split(/\r?\n/).some((l) => l.trim() && (/^\s+\S/.test(l) || /^\s*#{1,6}\s/.test(l)));

function OutlineImportDialog({ def, open, onClose }: { def: PropertyDefDTO; open: boolean; onClose: () => void }) {
  const toast = useToast();
  const [text, setText] = useState('');
  // 不分层的属性遇到带层级的大纲：默认保留层级（同时把属性改为分层），可以取消
  const [keepLevels, setKeepLevels] = useState(true);
  const nest = !def.nested && keepLevels && hasHierarchy(text);
  // 停顿后试运行一次（服务端执行后整体回滚），预览每一行会落到哪里、哪些已存在
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(text), 300);
    return () => window.clearTimeout(timer);
  }, [text]);
  const preview = useQuery({
    queryKey: ['outline-preview', def.id, debounced, nest],
    queryFn: () => sendJSON<OutlineImportResultDTO>('POST', `/api/properties/${def.id}/import`, { outline: debounced, dryRun: true, nest }),
    enabled: open && debounced.trim() !== '',
    placeholderData: keepPreviousData,
    retry: false,
  });
  const shown = text.trim() ? preview.data : undefined;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title={`导入${def.name}大纲`}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!text.trim()}
            onClick={async () => {
              try {
                const r = await sendJSON<OutlineImportResultDTO>('POST', `/api/properties/${def.id}/import`, { outline: text, nest });
                invalidateWrites(CATALOG_ONLY);
                toast(`已新建 ${r.created} 个选项，${r.existing} 个已存在`, 'success');
                setText('');
                onClose();
              } catch (err) {
                toast(errorMessage(err), 'error');
              }
            }}
          >
            {shown ? `导入（新建 ${shown.created} 个）` : '导入'}
          </button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <p className="text-ink-soft">每行一个，用缩进、Markdown 列表（- / 1.）或 # 标题表示层级。已存在的同名选项会直接沿用，不会重复。</p>
        {!def.nested && hasHierarchy(text) ? (
          <label className="flex items-start gap-2 text-ink-soft">
            <input type="checkbox" className="mt-1 accent-[var(--color-sage-deep)]" checked={keepLevels} onChange={(e) => setKeepLevels(e.target.checked)} />
            <span>
              保留层级：“{def.name}”的选项会改为可以有下级。{nestingConsequence(def)}不勾选则全部放在顶层。
            </span>
          </label>
        ) : null}
        <div className="grid gap-3 md:grid-cols-2">
          <textarea
            className="textarea min-h-[18rem]"
            value={text}
            aria-label="大纲内容"
            placeholder={'# 函数\n- 函数的概念\n- 单调性\n  - 单调区间\n# 数列\n- 等差数列'}
            onChange={(e) => setText(e.target.value)}
          />
          <section className="card-flat max-h-[18rem] min-h-[18rem] overflow-y-auto px-3 py-2" aria-label="导入预览">
            {!text.trim() ? (
              <p className="py-6 text-center text-xs text-ink-faint">粘贴大纲后，这里显示导入后的层级。</p>
            ) : preview.isError ? (
              <p className="py-6 text-center text-xs text-terracotta">{errorMessage(preview.error)}</p>
            ) : shown?.items ? (
              <>
                <p className="mb-1 text-xs text-ink-faint">
                  将新建 {shown.created} 个{shown.existing ? `，沿用 ${shown.existing} 个已有选项` : ''}
                  {shown.items.length < shown.created + shown.existing ? `（只预览前 ${shown.items.length} 行）` : ''}
                </p>
                <ul>
                  {shown.items.map((it, i) => (
                    <li key={i} className="flex items-center gap-2 py-0.5" style={{ paddingLeft: `${it.depth * 1.1}rem` }}>
                      <span className={`truncate ${it.existing ? 'text-ink-faint' : 'text-ink'}`}>{it.path.split('/').at(-1)}</span>
                      <span className={`flex-none text-[11px] ${it.existing ? 'text-ink-faint' : 'text-sage-deep'}`}>{it.existing ? '已有' : '新建'}</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="py-6 text-center text-xs text-ink-faint">正在生成预览…</p>
            )}
          </section>
        </div>
      </div>
    </Dialog>
  );
}

interface OptionNode extends ManageNode {
  option: PropertyOptionDTO;
  usage: UsageDTO;
}

export function OptionTreeEditor({ def }: { def: PropertyDefDTO }) {
  const toast = useToast();
  const undoToast = useUndoToast();
  const confirm = useConfirm();
  const { navigate } = useRouter();
  const [selected, setSelected] = useState<string[]>([]);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeDialog, setMergeDialog] = useState<PropertyOptionDTO[] | null>(null);
  // 每个选项（含子树）的使用次数；属性数据先到时先不显示
  const counts = useQuery({ queryKey: ['manage', 'option-usage', def.id], queryFn: () => getJSON<Record<string, UsageDTO>>(`/api/properties/${def.id}/usage`) });
  const usageOf = (id: string) => counts.data?.[id] ?? NO_USAGE;
  const byId = useMemo(() => new Map(def.options.map((o) => [o.id, o])), [def.options]);
  const nodes: OptionNode[] = useMemo(
    () =>
      def.options.map((o) => {
        const u = counts.data?.[o.id] ?? NO_USAGE;
        return { id: o.id, parentId: o.parentId, label: o.label, hint: counts.data ? usage(u) : undefined, option: o, usage: u };
      }),
    [def.options, counts.data],
  );
  const duplicates = useMemo(() => findDuplicates(nodes), [nodes]);
  const selectedOptions = selected.map((id) => byId.get(id)).filter((o): o is PropertyOptionDTO => Boolean(o));
  const current = selectedOptions.length === 1 ? selectedOptions[0] : undefined;

  /** 新建、改名、移动选项：取值按 ID 保存，题目内容不变 */
  const call = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      invalidateWrites(CATALOG_ONLY);
      if (ok) toast(ok, 'success');
      return true;
    } catch (err) {
      toast(errorMessage(err), 'error');
      return false;
    }
  };

  /** 第一次要建下级时：说明分层的后果，确认后把属性改为分层。 */
  const ensureNested = async (): Promise<boolean> => {
    if (def.nested) return true;
    const ok = await confirm({
      title: `让“${def.name}”的选项可以有下级`,
      message: `选项可以像“英语/完型填空”这样分出下级。${nestingConsequence(def)}`,
      confirmLabel: '可以有下级',
    });
    if (!ok) return false;
    return call(() => sendJSON('PUT', `/api/properties/${def.id}`, { nested: true }));
  };
  const flatten = () => void call(() => sendJSON('PUT', `/api/properties/${def.id}`, { nested: false }), `“${def.name}”的选项不再分层`);
  const hasChildren = def.options.some((o) => o.parentId !== null);

  const [adding, setAdding] = useState<{ parentId: string | null; label: string } | null>(null);
  const add = async (parentId: string | null) => {
    if (parentId !== null && !(await ensureNested())) return;
    setAdding({ parentId, label: '' });
  };
  const submitAdd = async () => {
    if (!adding?.label.trim()) return;
    const id = newId();
    const { parentId, label } = adding;
    if (await call(() => sendJSON('POST', `/api/properties/${def.id}/options`, { id, label: label.trim(), parentId }))) {
      setSelected([id]);
      setAdding({ parentId, label: '' });
    }
  };

  /** 只保留最上层：上级也被选中时随上级处理。 */
  const topmost = (xs: PropertyOptionDTO[]) => xs.filter((x) => !xs.some((y) => y !== x && x.path.startsWith(`${y.path}/`)));

  const remove = async (sel: PropertyOptionDTO[]) => {
    const xs = topmost(sel);
    if (xs.length === 0) return;
    const kids = def.options.filter((o) => xs.some((x) => o.path.startsWith(`${x.path}/`))).length;
    const ok = await confirm({
      title: xs.length === 1 ? `删除“${xs[0]!.path}”` : `删除 ${xs.length} 个选项`,
      message: (() => {
        const scope = scopeText(xs.map((x) => usageOf(x.id)));
        const them = xs.length > 1 || kids ? '它们' : '它';
        const list = xs.length > 1 ? `${xs.map((x) => `“${x.path}”`).slice(0, 5).join('、')}${xs.length > 5 ? ' 等' : ''}` : '';
        const what = kids ? `${list}连同 ${kids} 个下级选项一起删除。` : list ? `${list}一起删除。` : '';
        const effect = scope ? `用到${them}的 ${scope}会去掉这个${def.name}，题目和资料本身不受影响。` : `目前没有题目或资料用到${them}。`;
        return `${what}${effect}${UNDO_HINT}`;
      })(),
      confirmLabel: xs.length === 1 ? '删除' : `删除 ${xs.length} 个选项`,
      danger: true,
    });
    if (!ok) return;
    try {
      const r = await sendJSON<{ deleted: number; affectedItems: number; undoId?: string }>('POST', '/api/property-options/delete-many', { ids: xs.map((x) => x.id) });
      invalidateWrites();
      undoToast(`已删除 ${r.deleted} 个选项，影响 ${r.affectedItems} 项`, r.undoId);
      setSelected([]);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  const merge = async (sel: PropertyOptionDTO[], intoId: string) => {
    const into = byId.get(intoId);
    const xs = topmost(sel).filter((x) => x.id !== intoId);
    setMergeOpen(false);
    setMergeDialog(null);
    if (!into || xs.length === 0) return;
    const ok = await confirm({
      title: xs.length === 1 ? `把“${xs[0]!.path}”合并到“${into.path}”` : `把 ${xs.length} 个选项合并到“${into.path}”`,
      message: (() => {
        const scope = scopeText(xs.map((x) => usageOf(x.id)));
        return `${scope ? `用到前者的 ${scope}改为使用后者；` : ''}前者的下级移到后者下面（同名的继续合并），然后删除前者。${UNDO_HINT}`;
      })(),
      confirmLabel: '合并',
    });
    if (!ok) return;
    try {
      const r = await sendJSON<{ affectedItems: number; undoId?: string }>('POST', '/api/property-options/merge-many', { ids: xs.map((x) => x.id), intoId });
      invalidateWrites();
      undoToast(`已合并${r.affectedItems ? `，影响 ${r.affectedItems} 项` : ''}`, r.undoId);
      setSelected([into.id]);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  /** 按树的顺序写成 Markdown 列表（缩进表示层级），与“导入大纲”的格式一致。 */
  const copyOutline = async () => {
    const outline = def.options.map((o) => `${'  '.repeat(o.depth)}- ${o.label}`).join('\n');
    try {
      await navigator.clipboard.writeText(outline);
      toast(`已复制 ${def.options.length} 个选项的大纲，可以粘贴到“导入大纲”`, 'success');
    } catch {
      toast('无法写入剪贴板', 'error');
    }
  };

  const move = async (ids: string[], parentId: string | null, index: number | undefined) => {
    if (parentId !== null && !(await ensureNested())) return;
    await call(() => sendJSON('POST', '/api/property-options/move-many', { ids, parentId, index }));
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-sm" onClick={() => void add(null)}>
          <Plus size={14} /> 新建{hasChildren ? '顶级' : ''}选项
        </button>
        <button type="button" className="btn btn-sm" disabled={!current} onClick={() => current && void add(current.id)}>
          <Plus size={14} /> 新建下级
        </button>
        <button type="button" className="btn btn-sm" disabled={!current} onClick={() => current && setRenamingId(current.id)}>
          <Pencil size={14} /> 改名
        </button>
        <Popover open={mergeOpen} onOpenChange={setMergeOpen}>
          <PopoverTrigger asChild>
            <button type="button" className="btn btn-sm" disabled={selectedOptions.length === 0}>
              <GitMerge size={14} /> 合并到…
            </button>
          </PopoverTrigger>
          <PopoverContent>
            {selectedOptions.length ? (
              <OptionPicker def={def} selected={selected} allowCreate={false} placeholder="合并到哪个选项…" onPick={(id) => void merge(selectedOptions, id)} />
            ) : null}
          </PopoverContent>
        </Popover>
        <button type="button" className="btn btn-ghost btn-sm hover:!text-terracotta" disabled={selectedOptions.length === 0} onClick={() => void remove(selectedOptions)}>
          <Trash2 size={14} /> 删除{selectedOptions.length > 1 ? ` ${selectedOptions.length} 项` : ''}
        </button>
        <button type="button" className="btn btn-ghost btn-sm ml-auto" disabled={def.options.length === 0} onClick={() => void copyOutline()}>
          <ClipboardCopy size={14} /> 复制为大纲
        </button>
        <button type="button" className="btn btn-sage btn-sm" onClick={() => setImporting(true)}>
          <FileInput size={14} /> 导入大纲
        </button>
        <ManageHelp
          title={`${def.name}的选项`}
          tips={[
            ...treeTips({ drag: '拖动调整顺序；拖到另一个选项上，即成为它的下级' }),
            '选项改名、移动不会改动题目内容，也不改变题目的修改时间；删除或合并会同步修改用到它们的题目',
            '需要下级时，选中一个选项点“新建下级”，或把选项拖到另一个选项上',
          ]}
        />
      </div>
      {def.nested ? (
        <p className="flex flex-wrap items-center gap-x-2 text-xs text-ink-faint">
          <span>选项可以有下级：按“{def.name}”筛选时，选上级会包含全部下级。</span>
          <button
            type="button"
            className="link-btn text-xs"
            disabled={hasChildren}
            title={hasChildren ? '还有下级选项：先把它们移到顶级或合并，才能改回不分层' : undefined}
            onClick={flatten}
          >
            改为不分层
          </button>
        </p>
      ) : null}
      {adding ? (
        <form
          className="flex flex-wrap items-center gap-2 text-sm"
          onSubmit={(e) => {
            e.preventDefault();
            void submitAdd();
          }}
        >
          <span className="text-ink-soft">{adding.parentId ? `在“${byId.get(adding.parentId)?.path}”下新建：` : '新建顶级选项：'}</span>
          <input
            className="input max-w-xs py-1"
            value={adding.label}
            autoFocus
            maxLength={60}
            aria-label="新选项名称"
            onChange={(e) => setAdding({ ...adding, label: e.target.value })}
            onKeyDown={(e) => e.key === 'Escape' && setAdding(null)}
          />
          <button type="submit" className="btn btn-sage btn-sm" disabled={!adding.label.trim()}>
            添加
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAdding(null)}>
            完成
          </button>
        </form>
      ) : null}
      <DuplicateHint groups={duplicates} describe={(n) => n.option.path} onMerge={(xs, into) => void merge(xs.map((x) => x.option), into.id)} />
      <div className="card-flat max-h-[60vh] overflow-y-auto px-2 py-2">
        <ManageTree<OptionNode>
          label={`${def.name}选项树`}
          filterPlaceholder={def.nested ? `过滤${def.name}，例如“函数/单调”` : `过滤${def.name}`}
          nodes={nodes}
          selectedIds={selected}
          onSelectedIdsChange={setSelected}
          emptyText="还没有选项。可以逐个新建，或粘贴一份大纲导入。"
          drag={{ canReparent: true, canReorder: true, onMove: move }}
          renamingId={renamingId}
          onRenamingIdChange={setRenamingId}
          rename={{
            label: '选项新名称',
            initial: (n) => n.option.label,
            submit: (n, v) => void call(() => sendJSON('PUT', `/api/property-options/${n.id}`, { label: v }), '已改名'),
          }}
          onDelete={(sel) => void remove(sel.map((n) => n.option))}
          actions={(sel, { startRename }) => {
            const xs = sel.map((n) => n.option);
            const one = xs.length === 1 ? xs[0] : undefined;
            return [
              {
                key: 'view',
                label: '在题目列表中查看',
                icon: <Eye size={13} />,
                disabled: !one,
                onSelect: () => one && navigate(`/problems?${new URLSearchParams({ prop: `${def.id}:${one.id}` }).toString()}`),
              },
              { key: 'child', label: '新建下级', icon: <Plus size={13} />, disabled: !one, onSelect: () => one && void add(one.id) },
              { key: 'rename', label: '改名', icon: <Pencil size={13} />, disabled: !one, onSelect: () => one && startRename(one.id) },
              ...(hasChildren
                ? [{ key: 'top', label: '移到顶级', icon: <ArrowUpToLine size={13} />, disabled: !xs.some((x) => x.parentId !== null), onSelect: () => void move(topmost(xs).map((x) => x.id), null, undefined) }]
                : []),
              { key: 'merge', label: '合并到…', icon: <GitMerge size={13} />, disabled: xs.length === 0, onSelect: () => setMergeDialog(xs) },
              {
                key: 'delete',
                label: xs.length > 1 ? `删除 ${topmost(xs).length} 项` : '删除',
                icon: <Trash2 size={13} />,
                danger: true,
                separatorBefore: true,
                disabled: xs.length === 0,
                onSelect: () => void remove(xs),
              },
            ];
          }}
        />
      </div>
      <Dialog open={mergeDialog !== null} onClose={() => setMergeDialog(null)} title={`把 ${mergeDialog?.length ?? 0} 个选项合并到…`}>
        <OptionPicker def={def} selected={mergeDialog?.map((x) => x.id) ?? []} allowCreate={false} placeholder="合并到哪个选项…" onPick={(id) => void merge(mergeDialog ?? [], id)} />
      </Dialog>
      <OutlineImportDialog def={def} open={importing} onClose={() => setImporting(false)} />
    </div>
  );
}
