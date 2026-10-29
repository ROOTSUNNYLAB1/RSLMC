import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { AlertTriangle, Check, CheckCircle2, Copy, Info, Loader2, X, XCircle } from "lucide-react";

/* ------------------------------- Button -------------------------------- */
type ButtonVariant = "default" | "primary" | "success" | "warn" | "danger" | "ghost";

export function Button({
  variant = "default", size, icon, loading, children, className = "", ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant; size?: "sm"; icon?: ReactNode; loading?: boolean;
}) {
  const classes = [
    "btn",
    variant !== "default" ? `btn-${variant}` : "",
    size === "sm" ? "btn-sm" : "",
    !children ? "btn-icon" : "",
    className,
  ].filter(Boolean).join(" ");
  return (
    <button className={classes} {...rest} disabled={rest.disabled || loading}>
      {loading ? <span className="spinner" aria-hidden /> : icon}
      {children}
    </button>
  );
}

/* ------------------------------- Pills --------------------------------- */
export function Pill({ tone = "neutral", children, dot = false }: { tone?: "green" | "red" | "amber" | "blue" | "neutral" | "violet"; children: ReactNode; dot?: boolean }) {
  return (
    <span className={`pill pill-${tone}`}>
      {dot ? <span className="dot" /> : null}
      {children}
    </span>
  );
}

/* -------------------------------- Card --------------------------------- */
export function Card({ title, icon, actions, children, bodyClass = "", header = true }: {
  title?: ReactNode; icon?: ReactNode; actions?: ReactNode; children: ReactNode; bodyClass?: string; header?: boolean;
}) {
  return (
    <section className="card">
      {header && (title || actions) ? (
        <header className="card-header">
          {title ? <div className="card-title">{icon}{title}</div> : null}
          {actions ? <div className="spacer" /> : null}
          {actions}
        </header>
      ) : null}
      <div className={`card-body ${bodyClass}`}>{children}</div>
    </section>
  );
}

/* ------------------------------ Stat card ------------------------------ */
export function StatCard({
  label, value, unit, meta, icon, accent = "var(--green)", trailing, progress, hint, hintTitle,
}: {
  label: string; value: ReactNode; unit?: string; meta?: ReactNode; icon?: ReactNode;
  accent?: string; trailing?: ReactNode; progress?: number; hint?: string;
  /** Same honesty note as `hint`, but shown on hover instead of taking a line of its own. */
  hintTitle?: string;
}) {
  return (
    <div className="stat-card" style={{ ["--accent" as any]: accent }} title={hintTitle ?? hint}>
      <div className="stat-label">
        <span>{label}</span>
        {trailing ? <span className="trailing">{trailing}</span> : null}
        {icon ? <span className="stat-chip" aria-hidden>{icon}</span> : null}
      </div>
      <div className="stat-value">
        {value}
        {unit ? <span className="unit">{unit}</span> : null}
      </div>
      {meta ? <div className="stat-meta">{meta}</div> : null}
      {progress !== undefined ? (
        <div className="stat-progress"><span style={{ width: `${Math.max(0, Math.min(100, progress))}%` }} /></div>
      ) : null}
      {hint ? <div className="stat-meta" style={{ fontSize: 10.5 }}>{hint}</div> : null}

    </div>
  );
}

/* ------------------------------ Page header ---------------------------- */
export function PageHeader({ title, icon, subtitle, actions, status }: {
  title: ReactNode; icon?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; status?: ReactNode;
}) {
  return (
    <div className="page-header">
      <div className="titles">
        <h1 className="page-title">
          {icon ? <span className="title-icon">{icon}</span> : null}
          {title}
          {status}
        </h1>
        {subtitle ? <div className="page-subtitle">{subtitle}</div> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </div>
  );
}

/* -------------------------------- Tabs --------------------------------- */
export function Tabs<T extends string>({ tabs, value, onChange, right }: {
  tabs: { id: T; label: string; count?: number }[]; value: T; onChange: (id: T) => void; right?: ReactNode;
}) {
  return (
    <div className="tabs-bar">
      <div className="tabs" role="tablist">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={value === tab.id}
            className={`tab ${value === tab.id ? "active" : ""}`}
            onClick={() => onChange(tab.id)}
          >
            {tab.label}
            {tab.count !== undefined ? <span className="count">({tab.count})</span> : null}
          </button>
        ))}
      </div>
      {right ? <div className="spacer" /> : null}
      {right}
    </div>
  );
}

