import { CalendarDays, Check, FileSearch, HelpCircle, MessageSquareText, Pencil, Send, Users, X } from "lucide-react";
import { useState } from "react";
import type { Approval, ApprovalStatus } from "../../types/domain";

const kindMeta = {
  message: { label: "消息发送", icon: MessageSquareText },
  schedule: { label: "日程安排", icon: CalendarDays },
  clarification: { label: "需要输入", icon: HelpCircle },
};

interface ApprovalCardProps {
  approval: Approval;
  onResolve: (status: ApprovalStatus) => void;
}

export function ApprovalCard({ approval, onResolve }: ApprovalCardProps) {
  const meta = kindMeta[approval.kind];
  const Icon = meta.icon;
  const [slot, setSlot] = useState(approval.payload.type === "schedule" ? approval.payload.options[0]?.id ?? "" : "");
  const [answer, setAnswer] = useState("");

  return (
    <article className="approval-card">
      <div className="approval-heading">
        <span className="approval-kind-icon"><Icon aria-hidden="true" /></span>
        <div>
          <div className="approval-title-line"><h2>{approval.title}</h2><span>{meta.label}</span></div>
          <p>{approval.id} · {approval.summary}</p>
        </div>
        <time dateTime={approval.createdAt}>刚刚</time>
      </div>

      <div className="approval-body">
        <section>
          <h3>Agent 建议执行</h3>
          {approval.payload.type === "message" && (
            <>
              <p>向「{approval.payload.target}」发送以下消息：</p>
              <blockquote>{approval.payload.message}</blockquote>
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
              <input value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder={approval.payload.placeholder} />
            </label>
          )}
        </section>

        <section className="approval-reason">
          <h3>需要人工确认的原因</h3>
          <p>{approval.reason}</p>
          <strong>{approval.impact}</strong>
          <button className="evidence-link"><FileSearch />{approval.evidenceLabel}</button>
        </section>
      </div>

      <div className="approval-actions">
        {approval.payload.type === "message" && <button className="button button-danger-outline" onClick={() => onResolve("rejected")}><X />拒绝</button>}
        {approval.payload.type === "message" && <button className="button button-secondary" onClick={() => onResolve("edited")}><Pencil />修改内容</button>}
        <button
          className="button button-success"
          disabled={approval.payload.type === "clarification" && !answer.trim()}
          onClick={() => onResolve("approved")}
        >
          {approval.payload.type === "message" ? <><Check />批准执行</> : approval.payload.type === "schedule" ? <><CalendarDays />选择并继续</> : <><Send />填写并提交</>}
        </button>
      </div>
    </article>
  );
}
