/**
 * 语义树 → SQL 条件。只拼接白名单里的表名与列名，所有值（含字段列表）都作为参数绑定。
 * 每个叶子条件求值为 0/1、不会是 NULL，所以取反才正确（例如 `-学科:数学` 包含未设置学科的对象）。
 * e 是题目/资料表的别名。
 */
import type { SearchField } from '../../../shared/constants.js';
import type { PropTest, Q } from '../../../shared/query/ast.js';
import { localDateString, specBounds, type CmpOp, type DateSpec } from '../../../shared/query/dates.js';
import { FIELD_WEIGHT } from '../../../shared/query/keys.js';
import { inSubtree, tagKey } from '../../../shared/tagPath.js';
import type { DB } from '../../db/connection.js';
import { expandOptionFilter } from '../properties.js';
import { ownerColumn, placeholders, tagTable, type OwnerKind } from '../rows.js';
import { attemptFilterSql } from '../students.js';

export interface Sql {
  sql: string;
  params: unknown[];
}

const TRUE: Sql = { sql: '1', params: [] };
const FALSE: Sql = { sql: '0', params: [] };
const CMP: Record<CmpOp, string> = { '>=': '>=', '<=': '<=', '>': '>', '<': '<', '=': '=' };

export class QueryCompiler {
  private tags: { id: string; key: string }[] | null = null;

  constructor(
    private readonly db: DB,
    private readonly kind: OwnerKind,
    private readonly now: Date = new Date(),
  ) {}

  private get col(): string {
    return ownerColumn(this.kind);
  }

  /** 标签路径 → 子树内全部标签 ID */
  tagIds(path: string): string[] {
    this.tags ??= (this.db.prepare('SELECT id, name FROM tags').all() as { id: string; name: string }[]).map((t) => ({ id: t.id, key: tagKey(t.name) }));
    const pk = tagKey(path);
    return this.tags.filter((t) => inSubtree(t.key, pk)).map((t) => t.id);
  }

  /** 文字条件：在检索投影里找（可限定字段） */
  textSql(value: string, fields: readonly SearchField[] | undefined): Sql {
    const f = fields?.length ? ` AND s.field IN (${placeholders(fields.length)})` : '';
    return {
      sql: `EXISTS (SELECT 1 FROM search_index s WHERE s.owner_kind = ? AND s.owner_id = e.id${f} AND instr(s.text, ?) > 0)`,
      params: [this.kind, ...(fields ?? []), value],
    };
  }

  private propValue(propertyId: string, cond: string, params: unknown[] = []): Sql {
    return {
      sql: `EXISTS (SELECT 1 FROM property_values v WHERE v.${this.col} = e.id AND v.property_id = ?${cond ? ` AND ${cond}` : ''})`,
      params: [propertyId, ...params],
    };
  }

  private dateRange(column: string, spec: DateSpec, asLocalDate: boolean): { cond: string; params: unknown[] } | null {
    const b = specBounds(spec, this.now);
    if (!b) return null;
    const conds: string[] = [];
    const params: unknown[] = [];
    const fmt = (d: Date) => (asLocalDate ? localDateString(d) : d.toISOString());
    if (b.from) {
      conds.push(`${column} >= ?`);
      params.push(fmt(b.from));
    }
    if (b.to) {
      conds.push(`${column} < ?`);
      params.push(fmt(b.to));
    }
    return { cond: conds.length ? conds.join(' AND ') : `${column} IS NOT NULL`, params };
  }

  private prop(propertyId: string, t: PropTest): Sql {
    switch (t.t) {
      case 'options': {
        const ids = expandOptionFilter(this.db, propertyId, t.optionIds);
        if (ids.length === 0) return FALSE;
        return this.propValue(propertyId, `v.option_id IN (${placeholders(ids.length)})`, ids);
      }
      case 'none': {
        const s = this.propValue(propertyId, '');
        return { sql: `NOT ${s.sql}`, params: s.params };
      }
      case 'any':
        return this.propValue(propertyId, '');
      case 'checked': {
        const s = this.propValue(propertyId, 'v.number_value = 1');
        return t.value ? s : { sql: `NOT ${s.sql}`, params: s.params };
      }
      case 'number':
        return this.propValue(propertyId, `v.number_value ${CMP[t.op]} ?`, [t.value]);
      case 'numberRange': {
        const conds: string[] = ['v.number_value IS NOT NULL'];
        const params: unknown[] = [];
        if (t.lo !== null) {
          conds.push('v.number_value >= ?');
          params.push(t.lo);
        }
        if (t.hi !== null) {
          conds.push('v.number_value <= ?');
          params.push(t.hi);
        }
        return this.propValue(propertyId, conds.join(' AND '), params);
      }
      case 'date': {
        const r = this.dateRange('v.text_value', t.spec, true);
        return r ? this.propValue(propertyId, r.cond, r.params) : FALSE;
      }
      case 'text':
        return this.propValue(propertyId, 'instr(sworks_norm(v.text_value), ?) > 0', [t.value]);
    }
  }

