/**
 * 单行查询输入框（CodeMirror）：按分词结果高亮，字段条件显示成小标签并带 × （删掉该条件）；
 * 自动补全键名与取值；下划线提示前端按缓存目录解析出的问题。
 * 输入停顿 300ms 后提交，回车立即提交；换行会被替换成空格。
 */
import { acceptCompletion, autocompletion, completionStatus } from '@codemirror/autocomplete';
import { history, historyKeymap, defaultKeymap } from '@codemirror/commands';
import { linter, type Diagnostic as CmDiagnostic } from '@codemirror/lint';
import { Annotation, EditorState, Prec } from '@codemirror/state';
import { Decoration, EditorView, keymap, placeholder as placeholderExt, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { compileText, removeRange, tokenize, type Scope } from '@shared/query';
import type { QueryContext } from '../../lib/queryText';
import { queryCompletions } from './completion';

export interface QueryInputHandle {
  focus(): void;
  /** 选中查询文本里的一段（面板里“在文本中编辑”） */
  select(from: number, to: number): void;
}

const external = Annotation.define<boolean>();

class RemoveWidget extends WidgetType {
  constructor(
    readonly from: number,
    readonly to: number,
    readonly label: string,
  ) {
    super();
  }
  override eq(o: RemoveWidget) {
    return o.from === this.from && o.to === this.to && o.label === this.label;
  }
  toDOM(view: EditorView) {
    const b = document.createElement('button');
    b.type = 'button';
    // 符号用 CSS 画出来，不算进输入框的文字
    b.className = 'cm-q-remove';
    b.setAttribute('aria-label', `删除条件 ${this.label}`);
    b.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const doc = view.state.doc.toString();
      const next = removeRange(doc, this.from, this.to);
      view.dispatch({ changes: { from: 0, to: doc.length, insert: next }, selection: { anchor: Math.min(this.from, next.length) } });
    });
    return b;
  }
  override ignoreEvent() {
    return false;
  }
}

function decorate(text: string): DecorationSet {
  const { tokens } = tokenize(text);
  const marks: { from: number; to: number; deco: Decoration }[] = [];
  tokens.forEach((t, i) => {
    switch (t.t) {
      case 'field': {
        const prev = tokens[i - 1];
        const from = prev?.t === 'neg' && prev.to === t.from ? prev.from : t.from;
        marks.push({ from: t.from, to: t.to, deco: Decoration.mark({ class: 'cm-q-chip' }) });
        marks.push({ from: t.keyFrom, to: Math.min(t.keyTo + (t.hash ? 0 : 1), t.to), deco: Decoration.mark({ class: 'cm-q-key' }) });
        marks.push({ from: t.to, to: t.to, deco: Decoration.widget({ widget: new RemoveWidget(from, t.to, text.slice(from, t.to)), side: 1 }) });
        break;
      }
      case 'or':
        marks.push({ from: t.from, to: t.to, deco: Decoration.mark({ class: 'cm-q-op' }) });
        break;
      case 'neg':
        marks.push({ from: t.from, to: t.to, deco: Decoration.mark({ class: 'cm-q-neg' }) });
        break;
      case 'lparen':
      case 'rparen':
        marks.push({ from: t.from, to: t.to, deco: Decoration.mark({ class: 'cm-q-paren' }) });
        break;
      case 'word':
        if (t.quoted) marks.push({ from: t.from, to: t.to, deco: Decoration.mark({ class: 'cm-q-phrase' }) });
        break;
    }
  });
  return Decoration.set(
    marks.map((m) => m.deco.range(m.from, m.to)),
    true,
  );
}

const highlighter = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = decorate(view.state.doc.toString());
    }
    update(u: ViewUpdate) {
      if (u.docChanged) this.decorations = decorate(u.state.doc.toString());
    }
  },
  { decorations: (v) => v.decorations },
);

/** 单行：粘贴或输入的换行替换为空格 */
const singleLine = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || tr.newDoc.lines <= 1) return tr;
  const text = tr.newDoc.toString().replace(/[\r\n]+/g, ' ');
  return [tr, { changes: { from: 0, to: tr.newDoc.length, insert: text }, sequential: true }];
});

