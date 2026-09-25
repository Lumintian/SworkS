/** CodeMirror 6 Markdown 源码编辑器。源码是权威内容，编辑器不做任何自动重排。 */
import { useEffect, useRef } from 'react';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, placeholder as placeholderExt } from '@codemirror/view';
import { tags } from '@lezer/highlight';

const earthHighlight = HighlightStyle.define([
  { tag: tags.heading, color: '#5c4033', fontWeight: '700' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.link, color: '#8f5f2e' },
  { tag: tags.url, color: '#8f7a69' },
  { tag: tags.monospace, color: '#56673f' },
  { tag: tags.quote, color: '#6a5546' },
  { tag: tags.processingInstruction, color: '#9a6b22' },
  { tag: tags.meta, color: '#8f7a69' },
  { tag: tags.list, color: '#8f5f2e' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
]);

export interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel: string;
  autoFocus?: boolean;
  minHeight?: string;
  /** 粘贴/拖入图片：返回要插入的 Markdown 片段（上传失败时抛错，由调用方提示）。 */
  onImageFiles?: (files: File[]) => Promise<string>;
}

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

function imageFiles(list: FileList | null | undefined): File[] {
  return Array.from(list ?? []).filter((f) => f.type.startsWith('image/'));
}

export function CodeEditor({ value, onChange, placeholder, ariaLabel, autoFocus, minHeight = '8rem', onImageFiles }: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onImagesRef = useRef(onImageFiles);
  onChangeRef.current = onChange;
  onImagesRef.current = onImageFiles;

  useEffect(() => {
    const insertImages = (v: EditorView, files: File[], pos?: number) => {
      const handler = onImagesRef.current;
      if (!handler) return false;
      const supported = files.filter((f) => IMAGE_TYPES.has(f.type));
      if (supported.length === 0 && files.length > 0) {
        // 交给调用方提示不支持的格式
        void handler(files).catch(() => undefined);
        return true;
      }
      const at = pos ?? v.state.selection.main.head;
      handler(supported).then(
        (snippet) => {
          if (!snippet || !view.current) return;
          const cur = view.current;
          const insertAt = Math.min(at, cur.state.doc.length);
          cur.dispatch({ changes: { from: insertAt, insert: snippet }, selection: { anchor: insertAt + snippet.length } });
        },
        () => undefined,
      );
      return true;
    };
    const state = EditorState.create({
      doc: value,
      extensions: [
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        markdown({ base: markdownLanguage }),
        syntaxHighlighting(earthHighlight),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ 'aria-label': ariaLabel, spellcheck: 'false' }),
        placeholderExt(placeholder ?? ''),
        EditorView.theme({ '&': { minHeight }, '.cm-scroller': { minHeight } }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChangeRef.current(u.state.doc.toString());
        }),
        EditorView.domEventHandlers({
          paste: (e, v) => {
            const files = imageFiles(e.clipboardData?.files);
            if (files.length === 0) return false;
            e.preventDefault();
            return insertImages(v, files);
          },
          drop: (e, v) => {
            const files = imageFiles(e.dataTransfer?.files);
            if (files.length === 0) return false;
            e.preventDefault();
            const pos = v.posAtCoords({ x: e.clientX, y: e.clientY }) ?? undefined;
            return insertImages(v, files, pos);
          },
        }),
      ],
    });
    const v = new EditorView({ state, parent: host.current! });
    view.current = v;
    if (autoFocus) v.focus();
    return () => {
      v.destroy();
      view.current = null;
    };
    // 仅在挂载时创建编辑器；外部值变化见下方同步逻辑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 外部替换内容（如重新加载）时同步到编辑器；正常输入时两者一致，不产生额外事务
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const cur = v.state.doc.toString();
    if (cur !== value) v.dispatch({ changes: { from: 0, to: cur.length, insert: value } });
  }, [value]);

  return <div ref={host} className="min-w-0" data-testid="code-editor" />;
}
