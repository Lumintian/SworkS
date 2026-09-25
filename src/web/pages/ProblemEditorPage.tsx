import { useCallback, useMemo } from 'react';
import { Download, Trash2 } from 'lucide-react';
import type { ProblemDTO, SaveResult } from '@shared/api';
import { AttributeBar } from '../components/AttributeBar';
import { BlocksEditor, useMarkdownImageUpload, type ContentIO } from '../components/BlocksEditor';
import { ConflictDialog, RawInputsPanel, SourcesEditor } from '../components/EditorExtras';
import { NotesEditor } from '../components/NotesEditor';
import { SaveBar, useSaveShortcut } from '../components/SaveBar';
import { ErrorBox, Spinner, useToast } from '../components/ui';
import { errorMessage, postForBlob, saveBlob, sendJSON } from '../lib/api';
import { cloneWithNewIds, draftAsText, emptyProblemDraft, isDraftEmpty, problemDraftFromDTO, problemPayload, type ProblemDraft } from '../lib/draft';
import { formatTime, newId } from '../lib/format';
import { Link, useLeaveGuard, useRouter } from '../lib/router';
import { refreshCatalog } from '../lib/useCatalog';
import { useEntityEditor } from '../lib/useEntityEditor';
import { MarkdownAssetsContext } from '../markdown/MarkdownView';

