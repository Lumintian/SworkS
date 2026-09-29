import { describe, expect, it } from 'vitest';
import {
  compileText,
  conditionRows,
  navSelection,
  normalizeWithMap,
  normText,
  parseQuery,
  serializeQuery,
  setFieldCondition,
  specBounds,
  termRange,
  toOriginalRange,
  tokenize,
  type Q,
  type QueryCatalog,
} from '../../src/shared/query/index.js';

const ids = {
  qt: '11111111-1111-4111-8111-111111111111',
  diff: '22222222-2222-4222-8222-222222222222',
  year: '33333333-3333-4333-8333-333333333333',
  flag: '44444444-4444-4444-8444-444444444444',
  memo: '55555555-5555-4555-8555-555555555555',
  when: '66666666-6666-4666-8666-666666666666',
  titleProp: '77777777-7777-4777-8777-777777777777',
  s1: 'aaaa1111-0000-4000-8000-000000000001',
  s2: 'bbbb2222-0000-4000-8000-000000000002',
  s3: 'cccc3333-0000-4000-8000-000000000003',
};
const opt = (id: string, path: string, parentId: string | null = null) => ({ id, path, parentId });
const catalog: QueryCatalog = {
  properties: [
    {
      id: ids.qt,
      name: '题型',
      type: 'select',
      nested: true,
      appliesProblem: true,
      appliesMaterial: false,
      options: [opt('o-fill', '填空'), opt('o-en', '英语'), opt('o-cloze', '英语/完型填空', 'o-en'), opt('o-ensel', '英语/选择', 'o-en'), opt('o-gen', '通用'), opt('o-gensel', '通用/选择', 'o-gen')],
    },
    {
      id: ids.diff,
      name: '难度',
      type: 'select',
      nested: false,
      appliesProblem: true,
      appliesMaterial: true,
      options: [opt('d1', '容易'), opt('d2', '较易'), opt('d3', '中档'), opt('d4', '较难'), opt('d5', '困难')],
    },
    { id: ids.year, name: '年份', type: 'number', nested: false, appliesProblem: true, appliesMaterial: true, options: [] },
    { id: ids.flag, name: '重点', type: 'checkbox', nested: false, appliesProblem: true, appliesMaterial: true, options: [] },
    { id: ids.memo, name: '出处 说明', type: 'text', nested: false, appliesProblem: true, appliesMaterial: true, options: [] },
    { id: ids.when, name: '考试日期', type: 'date', nested: false, appliesProblem: true, appliesMaterial: true, options: [] },
    { id: ids.titleProp, name: '标题', type: 'text', nested: false, appliesProblem: true, appliesMaterial: true, options: [] },
  ],
  students: [
    { id: ids.s1, name: '小明' },
    { id: ids.s2, name: '小红' },
    { id: ids.s3, name: '小红' },
  ],
};
const run = (src: string, scope: 'problem' | 'material' = 'problem') => compileText(src, catalog, scope);
const errors = (src: string) => run(src).diagnostics.filter((d) => d.severity === 'error');

describe('规范化', () => {
  it('NFKC + 小写 + 折叠空白，并能把区间映射回原文', () => {
    expect(normText('  ＡＢＣ\n　 函数　f(x) ')).toBe('abc 函数 f(x)');
    const src = 'Ｆ（ｘ）\n\n的 最小值';
    const m = normalizeWithMap(src);
    expect(m.norm).toBe('f(x) 的 最小值');
    const at = m.norm.indexOf('最小值');
    const [a, b] = toOriginalRange(m, at, at + 3);
    expect(src.slice(a, b)).toBe('最小值');
    const [c, d] = toOriginalRange(m, 0, 4);
    expect(src.slice(c, d)).toBe('Ｆ（ｘ）');
  });
});

