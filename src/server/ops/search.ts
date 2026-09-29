/** 检索题目或资料（查询语言与页面搜索框相同）；列出常用检索。 */
import { z } from 'zod';
import { listSavedSearches } from '../services/savedSearches.js';
import { listEntities } from '../services/search.js';
import { defineOp } from './registry.js';

export const SEARCH_SYNTAX_HELP = [
  '查询语法（与界面搜索框相同）：空格分隔的词同时满足；OR 或 | 表示“或”；词前加 - 表示排除；"带空格的短语" 加引号；括号分组。',
  '字段：标题: 正文: 笔记: 答案: 解析: 来源: 只在该字段找；#标签路径（含下级；标签:无 表示没有标签）；学科: 学段:（无 = 未设置）；',
  '属性名:选项路径（例如 题型:英语/完型填空，可只写末级；难度:>=较难；年份:2020..2024；属性名:无 / 属性名:*）；',
  '有:答案 / 有:解析 / 有:图片；创建: 修改:（2026-09、>=2026-09-01、本周、7天）；学生:名字/错过（做过 没做 错过 最近错）；',
  '范围:标题,答案 让自由词只在这些字段里找。',
].join('');

export const searchOps = [
  defineOp({
    name: 'search',
    title: '检索',
    description: `检索题目（scope=problems）或资料（materials）。${SEARCH_SYNTAX_HELP} 返回每项的 ID、标题、摘要、标签、属性、命中字段与命中片段；用 get_problem 读取全文。查询有问题时 diagnostics 会说明。`,
    input: z
      .object({
        query: z.string().max(1000).default(''),
        scope: z.enum(['problems', 'materials']).default('problems'),
        sort: z.enum(['auto', 'created', 'updated', 'relevance']).default('auto').describe('auto：有关键词时按相关度，否则按创建时间'),
        limit: z.number().int().min(1).max(50).default(20),
        offset: z.number().int().min(0).max(100_000).default(0),
      })
      .strict(),
    access: 'read',
    run: (ctx, input) => {
      const r = listEntities(ctx.db, input.scope === 'materials' ? 'material' : 'problem', {
        q: input.query,
        sort: input.sort,
        offset: input.offset,
        limit: input.limit,
      });
      return {
        total: r.total,
        offset: r.offset,
        sortApplied: r.sortApplied,
        diagnostics: r.diagnostics.map((d) => ({ severity: d.severity, message: d.message, text: input.query.slice(d.from, d.to), ...(d.suggestions ? { suggestions: d.suggestions } : {}) })),
        items: r.items.map((i) => ({
          id: i.id,
          title: i.title,
          summary: i.summary,
          subject: i.subject,
          stage: i.stage,
          tags: i.tags,
          properties: i.properties,
          imageCount: i.imageCount,
          noteCounts: i.noteCounts,
          hits: i.hits,
          snippets: i.snippets?.map((s) => ({ field: s.field, text: s.text })),
          updatedAt: i.updatedAt,
        })),
      };
    },
  }),
  defineOp({
    name: 'list_saved_searches',
    title: '列出常用检索',
    description: '列出保存的常用检索（名称与查询文本）；查询文本可直接传给 search。',
    input: z.object({ scope: z.enum(['problems', 'materials']).optional() }).strict(),
    access: 'read',
    run: (ctx, input) =>
      listSavedSearches(ctx.db, input.scope === 'materials' ? 'material' : input.scope === 'problems' ? 'problem' : undefined).map((s) => ({
        id: s.id,
        scope: s.scope,
        name: s.name,
        query: s.text,
        ...(s.problems.length ? { problems: s.problems } : {}),
      })),
  }),
];