/* -------------------------------- Fields ------------------------------- */
export function Field({ label, hint, error, required, children, className = "" }: {
  label?: ReactNode; hint?: ReactNode; error?: string | null; required?: boolean; children: ReactNode; className?: string;
}) {
  return (
    <label className={`field ${className}`}>
      {label ? <span className="field-label">{label}{required ? <span style={{ color: "var(--red)" }}>*</span> : null}</span> : null}
      {children}
      {hint && !error ? <span className="field-hint">{hint}</span> : null}
      {error ? <span className="field-error">{error}</span> : null}
    </label>
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input className="input" {...props} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className="select" {...props} />;
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className="textarea" {...props} />;
}

export function Toggle({ checked, onChange, label, disabled }: {
  checked: boolean; onChange: (value: boolean) => void; label?: ReactNode; disabled?: boolean;
}) {
  return (
    <div className="toggle-label">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={typeof label === "string" ? label : "Toggle"}
        className="toggle"
        disabled={disabled}
        onClick={() => onChange(!checked)}
      />
      {label ? <span>{label}</span> : null}
    </div>
  );
}

/* -------------------------------- Modal -------------------------------- */
export function Modal({ open, onClose, title, children, footer, size, icon }: {
  open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode;
  size?: "wide" | "narrow" | "xl"; icon?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Callers pass an inline onClose, so it changes identity on every render. Keeping it in a ref
  // means the focus effect only runs when the dialog opens — otherwise every keystroke re-ran it,
  // yanked focus back to the first focusable element and silently ate typed characters.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") closeRef.current(); };
    document.addEventListener("keydown", onKey);
    const previous = document.activeElement as HTMLElement | null;
    const active = document.activeElement as HTMLElement | null;
    // Never steal focus from something the user already put it in (e.g. a field that autofocused).
    if (!active || !ref.current?.contains(active)) {
      ref.current?.querySelector<HTMLElement>("input:not([disabled]), select, textarea, button")?.focus();
    }
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
      previous?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  // Rendered into <body>: any transformed/animated ancestor (page transitions, cards) would
  // otherwise become the containing block for `position: fixed` and the dialog would sit in
  // the middle of the content area instead of the middle of the screen — and get clipped.
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className={`modal ${size ?? ""}`} role="dialog" aria-modal="true" ref={ref}>
        <div className="modal-header">
          {icon}
          <div className="modal-title">{title}</div>
          <button className="icon-btn" style={{ marginLeft: "auto" }} onClick={onClose} aria-label="Close dialog">
            <X size={15} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-footer">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}

/* ---------------------------- Confirm dialog --------------------------- */
export function ConfirmDialog({
  open, title, message, confirmLabel = "Confirm", tone = "danger", onConfirm, onClose, requireText, busy,
}: {
  open: boolean; title: string; message: ReactNode; confirmLabel?: string;
  tone?: "danger" | "primary"; onConfirm: () => void; onClose: () => void; requireText?: string; busy?: boolean;
}) {
  const [typed, setTyped] = useState("");
  useEffect(() => { if (!open) setTyped(""); }, [open]);
  const blocked = Boolean(requireText) && typed !== requireText;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="narrow"
      icon={tone === "danger" ? <AlertTriangle size={16} color="var(--red)" /> : undefined}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant={tone} onClick={onConfirm} disabled={blocked} loading={busy}>{confirmLabel}</Button>
        </>
      }
    >
      <div style={{ fontSize: 12.5, lineHeight: 1.6, color: "var(--text-dim)" }}>{message}</div>
      {requireText ? (
        <Field label={<>Type <code className="mono" style={{ color: "var(--text)" }}>{requireText}</code> to confirm</>}>
          <Input value={typed} onChange={(event) => setTyped(event.target.value)} autoFocus />
        </Field>
      ) : null}
    </Modal>
  );
}

/* ------------------------------ Empty state ---------------------------- */
export function EmptyState({ icon, title, description, action }: {
  icon?: ReactNode; title: string; description?: ReactNode; action?: ReactNode;
}) {
  return (
    <div className="empty">
      {icon ? <div className="icon-wrap">{icon}</div> : null}
      <h4>{title}</h4>
      {description ? <p>{description}</p> : null}
      {action ? <div style={{ marginTop: 6 }}>{action}</div> : null}
    </div>
  );
}

/* ------------------------------- Loading ------------------------------- */
export function Loading({ label = "Loading…", minHeight = 160 }: { label?: string; minHeight?: number }) {
  return (
    <div className="empty" style={{ minHeight }} role="status" aria-live="polite">
      <Loader2 size={19} className="spin" style={{ animation: "spin 900ms linear infinite", color: "var(--text-faint)" }} />
      <span style={{ fontSize: 12 }}>{label}</span>
    </div>
  );
}

export function SkeletonRows({ rows = 4 }: { rows?: number }) {
  return (
    <div className="stack" style={{ padding: 12, gap: 8 }}>
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="skeleton" style={{ height: 14, width: `${100 - index * 9}%` }} />
      ))}
    </div>
  );
}

