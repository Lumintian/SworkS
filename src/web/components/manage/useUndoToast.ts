/** 管理操作成功后的提示：服务端给了 undoId 时带“撤销”按钮（POST /api/undo/:id；期间数据又被改过时服务端会拒绝）。 */
import { errorMessage, sendJSON } from '../../lib/api';
import { invalidateWrites } from '../../lib/queryClient';
import { useToast } from '../ui';

export function useUndoToast(): (message: string, undoId?: string) => void {
  const toast = useToast();
  return (message, undoId) =>
    toast(
      message,
      'success',
      undoId
        ? {
            label: '撤销',
            onClick: () =>
              void sendJSON<{ affectedItems: number }>('POST', `/api/undo/${undoId}`).then(
                (r) => {
                  invalidateWrites();
                  toast(r.affectedItems ? `已撤销，影响 ${r.affectedItems} 项` : '已撤销', 'info');
                },
                (err: unknown) => toast(`撤销失败：${errorMessage(err)}`, 'error'),
              ),
          }
        : undefined,
    );
}
