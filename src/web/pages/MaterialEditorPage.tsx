import { useCallback, useMemo, useState } from 'react';
import { ListChecks, Trash2 } from 'lucide-react';
import type { MaterialDTO, ProblemDTO, SaveResult } from '@shared/api';
import type { MaterialStatus } from '@shared/constants';
import { AttributeBar } from '../components/AttributeBar';
import { BlocksEditor, type ContentIO } from '../components/BlocksEditor';
import { ChangedElsewhereBanner, ConflictDialog, RawInputsPanel } from '../components/EditorExtras';
import { SaveBar, useSaveShortcut } from '../components/SaveBar';
import { ErrorBox, Spinner, useConfirm, useToast } from '../components/ui';
import { errorMessage, sendJSON } from '../lib/api';
import { cloneWithNewIds, draftAsText, emptyMaterialDraft, isDraftEmpty, materialDraftFromDTO, materialPayload, type MaterialDraft } from '../lib/draft';
import { formatTime, newId } from '../lib/format';
import { Link, useLeaveGuard, useRouter } from '../lib/router';
import { invalidateWrites } from '../lib/queryClient';
import { useEntityEditor } from '../lib/useEntityEditor';

export function MaterialEditorPage({ id, isNew, initialStatus }: { id: string; isNew: boolean; initialStatus: MaterialStatus }) {
  const { navigate } = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const ed = useEntityEditor<MaterialDraft, MaterialDTO>({
    collection: 'materials',
    id,
    isNew,
    empty: () => emptyMaterialDraft(initialStatus),
    fromEntity: materialDraftFromDTO,
    toPayload: materialPayload,
    onCreated: (e) => navigate(`/materials/${e.id}`, { replace: true, force: true }),
  });
  const { draft, setDraft } = ed;
  useLeaveGuard(() => ed.dirtyRef.current);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [markActive, setMarkActive] = useState(true);

  const io: ContentIO = useMemo(
    () => ({ refs: ed.refs, addRefs: ed.addRefs, updateRemote: ed.updateRemote, addRawInput: ed.addRawInput }),
    [ed.refs, ed.addRefs, ed.updateRemote, ed.addRawInput],
  );
  const canSave = ed.phase === 'ready' && (ed.dirty || ed.saveState.kind === 'error') && !(ed.isNew() && isDraftEmpty(draft));
  const doSave = useCallback(async () => {
    if (!canSave) return;
    await ed.save();
  }, [canSave, ed]);
  useSaveShortcut(() => void doSave());

  if (ed.phase === 'loading') return <Spinner />;
  if (ed.phase === 'error') return <ErrorBox message={ed.loadError ?? '加载失败'} onRetry={() => void ed.reload()} />;
  const entity = ed.entity;
  const deleted = Boolean(entity?.deletedAt);

  const derive = async () => {
    if (ed.dirty) {
      toast('请先保存资料，再从中建立题目', 'warn');
      return;
    }
    const pid = newId();
    try {
      // 保持资料中的顺序
      const blockIds = draft.blocks.filter((b) => selected.has(b.id)).map((b) => b.id);
      await sendJSON<SaveResult<ProblemDTO>>('POST', `/api/materials/${id}/derive`, { problemId: pid, blockIds, markMaterialActive: markActive });
      invalidateWrites({ problems: [pid], materials: [id] });
      toast('已从资料建立题目，资料本身保持不变', 'success');
      navigate(`/problems/${pid}`, { force: true });
    } catch (err) {
      toast(`建题失败：${errorMessage(err)}`, 'error');
    }
  };

  return (
    <div data-testid="material-editor">
      <SaveBar
        title={
          <span>
            <Link to="/materials" className="hover:text-stone">
              资料
            </Link>{' '}
            / <span className={draft.title.trim() ? 'text-ink' : 'italic'}>{ed.isNew() ? '收一份资料' : draft.title.trim() || '未命名资料'}</span>
            {entity ? <span className="ml-3 hidden text-xs text-ink-faint lg:inline">添加于 {formatTime(entity.createdAt)} · 修改于 {formatTime(entity.updatedAt)}</span> : null}
          </span>
        }
        state={ed.saveState}
        dirty={ed.dirty}
        canSave={canSave && !deleted}
        onSave={() => void doSave()}
        actions={
          !ed.isNew() && entity && !deleted ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm hover:!text-terracotta"
              onClick={async () => {
                if (!(await confirm({ title: '移到回收站', message: '把这份资料移到回收站？由它建立的题目不受影响。', confirmLabel: '移到回收站', danger: true }))) return;
                try {
                  await sendJSON('DELETE', `/api/materials/${id}`);
                  invalidateWrites({ materials: [id] });
                  toast('已移到回收站', 'info');
                  navigate('/materials', { force: true });
                } catch (err) {
                  toast(errorMessage(err), 'error');
                }
              }}
            >
              <Trash2 size={15} /> 删除
            </button>
          ) : null
        }
      />
      {ed.changedElsewhere ? <ChangedElsewhereBanner noun="份资料" onReload={() => void ed.reload()} /> : null}
      {deleted ? (
        <div className="mb-4">
          <ErrorBox message="这份资料在回收站中，恢复后才能编辑。" />
          <button
            type="button"
            className="btn btn-sage mt-2"
            onClick={async () => {
              await sendJSON('POST', `/api/materials/${id}/restore`);
              invalidateWrites({ materials: [id] });
              await ed.reload();
            }}
          >
            恢复这份资料
          </button>
        </div>
      ) : null}
      <div className="space-y-8" inert={deleted || undefined}>
        <AttributeBar
          draft={draft}
          setDraft={setDraft}
          titlePlaceholder="资料标题（可选）"
          kind="materials"
          status={draft.status}
          onStatus={(s) => setDraft((d) => ({ ...d, status: s }))}
        />
        <section aria-labelledby="m-content-h" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="m-content-h" className="text-lg font-semibold text-stone">
              资料内容
            </h2>
            {!ed.isNew() && draft.blocks.length > 0 ? (
              <button
                type="button"
                className={`btn btn-sm ${selecting ? 'btn-sage' : ''}`}
                aria-pressed={selecting}
                onClick={() => {
                  setSelecting((v) => !v);
                  setSelected(new Set());
                }}
              >
                <ListChecks size={15} /> {selecting ? '取消建题' : '从资料建题'}
              </button>
            ) : null}
          </div>
          {selecting ? (
            <div className="card-flat flex flex-wrap items-center gap-3 bg-sage-soft px-4 py-3 text-sm">
              <span>勾选要复制到新题目的内容块（完整复制，保留来源关系；之后两边各自编辑）。已选 {selected.size} 块。</span>
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={markActive} onChange={(e) => setMarkActive(e.target.checked)} className="accent-[var(--color-sage-deep)]" />
                同时标记资料为“已整理”
              </label>
              <button type="button" className="btn btn-primary btn-sm ml-auto" disabled={selected.size === 0} onClick={() => void derive()}>
                用所选内容建题
              </button>
            </div>
          ) : null}
          <BlocksEditor
            blocks={draft.blocks}
            onChange={(u) => setDraft((d) => ({ ...d, blocks: u(d.blocks) }))}
            io={io}
            captureGlobalPaste
            selectable={selecting}
            selected={selected}
            onToggleSelect={(bid) =>
              setSelected((s) => {
                const n = new Set(s);
                if (n.has(bid)) n.delete(bid);
                else n.add(bid);
                return n;
              })
            }
            emptyHint="资料可以是一组截图、专题摘录或文字材料；不必拆成题目也能独立保存和搜索。"
          />
        </section>
        {entity && entity.derivedProblems.length > 0 ? (
          <section aria-labelledby="derived-h" className="space-y-2">
            <h2 id="derived-h" className="text-lg font-semibold text-stone">
              由此资料建立的题目
            </h2>
            <ul className="space-y-1 text-sm">
              {entity.derivedProblems.map((p) => (
                <li key={p.problemId}>
                  <Link to={`/problems/${p.problemId}`} className="link-btn">
                    {p.title ?? '未命名题目'}
                  </Link>
                  <span className="ml-2 text-xs text-ink-faint">{formatTime(p.createdAt)}</span>
                  {p.deleted ? <span className="chip chip-warn ml-2">在回收站</span> : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {entity ? <RawInputsPanel items={entity.rawInputs} /> : null}
      </div>
      <ConflictDialog
        open={ed.conflict !== null}
        message={ed.conflict?.message ?? ''}
        noun="资料"
        onClose={ed.dismissConflict}
        onReload={() => void ed.reload()}
        onSaveAsNew={async () => {
          const nid = newId();
          try {
            await sendJSON('POST', '/api/materials', { id: nid, ...materialPayload(cloneWithNewIds(draft)) });
            invalidateWrites({ materials: [nid] });
            navigate(`/materials/${nid}`, { force: true });
          } catch (err) {
            toast(errorMessage(err), 'error');
          }
        }}
        onCopy={() => void navigator.clipboard.writeText(draftAsText(draft)).then(() => toast('已复制到剪贴板', 'success'))}
      />
    </div>
  );
}