export function ProblemEditorPage({ id, isNew }: { id: string; isNew: boolean }) {
  const { navigate } = useRouter();
  const toast = useToast();
  const ed = useEntityEditor<ProblemDraft, ProblemDTO>({
    collection: 'problems',
    id,
    isNew,
    empty: emptyProblemDraft,
    fromEntity: problemDraftFromDTO,
    toPayload: problemPayload,
    onCreated: (e) => navigate(`/problems/${e.id}`, { replace: true, force: true }),
  });
  const { draft, setDraft } = ed;
  useLeaveGuard(() => ed.dirtyRef.current);

  const io: ContentIO = useMemo(
    () => ({ refs: ed.refs, addRefs: ed.addRefs, updateRemote: ed.updateRemote, addRawInput: ed.addRawInput }),
    [ed.refs, ed.addRefs, ed.updateRemote, ed.addRawInput],
  );
  const uploadMd = useMarkdownImageUpload(io);

  const canSave = ed.phase === 'ready' && (ed.dirty || ed.saveState.kind === 'error') && !(ed.isNew() && isDraftEmpty(draft));
  const doSave = useCallback(async () => {
    if (!canSave) return;
    const ok = await ed.save();
    if (ok) void refreshCatalog();
  }, [canSave, ed]);
  useSaveShortcut(() => void doSave());

  const saveAsNew = async () => {
    const nid = newId();
    try {
      await sendJSON<SaveResult<ProblemDTO>>('POST', '/api/problems', { id: nid, ...problemPayload(cloneWithNewIds(draft)) });
      toast('已另存为新题目', 'success');
      navigate(`/problems/${nid}`, { force: true });
    } catch (err) {
      toast(`另存失败：${errorMessage(err)}`, 'error');
    }
  };

  if (ed.phase === 'loading') return <Spinner />;
  if (ed.phase === 'error') return <ErrorBox message={ed.loadError ?? '加载失败'} onRetry={() => void ed.reload()} />;

  const entity = ed.entity;
  const deleted = Boolean(entity?.deletedAt);
  const heading = draft.title.trim() || '未命名题目';

  return (
    <div data-testid="problem-editor">
      <SaveBar
        title={
          <span>
            <Link to="/problems" className="hover:text-stone">
              题目
            </Link>{' '}
            / <span className={draft.title.trim() ? 'text-ink' : 'italic'}>{ed.isNew() ? '收一道题' : heading}</span>
            {entity ? <span className="ml-3 hidden text-xs text-ink-faint lg:inline">添加于 {formatTime(entity.createdAt)} · 修改于 {formatTime(entity.updatedAt)}</span> : null}
          </span>
        }
        state={ed.saveState}
        dirty={ed.dirty}
        canSave={canSave && !deleted}
        onSave={() => void doSave()}
        actions={
          !ed.isNew() && entity && !deleted ? (
            <>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                title={ed.dirty ? '导出的是已保存的版本' : '导出为 Markdown'}
                onClick={async () => {
                  try {
                    const r = await postForBlob('/api/export/markdown', { problemIds: [id] });
                    saveBlob(r.blob, r.fileName);
                    const w = Number(r.headers.get('x-sworks-export-warnings') ?? 0);
                    toast(w > 0 ? `已导出，但有 ${w} 条警告（见压缩包内 README）` : '已导出 Markdown', w > 0 ? 'warn' : 'success');
                  } catch (err) {
                    toast(errorMessage(err), 'error');
                  }
                }}
              >
                <Download size={15} /> 导出
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm hover:!text-terracotta"
                onClick={async () => {
                  if (!window.confirm('把这道题移到回收站？之后可以在回收站恢复。')) return;
                  try {
                    await sendJSON('DELETE', `/api/problems/${id}`);
                    toast('已移到回收站', 'info');
                    navigate('/problems', { force: true });
                  } catch (err) {
                    toast(errorMessage(err), 'error');
                  }
                }}
              >
                <Trash2 size={15} /> 删除
              </button>
            </>
          ) : null
        }
      />

      {deleted ? (
        <div className="mb-4">
          <ErrorBox message="这道题在回收站中，恢复后才能编辑。" />
          <button
            type="button"
            className="btn btn-sage mt-2"
            onClick={async () => {
              await sendJSON('POST', `/api/problems/${id}/restore`);
              await ed.reload();
              toast('已恢复', 'success');
            }}
          >
            恢复这道题
          </button>
        </div>
      ) : null}

      <div className="space-y-8" inert={deleted || undefined}>
        <AttributeBar draft={draft} setDraft={setDraft} titlePlaceholder="标题（可选，留空也能保存）" />

        <section aria-labelledby="content-h" className="space-y-3">
          <h2 id="content-h" className="text-lg font-semibold text-stone">
            题目内容
          </h2>
          <BlocksEditor
            blocks={draft.blocks}
            onChange={(u) => setDraft((d) => ({ ...d, blocks: u(d.blocks) }))}
            io={io}
            captureGlobalPaste
            emptyHint="粘贴一张截图即可开始；也可以添加 Markdown、普通文字、图片或图片 URL，并按需调整顺序。"
          />
        </section>

        <section aria-labelledby="notes-h" className="space-y-3">
          <h2 id="notes-h" className="text-lg font-semibold text-stone">
            笔记 · 答案 · 解析
          </h2>
          <MarkdownAssetsContext.Provider value={{ remoteImageUrls: ed.refs.remoteImageUrls, remoteImages: ed.refs.remoteImages }}>
            <NotesEditor notes={draft.notes} onChange={(u) => setDraft((d) => ({ ...d, notes: u(d.notes) }))} onImageFiles={uploadMd} />
          </MarkdownAssetsContext.Provider>
        </section>

        <section aria-labelledby="sources-h" className="space-y-3">
          <h2 id="sources-h" className="text-lg font-semibold text-stone">
            来源资料
          </h2>
          <SourcesEditor sources={draft.sources} onChange={(u) => setDraft((d) => ({ ...d, sources: u(d.sources) }))} />
        </section>

        {entity ? <RawInputsPanel items={entity.rawInputs} /> : null}
      </div>

      <ConflictDialog
        open={ed.conflict !== null}
        message={ed.conflict?.message ?? ''}
        noun="题目"
        onClose={ed.dismissConflict}
        onReload={() => void ed.reload()}
        onSaveAsNew={() => void saveAsNew()}
        onCopy={() => {
          void navigator.clipboard.writeText(draftAsText(draft)).then(
            () => toast('已复制到剪贴板', 'success'),
            () => toast('复制失败，请手动选择内容复制', 'error'),
          );
        }}
      />
    </div>
  );
}
