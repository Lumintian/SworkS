/** 把列表行拖到导航树节点上（例如拖到标签上 = 给这些对象加标签）时使用的数据格式。 */

export const LIST_DRAG_TYPE = 'application/x-sworks-items';

export function writeDraggedIds(dt: DataTransfer, ids: string[]): void {
  dt.setData(LIST_DRAG_TYPE, JSON.stringify(ids));
  dt.effectAllowed = 'copy';
}

export function readDraggedIds(dt: DataTransfer): string[] {
  try {
    const v = JSON.parse(dt.getData(LIST_DRAG_TYPE) || '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
