import { Check, Pencil, RefreshCw, ShieldCheck, Trash2, UserRound, Users, X } from "lucide-react";
import { useState } from "react";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { Toast } from "../components/ui/Toast";
import { formatDateTime, relativeTime } from "../lib/task-utils";
import { useQuery } from "../queries/core";
import { queryKeys } from "../queries/keys";
import { useAppData } from "../state/AppDataContext";
import type { ContactConfigDto, HealthDto } from "../types/domain";

/**
 * Runtime status + contacts management. The owner/health/capability cards
 * stay read-only; the contacts card is the one local config the console may
 * edit (docs/sidebar-pages-design.md §7). Everything else — credentials,
 * routing, dry-run — still needs its own backend contract first.
 */

const AGENT_STATE_LABELS: Record<string, string> = {
  idle: "空闲",
  running: "运行中",
  waiting: "等待中",
};

const CAPABILITY_ITEMS = [
  { key: "attachments", label: "附件上传", onLabel: "已开启", offLabel: "未接入" },
  { key: "artifacts", label: "产物浏览与下载", onLabel: "已开启", offLabel: "未接入" },
  { key: "liveSend", label: "真实消息发送", onLabel: "已开启", offLabel: "未开启" },
  { key: "sse", label: "实时推送（SSE）", onLabel: "已开启", offLabel: "不可用" },
] as const;

/** Masked for display only; the API keeps the full employee number. */
function maskEmployeeNumber(value: string | null) {
  if (!value) return "未配置";
  return value.length <= 4 ? value : `••••${value.slice(-4)}`;
}

function CardNotice({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <p className="settings-card-error" role="alert">
      <span>{message}</span>
      <button className="button button-secondary" onClick={onRetry}>重试</button>
    </p>
  );
}

interface ContactDraft {
  employeeNumber: string;
  name: string;
  department: string;
  autoContact: boolean;
}

const emptyDraft: ContactDraft = { employeeNumber: "", name: "", department: "", autoContact: true };