  compile(q: Q): Sql {
    const col = this.col;
    switch (q.k) {
      case 'true':
        return TRUE;
      case 'false':
        return FALSE;
      case 'and':
      case 'or': {
        const parts = q.items.map((i) => this.compile(i));
        return { sql: `(${parts.map((p) => p.sql).join(q.k === 'and' ? ' AND ' : ' OR ')})`, params: parts.flatMap((p) => p.params) };
      }
      case 'not': {
        const inner = this.compile(q.item);
        return { sql: `NOT (${inner.sql})`, params: inner.params };
      }
      case 'text':
        return this.textSql(q.value, q.fields);
      case 'tag': {
        const ids = [...new Set(q.paths.flatMap((p) => this.tagIds(p)))];
        if (ids.length === 0) return FALSE;
        return { sql: `EXISTS (SELECT 1 FROM ${tagTable(this.kind)} x WHERE x.${col} = e.id AND x.tag_id IN (${placeholders(ids.length)}))`, params: ids };
      }
      case 'untagged':
        return { sql: `NOT EXISTS (SELECT 1 FROM ${tagTable(this.kind)} x WHERE x.${col} = e.id)`, params: [] };
      case 'dict': {
        const column = q.field === 'subject' ? 'e.subject' : 'e.stage';
        if (q.values.length === 0) return FALSE;
        return { sql: `(${q.values.map(() => `${column} IS ?`).join(' OR ')})`, params: [...q.values] };
      }
      case 'status':
        return this.kind === 'material' ? { sql: 'e.status IS ?', params: [q.value] } : FALSE;
      case 'prop':
        return this.prop(q.propertyId, q.test);
      case 'date': {
        const r = this.dateRange(q.field === 'created' ? 'e.created_at' : 'e.updated_at', q.spec, false);
        return r ? { sql: `(${r.cond})`, params: r.params } : FALSE;
      }
      case 'has':
        switch (q.what) {
          case 'answer':
          case 'solution':
          case 'note':
            if (this.kind !== 'problem') return FALSE;
            return { sql: 'EXISTS (SELECT 1 FROM notes n WHERE n.problem_id = e.id AND n.deleted_at IS NULL AND n.type = ?)', params: [q.what] };
          case 'image':
            return { sql: `EXISTS (SELECT 1 FROM content_blocks b WHERE b.${col} = e.id AND b.kind = 'image')`, params: [] };
          case 'tag':
            return { sql: `EXISTS (SELECT 1 FROM ${tagTable(this.kind)} x WHERE x.${col} = e.id)`, params: [] };
          case 'source':
            return this.kind === 'problem'
              ? { sql: '(e.source_note IS NOT NULL OR EXISTS (SELECT 1 FROM problem_material_links l WHERE l.problem_id = e.id))', params: [] }
              : { sql: '(e.source_note IS NOT NULL)', params: [] };
          case 'title':
            return { sql: '(e.title IS NOT NULL)', params: [] };
        }
        return FALSE;
      case 'student': {
        if (this.kind !== 'problem') return FALSE;
        const f = attemptFilterSql(q.studentId, q.state);
        return f ? { sql: `COALESCE(${f.sql}, 0)`, params: f.params } : FALSE;
      }
    }
  }

  /**
   * 相关度：Σ 字段权重 × 命中的原子（同一原子在同一字段只算一次；短语 ×2）。
   * 权重是代码里的常量，不来自用户输入。
   */
  score(atoms: readonly { value: string; phrase: boolean; fields?: readonly SearchField[] }[]): Sql {
    if (atoms.length === 0) return { sql: '0', params: [] };
    const weight = `CASE f.field ${Object.entries(FIELD_WEIGHT)
      .map(([k, w]) => `WHEN '${k}' THEN ${w}`)
      .join(' ')} ELSE 1 END`;
    const parts: string[] = [];
    const params: unknown[] = [];
    for (const a of atoms) {
      const f = a.fields?.length ? ` AND s.field IN (${placeholders(a.fields.length)})` : '';
      parts.push(
        `(SELECT COALESCE(SUM(${weight}), 0) FROM (SELECT DISTINCT s.field AS field FROM search_index s WHERE s.owner_kind = ? AND s.owner_id = e.id${f} AND instr(s.text, ?) > 0) f) * ${a.phrase ? 2 : 1}`,
      );
      params.push(this.kind, ...(a.fields ?? []), a.value);
    }
    return { sql: `(${parts.join(' + ')})`, params };
  }
}