describe('分词与语法', () => {
  it('全角符号：冒号、括号、引号、取反与竖线', () => {
    const r = parseQuery('标签：函数 －题型：填空 （a ｜ b） “二次 函数”');
    expect(r.diagnostics).toEqual([]);
    expect(r.ast).toMatchObject({
      type: 'and',
      items: [
        { type: 'field', key: '标签' },
        { type: 'not', item: { type: 'field', key: '题型' } },
        { type: 'or', items: [{ type: 'text', value: 'a' }, { type: 'text', value: 'b' }] },
        { type: 'text', value: '二次 函数', phrase: true },
      ],
    });
  });

  it('f(x)、sin(2x)、(f(x) OR g) 与 URL、10:30 按字面处理', () => {
    expect(parseQuery('f(x)').ast).toMatchObject({ type: 'text', value: 'f(x)' });
    expect(parseQuery('sin(2x)+1').ast).toMatchObject({ type: 'text', value: 'sin(2x)+1' });
    expect(parseQuery('(f(x) OR g)').ast).toMatchObject({ type: 'or', items: [{ value: 'f(x)' }, { value: 'g' }] });
    expect(parseQuery('https://example.com/a.png').ast).toMatchObject({ type: 'text', value: 'https://example.com/a.png' });
    expect(parseQuery('10:30').ast).toMatchObject({ type: 'text', value: '10:30' });
    expect(parseQuery('a)').ast).toMatchObject({ type: 'text', value: 'a)' });
  });

  it('优先级：取反 > OR > 空格', () => {
    expect(parseQuery('a b OR c').ast).toMatchObject({ type: 'and', items: [{ value: 'a' }, { type: 'or', items: [{ value: 'b' }, { value: 'c' }] }] });
    expect(parseQuery('-a OR b').ast).toMatchObject({ type: 'or', items: [{ type: 'not', item: { value: 'a' } }, { value: 'b' }] });
    expect(parseQuery('-(a b)').ast).toMatchObject({ type: 'not', item: { type: 'and' } });
    expect(parseQuery('- a').ast).toMatchObject({ type: 'and', items: [{ value: '-' }, { value: 'a' }] });
  });

  it('引号转义、未闭合引号、#路径、带空格的属性名', () => {
    expect(parseQuery('"say \\"hi\\" \\\\"').ast).toMatchObject({ type: 'text', value: 'say "hi" \\', phrase: true });
    const open = parseQuery('"没有闭合');
    expect(open.ast).toMatchObject({ type: 'text', value: '没有闭合' });
    expect(open.diagnostics[0]?.message).toContain('引号');
    expect(parseQuery('#方法/换元').ast).toMatchObject({ type: 'field', hash: true, values: [{ text: '方法/换元' }] });
    expect(parseQuery('"出处 说明":课本').ast).toMatchObject({ type: 'field', key: '出处 说明', values: [{ text: '课本' }] });
    expect(parseQuery('标签:"a b"').ast).toMatchObject({ type: 'field', values: [{ text: 'a b', quoted: true }] });
  });

  it('比较符、区间与列表', () => {
    expect(parseQuery('难度:>=较难').ast).toMatchObject({ op: '>=', values: [{ text: '较难' }] });
    expect(parseQuery('难度:≥较难').ast).toMatchObject({ op: '>=' });
    expect(parseQuery('年份:2020..2024').ast).toMatchObject({ range: { lo: { text: '2020' }, hi: { text: '2024' } } });
    expect(parseQuery('学科:数学，物理').ast).toMatchObject({ values: [{ text: '数学' }, { text: '物理' }] });
  });

  it('错误恢复：悬空 OR、括号不配、空值、空括号都给出警告而不是失败', () => {
    for (const src of ['OR a', 'a OR', 'a OR OR b', '(a b', '标签:', '()', '-(']) {
      const r = parseQuery(src);
      expect(r.diagnostics.length, src).toBeGreaterThan(0);
    }
    expect(parseQuery('(a b').ast).toMatchObject({ type: 'and', items: [{ value: 'a' }, { value: 'b' }] });
  });

  it('上限：超长截断，最多 64 个条件', () => {
    const long = parseQuery('x'.repeat(1200));
    expect(long.diagnostics[0]?.message).toContain('1000');
    const many = parseQuery(Array.from({ length: 70 }, (_, i) => `w${i}`).join(' '));
    expect((many.ast as { items: unknown[] }).items).toHaveLength(64);
    expect(many.diagnostics.some((d) => d.message.includes('64'))).toBe(true);
  });

  it('记号位置对应原文', () => {
    const src = '标签：函数  "a b"';
    for (const t of tokenize(src).tokens) expect(src.slice(t.from, t.to).length).toBeGreaterThan(0);
    const f = parseQuery(src).ast as { items: { from: number; to: number }[] };
    expect(src.slice(f.items[0]!.from, f.items[0]!.to)).toBe('标签：函数');
    expect(src.slice(f.items[1]!.from, f.items[1]!.to)).toBe('"a b"');
  });
});

