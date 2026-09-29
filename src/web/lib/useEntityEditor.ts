/**
 * 题目/资料编辑页的共用状态：加载、草稿、未保存判断、保存（版本条件更新）、冲突、远程图片状态轮询。
 * 只有服务端返回成功才显示“已保存”；失败时草稿保持不变，可重试或复制。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RemoteImageDTO, SaveResult } from '@shared/api';
import { ApiError, errorMessage, getJSON, sendJSON } from './api';
import { onWrite, TAB_ID } from './broadcast';
import { mergeRefs, emptyRefs, type Refs } from './draft';
import { invalidateWrites } from './queryClient';

export type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved'; at: Date }
  | { kind: 'error'; message: string; code: string };

interface EntityBase extends Refs {
  id: string;
  version: number;
  deletedAt: string | null;
}

export interface EntityEditorOptions<D, E extends EntityBase> {
  collection: 'problems' | 'materials';
  id: string;
  isNew: boolean;
  empty: () => D;
  fromEntity: (e: E) => D;
  toPayload: (d: D) => object;
  onCreated?: (e: E) => void;
}

export function useEntityEditor<D, E extends EntityBase>(opts: EntityEditorOptions<D, E>) {
  const { collection, id } = opts;
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>(opts.isNew ? 'ready' : 'loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [entity, setEntity] = useState<E | null>(null);
  const [draft, setDraftState] = useState<D>(() => opts.empty());
  const [savedKey, setSavedKey] = useState<string | null>(() => (opts.isNew ? null : ''));
  const [refs, setRefs] = useState<Refs>(emptyRefs);
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' });
  const [conflict, setConflict] = useState<{ currentVersion?: number; message: string } | null>(null);
  /** 其他页面修改了这个对象，而本页还有未保存的修改（保存时会冲突） */
  const [changedElsewhere, setChangedElsewhere] = useState(false);

  const draftRef = useRef(draft);
  draftRef.current = draft;
  const versionRef = useRef<number | null>(null);
  const isNewRef = useRef(opts.isNew);
  const rawInputIds = useRef<string[]>([]);
  const saving = useRef(false);

  const applyEntity = useCallback((e: E, resetDraft: boolean) => {
    const o = optsRef.current;
    setEntity(e);
    versionRef.current = e.version;
    setRefs((r) => mergeRefs(r, e));
    const fromServer = o.fromEntity(e);
    setSavedKey(JSON.stringify(o.toPayload(fromServer)));
    if (resetDraft) setDraftState(fromServer);
  }, []);

  const load = useCallback(async () => {
    setPhase('loading');
    setLoadError(null);
    try {
      const e = await getJSON<E>(`/api/${collection}/${id}`);
      applyEntity(e, true);
      isNewRef.current = false;
      setPhase('ready');
    } catch (err) {
      setLoadError(err instanceof ApiError && err.status === 404 ? '对象不存在，可能 ID 有误' : errorMessage(err));
      setPhase('error');
    }
  }, [applyEntity, collection, id]);

  useEffect(() => {
    if (!optsRef.current.isNew) void load();
  }, [load]);

  const setDraft = useCallback((update: (d: D) => D) => setDraftState((d) => update(d)), []);

  const dirty = useMemo(() => {
    const key = JSON.stringify(opts.toPayload(draft));
    if (savedKey === null) {
      // 新建：与空草稿比较
      return key !== JSON.stringify(opts.toPayload(opts.empty()));
    }
    return key !== savedKey;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, savedKey]);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const save = useCallback(async (): Promise<boolean> => {
    if (saving.current) return false;
    saving.current = true;
    setSaveState({ kind: 'saving' });
    const o = optsRef.current;
    const payload = o.toPayload(draftRef.current);
    const sentRaw = [...rawInputIds.current];
    try {
      let res: SaveResult<E>;
      if (isNewRef.current) {
        res = await sendJSON<SaveResult<E>>('POST', `/api/${collection}`, { id, ...payload, rawInputIds: sentRaw });
      } else {
        res = await sendJSON<SaveResult<E>>('PUT', `/api/${collection}/${id}`, {
          ...payload,
          rawInputIds: sentRaw,
          expectedVersion: versionRef.current,
        });
      }
      rawInputIds.current = rawInputIds.current.filter((x) => !sentRaw.includes(x));
      const wasNew = isNewRef.current;
      isNewRef.current = false;
      applyEntity(res.entity, false);
      setConflict(null);
      setChangedElsewhere(false);
      setSaveState({ kind: 'saved', at: new Date() });
      if (res.changed || wasNew) invalidateWrites({ [collection]: [id] });
      if (wasNew) o.onCreated?.(res.entity);
      return true;
    } catch (err) {
      const e = err instanceof ApiError ? err : new ApiError('UNKNOWN', errorMessage(err), 0);
      setSaveState({ kind: 'error', message: e.message, code: e.code });
      if (e.code === 'CONFLICT') {
        const details = e.details as { currentVersion?: number } | undefined;
        setConflict({ message: e.message, ...(details?.currentVersion !== undefined ? { currentVersion: details.currentVersion } : {}) });
      }
      return false;
    } finally {
      saving.current = false;
    }
  }, [applyEntity, collection, id]);

  const addRawInput = useCallback((rawId: string) => {
    rawInputIds.current.push(rawId);
  }, []);

  const addRefs = useCallback((r: Partial<Refs>) => setRefs((cur) => mergeRefs(cur, r)), []);

  const updateRemote = useCallback((remote: RemoteImageDTO) => {
    setRefs((cur) => mergeRefs(cur, { remoteImages: { [remote.id]: remote }, remoteImageUrls: { [remote.url]: remote.id } }));
  }, []);

  // 轮询尚在归档中的远程图片
  const pendingIds = useMemo(
    () => Object.values(refs.remoteImages).filter((r) => r.status === 'pending').map((r) => r.id).sort().join(','),
    [refs.remoteImages],
  );
  useEffect(() => {
    if (!pendingIds) return;
    const timer = window.setTimeout(async () => {
      for (const rid of pendingIds.split(',')) {
        try {
          const r = await getJSON<RemoteImageDTO>(`/api/remote-images/${rid}`);
          updateRemote(r);
          if (r.assetId) {
            const e = await getJSON<E>(`/api/${collection}/${id}`).catch(() => null);
            if (e) setRefs((cur) => mergeRefs(cur, e));
          }
        } catch {
          // 忽略，下次再试
        }
      }
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [pendingIds, updateRemote, collection, id]);

  const reload = useCallback(async () => {
    rawInputIds.current = [];
    setConflict(null);
    setChangedElsewhere(false);
    setSaveState({ kind: 'idle' });
    await load();
  }, [load]);

  // 其他标签页的写入：没有未保存修改时静默刷新；有未保存修改时提示，而不是等到保存时才冲突
  useEffect(
    () =>
      onWrite((ev, fromOtherTab) => {
        if (!fromOtherTab || isNewRef.current || saving.current) return;
        const scoped = ev.problems !== undefined || ev.materials !== undefined;
        if (scoped && !(ev[collection] ?? []).includes(id)) return;
        // 服务端事件：本页自己保存的、或版本与本页一致（只重建了检索投影）的，不用重新读取
        if (ev.originClient === TAB_ID || ev.versions?.[id] === versionRef.current) return;
        void getJSON<E>(`/api/${collection}/${id}`).then(
          (e) => {
            if (e.version === versionRef.current) return;
            if (dirtyRef.current) setChangedElsewhere(true);
            else applyEntity(e, true);
          },
          () => undefined,
        );
      }),
    [applyEntity, collection, id],
  );

  return {
    phase,
    loadError,
    entity,
    draft,
    setDraft,
    dirty,
    dirtyRef,
    save,
    saveState,
    conflict,
    changedElsewhere,
    dismissConflict: () => setConflict(null),
    reload,
    refs,
    addRefs,
    updateRemote,
    addRawInput,
    isNew: () => isNewRef.current,
    version: () => versionRef.current,
  };
}

export type EntityEditor<D, E extends EntityBase> = ReturnType<typeof useEntityEditor<D, E>>;
