import { useEffect, useState } from "react";

export type DialogRequest = {
  id: number;
  kind: "confirm" | "input";
  title: string;
  description: string;
  confirmLabel: string;
  tone?: "accent" | "danger";
  defaultValue?: string;
  placeholder?: string;
  inputLabel?: string;
  onConfirm: (value?: string) => void;
};

export function Dialog({
  request,
  onClose,
}: {
  request: DialogRequest;
  onClose: () => void;
}) {
  const [value, setValue] = useState(request.defaultValue ?? "");

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  function submit() {
    request.onConfirm(request.kind === "input" ? value : undefined);
  }

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div
        className={`dialog dialog--${request.tone ?? "accent"}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`dialog-title-${request.id}`}
        aria-describedby={`dialog-description-${request.id}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog__signal"><span /></div>
        <div className="dialog__copy">
          <span className="eyebrow">SECURITY CONSOLE</span>
          <h3 id={`dialog-title-${request.id}`}>{request.title}</h3>
          <p id={`dialog-description-${request.id}`}>{request.description}</p>
        </div>
        {request.kind === "input" ? (
          <label className="dialog__field">
            <span>{request.inputLabel ?? "Reason"}</span>
            <input
              autoFocus
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={request.placeholder}
              maxLength={240}
              onKeyDown={(event) => {
                if (event.key === "Enter" && value.trim()) submit();
              }}
            />
          </label>
        ) : null}
        <div className="dialog__actions">
          <button type="button" className="button button--subtle" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={`button ${request.tone === "danger" ? "dialog__confirm--danger" : "button--primary"}`}
            onClick={submit}
            disabled={request.kind === "input" && !value.trim()}
          >
            {request.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