describe('名称解析', () => {
  it('自由词规范化；in: 限定范围；标题等字段', () => {
    expect(run('ＡＢ 函数').q).toEqual({ k: 'and', items: [{ k: 'text', value: 'ab', phrase: false }, { k: 'text', value: '函数', phrase: false }] });
    expect(run('函数 范围:标题,标签').q).toEqual({ k: 'text', value: '函数', phrase: false, fields: ['title', 'tag'], via: 'in' });
    expect(run('标题:函数').q).toEqual({ k: 'text', value: '函数', phrase: false, fields: ['title'] });
    expect(run('函数').hasFreeText).toBe(true);
    expect(run('-函数').hasFreeText).toBe(false);
  });

  it('选项：精确路径、末级简写、重名取并集并提示、未知选项报错（恒假）', () => {
    expect(run('题型:英语/完型填空').q).toMatchObject({ k: 'prop', propertyId: ids.qt, test: { t: 'options', optionIds: ['o-cloze'] } });
    expect(run('题型:完型填空').q).toMatchObject({ test: { optionIds: ['o-cloze'] } });
    const amb = run('题型:选择');
    expect(amb.q).toMatchObject({ test: { optionIds: ['o-ensel', 'o-gensel'] } });
    expect(amb.diagnostics.some((d) => d.severity === 'warning' && d.message.includes('多个'))).toBe(true);
    const bad = run('题型:阅读理解');
    expect(bad.q).toMatchObject({ k: 'false' });
    expect(errors('题型:阅读理解')).toHaveLength(1);
    expect(run('题型:无').q).toMatchObject({ test: { t: 'none' } });
    expect(run('题型:*').q).toMatchObject({ test: { t: 'any' } });
  });

  it('有序单选可以比较；分层单选不行', () => {
    expect(run('难度:>=较难').q).toMatchObject({ test: { optionIds: ['d4', 'd5'] } });
    expect(run('难度:<较易').q).toMatchObject({ test: { optionIds: ['d1'] } });
    expect(run('难度:较易..中档').q).toMatchObject({ test: { optionIds: ['d2', 'd3'] } });
    expect(errors('题型:>=填空')).toHaveLength(1);
  });

  it('数字、勾选、文本、日期属性；属性名与保留键冲突时用 属性. 前缀', () => {
    expect(run('年份:>=2020').q).toMatchObject({ test: { t: 'number', op: '>=', value: 2020 } });
    expect(run('年份:2020..2024').q).toMatchObject({ test: { t: 'numberRange', lo: 2020, hi: 2024 } });
    expect(errors('年份:abc')).toHaveLength(1);
    expect(run('重点:是').q).toMatchObject({ test: { t: 'checked', value: true } });
    expect(run('"出处 说明":课本').q).toMatchObject({ propertyId: ids.memo, test: { t: 'text', value: '课本' } });
    expect(run('考试日期:2026-06').q).toMatchObject({ test: { t: 'date', spec: { kind: 'cmp', op: '=', v: '2026-06' } } });
    expect(run('标题:x').q).toMatchObject({ k: 'text', fields: ['title'] });
    expect(run('属性.标题:x').q).toMatchObject({ k: 'prop', propertyId: ids.titleProp });
    expect(errors('属性.不存在:x')).toHaveLength(1);
  });

  it('未知键按普通文字（警告）；标签与字典；状态只对资料', () => {
    const r = run('作者:张三');
    expect(r.q).toEqual({ k: 'text', value: '作者:张三', phrase: false });
    expect(r.diagnostics[0]?.severity).toBe('warning');
    expect(run('#数学/函数 标签:无').q).toMatchObject({ k: 'and', items: [{ k: 'tag', paths: ['数学/函数'] }, { k: 'untagged' }] });
    expect(run('学科:数学,无').q).toEqual({ k: 'dict', field: 'subject', values: ['数学', null] });
    expect(run('状态:待整理', 'material').q).toEqual({ k: 'status', value: 'inbox' });
    expect(errors('状态:待整理')).toHaveLength(1);
  });

  it('学生：状态、重名要求 #ID 前缀、第一个正向顶层条件作为上下文', () => {
    expect(run('学生:小明/错过').q).toEqual({ k: 'student', studentId: ids.s1, state: 'wrong-ever' });
    expect(run('学生:小明').studentId).toBe(ids.s1);
    expect(run('-学生:小明').studentId).toBeNull();
    expect(run('(学生:小明 OR a)').studentId).toBeNull();
    const dup = run('学生:小红');
    expect(dup.q.k).toBe('false');
    expect(dup.diagnostics[0]?.suggestions).toEqual(['小红#bbbb', '小红#cccc']);
    expect(run('学生:小红#cccc/最近错').q).toEqual({ k: 'student', studentId: ids.s3, state: 'wrong-last' });
    expect(errors('学生:不存在')).toHaveLength(1);
  });

  it('日期：写法校验', () => {
    expect(run('创建:2026-09').q).toEqual({ k: 'date', field: 'created', spec: { kind: 'cmp', op: '=', v: '2026-09' } });
    expect(run('修改:本周').q).toMatchObject({ spec: { v: '本周' } });
    expect(errors('创建:2026-13')).toHaveLength(1);
    expect(errors('创建:明年')).toHaveLength(1);
    expect(run('有:答案 有:题型').q).toMatchObject({ k: 'and', items: [{ k: 'has', what: 'answer' }, { k: 'prop', test: { t: 'any' } }] });
  });
});

