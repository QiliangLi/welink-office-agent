import { useEffect, useRef, useState, type FormEvent } from "react";
import { X } from "lucide-react";

interface PromptDialogProps {
  open: boolean;
  title: string;
  description: string;
  placeholder?: string;
  confirmLabel: string;
  tone?: "primary" | "danger";
  multiline?: boolean;
  onConfirm: (value: string) => void;
  onClose: () => void;
}

/**
 * Small input dialog used for "给 Agent 新指令". Reuses the shared dialog
 * visual contract and keeps focus/aria semantics intact.
 */
export function PromptDialog({ open, title, description, placeholder, confirmLabel, tone = "primary", multiline = true, onConfirm, onClose }: PromptDialogProps) {
  const [value, setValue] = useState("");
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    cancelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, open]);

  if (!open) return null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!value.trim()) return;
    onConfirm(value.trim());
    setValue("");
  };

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <form className="dialog" role="dialog" aria-modal="true" aria-labelledby="prompt-dialog-title" onSubmit={submit}>
        <button type="button" className="icon-button dialog-close" onClick={onClose} aria-label="关闭对话框"><X /></button>
        <h2 id="prompt-dialog-title">{title}</h2>
        <p>{description}</p>
        {multiline ? (
          <textarea
            className="dialog-input"
            value={value}
            placeholder={placeholder}
            rows={4}
            onChange={(event) => setValue(event.target.value)}
            aria-label={title}
          />
        ) : (
          <input
            className="dialog-input"
            value={value}
            placeholder={placeholder}
            onChange={(event) => setValue(event.target.value)}
            aria-label={title}
          />
        )}
        <div className="dialog-actions">
          <button ref={cancelRef} type="button" className="button button-secondary" onClick={onClose}>取消</button>
          <button type="submit" className={`button ${tone === "danger" ? "button-danger" : "button-primary"}`} disabled={!value.trim()}>{confirmLabel}</button>
        </div>
      </form>
    </div>
  );
}
