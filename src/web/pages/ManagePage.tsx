/**
 * 数据管理：左边列出所有分类——属性（含内置的题型、难度、考点）与学科、学段、标签——右边是选中分类的详情。
 * 地址为 /manage?item=<属性ID|subject|stage|tags>（左侧栏标题的右键菜单也链到这里）；旧的 ?tab= 仍然有效。
 * 属性在左边拖动排序（键盘也可以；右键菜单里还有上移/下移），右键菜单有改名、改类型、左侧栏、归档。
 */
import { closestCenter, DndContext, KeyboardSensor, MeasuringStrategy, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useQuery } from '@tanstack/react-query';
import { Archive, ArrowDown, ArrowUp, Eye, EyeOff, GripVertical, Pencil, Plus, Shapes } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type { DictManageDTO, PropertyDefDTO, TagManageDTO, UsageDTO } from '@shared/api';
import { PROPERTY_TYPE_LABELS } from '@shared/constants';
import { DICT_LABEL, DictPanel } from '../components/manage/DictPanel';
import { ManageHelp } from '../components/manage/ManageHelp';
import { PropertyPanel, retypeBlock, usePropertyActions } from '../components/manage/PropertyPanel';
import { TagsPanel } from '../components/manage/TagsPanel';
import { ContextContent, ContextItem, ContextMenu, ContextSeparator, ContextTrigger } from '../components/Menu';
import { CreatePropertyDialog } from '../components/props/CreatePropertyDialog';
import { isNavType } from '../components/props/propertyText';
import { TypeChangeDialog } from '../components/props/TypeChangeDialog';
import { ErrorBox, PageHeader, Spinner, useToast } from '../components/ui';
import { errorMessage, getJSON, sendJSON } from '../lib/api';
import { invalidateWrites } from '../lib/queryClient';
import { useRouter } from '../lib/router';

const BUILTIN = ['subject', 'stage', 'tags'] as const;
type Builtin = (typeof BUILTIN)[number];
const isBuiltin = (x: string | null): x is Builtin => BUILTIN.includes(x as Builtin);
const BUILTIN_LABEL: Record<Builtin, string> = { subject: '学科', stage: '学段', tags: '标签' };

function SortableProperty({ def, active, onSelect, menu }: { def: PropertyDefDTO; active: boolean; onSelect: () => void; menu: ReactNode }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: def.id });
  return (
    <ContextMenu>
      <ContextTrigger asChild>
        <li ref={setNodeRef} style={{ transform: CSS.Translate.toString(transform), transition }} className={`group flex items-center ${isDragging ? 'relative z-10' : ''}`}>
          <button type="button" className="tree-row min-w-0 flex-1 pl-2 text-left" data-active={active || undefined} aria-current={active ? 'true' : undefined} onClick={onSelect}>
            <span className="min-w-0 truncate">{def.name}</span>
            <span className="tree-count">{PROPERTY_TYPE_LABELS[def.type]}</span>
          </button>
          <button
            ref={setActivatorNodeRef}
            type="button"
            className="btn btn-ghost btn-icon h-6 w-6 flex-none cursor-grab touch-none opacity-0 group-hover:opacity-60 focus-visible:opacity-100 active:cursor-grabbing"
            aria-label={`拖动排序：${def.name}`}
            {...attributes}
            {...listeners}
          >
            <GripVertical size={14} />
          </button>
        </li>
      </ContextTrigger>
      <ContextContent>{menu}</ContextContent>
    </ContextMenu>
  );
}

function CategoryButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <li>
      <button type="button" className="tree-row pl-2 text-left" data-active={active || undefined} aria-current={active ? 'true' : undefined} onClick={onClick}>
        {children}
      </button>
    </li>
  );
}

