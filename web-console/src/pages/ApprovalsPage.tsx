import { CheckCircle2, Clock3, HelpCircle, Lightbulb, MessageSquareText, Pencil, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { ApprovalCard } from "../components/approvals/ApprovalCard";
import { AgentMascot } from "../components/mascot/AgentMascot";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { Toast } from "../components/ui/Toast";
import { useQuery } from "../queries/core";
import { queryKeys } from "../queries/keys";
import { useAppData } from "../state/AppDataContext";
import type { ApprovalDecisionInput } from "../types/domain";

export function ApprovalsPage() {
  const { client, decide, bulkMarkForEdit } = useAppData();
  const approvalsQuery = useQuery(
    queryKeys.approvals("pending"),
    () => client.getApprovals({ status: ["pending"] }),
  );
  const pending = approvalsQuery.data?.items ?? [];
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [error, setError] = useState("");

  const handleDecide = async (approvalId: string, input: ApprovalDecisionInput) => {
    try {
      const result = await decide(approvalId, input);
      setToast(result.command ? "已记录你的决定，等待 Agent 执行。" : "已记录你的决定。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "提交失败，请稍后重试。");
    }
  };

  const markAllForEdit = async () => {
    setConfirmOpen(false);
    try {
      const changed = await bulkMarkForEdit(pending.map((approval) => approval.id));
      setToast(`已把 ${changed.length} 个待处理项目转为待修改，没有批准外部动作。`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "操作失败，请稍后重试。");
    }
  };

  return (
    <div className="page approvals-page">
      <div className="approvals-heading">
        <div>
          <div><span className="heading-icon"><Clock3 /></span><h1>待我处理</h1><b>{pending.length} 个待处理</b></div>
          <p>Agent 需要你的确认或输入后才能继续执行任务。</p>
        </div>
        {pending.length > 0 && <button className="button button-quiet" onClick={() => setConfirmOpen(true)}><CheckCircle2 />全部转为待修改</button>}
      </div>
      {approvalsQuery.loading && !approvalsQuery.data ? (
        <div className="approval-list" aria-busy="true"><div className="skeleton-panel" style={{ height: 220 }} /></div>
      ) : approvalsQuery.error && !approvalsQuery.data ? (
        <section className="empty-approvals"><h2>无法加载待处理事项</h2><p>{approvalsQuery.error.message}</p><button className="button button-primary" onClick={approvalsQuery.refetch}>重试</button></section>
      ) : pending.length ? (
        <div className="approvals-layout">
          <div className="approval-list">
            {pending.map((approval) => (
              <ApprovalCard key={approval.id} approval={approval} onDecide={(input) => handleDecide(approval.id, input)} />
            ))}
          </div>
          <aside className="approval-tips">
            <div className="tips-mascot"><span><Lightbulb /></span><AgentMascot mood="approval" scene="approval" size="lg" /></div>
            <h2>人工参与小贴士</h2>
            <div><span><ShieldCheck /></span><p><strong>重要操作需确认</strong>涉及对外发送、费用或多人影响的动作会停下来等你。</p></div>
            <div><span><Clock3 /></span><p><strong>及时处理更高效</strong>待处理项不会自动批准，任务会安全地停在当前步骤。</p></div>
            <div><span><Pencil /></span><p><strong>不确定可修改</strong>先调整内容或补充信息，再让 Agent 继续执行。</p></div>
            <Link to="/tasks" className="tips-link"><MessageSquareText />有疑问？查看相关任务 <HelpCircle /></Link>
          </aside>
        </div>
      ) : (
        <section className="empty-approvals">
          <AgentMascot mood="empty" scene="empty" size="lg" />
          <h2>当前没有待处理事项</h2>
          <p>Agent 会继续推进任务，有需要确认的动作会出现在这里。</p>
          <Link className="button button-primary" to="/tasks">查看全部任务</Link>
        </section>
      )}
      <ConfirmDialog
        open={confirmOpen}
        title="把全部项目转为待修改？"
        description="这不会批准任何外部动作。所有待处理项目会保留，并标记为需要你稍后修改。"
        confirmLabel="全部转为待修改"
        onConfirm={markAllForEdit}
        onClose={() => setConfirmOpen(false)}
      />
      {error ? <Toast message={error} tone="danger" onClose={() => setError("")} /> : toast ? <Toast message={toast} onClose={() => setToast("")} /> : null}
    </div>
  );
}
