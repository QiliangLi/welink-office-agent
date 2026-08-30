import { CalendarDays, Check, HelpCircle, ListChecks, MessageSquareText, Pencil, Send, Users, X } from "lucide-react";
import { useState } from "react";
import type { ApprovalDecisionInput, ApprovalDto } from "../../types/domain";

const kindMeta = {
  message: { label: "消息发送", icon: MessageSquareText },
  schedule: { label: "日程安排", icon: CalendarDays },
  clarification: { label: "需要输入", icon: HelpCircle },
  scope_change: { label: "范围变更", icon: ListChecks },
} as const;

interface ApprovalCardProps {
  approval: ApprovalDto;
  onDecide: (input: ApprovalDecisionInput) => Promise<void>;
}

export function ApprovalCard({ approval, onDecide }: ApprovalCardProps) {
  const meta = kindMeta[approval.kind];
  const Icon = meta.icon;
  const [slot, setSlot] = useState(approval.payload.type === "schedule" ? approval.payload.options[0]?.id ?? "" : "");
  const [answer, setAnswer] = useState("");
  const [editing, setEditing] = useState(false);
  const [edited, setEdited] = useState(approval.payload.type === "message" ? approval.payload.message : "");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");

  const allowed = new Set(approval.allowedDecisions);
  const decide = async (input: Omit<ApprovalDecisionInput, "expectedRevision">, label: string) => {
    setPending(label);
    setError("");
    try {
      await onDecide({ ...input, expectedRevision: approval.revision });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "提交失败，请稍后重试。");
    } finally {
      setPending(null);
    }
  };

  return (
    <article className="approval-card">
      <div className="approval-heading">
        <span className="approval-kind-icon"><Icon aria-hidden="true" /></span>
        <div>
          <div className="approval-title-line"><h2>{approval.title}</h2><span>{meta.label}</span></div>
          <p>{approval.id} · {approval.summary}</p>
        </div>
        <time dateTime={approval.createdAt}>等待处理</time>
      </div>

      <div className="approval-body">
        <section>
          <h3>Agent 建议执行</h3>
          {approval.payload.type === "message" && (
            <>
              <p>向「{approval.payload.target}」发送以下消息：</p>
              {editing ? (
                <label className="clarification-field">
                  <span>修改后的消息内容</span>
                  <textarea value={edited} rows={4} onChange={(event) => setEdited(event.target.value)} />
                </label>
              ) : (
                <blockquote>{approval.payload.message}</blockquote>
              )}
              <span className="approval-audience"><Users />{approval.payload.audience}</span>
            </>
          )}
          {approval.payload.type === "schedule" && (
            <fieldset className="schedule-options">
              <legend className="sr-only">选择会议时间</legend>
              {approval.payload.options.map((option) => (
                <label key={option.id} className={slot === option.id ? "schedule-option selected" : "schedule-option"}>
                  <input type="radio" name={`slot-${approval.id}`} value={option.id} checked={slot === option.id} onChange={() => setSlot(option.id)} />
                  <span>{option.label}</span><small className={option.tone === "good" ? "text-success" : "text-warning"}>{option.attendance}</small>
                </label>
              ))}
            </fieldset>
          )}
          {approval.payload.type === "clarification" && (
            <label className="clarification-field">
              <span>{approval.payload.question}</span>
              <input value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder={approval.payload.placeholder ?? "请输入你的回答"} />
            </label>
          )}
          {approval.payload.type === "scope_change" && (
            <fieldset className="schedule-options">
              <legend className="sr-only">选择处理方式</legend>
              {approval.payload.itemDescription && <blockquote>{approval.payload.itemDescription}</blockquote>}
              {approval.payload.options.map((option) => (
                <label key={option.value} className={slot === option.value ? "schedule-option selected" : "schedule-option"}>
                  <input type="radio" name={`scope-${approval.id}`} value={option.value} checked={slot === option.value} onChange={() => setSlot(option.value)} />
                  <span>{option.label}</span>
                </label>
              ))}
            </fieldset>
          )}
        </section>

        <section className="approval-reason">
          <h3>需要人工确认的原因</h3>
          <p>{approval.reason}</p>
          <strong>{approval.impact}</strong>
        </section>
      </div>

      {error && <p className="field-error approval-error" role="alert">{error}</p>}

      <div className="approval-actions">
        {approval.payload.type === "message" && allowed.has("reject") && (
          <button className="button button-danger-outline" disabled={pending !== null} onClick={() => decide({ decision: "reject" }, "reject")}><X />拒绝</button>
        )}
        {approval.payload.type === "message" && allowed.has("edit") && !editing && (
          <button className="button button-secondary" disabled={pending !== null} onClick={() => setEditing(true)}><Pencil />修改内容</button>
        )}
        {approval.payload.type === "message" && editing && (
          <button className="button button-secondary" disabled={!edited.trim() || pending !== null} onClick={() => decide({ decision: "edit", editedContent: edited }, "edit")}>保存修改并提交</button>
        )}
        {(approval.payload.type === "schedule" || approval.payload.type === "scope_change") && allowed.has("reject") && (
          <button className="button button-danger-outline" disabled={pending !== null} onClick={() => decide({ decision: "reject" }, "reject")}><X />拒绝</button>
        )}
        {approval.payload.type === "schedule" && (
          <button className="button button-success" disabled={!slot || pending !== null} onClick={() => decide({ decision: "select_option", optionId: slot }, "select")}><CalendarDays />选择并继续</button>
        )}
        {approval.payload.type === "scope_change" && (
          <button className="button button-success" disabled={!slot || pending !== null} onClick={() => decide({ decision: "select_option", optionId: slot }, "select")}><Check />确认处理方式</button>
        )}
        {approval.payload.type === "clarification" && allowed.has("submit_answer") && (
          <button className="button button-success" disabled={!answer.trim() || pending !== null} onClick={() => decide({ decision: "submit_answer", answer }, "answer")}><Send />填写并提交</button>
        )}
      </div>
    </article>
  );
}