export function ManagePage() {
  const { search, navigate } = useRouter();
  const toast = useToast();
  const actions = usePropertyActions();
  const params = new URLSearchParams(search);
  const legacyTab = params.get('tab');
  const requested = params.get('item') ?? (legacyTab && legacyTab !== 'properties' ? legacyTab : null);

  const props = useQuery({ queryKey: ['manage', 'properties'], queryFn: () => getJSON<PropertyDefDTO[]>('/api/properties?all=1') });
  const usage = useQuery({ queryKey: ['manage', 'property-usage'], queryFn: () => getJSON<Record<string, UsageDTO>>('/api/properties/usage') });
  const defs = props.data ?? [];
  const live = defs.filter((d) => !d.archived);
  const archived = defs.filter((d) => d.archived);
  // 没指定、或指定的属性不存在时：考点（最常整理的树），没有就第一个属性
  const fallback = live.find((d) => d.preset === 'knowledge')?.id ?? live[0]?.id ?? 'tags';
  const item = isBuiltin(requested) || (requested && defs.some((d) => d.id === requested)) ? requested! : props.data ? fallback : requested;
  const current = defs.find((d) => d.id === item);

  const dict = useQuery({ queryKey: ['manage', 'dict'], queryFn: () => getJSON<DictManageDTO>('/api/dict/manage'), enabled: item === 'subject' || item === 'stage' });
  const tags = useQuery({ queryKey: ['manage', 'tags'], queryFn: () => getJSON<TagManageDTO>('/api/tags/manage'), enabled: item === 'tags' });

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [retyping, setRetyping] = useState<PropertyDefDTO | null>(null);
  const [creating, setCreating] = useState(false);
  const select = (x: string) => {
    setRenamingId(null);
    navigate(`/manage?item=${encodeURIComponent(x)}`, { replace: true });
  };

  // 拖动后先按新顺序显示，等服务端数据回来再以它为准
  const [order, setOrder] = useState<string[] | null>(null);
  useEffect(() => setOrder(null), [props.data]);
  const ordered = order ? order.map((id) => live.find((d) => d.id === id)).filter((d): d is PropertyDefDTO => Boolean(d)) : live;
  const reorder = async (ids: string[]) => {
    setOrder(ids);
    try {
      await sendJSON('POST', '/api/properties/reorder', { ids });
      invalidateWrites();
    } catch (err) {
      setOrder(null);
      toast(errorMessage(err), 'error');
    }
  };
  const move = (d: PropertyDefDTO, delta: number) => {
    const ids = ordered.map((x) => x.id);
    const i = ids.indexOf(d.id);
    if (i + delta < 0 || i + delta >= ids.length) return;
    void reorder(arrayMove(ids, i, i + delta));
  };
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const ids = ordered.map((x) => x.id);
    void reorder(arrayMove(ids, ids.indexOf(String(active.id)), ids.indexOf(String(over.id))));
  };

  const propertyMenu = (d: PropertyDefDTO, i: number) => {
    const block = retypeBlock(d);
    return (
      <>
        <ContextItem
          onSelect={() => {
            select(d.id);
            setRenamingId(d.id);
          }}
        >
          <Pencil size={13} /> 改名
        </ContextItem>
        <ContextItem disabled={Boolean(block)} onSelect={() => setRetyping(d)}>
          <Shapes size={13} /> {block ? `改类型（${block}）` : '改类型…'}
        </ContextItem>
        {isNavType(d.type) ? (
          <ContextItem onSelect={() => actions.toggleNav(d)}>
            {d.showInNav ? <EyeOff size={13} /> : <Eye size={13} />} {d.showInNav ? '不在左侧栏列出' : '在左侧栏列出'}
          </ContextItem>
        ) : null}
        <ContextItem disabled={i === 0} onSelect={() => move(d, -1)}>
          <ArrowUp size={13} /> 上移
        </ContextItem>
        <ContextItem disabled={i === ordered.length - 1} onSelect={() => move(d, 1)}>
          <ArrowDown size={13} /> 下移
        </ContextItem>
        <ContextSeparator />
        <ContextItem danger disabled={Boolean(d.preset)} onSelect={() => void actions.archive(d)}>
          <Archive size={13} /> {d.preset ? '归档（内置属性不能归档）' : '归档'}
        </ContextItem>
      </>
    );
  };

  const detail = (): ReactNode => {
    if (current) {
      return (
        <PropertyPanel
          key={current.id}
          def={current}
          usage={usage.data?.[current.id]}
          renaming={renamingId === current.id}
          onRenamingChange={(on) => setRenamingId(on ? current.id : null)}
          onRetype={() => setRetyping(current)}
        />
      );
    }
    if (item === 'subject' || item === 'stage') {
      if (dict.isError) return <ErrorBox message={errorMessage(dict.error)} onRetry={() => void dict.refetch()} />;
      return dict.data ? <DictPanel key={item} kind={item} entries={dict.data[item]} /> : <Spinner />;
    }
    if (item === 'tags') {
      if (tags.isError) return <ErrorBox message={errorMessage(tags.error)} onRetry={() => void tags.refetch()} />;
      return tags.data ? <TagsPanel data={tags.data} /> : <Spinner />;
    }
    return null;
  };

  return (
    <div>
      <PageHeader title="数据管理" subtitle="整理题目和资料的分类：属性与考点树、学科、学段和标签。" />
      {props.isError ? <ErrorBox message={errorMessage(props.error)} onRetry={() => void props.refetch()} /> : null}
      <div className="grid gap-6 md:grid-cols-[13.5rem_minmax(0,1fr)]">
        <aside className="space-y-4 md:sticky md:top-4 md:self-start" aria-label="分类">
          <section className="space-y-0.5">
            <div className="flex items-center gap-1">
              <h2 className="nav-section-title flex-1">属性</h2>
              <ManageHelp
                title="属性"
                tips={[
                  '属性出现在题目和资料的属性面板里，可以用来筛选和检索，也会写进 Markdown 导出',
                  '拖动右边的手柄调整顺序：属性面板和左侧栏都按这个顺序',
                  '右键打开菜单：改名、改类型、是否在左侧栏列出、上移下移、归档',
                ]}
              />
              <button type="button" className="btn btn-ghost btn-icon h-7 w-7" aria-label="新建属性" title="新建属性" onClick={() => setCreating(true)}>
                <Plus size={16} />
              </button>
            </div>
            {props.isPending ? <Spinner /> : null}
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
              onDragEnd={onDragEnd}
              accessibility={{ screenReaderInstructions: { draggable: '按空格或回车拿起，用上下方向键移动，再按空格或回车放下；按 Esc 取消。' } }}
            >
              <SortableContext items={ordered.map((d) => d.id)} strategy={verticalListSortingStrategy}>
                <ul className="space-y-0.5" aria-label="属性列表">
                  {ordered.map((d, i) => (
                    <SortableProperty key={d.id} def={d} active={item === d.id} onSelect={() => select(d.id)} menu={propertyMenu(d, i)} />
                  ))}
                </ul>
              </SortableContext>
            </DndContext>
          </section>
          <section className="space-y-0.5">
            <h2 className="nav-section-title">其他分类</h2>
            <ul className="space-y-0.5" aria-label="其他分类">
              {BUILTIN.map((b) => (
                <CategoryButton key={b} active={item === b} onClick={() => select(b)}>
                  <span className="min-w-0 truncate">{BUILTIN_LABEL[b]}</span>
                </CategoryButton>
              ))}
            </ul>
          </section>
          {archived.length ? (
            <details className="space-y-0.5" open={Boolean(current?.archived) || undefined}>
              <summary className="nav-section-title cursor-pointer">已归档（{archived.length}）</summary>
              <ul className="space-y-0.5" aria-label="已归档的属性">
                {archived.map((d) => (
                  <CategoryButton key={d.id} active={item === d.id} onClick={() => select(d.id)}>
                    <span className="min-w-0 truncate text-ink-faint">{d.name}</span>
                    <span className="tree-count">{PROPERTY_TYPE_LABELS[d.type]}</span>
                  </CategoryButton>
                ))}
              </ul>
            </details>
          ) : null}
        </aside>
        <section className="min-w-0 space-y-3" aria-label={current ? `属性“${current.name}”` : isBuiltin(item) ? BUILTIN_LABEL[item] : '详情'}>
          {isBuiltin(item) ? <h2 className="text-xl font-semibold text-stone">{item === 'tags' ? '标签' : DICT_LABEL[item]}</h2> : null}
          {detail()}
        </section>
      </div>
      <CreatePropertyDialog open={creating} onClose={() => setCreating(false)} onCreated={(d) => select(d.id)} />
      {retyping ? <TypeChangeDialog key={retyping.id} def={retyping} open onClose={() => setRetyping(null)} /> : null}
    </div>
  );
}
