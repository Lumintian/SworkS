import { useCallback, useMemo } from 'react';
import { Download, Trash2 } from 'lucide-react';
import type { ProblemDTO, SaveResult } from '@shared/api';
import { AttributeBar } from '../components/AttributeBar';
import { BlocksEditor, useMarkdownImageUpload, type ContentIO } from '../components/BlocksEditor';
import { ChangedElsewhereBanner, ConflictDialog, RawInputsPanel, SourcesEditor } from '../components/EditorExtras';
import { ProblemLessons } from '../components/lessons/LessonBits';
import { NotesEditor } from '../components/NotesEditor';
import { SaveBar, useSaveShortcut } from '../components/SaveBar';
import { AttemptLog } from '../components/students/AttemptLog';
import { ErrorBox, Spinner, useConfirm, useToast } from '../components/ui';
import { errorMessage, sendJSON } from '../lib/api';
import { exportProblems } from '../lib/exportMarkdown';
import { cloneWithNewIds, draftAsText, emptyProblemDraft, isDraftEmpty, problemDraftFromDTO, problemPayload, type ProblemDraft } from '../lib/draft';
import { formatTime, newId } from '../lib/format';
import { Link, useLeaveGuard, useRouter } from '../lib/router';
import { invalidateWrites } from '../lib/queryClient';
import { useEntityEditor } from '../lib/useEntityEditor';
import { MarkdownAssetsContext } from '../markdown/MarkdownView';

export function ProblemEditorPage({ id, isNew }: { id: string; isNew: boolean }) {
  const { navigate } = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
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
    await ed.save();
  }, [canSave, ed]);
  useSaveShortcut(() => void doSave());

  const saveAsNew = async () => {
    const nid = newId();
    try {
      await sendJSON<SaveResult<ProblemDTO>>('POST', '/api/problems', { id: nid, ...problemPayload(cloneWithNewIds(draft)) });
      invalidateWrites({ problems: [nid] });
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
                  const r = await exportProblems([id]);
                  toast(r.message, r.tone);
                }}
              >
                <Download size={15} /> 导出
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm hover:!text-terracotta"
                onClick={async () => {
                  if (!(await confirm({ title: '移到回收站', message: '把这道题移到回收站？之后可以在回收站恢复。', confirmLabel: '移到回收站', danger: true }))) return;
                  try {
                    await sendJSON('DELETE', `/api/problems/${id}`);
                  invalidateWrites({ problems: [id] });
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

      {ed.changedElsewhere ? <ChangedElsewhereBanner noun="道题" onReload={() => void ed.reload()} /> : null}
      {deleted ? (
        <div className="mb-4">
          <ErrorBox message="这道题在回收站中，恢复后才能编辑。" />
          <button
            type="button"
            className="btn btn-sage mt-2"
            onClick={async () => {
              await sendJSON('POST', `/api/problems/${id}/restore`);
              invalidateWrites({ problems: [id] });
              await ed.reload();
              toast('已恢复', 'success');
            }}
          >
            恢复这道题
          </button>
        </div>
      ) : null}

      <div className="space-y-8" inert={deleted || undefined}>
        <AttributeBar draft={draft} setDraft={setDraft} kind="problems" titlePlaceholder="标题（可选，留空也能保存）" />

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
            笔记 · 解析 · 答案
          </h2>
          <MarkdownAssetsContext.Provider value={{ remoteImageUrls: ed.refs.remoteImageUrls, remoteImages: ed.refs.remoteImages }}>
            <NotesEditor notes={draft.notes} onChange={(u) => setDraft((d) => ({ ...d, notes: u(d.notes) }))} onImageFiles={uploadMd} />
          </MarkdownAssetsContext.Provider>
        </section>

        <section aria-labelledby="attempts-h" className="space-y-3">
          <h2 id="attempts-h" className="text-lg font-semibold text-stone">
            作答记录
          </h2>
          <AttemptLog problemId={id} disabled={ed.isNew() || !entity} />
        </section>

        <ProblemLessons problemId={id} enabled={!ed.isNew() && entity !== null} />

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