export const QueryInput = forwardRef<
  QueryInputHandle,
  {
    value: string;
    /** immediate：回车提交（否则是停顿后的提交） */
    onChange: (value: string, immediate: boolean) => void;
    ctx: QueryContext;
    scope: Scope;
    placeholder: string;
    onArrowDown?: () => void;
  }
>(function QueryInput({ value, onChange, ctx, scope, placeholder, onArrowDown }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const cb = useRef({ onChange, onArrowDown, ctx, scope });
  cb.current = { onChange, onArrowDown, ctx, scope };
  const timer = useRef<number | null>(null);
  const lastEmitted = useRef(value);

  useImperativeHandle(ref, () => ({
    focus: () => view.current?.focus(),
    select: (from, to) => {
      const v = view.current;
      if (!v) return;
      v.focus();
      v.dispatch({ selection: { anchor: Math.min(from, v.state.doc.length), head: Math.min(to, v.state.doc.length) } });
    },
  }));

  useEffect(() => {
    const emit = (text: string, immediate: boolean) => {
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = null;
      const run = () => {
        lastEmitted.current = text;
        cb.current.onChange(text, immediate);
      };
      if (immediate) run();
      else timer.current = window.setTimeout(run, 300);
    };
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          singleLine,
          history(),
          Prec.highest(
            keymap.of([
              {
                key: 'Enter',
                run: (ed) => {
                  // 补全框打开时回车只用来选中候选；无论如何都不插入换行
                  if (completionStatus(ed.state) === 'active') {
                    acceptCompletion(ed);
                    return true;
                  }
                  emit(ed.state.doc.toString().trim(), true);
                  return true;
                },
              },
              {
                key: 'Escape',
                run: (ed) => {
                  if (completionStatus(ed.state) === 'active') return false;
                  ed.contentDOM.blur();
                  return true;
                },
              },
              {
                key: 'ArrowDown',
                run: (ed) => {
                  if (completionStatus(ed.state) === 'active' || !cb.current.onArrowDown) return false;
                  ed.contentDOM.blur();
                  cb.current.onArrowDown();
                  return true;
                },
              },
            ]),
          ),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          autocompletion({ override: [queryCompletions(() => cb.current.ctx, () => cb.current.scope)], icons: false, activateOnTyping: true, interactionDelay: 0 }),
          linter(
            (ed): CmDiagnostic[] => {
              const text = ed.state.doc.toString();
              if (!text.trim() || !cb.current.ctx.ready) return [];
              const len = text.length;
              return compileText(text, cb.current.ctx.qc, cb.current.scope).diagnostics.map((d) => {
                const from = Math.min(d.from, len);
                const to = Math.min(Math.max(d.to, from), len);
                return { from, to, severity: d.severity, message: d.suggestions?.length ? `${d.message}（${d.suggestions.slice(0, 5).join('、')}）` : d.message };
              });
            },
            { delay: 250 },
          ),
          highlighter,
          placeholderExt(placeholder),
          EditorView.contentAttributes.of({ 'data-testid': 'search-input', 'aria-label': '搜索', role: 'searchbox', spellcheck: 'false', autocapitalize: 'off' }),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged || u.transactions.some((tr) => tr.annotation(external))) return;
            emit(u.state.doc.toString().trim(), false);
          }),
        ],
      }),
    });
    view.current = v;
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
      v.destroy();
      view.current = null;
    };
    // 编辑器只创建一次；外部值的变化在下面同步
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 地址栏变化（导航点击、浏览器后退、面板修改）时同步编辑器内容
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const cur = v.state.doc.toString();
    if (value === cur.trim() || value === lastEmitted.current) return;
    lastEmitted.current = value;
    v.dispatch({ changes: { from: 0, to: cur.length, insert: value }, annotations: external.of(true), selection: { anchor: value.length } });
  }, [value]);

  // 目录加载后重新检查诊断
  useEffect(() => {
    const v = view.current;
    if (v) v.dispatch({});
  }, [ctx.ready, ctx.qc]);

  return <div ref={host} className="query-input min-w-0 flex-1" />;
});
