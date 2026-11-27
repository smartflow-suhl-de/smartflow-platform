/**
 * Small "?" affordance for field hints. The bubble is CSS-only (hover/focus),
 * so it needs no state and stays accessible through `aria-label` plus the
 * tooltip role.
 */
export function HelpTip({ text }: { text: string }) {
  return (
    <span className="sf-help-tip" tabIndex={0} aria-label={text}>
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="10" />
        <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
      <span className="sf-help-tip-bubble" role="tooltip">
        {text}
      </span>
    </span>
  );
}

export default HelpTip;