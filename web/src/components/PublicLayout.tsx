import { useEffect, useRef, type ReactNode } from 'react';
import type { Locale } from '../lib/i18n';
import { BrandLogo } from './BrandLogo';

/**
 * Texts of the public shell. They live here, not in the app catalogue, because
 * the public area is separate from the signed-in app and must not grow it.
 */
const TEXT: Record<
  Locale,
  {
    skip: string;
    platform: string;
    legal: string;
    unavailableTitle: string;
    unavailableBody: string;
  }
> = {
  de: {
    skip: 'Zum Inhalt springen',
    platform: 'SmartFlow Plattform',
    legal: 'Datenschutz und Impressum: Angaben noch offen.',
    unavailableTitle: 'Dieser Link ist nicht verfügbar',
    unavailableBody:
      'Der Link ist abgelaufen, wurde widerrufen oder ist nicht korrekt. Bitte frage bei der Person nach, die ihn dir geschickt hat.',
  },
  en: {
    skip: 'Skip to content',
    platform: 'SmartFlow Platform',
    legal: 'Privacy notice and imprint: details still open.',
    unavailableTitle: 'This link is not available',
    unavailableBody:
      'The link has expired, was revoked or is not correct. Please ask the person who sent it to you.',
  },
};

interface PublicLayoutProps {
  locale: Locale;
  /** Page title; the platform name is appended. */
  title?: string;
  children: ReactNode;
}

/**
 * Frame for public pages: brand header, one column, footer. No navigation, no
 * account controls. Keeps the page out of search indexes.
 */
export function PublicLayout({ locale, title, children }: PublicLayoutProps) {
  const text = TEXT[locale];
  const mainRef = useRef<HTMLElement>(null);
  const documentTitle = title ? `${title} · ${text.platform}` : text.platform;

  useEffect(() => {
    // Start on the heading, so a screen reader announces the page, not the
    // brand. The heading is not a tab stop, it only takes programmatic focus.
    const heading = mainRef.current?.querySelector('h1');
    if (heading) {
      heading.setAttribute('tabindex', '-1');
      heading.focus({ preventScroll: true });
    }
  }, []);

  return (
    <div className="sf-login-shell">
      {/* React 19 moves these into the document head. */}
      <title>{documentTitle}</title>
      <meta name="robots" content="noindex, nofollow" />
      <a href="#sf-main" className="sf-skip-link">
        {text.skip}
      </a>
      <header>
        <BrandLogo size="sm" />
      </header>
      <main id="sf-main" ref={mainRef} className="sf-login-center">
        <div className="sf-login-box">{children}</div>
      </main>
      <footer className="sf-login-footer">{text.legal}</footer>
    </div>
  );
}

/** Friendly page for an unknown, expired or not yet served public link. */
export function PublicUnavailable({ locale }: { locale: Locale }) {
  const text = TEXT[locale];
  return (
    <section>
      <h1 className="sf-login-title">{text.unavailableTitle}</h1>
      <p className="sf-login-subtitle">{text.unavailableBody}</p>
    </section>
  );
}
