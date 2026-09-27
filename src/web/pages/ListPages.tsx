import { Inbox, Plus } from 'lucide-react';
import { EntityList } from '../components/EntityList';
import { PageHeader } from '../components/ui';
import { newId } from '../lib/format';
import { useRouter } from '../lib/router';

export function ProblemsPage() {
  const { navigate } = useRouter();
  return (
    <div>
      <PageHeader
        title="题目"
        subtitle="搜索默认包含笔记、答案与解析。左侧标签树可筛选；勾选或按 X 多选后可批量加标签、改学科学段、导出或移到回收站。"
        actions={
          <button type="button" className="btn btn-primary" onClick={() => navigate(`/problems/new?id=${newId()}`)}>
            <Plus size={16} /> 收一道题
          </button>
        }
      />
      <EntityList
        collection="problems"
        placeholder="未命名题目"
        emptyTitle="还没有题目"
        emptyHint="点击“收一道题”，粘贴一张截图就能开始。标题、学科、学段都可以先空着。"
      />
    </div>
  );
}

export function MaterialsPage() {
  const { navigate } = useRouter();
  return (
    <div>
      <PageHeader
        title="资料"
        subtitle="独立值得保存的内容：专题摘录、一组截图、文字材料。可以从中手动建立题目。"
        actions={
          <button type="button" className="btn btn-primary" onClick={() => navigate(`/materials/new?id=${newId()}`)}>
            <Plus size={16} /> 收一份资料
          </button>
        }
      />
      <EntityList collection="materials" placeholder="未命名资料" emptyTitle="还没有资料" emptyHint="资料不必拆成题目，也能独立保存、搜索和编辑。" />
    </div>
  );
}

export function InboxPage() {
  const { navigate } = useRouter();
  return (
    <div>
      <PageHeader
        title="收件箱"
        subtitle="先收下、待整理的资料。整理后把状态改为“已整理”（可多选后批量修改），资料仍会保留。"
        actions={
          <button type="button" className="btn btn-primary" onClick={() => navigate(`/materials/new?id=${newId()}&status=inbox`)}>
            <Inbox size={16} /> 收进收件箱
          </button>
        }
      />
      <EntityList collection="materials" status="inbox" placeholder="未命名资料" emptyTitle="收件箱是空的" emptyHint="临时来不及整理的截图和摘录，可以先收进这里。" />
    </div>
  );
}