/* -------------------------------- Banner ------------------------------- */
export function Banner({ tone = "warning", title, children, action, icon }: {
  tone?: "warning" | "error" | "info" | "success"; title?: ReactNode; children?: ReactNode; action?: ReactNode; icon?: ReactNode;
}) {
  const defaultIcon = tone === "error" ? <XCircle size={15} color="#f28b8b" />
    : tone === "success" ? <CheckCircle2 size={15} color="#5fdc93" />
    : tone === "info" ? <Info size={15} color="#7fb2ff" />
    : <AlertTriangle size={15} color="#e8c46a" />;
  return (
    <div className={`banner ${tone === "warning" ? "" : tone}`} role={tone === "error" ? "alert" : "status"}>
      <span className="ic">{icon ?? defaultIcon}</span>
      <div style={{ minWidth: 0, flex: 1 }}>
        {title ? <b>{title}</b> : null}
        {children}
      </div>
      {action}
    </div>
  );
}

/* ------------------------------ Progress ------------------------------- */
export function ProgressBar({ value, max = 100, tone = "var(--blue)" }: { value: number; max?: number; tone?: string }) {
  const percent = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return <div className="progress"><span style={{ width: `${percent}%`, background: tone }} /></div>;
}

/* ------------------------------- Info row ------------------------------ */
export function InfoList({ rows }: { rows: { key: ReactNode; value: ReactNode }[] }) {
  return (
    <div className="info-list">
      {rows.map((row, index) => (
        <div className="info-row" key={index}>
          <span className="k">{row.key}</span>
          <span className="v">{row.value}</span>
        </div>
      ))}
    </div>
  );
}

/* --------------------------- Copy-to-clipboard -------------------------- */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to the legacy path */ }
  // Plain-HTTP deployments (and older browsers) have no async clipboard — use a hidden textarea.
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "readonly");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

/**
 * A value with a copy button — used for the server address, where "select the text and hope" is not
 * good enough on a phone or over plain HTTP.
 */
/**
 * The one place avatars are rendered: the uploaded picture when there is one, the coloured initials
 * otherwise (and again if the image fails to load, so a broken file never leaves a blank hole).
 */
export function Avatar({
  name, color, url, size = 28, className = "",
}: {
  name: string; color?: string | null; url?: string | null; size?: number; className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const box = { width: size, height: size, fontSize: Math.round(size * 0.36) };
  useEffect(() => { setFailed(false); }, [url]);
  if (url && !failed) {
    return (
      <img
        src={url}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        className={`avatar avatar-image ${className}`}
        style={box}
        onError={() => setFailed(true)}
      />
    );
  }
  const initials = name.trim().slice(0, 2).toUpperCase() || "??";
  return (
    <span className={`avatar ${className}`} style={{ ...box, background: color ?? "#2f6b4a" }} aria-hidden>
      {initials}
    </span>
  );
}

export function CopyValue({
  value, display, mono = true, className = "", title,
}: {
  value: string;
  display?: ReactNode;
  mono?: boolean;
  className?: string;
  title?: string;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 1600);
    return () => clearTimeout(timer);
  }, [state]);

  return (
    <span className={`copy-value ${className}`} title={title ?? `Copy ${value}`}>
      <span className={mono ? "mono copy-value-text" : "copy-value-text"}>{display ?? value}</span>
      <button
        type="button"
        className="copy-value-button"
        aria-label={state === "copied" ? "Copied" : `Copy ${value}`}
        onClick={async () => {
          const ok = await writeClipboard(value);
          setState(ok ? "copied" : "failed");
        }}
      >
        {state === "copied" ? <Check size={12} /> : <Copy size={12} />}
      </button>
      {state === "copied" ? <span className="copy-value-toast" role="status">Copied</span> : null}
      {state === "failed" ? <span className="copy-value-toast is-error" role="status">Copy failed</span> : null}
    </span>
  );
}