describe('日期换算（本机时区的自然日）', () => {
  const now = new Date(2026, 8, 30, 15, 0, 0); // 2026-09-30 周三
  it('区间与相对日期', () => {
    expect(termRange('2026-09', now)).toEqual([new Date(2026, 8, 1), new Date(2026, 9, 1)]);
    expect(termRange('今天', now)).toEqual([new Date(2026, 8, 30), new Date(2026, 9, 1)]);
    expect(termRange('本周', now)).toEqual([new Date(2026, 8, 28), new Date(2026, 9, 5)]);
    expect(termRange('7天', now)).toEqual([new Date(2026, 8, 24), new Date(2026, 9, 1)]);
    expect(termRange('2026-02-30', now)).toBeNull();
    expect(specBounds({ kind: 'cmp', op: '<=', v: '2026-09-01' }, now)).toEqual({ to: new Date(2026, 8, 2) });
    expect(specBounds({ kind: 'range', lo: '2026-01', hi: null }, now)).toEqual({ from: new Date(2026, 0, 1) });
  });
});

describe('序列化', () => {
  const round = (src: string) => serializeQuery(run(src).q, catalog).text;
  it('按当前名称输出规范文本，且 serialize∘parse 稳定', () => {
    const cases = [
      '函数 #数学/函数',
      '题型:完型填空 难度:>=较难',
      '-学科:数学 学生:小红#cccc/错过',
      'a (b OR c d)',
      '"二次 函数" 范围:标题,答案',
      '年份:2020..2024 重点:否 创建:本周',
      '"出处 说明":"人教 版" 属性.标题:x',
      '标签:"带 空格" 标签:无 有:图片',
    ];
    for (const c of cases) {
      const once = round(c);
      expect(round(once), c).toBe(once);
      expect(run(once).diagnostics.filter((d) => d.severity === 'error'), c).toEqual([]);
    }
    expect(round('题型:完型填空')).toBe('题型:英语/完型填空');
    expect(round('难度:>=较难')).toBe('难度:较难,困难');
  });

  it('已删除的选项与学生被略去并提示', () => {
    const q: Q = { k: 'and', items: [{ k: 'prop', propertyId: ids.qt, test: { t: 'options', optionIds: ['gone'] } }, { k: 'student', studentId: 'x', state: 'done' }, { k: 'text', value: 'a', phrase: false }] };
    const r = serializeQuery(q, catalog);
    expect(r.text).toBe('a');
    expect(r.problems).toHaveLength(2);
  });
});

describe('条件行与编辑', () => {
  it('顶层条件拆成行；导航高亮只看正向条件', () => {
    const src = '#数学 -学科:物理 题型:填空 (a OR b) 学生:小明';
    const rows = conditionRows(src, parseQuery(src).ast, catalog, 'problem');
    expect(rows.map((r) => r.kind)).toEqual(['field', 'field', 'field', 'complex', 'field']);
    expect(rows[1]!.negated).toBe(true);
    const sel = navSelection(rows);
    expect(sel.tagPaths).toEqual(['数学']);
    expect(sel.subject).toEqual([]);
    expect([...sel.props.get(ids.qt)!]).toEqual(['o-fill']);
    expect(sel.student).toEqual({ id: ids.s1, state: 'done' });
  });

  it('替换同一字段的条件，其余文字原样保留；追加；删除', () => {
    const src = '函数  #数学 学科:数学 “手打的 短语”';
    const replaced = setFieldCondition(src, catalog, 'problem', { reserved: 'tag' }, '#物理');
    expect(replaced).toBe('函数 学科:数学 “手打的 短语” #物理');
    expect(setFieldCondition(src, catalog, 'problem', { reserved: 'tag' }, '#物理', 'append')).toBe(`${src} #物理`);
    expect(setFieldCondition(src, catalog, 'problem', { reserved: 'subject' }, null)).toBe('函数  #数学 “手打的 短语”');
    expect(setFieldCondition('题型:填空 -题型:选择', catalog, 'problem', { propertyId: ids.qt }, '题型:英语')).toBe('-题型:选择 题型:英语');
  });
});
