import { CheckCircle2, X } from "lucide-react";

export function Toast({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <div className="toast" role="status" aria-live="polite">
      <CheckCircle2 aria-hidden="true" />
      <span>{message}</span>
      <button className="icon-button" onClick={onClose} aria-label="关闭提示"><X /></button>
    </div>
  );
}
