import {
  cloneElement,
  forwardRef,
  isValidElement,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
  useRef,
} from 'react';
import { CloseIcon } from './icons';
import { useFocusTrap } from './useFocusTrap';

function joinClasses(...parts: Array<string | false | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'md' | 'sm' | 'icon';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    fullWidth = false,
    className,
    children,
    type = 'button',
    ...props
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={joinClasses(
        'sf-btn',
        `sf-btn-${variant}`,
        size === 'sm' && 'sf-btn-sm',
        size === 'icon' && 'sf-btn-icon',
        fullWidth && 'sf-btn-full',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
});

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { invalid = false, className, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      className={joinClasses('sf-input', invalid && 'sf-input-invalid', className)}
      {...props}
    />
  );
});

export interface FieldProps {
  label: string;
  hint?: string;
  error?: string;
  htmlFor?: string;
  children: ReactNode;
}

/**
 * Gives the control its `aria-describedby`, built from the ids `Field` renders
 * below. Only text that exists is referenced: a dangling id would make a screen
 * reader announce nothing at all.
 */
function linkDescription(children: ReactNode, describedBy: string): ReactNode {
  if (describedBy === '' || !isValidElement(children)) return children;
  const child = children as ReactElement<{ 'aria-describedby'?: string }>;
  const existing = child.props['aria-describedby'];
  return cloneElement(child, {
    'aria-describedby': existing ? `${existing} ${describedBy}` : describedBy,
  });
}

export function Field({ label, hint, error, htmlFor, children }: FieldProps) {
  // The ids derive from the control id, so hint and error always belong to the
  // input the label points at. Without `htmlFor` there is nothing to describe.
  const hintId = htmlFor && hint ? `${htmlFor}-hint` : null;
  const errorId = htmlFor && error ? `${htmlFor}-error` : null;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ');

  return (
    <div className="sf-field">
      <div className="sf-field-label">
        <label className="label" htmlFor={htmlFor}>
          {label}
        </label>
        {hint ? (
          <span id={hintId ?? undefined} className="sf-field-hint">
            {hint}
          </span>
        ) : null}
      </div>
      {linkDescription(children, describedBy)}
      {error ? (
        <div id={errorId ?? undefined} className="sf-field-error" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}

export type BadgeTone = 'good' | 'warn' | 'bad' | 'neutral' | 'accent';

export function Badge({ tone = 'neutral', children }: { tone?: BadgeTone; children: ReactNode }) {
  return (
    <span className={joinClasses('sf-badge', tone !== 'neutral' && `sf-badge-${tone}`)}>
      <span
        className={`sf-dot sf-dot-${tone === 'accent' ? 'neutral' : tone}`}
        aria-hidden="true"
      />
      {children}
    </span>
  );
}

export function Card({
  children,
  className,
  as: Tag = 'section',
}: {
  children: ReactNode;
  className?: string;
  as?: 'section' | 'div' | 'article';
}) {
  return <Tag className={joinClasses('sf-card', className)}>{children}</Tag>;
}

export function CardHeader({
  title,
  meta,
  actions,
}: {
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="sf-card-head">
      <div>
        <h2 className="sf-card-title">{title}</h2>
        {meta ? <div className="sf-card-meta">{meta}</div> : null}
      </div>
      {actions ? <div className="sf-page-actions">{actions}</div> : null}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="sf-page-head">
      <div>
        <h1 className="sf-page-title">{title}</h1>
        {description ? <p className="sf-page-desc">{description}</p> : null}
      </div>
      {actions ? <div className="sf-page-actions">{actions}</div> : null}
    </header>
  );
}

export function KpiTile({
  label,
  value,
  hint,
  tone = 'neutral',
  icon,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'accent';
  icon?: ReactNode;
}) {
  return (
    <div className="sf-kpi">
      <div className="sf-kpi-top">
        <span className="label">{label}</span>
        {icon ?? null}
      </div>
      <div className={`sf-kpi-value sf-kpi-value-${tone}`}>{value}</div>
      {hint ? <div className="sf-kpi-hint">{hint}</div> : null}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="sf-empty">
      <div className="sf-empty-title-row">
        {icon ?? null}
        <h2 className="sf-empty-title">{title}</h2>
      </div>
      <p className="sf-empty-desc">{description}</p>
      {action ? <div className="sf-empty-action">{action}</div> : null}
    </div>
  );
}

export interface ConfirmModalProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel: string;
  closeLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmModal({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel,
  closeLabel,
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useFocusTrap(dialogRef, open, {
    onEscape: onCancel,
    escapeDisabled: busy,
    initialFocusRef: cancelRef,
  });

  if (!open) return null;

  return (
    <>
      <div className="sf-overlay-backdrop" onClick={() => !busy && onCancel()} aria-hidden="true" />
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="sf-confirm-title"
        aria-describedby="sf-confirm-desc"
        tabIndex={-1}
        className="sf-modal"
      >
        <div className="sf-modal-head">
          <h2 id="sf-confirm-title" className="sf-modal-title">
            {title}
          </h2>
          <Button
            variant="ghost"
            size="icon"
            aria-label={closeLabel}
            disabled={busy}
            onClick={onCancel}
          >
            <CloseIcon size={16} />
          </Button>
        </div>
        <div id="sf-confirm-desc" className="sf-modal-body">
          {description}
        </div>
        <div className="sf-modal-foot">
          <Button ref={cancelRef} variant="secondary" disabled={busy} onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} disabled={busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </>
  );
}
