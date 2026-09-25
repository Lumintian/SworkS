import { useId, useState } from 'react';
import { X } from 'lucide-react';

export function TagInput({ value, onChange, suggestions }: { value: string[]; onChange: (tags: string[]) => void; suggestions: string[] }) {
  const [text, setText] = useState('');
  const listId = useId();
  const add = (raw: string) => {
    const parts = raw
      .split(/[,，、\n]/)
      .map((s) => s.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    if (parts.length === 0) return;
    const lower = new Set(value.map((v) => v.toLowerCase()));
    const next = [...value];
    for (const p of parts) {
      if (!lower.has(p.toLowerCase())) {
        next.push(p.slice(0, 60));
        lower.add(p.toLowerCase());
      }
    }
    onChange(next);
    setText('');
  };
  return (
    <div className="input flex min-h-[2.4rem] flex-wrap items-center gap-1.5 py-1.5">
      {value.map((t) => (
        <span key={t} className="chip">
          {t}
          <button type="button" aria-label={`移除标签 ${t}`} className="opacity-70 hover:opacity-100" onClick={() => onChange(value.filter((x) => x !== t))}>
            <X size={13} />
          </button>
        </span>
      ))}
      <input
        className="min-w-[8rem] flex-1 bg-transparent text-sm outline-none placeholder:text-ink-faint"
        value={text}
        list={listId}
        placeholder={value.length ? '继续添加…' : '输入标签，回车添加'}
        aria-label="添加标签"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',' || e.key === '，') {
            if (e.nativeEvent.isComposing) return;
            e.preventDefault();
            add(text);
          } else if (e.key === 'Backspace' && !text && value.length) {
            onChange(value.slice(0, -1));
          }
        }}
        onBlur={() => add(text)}
      />
      <datalist id={listId}>
        {suggestions
          .filter((s) => !value.some((v) => v.toLowerCase() === s.toLowerCase()))
          .map((s) => (
            <option key={s} value={s} />
          ))}
      </datalist>
    </div>
  );
}
