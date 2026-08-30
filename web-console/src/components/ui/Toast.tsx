import { AlertTriangle, CheckCircle2, X } from "lucide-react";

export function Toast({ message, tone = "success", onClose }: { message: string; tone?: "success" | "danger"; onClose: () => void }) {
  const Icon = tone === "danger" ? AlertTriangle : CheckCircle2;
  return (
    <div className={`toast${tone === "danger" ? " toast-danger" : ""}`} role="status" aria-live="polite">
      <Icon aria-hidden="true" />
      <span>{message}</span>
      <button className="icon-button" onClick={onClose} aria-label="关闭提示"><X /></button>
    </div>
  );
}