export function SettingsPage() {
  const { client, saveContact } = useAppData();
  const healthQuery = useQuery(queryKeys.health(), () => client.getHealth());
  const sessionQuery = useQuery(queryKeys.session(), () => client.getSession());
  const contactsQuery = useQuery(queryKeys.contacts(), () => client.getContacts());
  const health = healthQuery.data;
  const session = sessionQuery.data;
  const contacts = contactsQuery.data?.items ?? [];

  const refreshStatus = () => {
    healthQuery.refetch();
    sessionQuery.refetch();
  };

  const [draft, setDraft] = useState<ContactDraft>(emptyDraft);
  const [editing, setEditing] = useState(false);
  const [pendingContact, setPendingContact] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<ContactConfigDto | null>(null);
  const [toast, setToast] = useState("");
  const [contactError, setContactError] = useState("");

  const draftEmployeeError = draft.employeeNumber && !/^\d{4,16}$/.test(draft.employeeNumber.trim())
    ? "员工号必须是 4 到 16 位数字。"
    : "";
  const draftNameError = draft.name.trim() ? "" : "请填写联系人姓名。";
  const draftValid = !draftEmployeeError && !draftNameError;

  const editContact = (contact: ContactConfigDto) => {
    setEditing(true);
    setContactError("");
    setDraft({
      employeeNumber: contact.employeeNumber,
      name: contact.name,
      department: contact.department ?? "",
      autoContact: contact.autoContact,
    });
  };

  const resetDraft = () => {
    setEditing(false);
    setDraft(emptyDraft);
    setContactError("");
  };

  const submitContact = async () => {
    if (!draftValid) return;
    setPendingContact(true);
    setContactError("");
    try {
      await saveContact({
        type: "upsert",
        employeeNumber: draft.employeeNumber.trim(),
        name: draft.name.trim(),
        department: draft.department.trim() || null,
        autoContact: draft.autoContact,
      });
      setToast(editing ? "联系人已更新。" : "联系人已添加。");
      resetDraft();
    } catch (caught) {
      setContactError(caught instanceof Error ? caught.message : "保存联系人失败，请稍后重试。");
    } finally {
      setPendingContact(false);
    }
  };

  const confirmRemove = async () => {
    if (!removeTarget) return;
    const target = removeTarget;
    setRemoveTarget(null);
    setPendingContact(true);
    setContactError("");
    try {
      await saveContact({ type: "remove", employeeNumber: target.employeeNumber });
      setToast(`已移除联系人 ${target.name}。`);
      if (editing && draft.employeeNumber === target.employeeNumber) resetDraft();
    } catch (caught) {
      setContactError(caught instanceof Error ? caught.message : "移除联系人失败，请稍后重试。");
    } finally {
      setPendingContact(false);
    }
  };

  return (
    <div className="page settings-page">
      <div className="page-heading">
        <div>
          <h1>设置</h1>
          <p>查看当前用户、运行模式、健康状态和能力开关，并管理可联系的同事。</p>
        </div>
        <button className="button button-secondary" onClick={refreshStatus} disabled={healthQuery.loading || sessionQuery.loading}>
          <RefreshCw aria-hidden="true" />刷新状态
        </button>
      </div>

      <div className="settings-grid">
        <section className="panel settings-user-panel">
          <header className="panel-header"><div><UserRound /><h2>当前用户</h2></div></header>
          {session ? (
            <div className="settings-user">
              <span className="avatar" aria-hidden="true">{session.owner.initials}</span>
              <dl className="settings-dl">
                <div><dt>姓名</dt><dd>{session.owner.name}</dd></div>
                <div><dt>员工号</dt><dd>{maskEmployeeNumber(session.owner.employeeNumber)}</dd></div>
                <div><dt>时区</dt><dd>{session.timezone}</dd></div>
              </dl>
            </div>
          ) : sessionQuery.error ? (
            <CardNotice message={`无法读取用户信息：${sessionQuery.error.message}`} onRetry={sessionQuery.refetch} />
          ) : (
            <div className="skeleton-panel" style={{ height: 140 }} aria-busy="true" aria-label="正在读取用户信息" />
          )}
        </section>

        <section className="panel settings-runtime-panel">
          <header className="panel-header"><div><ShieldCheck /><h2>运行状态</h2></div></header>
          {health ? (
            <>
              <dl className="settings-dl">
                <div>
                  <dt>Agent 状态</dt>
                  <dd>{AGENT_STATE_LABELS[health.agent.state] ?? health.agent.state}{health.agent.stale ? "（数据已过期）" : ""}</dd>
                </div>
                <div>
                  <dt>最近一次成功 tick</dt>
                  <dd>{health.agent.lastSuccessfulTick ? `${formatDateTime(health.agent.lastSuccessfulTick)} · ${relativeTime(health.agent.lastSuccessfulTick)}` : "尚未记录"}</dd>
                </div>
                <div><dt>命令积压</dt><dd>{health.agent.queuedCommands} 个</dd></div>
                <div><dt>待核实外部动作</dt><dd>{health.agent.uncertainActions} 个</dd></div>
                <div>
                  <dt>运行模式</dt>
                  <dd className={health.mode === "dry_run" ? "warning-text" : "text-success"}>
                    {health.mode === "dry_run" ? "Dry-run（预演）" : "Live（真实发送）"}
                  </dd>
                </div>
                <div><dt>实时推送（SSE）</dt><dd>{health.capabilities.sse ? "可用" : "不可用"}</dd></div>
              </dl>
              {health.mode === "dry_run" ? (
                <p className="mode-note">当前为 dry-run 预演模式：外发消息不会真实发送，只会生成发送预览并记录。切换到 live 需要在服务端配置中修改。</p>
              ) : (
                <p className="mode-note mode-note-live">后端当前运行在 live 模式，经过审批的外发消息会真实发送。页面不提供模式切换。</p>
              )}
            </>
          ) : healthQuery.error ? (
            <CardNotice message={`无法读取运行状态：${healthQuery.error.message}`} onRetry={healthQuery.refetch} />
          ) : (
            <div className="skeleton-panel" style={{ height: 220 }} aria-busy="true" aria-label="正在读取运行状态" />
          )}
        </section>

        <section className="panel settings-capability-panel">
          <header className="panel-header"><div><ShieldCheck /><h2>能力</h2></div></header>
          {health ? (
            <div className="capability-list">
              {CAPABILITY_ITEMS.map(({ key, label, onLabel, offLabel }) => {
                const enabled = health.capabilities[key as keyof HealthDto["capabilities"]];
                return (
                  <div className="capability-item" key={key}>
                    {enabled
                      ? <Check className="capability-on" aria-hidden="true" />
                      : <X className="capability-off" aria-hidden="true" />}
                    <div>
                      <strong>{label}</strong>
                      <small>{enabled ? onLabel : offLabel}</small>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : healthQuery.error ? (
            <CardNotice message={`无法读取能力开关：${healthQuery.error.message}`} onRetry={healthQuery.refetch} />
          ) : (
            <div className="skeleton-panel" style={{ height: 120 }} aria-busy="true" aria-label="正在读取能力开关" />
          )}
        </section>

        <section className="panel settings-contacts-panel">
          <header className="panel-header">
            <div><Users /><h2>可联系同事</h2></div>
            <span className="contacts-hint">Agent 只会主动联系这里开启「允许主动联系」的同事。</span>
          </header>
          {contactsQuery.error && !contactsQuery.data ? (
            <CardNotice message={`无法读取联系人配置：${contactsQuery.error.message}`} onRetry={contactsQuery.refetch} />
          ) : contactsQuery.loading && !contactsQuery.data ? (
            <div className="skeleton-panel" style={{ height: 180 }} aria-busy="true" aria-label="正在读取联系人配置" />
          ) : (
            <>
              <ul className="contact-list">
                {contacts.length === 0 && <li className="contact-empty">还没有配置联系人。添加后 Agent 才能主动联系对方。</li>}
                {contacts.map((contact) => (
                  <li key={contact.employeeNumber}>
                    <span className="person-avatar" aria-hidden="true">{contact.avatarInitials ?? contact.name.slice(0, 2)}</span>
                    <div className="contact-info">
                      <strong>{contact.name}</strong>
                      <small>{contact.employeeNumber}{contact.department ? ` · ${contact.department}` : ""}</small>
                    </div>
                    <span className={`contact-permission ${contact.autoContact ? "contact-permission-on" : "contact-permission-off"}`}>
                      {contact.autoContact ? <Check aria-hidden="true" /> : <X aria-hidden="true" />}
                      {contact.autoContact ? "允许主动联系" : "不会主动联系"}
                    </span>
                    <span className="contact-actions">
                      <button className="icon-button" aria-label={`编辑联系人 ${contact.name}`} disabled={pendingContact} onClick={() => editContact(contact)}><Pencil /></button>
                      <button className="icon-button contact-remove" aria-label={`移除联系人 ${contact.name}`} disabled={pendingContact} onClick={() => setRemoveTarget(contact)}><Trash2 /></button>
                    </span>
                  </li>
                ))}
              </ul>

              <form
                className="contact-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (draftValid && !pendingContact) void submitContact();
                }}
              >
                <div className="contact-form-title">{editing ? `编辑联系人 ${draft.employeeNumber}` : "添加联系人"}</div>
                <label>
                  <span>员工号</span>
                  <input
                    value={draft.employeeNumber}
                    onChange={(event) => setDraft({ ...draft, employeeNumber: event.target.value })}
                    inputMode="numeric"
                    placeholder="例如 00200000"
                    disabled={editing || pendingContact}
                    aria-invalid={Boolean(draftEmployeeError)}
                  />
                  {draftEmployeeError && <small role="alert">{draftEmployeeError}</small>}
                </label>
                <label>
                  <span>姓名</span>
                  <input
                    value={draft.name}
                    onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                    placeholder="例如 王璐"
                    disabled={pendingContact}
                    aria-invalid={Boolean(draftNameError && draft.name.length > 0)}
                  />
                  {draft.name.length > 0 && draftNameError && <small role="alert">{draftNameError}</small>}
                </label>
                <label>
                  <span>部门（可选）</span>
                  <input
                    value={draft.department}
                    onChange={(event) => setDraft({ ...draft, department: event.target.value })}
                    placeholder="例如 市场部"
                    disabled={pendingContact}
                  />
                </label>
                <label className="contact-checkbox">
                  <input
                    type="checkbox"
                    checked={draft.autoContact}
                    onChange={(event) => setDraft({ ...draft, autoContact: event.target.checked })}
                    disabled={pendingContact}
                  />
                  <span>允许 Agent 主动给这位同事发消息</span>
                </label>
                <div className="contact-form-actions">
                  <button type="submit" className="button button-primary" disabled={!draftValid || pendingContact}>
                    {pendingContact ? "正在保存…" : editing ? "保存修改" : "添加联系人"}
                  </button>
                  {editing && (
                    <button type="button" className="button button-quiet" onClick={resetDraft} disabled={pendingContact}>取消编辑</button>
                  )}
                </div>
                {contactError && <p className="contact-form-error" role="alert">{contactError}</p>}
              </form>
            </>
          )}
        </section>
      </div>

      <ConfirmDialog
        open={removeTarget !== null}
        title={`移除联系人 ${removeTarget?.name ?? ""}？`}
        description="移除后 Agent 不会再主动联系这位同事；正在进行的相关任务会按策略等待或寻求确认。此操作只改本地联系人配置，不会撤回已发送的消息。"
        confirmLabel="移除联系人"
        tone="danger"
        onConfirm={() => void confirmRemove()}
        onClose={() => setRemoveTarget(null)}
      />
      {toast && <Toast message={toast} onClose={() => setToast("")} />}
    </div>
  );
}
