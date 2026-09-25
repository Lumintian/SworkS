import { Download, Inbox, Plus } from 'lucide-react';
import { EntityList } from '../components/EntityList';
import { PageHeader, useToast } from '../components/ui';
import { errorMessage, postForBlob, saveBlob } from '../lib/api';
import { newId } from '../lib/format';
import { useRouter } from '../lib/router';

export function ProblemsPage() {
  const { navigate } = useRouter();
  const toast = useToast();
  return (
    <div>
      <PageHeader
        title="题目"
        subtitle="搜索默认包含笔记、答案与解析。勾选题目可导出为 Markdown。"
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
        selectionActions={(ids, clear) => (
          <button
            type="button"
            className="btn btn-sage btn-sm"
            onClick={async () => {
              try {
                const r = await postForBlob('/api/export/markdown', { problemIds: ids });
                saveBlob(r.blob, r.fileName);
                const w = Number(r.headers.get('x-sworks-export-warnings') ?? 0);
                toast(w > 0 ? `已导出 ${ids.length} 道题，有 ${w} 条警告（见 README）` : `已导出 ${ids.length} 道题`, w > 0 ? 'warn' : 'success');
                clear();
              } catch (err) {
                toast(errorMessage(err), 'error');
              }
            }}
          >
            <Download size={15} /> 导出所选为 Markdown
          </button>
        )}
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
        subtitle="先收下、待整理的资料。整理后在资料页把状态改为“已整理”，资料仍会保留。"
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
