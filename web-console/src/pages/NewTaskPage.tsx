import { ArrowLeft, ArrowRight, CalendarDays, Check, ChevronDown, Flag, Lightbulb, Lock, Paperclip, Save, ShieldCheck, Sparkles, WandSparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { AgentMascot } from "../components/mascot/AgentMascot";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { Toast } from "../components/ui/Toast";
import { useAppData } from "../state/AppDataContext";
import type { NewTaskInput } from "../types/domain";

const draftKey = "welink-office-agent-new-task-draft";
const examples = [
  "收集本周项目进展，向各负责人确认阻塞和预计完成时间，并整理成周报。",
  "分析上月渠道数据，找出增长点和异常原因，输出可执行的改进建议。",
  "跟进尚未回复的客户邮件，必要时提醒对方，并汇总所有回复状态。",
];

const defaultForm: NewTaskInput = {
  description: "",
  priority: "normal",
  deadline: "",
  externalPolicy: "balanced",
  executionMode: "automatic",
};

export function NewTaskPage() {
  const { createTask, session, health } = useAppData();
  const [form, setForm] = useState<NewTaskInput>(() => {
    const saved = localStorage.getItem(draftKey);
    return saved ? { ...defaultForm, ...JSON.parse(saved) as Partial<NewTaskInput> } : defaultForm;
  });
  const [advanced, setAdvanced] = useState(true);
  const [attachments] = useState<string[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<{ id: string; queued: boolean } | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [error, setError] = useState("");
  const descriptionError = form.description.trim().length < 12 ? "请至少写 12 个字，说明目标和期望结果。" : "";

  const checks = useMemo(() => [
    { label: "任务描述", value: descriptionError ? "描述还不够具体" : `${form.description.trim().length} 个字，目标已填写`, pass: !descriptionError },
    { label: "截止时间", value: form.deadline ? new Date(form.deadline).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) : "未设置（可选）", pass: true },
    { label: "外部操作", value: form.executionMode === "automatic" ? "低风险操作自动执行，高风险操作仍需确认" : "所有外部操作均先确认", pass: true },
  ], [descriptionError, form.deadline, form.description, form.executionMode]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      localStorage.setItem(draftKey, JSON.stringify(form));
      setSavedAt(new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }));
    }, 3000);
    return () => window.clearTimeout(timer);
  }, [form]);

  const update = <K extends keyof NewTaskInput>(key: K, value: NewTaskInput[K]) => setForm((current) => ({ ...current, [key]: value }));
  const saveDraft = () => { localStorage.setItem(draftKey, JSON.stringify(form)); setSavedAt(new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })); };

  const submit = async () => {
    setSubmitting(true);
    setError("");
    try {
      // datetime-local has no timezone; send the owner timezone so the
      // server can store a full ISO instant (docs §4.3).
      const deadlineIso = form.deadline
        ? new Date(form.deadline).toISOString()
        : null;
      const result = await createTask({
        description: form.description.trim(),
        priority: form.priority,
        deadline: deadlineIso,
        timezone: session?.timezone,
        externalPolicy: form.externalPolicy,
        executionMode: form.executionMode,
      });
      localStorage.removeItem(draftKey);
      setCreated({ id: result.task.id, queued: result.task.displayStatus === "queued" });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "创建失败，请稍后重试。");
    } finally {
      setSubmitting(false);
    }
  };

  if (created) {
    return (
      <div className="page create-success">
        <div className="success-card">
          <AgentMascot mood="success" size="lg" />
          <span className="success-icon"><Check /></span>
          <h1>任务已创建，当前待执行</h1>
          <p>
            {created.queued
              ? "Agent 还没有处理这条任务：如果它正在运行，会自动领取并开始拆解；完成后这里会显示“已开始执行”。"
              : "Agent 正在拆解执行计划。涉及外部发送或高风险操作时，会先回到“待我处理”等你确认。"}
          </p>
          {health?.mode === "dry_run" && <p className="field-help">当前为 dry-run 模式：消息只会生成预览，不会真实发送。</p>}
          <code>{created.id}</code>
          <div>
            <Link className="button button-primary" to={`/tasks/${created.id}`}>查看任务 <ArrowRight /></Link>
            <button className="button button-secondary" onClick={() => { setCreated(null); setForm(defaultForm); }}>继续创建</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page new-task-page">
      <div className="new-task-heading"><div><Link to="/tasks" className="back-link"><ArrowLeft />返回任务</Link><h1>创建新任务 <Sparkles /></h1><p>告诉 Agent 你需要完成的工作，它会规划步骤、推进执行并在关键节点请你确认。</p></div></div>
      <div className="new-task-layout">
        <form className="task-form" onSubmit={(event) => { event.preventDefault(); if (!descriptionError) setConfirmOpen(true); }}>
          <section className="form-card prompt-card">
            <header><WandSparkles /><h2>你希望 Agent 做什么？</h2></header>
            <label className="textarea-wrap"><span className="sr-only">任务描述</span><textarea value={form.description} onChange={(event) => update("description", event.target.value)} maxLength={1000} placeholder="说明任务目标、需要联系的人、需要收集的信息和期望输出。" aria-invalid={Boolean(descriptionError)} aria-describedby="description-help description-error" /><small>{form.description.length} / 1000</small></label>
            <p id="description-help" className="field-help">写清楚目标和结果即可，Agent 会自行拆解执行步骤。</p>
            {form.description && descriptionError && <p id="description-error" className="field-error">{descriptionError}</p>}
            <div className="attachment-row"><span className="button button-secondary attachment-disabled"><Paperclip />添加附件</span><span>附件功能尚未接入，暂不支持上传。需要材料时可以先在描述中说明来源。</span></div>
            {attachments.length > 0 && <div className="attachment-chips" />}
          </section>

          <section className="form-card advanced-card">
            <button type="button" className="advanced-toggle" onClick={() => setAdvanced((current) => !current)} aria-expanded={advanced}><ChevronDown className={advanced ? "rotate" : ""} /><span>高级设置</span><small>优先级、截止时间和执行策略</small></button>
            {advanced && <div className="advanced-grid">
              <fieldset><legend><Flag />优先级</legend><div className="segmented-control">{(["low", "normal", "high"] as const).map((value) => <label key={value} className={form.priority === value ? "selected" : ""}><input type="radio" name="priority" value={value} checked={form.priority === value} onChange={() => update("priority", value)} />{{ low: "低", normal: "普通", high: "高" }[value]}</label>)}</div><small>高优先级任务在等待同一联系人时会排在队列前面。</small></fieldset>
              <label className="form-field"><span><CalendarDays />截止时间</span><input type="datetime-local" value={form.deadline} onChange={(event) => update("deadline", event.target.value)} /><small>超过该时间后 Agent 会标记任务逾期。</small></label>
              <fieldset><legend><ShieldCheck />外部操作策略</legend><div className="segmented-control">{(["conservative", "balanced", "active"] as const).map((value) => <label key={value} className={form.externalPolicy === value ? "selected" : ""}><input type="radio" name="policy" value={value} checked={form.externalPolicy === value} onChange={() => update("externalPolicy", value)} />{{ conservative: "保守", balanced: "平衡", active: "积极" }[value]}</label>)}</div><small>高风险动作始终需要人工确认。</small></fieldset>
              <fieldset><legend><Sparkles />执行方式</legend><div className="segmented-control two">{(["automatic", "confirm"] as const).map((value) => <label key={value} className={form.executionMode === value ? "selected" : ""}><input type="radio" name="execution" value={value} checked={form.executionMode === value} onChange={() => update("executionMode", value)} />{{ automatic: "自动执行", confirm: "需要我确认" }[value]}</label>)}</div><small>选择确认后，每个外部动作都会先进入待处理队列。</small></fieldset>
            </div>}
          </section>

          <section className="form-card preflight-card"><header><ShieldCheck /><h2>创建检查</h2><span>{checks.every((item) => item.pass) ? "可以创建" : "还有 1 项需要补充"}</span></header>{checks.map((item) => <div className={item.pass ? "check-row pass" : "check-row fail"} key={item.label}><span>{item.pass ? <Check /> : <span aria-hidden="true">·</span>}</span><strong>{item.label}</strong><p>{item.value}</p>{!item.pass && <button type="button" onClick={() => document.querySelector("textarea")?.focus()}>去补充</button>}</div>)}</section>

          <div className="form-action-bar"><span><Lock />创建后，Agent 将立即拆解任务并开始执行</span><div><button type="button" className="button button-secondary" onClick={saveDraft}><Save />保存草稿</button><button className="button button-primary" disabled={Boolean(descriptionError) || submitting}>{submitting ? "创建中…" : "创建任务"} <ArrowRight /></button></div>{savedAt && <small>草稿已保存 · {savedAt}</small>}</div>
        </form>

        <aside className="inspiration-panel"><div className="inspiration-mascot"><span><Lightbulb /></span><AgentMascot mood="working" scene="inspiration" size="lg" /></div><p>需要灵感？</p><h2>试试这样描述任务</h2><div className="inspiration-list">{examples.map((example) => <button key={example} onClick={() => update("description", example)}><Sparkles />{example}</button>)}</div><button className="shuffle-button" onClick={() => update("description", examples[Math.floor(Math.random() * examples.length)])}>换一换</button></aside>
      </div>
      <ConfirmDialog open={confirmOpen} title="确认创建并开始执行？" description="Agent 会立即拆解任务并开始推进。同一联系人同时只有一个进行中的沟通，其他任务会先排队。涉及对外发送、费用或不可撤回动作时仍会等待你的确认。" confirmLabel="创建并开始" onConfirm={submit} onClose={() => setConfirmOpen(false)} />
      {error && <Toast message={error} tone="danger" onClose={() => setError("")} />}
    </div>
  );
}
