/** 列表中的一行：缩略图、标题、预览、属性与标签；支持多选、键盘焦点、右键菜单与拖到导航树。 */
import { ImageOff } from 'lucide-react';
import { memo, type MouseEvent, type ReactNode } from 'react';
import type { ListItemDTO, PropertyDefDTO } from '@shared/api';
import { MATERIAL_STATUS_LABELS, NOTE_TYPE_LABELS, SEARCH_FIELD_LABELS, type SearchField } from '@shared/constants';
import { assetUrl } from '../../lib/api';
import { writeDraggedIds } from '../../lib/dragItems';
import { formatTime } from '../../lib/format';
import { Link } from '../../lib/router';
import { ContextContent, ContextMenu, ContextTrigger } from '../Menu';
import { AttemptBadge } from '../students/AttemptBits';
import { TagLabel } from '../TagLabel';

function HitBadges({ item }: { item: ListItemDTO }) {
  if (item.hits.length === 0) return null;
  const inNotes: SearchField[] = item.hits.filter((h) => h === 'note' || h === 'answer' || h === 'solution');
  return (
    <span className="flex flex-wrap items-center gap-1 text-xs" data-testid="hit-badges">
      {inNotes.length > 0 ? <span className="chip chip-clay">命中{inNotes.map((h) => SEARCH_FIELD_LABELS[h]).join('/')}</span> : null}
      {item.hits
        .filter((h) => !inNotes.includes(h))
        .map((h) => (
          <span key={h} className="chip chip-stone">
            命中{SEARCH_FIELD_LABELS[h]}
          </span>
        ))}
    </span>
  );
}

/** 命中片段：<mark class="hit"> 标出命中的文字（区间由服务端按原文计算） */
function Snippets({ item }: { item: ListItemDTO }) {
  if (!item.snippets?.length) return null;
  return (
    <ul className="space-y-0.5 text-sm text-ink-soft" data-testid="snippets">
      {item.snippets.map((sn, i) => {
        const parts: ReactNode[] = [];
        let at = 0;
        sn.ranges.forEach(([a, b], k) => {
          if (a > at) parts.push(sn.text.slice(at, a));
          parts.push(
            <mark key={k} className="hit">
              {sn.text.slice(a, b)}
            </mark>,
          );
          at = b;
        });
        if (at < sn.text.length) parts.push(sn.text.slice(at));
        return (
          <li key={i} className="line-clamp-2">
            <span className="mr-1.5 text-xs text-ink-faint">{SEARCH_FIELD_LABELS[sn.field]}</span>
            {parts}
          </li>
        );
      })}
    </ul>
  );
}

/** 各属性里在不同上级下重名的末级名称（小写）；按属性对象缓存，目录刷新后自然失效。 */
const ambiguousCache = new WeakMap<PropertyDefDTO, ReadonlySet<string>>();
function ambiguousLabels(def: PropertyDefDTO): ReadonlySet<string> {
  let set = ambiguousCache.get(def);
  if (!set) {
    const seen = new Set<string>();
    const dup = new Set<string>();
    for (const o of def.options) {
      const k = o.label.toLowerCase();
      if (seen.has(k)) dup.add(k);
      seen.add(k);
    }
    set = dup;
    ambiguousCache.set(def, set);
  }
  return set;
}

/** 选项值的简短显示：只显示最后一级；末级名在该属性里有重名时显示完整路径（例如“通用/选择”与“英语/选择”）。 */
function shortOptionLabel(def: PropertyDefDTO, path: string): string {
  const last = path.split('/').at(-1) ?? path;
  return ambiguousLabels(def).has(last.toLowerCase()) ? path : last;
}

/** 列表行里的属性：选项类显示为小标签（层级选项通常只显示最后一级），其他类型显示“名称：值”。 */
function PropertyPills({ item, defs }: { item: ListItemDTO; defs: ReadonlyMap<string, PropertyDefDTO> }) {
  return (
    <>
      {item.properties.map((p) => {
        const def = defs.get(p.propertyId);
        if (!def || p.values.length === 0) return null;
        if (def.type === 'select' || def.type === 'multiselect') {
          return p.values.map((v) => (
            <span key={`${p.propertyId}:${v}`} className={`chip ${def.preset === 'difficulty' ? 'chip-warn' : def.preset === 'knowledge' ? 'chip-clay' : 'chip-stone'}`} title={`${def.name}：${v}`}>
              {shortOptionLabel(def, v)}
            </span>
          ));
        }
        if (def.type === 'checkbox') {
          return (
            <span key={p.propertyId} className="chip chip-stone">
              {def.name}
            </span>
          );
        }
        return (
          <span key={p.propertyId}>
            {def.name}：{p.values[0]}
          </span>
        );
      })}
    </>
  );
}

