/**
 * 命令面板（⌘K / Ctrl+K）：按关键词跳到题目或资料、新建、跳到标签或页面。
 * 在现有的原生 Dialog 里渲染 cmdk 的 <Command>，全站只有一套对话框。
 */
import { Command } from 'cmdk';
import { BookOpen, FilePlus2, Hash, Inbox, Library, Plus, Search, SlidersHorizontal, Tags, Trash2, Archive, FileText, UserRound, Users } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ListResponse } from '@shared/api';
import { listFiltersToParams, EMPTY_FILTERS } from '@shared/listFilters';
import { getJSON } from '../lib/api';
import { newId } from '../lib/format';
import { useRouter } from '../lib/router';
import { useStudents } from '../lib/queries';
import { useCatalog } from '../lib/useCatalog';
import { Dialog } from './ui';

interface Entry {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon: ReactNode;
  keywords?: string;
  run: () => void;
}

function matches(e: Entry, q: string): boolean {
  if (!q) return true;
  const hay = `${e.label} ${e.hint ?? ''} ${e.keywords ?? ''}`.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((k) => hay.includes(k));
}

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { navigate } = useRouter();
  const catalog = useCatalog();
  const students = useStudents();
  const [q, setQ] = useState('');
  const [found, setFound] = useState<{ problems: ListResponse['items']; materials: ListResponse['items'] }>({ problems: [], materials: [] });

  useEffect(() => {
    if (!open) {
      setQ('');
      setFound({ problems: [], materials: [] });
    }
  }, [open]);

  // 关键词搜索题目与资料（与列表页同一个检索接口）
  useEffect(() => {
    const kw = q.trim();
    if (!open || !kw) {
      setFound({ problems: [], materials: [] });
      return;
    }
    let alive = true;
    const t = window.setTimeout(() => {
      const p = new URLSearchParams({ q: kw, limit: '8' });
      Promise.all([getJSON<ListResponse>(`/api/problems?${p.toString()}`), getJSON<ListResponse>(`/api/materials?${p.toString()}`)]).then(
        ([pr, ma]) => alive && setFound({ problems: pr.items, materials: ma.items.slice(0, 5) }),
        () => undefined,
      );
    }, 180);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [q, open]);

  const go = (to: string) => {
    onClose();
    navigate(to);
  };

  const staticEntries: Entry[] = useMemo(
    () => [
      { id: 'new-problem', group: '新建', label: '收一道题', icon: <Plus size={15} />, keywords: 'new 新建 题目', run: () => go(`/problems/new?id=${newId()}`) },
      { id: 'new-material', group: '新建', label: '收一份资料', icon: <FilePlus2 size={15} />, keywords: 'new 新建 资料', run: () => go(`/materials/new?id=${newId()}`) },
      { id: 'new-inbox', group: '新建', label: '收进收件箱', icon: <Inbox size={15} />, keywords: 'inbox', run: () => go(`/materials/new?id=${newId()}&status=inbox`) },
      { id: 'go-problems', group: '前往', label: '题目', icon: <BookOpen size={15} />, keywords: 'problems', run: () => go('/problems') },
      { id: 'go-materials', group: '前往', label: '资料', icon: <Library size={15} />, keywords: 'materials', run: () => go('/materials') },
      { id: 'go-inbox', group: '前往', label: '收件箱', icon: <Inbox size={15} />, keywords: 'inbox', run: () => go('/inbox') },
      { id: 'go-manage', group: '前往', label: '数据管理', hint: '属性与考点、学科、学段、标签', icon: <SlidersHorizontal size={15} />, keywords: 'manage 管理 改名 合并', run: () => go('/manage') },
      { id: 'go-students', group: '前往', label: '学生', icon: <Users size={15} />, keywords: 'students', run: () => go('/students') },
      ...(students.data ?? []).map<Entry>((s) => ({
        id: `student-${s.id}`,
        group: '学生',
        label: s.name,
        hint: s.stats.openMistakes ? `当前错题 ${s.stats.openMistakes}` : `做过 ${s.stats.problems} 题`,
        icon: <UserRound size={15} />,
        run: () => go(`/students/${s.id}`),
      })),
      { id: 'go-trash', group: '前往', label: '回收站', icon: <Trash2 size={15} />, keywords: 'trash', run: () => go('/trash') },
      { id: 'go-backup', group: '前往', label: '备份与导出', icon: <Archive size={15} />, keywords: 'backup export', run: () => go('/backup') },
      ...catalog.tags
        .filter((t) => t.problemCount > 0)
        .map<Entry>((t) => ({
          id: `tag-${t.id}`,
          group: '标签',
          label: t.name,
          hint: `${t.problemCount} 道题`,
          icon: <Hash size={15} />,
          run: () => go(`/problems?${listFiltersToParams({ ...EMPTY_FILTERS, tagPaths: [t.name] }).toString()}`),
        })),
      // 属性选项（例如考点树）：跳到按该选项筛选的题目列表
      ...catalog.properties
        .filter((d) => d.appliesProblem && (d.type === 'select' || d.type === 'multiselect'))
        .flatMap((d) =>
          d.options.map<Entry>((o) => ({
            id: `opt-${o.id}`,
            group: '属性',
            label: o.path,
            hint: d.name,
            icon: <Tags size={15} />,
            keywords: d.name,
            run: () => go(`/problems?${listFiltersToParams({ ...EMPTY_FILTERS, props: [{ propertyId: d.id, values: [o.id] }] }).toString()}`),
          })),
        ),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [catalog.tags, catalog.properties, students.data],
  );

  const kw = q.trim();
  const visible = staticEntries.filter((e) => matches(e, kw));
  const groups = [...new Set(visible.map((e) => e.group))];
  // 没有关键词时，标签太多会淹没常用操作
  const limited = (g: string) => visible.filter((e) => e.group === g).slice(0, kw ? 12 : g === '标签' || g === '属性' ? 0 : 20);

  return (
    <Dialog open={open} onClose={onClose} title="查找与跳转">
      <div className="-mx-5 -my-4">
        <Command shouldFilter={false} label="查找与跳转" loop>
          <Command.Input value={q} onValueChange={setQ} placeholder="输入关键词：题目、资料、标签或页面…" autoFocus data-testid="palette-input" />
          <Command.List>
            <Command.Empty>没有找到匹配的内容</Command.Empty>
            {kw ? (
              <Command.Group heading="搜索">
                <Command.Item value="search-problems" onSelect={() => go(`/problems?${new URLSearchParams({ q: kw }).toString()}`)}>
                  <Search size={15} /> 在题目中搜索“{kw}”
                </Command.Item>
              </Command.Group>
            ) : null}
            {found.problems.length ? (
              <Command.Group heading="题目">
                {found.problems.map((p) => (
                  <Command.Item key={p.id} value={`p-${p.id}`} onSelect={() => go(`/problems/${p.id}`)}>
                    <BookOpen size={15} className="flex-none" />
                    <span className="min-w-0 flex-1 truncate">{p.title ?? (p.summary || '未命名题目')}</span>
                    {p.title && p.summary ? <span className="max-w-[45%] truncate text-xs text-ink-faint">{p.summary}</span> : null}
                  </Command.Item>
                ))}
              </Command.Group>
            ) : null}
            {found.materials.length ? (
              <Command.Group heading="资料">
                {found.materials.map((m) => (
                  <Command.Item key={m.id} value={`m-${m.id}`} onSelect={() => go(`/materials/${m.id}`)}>
                    <FileText size={15} className="flex-none" />
                    <span className="min-w-0 flex-1 truncate">{m.title ?? (m.summary || '未命名资料')}</span>
                  </Command.Item>
                ))}
              </Command.Group>
            ) : null}
            {groups.map((g) =>
              limited(g).length ? (
                <Command.Group key={g} heading={g}>
                  {limited(g).map((e) => (
                    <Command.Item key={e.id} value={e.id} onSelect={e.run}>
                      {e.icon}
                      <span className="min-w-0 flex-1 truncate">{e.label}</span>
                      {e.hint ? <span className="text-xs text-ink-faint">{e.hint}</span> : null}
                    </Command.Item>
                  ))}
                </Command.Group>
              ) : null,
            )}
          </Command.List>
        </Command>
      </div>
    </Dialog>
  );
}
