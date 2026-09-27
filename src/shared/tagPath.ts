/**
 * 标签路径：沿用 Obsidian 的约定，用 `/` 表示层级（例如 `方法/换元`）。
 * 数据库里只存完整的标签名；层级、子树与计数都在读取时由名称推导，不改库结构。
 * 已有标签名保持原样，只有新输入才规范化；分组与匹配统一使用 tagKey()。
 */

export const TAG_SEP = '/';

/** 按 `/` 切分并去掉每段首尾空白，丢弃空段。 */
export function splitTagPath(name: string): string[] {
  return name
    .split(TAG_SEP)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/** 分组与比较用的键：段规范化 + 大小写折叠（与 normalizeTagNames 的 toLowerCase 规则一致）。 */
export function tagKey(name: string): string {
  return splitTagPath(name).join(TAG_SEP).toLowerCase();
}

/** 新输入的标签：合并空白、去掉多余的 `/` 与段首尾空白。 */
export function normalizeTagInput(raw: string): string {
  return splitTagPath(raw).join(TAG_SEP);
}

/** 标签（键）是否位于某个路径（键）的子树内，含路径本身。 */
export function inSubtree(nameKey: string, pathKey: string): boolean {
  return nameKey === pathKey || nameKey.startsWith(pathKey + TAG_SEP);
}

/** 某个标签键的全部祖先路径键（含自身），例如 `a/b/c` → `a`、`a/b`、`a/b/c`。 */
export function ancestorKeys(key: string): string[] {
  const segs = key.split(TAG_SEP);
  return segs.map((_, i) => segs.slice(0, i + 1).join(TAG_SEP));
}

export interface TagTreeNode {
  /** 规范化后的路径键（小写），用作筛选参数与计数的索引 */
  key: string;
  /** 显示用的完整路径（取第一次出现时的写法） */
  path: string;
  /** 最后一段 */
  name: string;
  /** 恰好是这个路径的标签（可能有多个写法不同的标签归到同一节点） */
  tagIds: string[];
  children: TagTreeNode[];
}

/** 由扁平的标签列表构建层级树；只存在于路径中的上级节点是“虚拟节点”（tagIds 为空）。 */
export function buildTagTree(tags: readonly { id: string; name: string }[]): TagTreeNode[] {
  const roots: TagTreeNode[] = [];
  const byKey = new Map<string, TagTreeNode>();
  const sorted = [...tags].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  for (const t of sorted) {
    const segs = splitTagPath(t.name);
    if (segs.length === 0) continue;
    let siblings = roots;
    for (let i = 0; i < segs.length; i++) {
      const path = segs.slice(0, i + 1).join(TAG_SEP);
      const key = path.toLowerCase();
      let node = byKey.get(key);
      if (!node) {
        node = { key, path, name: segs[i]!, tagIds: [], children: [] };
        byKey.set(key, node);
        siblings.push(node);
      }
      if (i === segs.length - 1) node.tagIds.push(t.id);
      siblings = node.children;
    }
  }
  return roots;
}

/** 深度优先遍历树中的全部节点。 */
export function flattenTagTree(nodes: readonly TagTreeNode[]): TagTreeNode[] {
  const out: TagTreeNode[] = [];
  const walk = (ns: readonly TagTreeNode[]) => {
    for (const n of ns) {
      out.push(n);
      walk(n.children);
    }
  };
  walk(nodes);
  return out;
}
