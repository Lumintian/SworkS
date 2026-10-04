/** 数据管理里的操作提示：收进一个“?”按钮，不在页面上铺大段说明。 */
import { CircleHelp } from 'lucide-react';
import type { ReactNode } from 'react';
import { MOD_LABEL } from '../../lib/hotkeys';
import { Popover, PopoverContent, PopoverTrigger } from '../Menu';

/** 树（标签、选项、学科学段）共用的选择与编辑方式。 */
export function treeTips(opts: { drag: string; del?: string }): ReactNode[] {
  return [
    `单击选择；按住 ${MOD_LABEL} 点选多个，按住 ⇧ 连选，${MOD_LABEL}+A 全选，Esc 取消`,
    '右键或每行的“⋯”打开菜单，作用于所有选中的项',
    'F2 或双击改名',
    opts.del ?? 'Delete 删除所选',
    opts.drag,
  ];
}

export function ManageHelp({ title, tips }: { title: string; tips: ReactNode[] }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className="btn btn-ghost btn-icon h-7 w-7 text-ink-faint" aria-label={`${title}：操作说明`}>
          <CircleHelp size={16} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <div className="space-y-1.5 px-4 py-3 text-sm text-ink-soft">
          <p className="font-semibold text-stone">{title}</p>
          <ul className="list-disc space-y-1 pl-4">
            {tips.map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ul>
        </div>
      </PopoverContent>
    </Popover>
  );
}