function MenuSlot({ render, id }: { render: (id: string) => ReactNode; id: string }) {
  return <>{render(id)}</>;
}

function isInteractive(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && Boolean(t.closest('a, button, input, label'));
}

export const ListRow = memo(function ListRow({
  item,
  href,
  placeholder,
  selected,
  focused,
  dragIds,
  onCheck,
  onFocusRow,
  onTagClick,
  defs,
  studentName,
  renderMenu,
}: {
  item: ListItemDTO;
  href: string;
  placeholder: string;
  selected: boolean;
  focused: boolean;
  /** 拖动这一行时带上的对象（已选中时为全部选中项） */
  dragIds: () => string[];
  onCheck: (id: string, range: boolean) => void;
  onFocusRow: (id: string) => void;
  onTagClick: (name: string) => void;
  defs: ReadonlyMap<string, PropertyDefDTO>;
  /** 按学生查看时的学生姓名 */
  studentName?: string | undefined;
  /** 右键菜单内容；只在菜单打开时调用 */
  renderMenu: (id: string) => ReactNode;
}) {
  const onRowClick = (e: MouseEvent) => {
    if (isInteractive(e.target)) return;
    onFocusRow(item.id);
    if (e.shiftKey) onCheck(item.id, true);
    else if (e.metaKey || e.ctrlKey) onCheck(item.id, false);
  };
  return (
    <ContextMenu>
      <ContextTrigger asChild>
        <li
          className="list-row card flex gap-3 px-3 py-3 transition-shadow hover:shadow-[var(--shadow-lift)] sm:gap-4 sm:px-4"
          data-testid="list-item"
          data-id={item.id}
          data-selected={selected || undefined}
          data-focused={focused || undefined}
          draggable
          onDragStart={(e) => writeDraggedIds(e.dataTransfer, dragIds())}
          onClick={onRowClick}
          onContextMenu={() => onFocusRow(item.id)}
        >
          <input
            type="checkbox"
            className="mt-1 h-4 w-4 flex-none accent-[var(--color-sage-deep)]"
            checked={selected}
            onChange={() => undefined}
            onClick={(e) => {
              e.stopPropagation();
              onFocusRow(item.id);
              onCheck(item.id, e.shiftKey);
            }}
            aria-label={`选择 ${item.title ?? placeholder}`}
          />
          <Link to={href} className="flex-none" tabIndex={-1} aria-hidden="true" draggable={false}>
            {item.firstImageAssetId ? (
              <img className="thumb" src={assetUrl(item.firstImageAssetId)} alt="" loading="lazy" draggable={false} />
            ) : (
              <span className="thumb flex items-center justify-center text-ink-faint">
                {item.imageCount > 0 ? <ImageOff size={20} /> : <span className="font-serif text-2xl text-line-strong">¶</span>}
              </span>
            )}
          </Link>
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <Link
                to={href}
                draggable={false}
                className={`truncate font-serif text-[1.02rem] font-semibold hover:underline ${item.title ? 'text-stone' : 'italic text-ink-soft'}`}
              >
                {item.title ?? placeholder}
              </Link>
              {item.status ? <span className={`chip ${item.status === 'inbox' ? 'chip-warn' : 'chip-stone'}`}>{MATERIAL_STATUS_LABELS[item.status]}</span> : null}
              <HitBadges item={item} />
            </div>
            {item.snippets?.length ? (
              <Snippets item={item} />
            ) : (
              <p className="line-clamp-2 text-sm text-ink-soft">{item.summary || (item.imageCount ? `${item.imageCount} 张图片` : '（无文字内容）')}</p>
            )}
            {item.attempt !== undefined ? (
              <div className="text-xs">
                <AttemptBadge summary={item.attempt} studentName={studentName} />
              </div>
            ) : null}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-faint">
              {item.subject ? <span>{item.subject}</span> : null}
              {item.stage ? <span>{item.stage}</span> : null}
              <PropertyPills item={item} defs={defs} />
              {item.tags.map((t) => (
                <button key={t} type="button" className="chip hover:bg-sage hover:text-white" title={`只看“${t}”`} onClick={() => onTagClick(t)}>
                  <TagLabel name={t} />
                </button>
              ))}
              {item.noteCounts
                ? (['answer', 'solution', 'note'] as const)
                    .filter((k) => item.noteCounts![k] > 0)
                    .map((k) => (
                      <span key={k}>
                        {NOTE_TYPE_LABELS[k]} {item.noteCounts![k]}
                      </span>
                    ))
                : null}
              <span className="ml-auto">添加 {formatTime(item.createdAt)}</span>
              <span>修改 {formatTime(item.updatedAt)}</span>
            </div>
          </div>
        </li>
      </ContextTrigger>
      <ContextContent>
        <MenuSlot render={renderMenu} id={item.id} />
      </ContextContent>
    </ContextMenu>
  );
});
