interface BrandLogoProps {
  size?: 'sm' | 'lg';
  className?: string;
}

export function BrandLogo({ size = 'lg', className }: BrandLogoProps) {
  const isLarge = size === 'lg';
  const markSize = isLarge ? 32 : 28;
  const classes = className ? `sf-brand ${className}` : 'sf-brand';

  return (
    <div className={classes}>
      <div
        className={`sf-brand-mark ${isLarge ? 'sf-brand-mark-lg' : 'sf-brand-mark-sm'}`}
        aria-hidden="true"
      >
        <svg viewBox="0 0 64 64" width={markSize} height={markSize}>
          <path
            fill="currentColor"
            d="M21.9 45.4c-5.4 0-9-2.8-9.3-7.6h4.9c.3 2.2 1.8 3.5 4.5 3.5 2.4 0 3.9-1.1 3.9-2.9 0-1.6-1-2.5-3.6-3.1l-3.1-.7c-4.3-1-6.2-3.2-6.2-6.8 0-4.6 3.5-7.6 8.8-7.6 5.1 0 8.4 2.7 8.8 7.2h-4.8c-.3-2-1.7-3.1-4.1-3.1-2.2 0-3.6 1-3.6 2.8 0 1.5 1 2.3 3.4 2.9l3.1.7c4.5 1.1 6.5 3.3 6.5 7 0 4.8-3.6 7.7-9.2 7.7ZM34.5 45V20.6h16.4v4.3H39.6v5.9h9.5v4.2h-9.5V45h-5.1Z"
          />
        </svg>
      </div>
      <div className="sf-brand-text">
        <span className="sf-brand-eyebrow">SmartFlow</span>
        <span className={`sf-brand-name ${isLarge ? 'sf-brand-name-lg' : 'sf-brand-name-sm'}`}>
          Plattform
        </span>
      </div>
    </div>
  );
}
