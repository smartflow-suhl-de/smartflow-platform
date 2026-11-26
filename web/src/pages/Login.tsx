import { useEffect, useState, type FormEvent } from 'react';
import { BrandLogo } from '../components/BrandLogo';
import { ArrowRightIcon, KeyIcon, MoonIcon, SunIcon } from '../components/icons';
import { Button, Card, Field, Input } from '../components/ui';
import { ApiError, api } from '../lib/api';
import { formatApiError, formatFieldError, type Locale, type Messages } from '../lib/i18n';
import {
  confirmMagicLinkOnce,
  magicLinkNotice,
  toAppHref,
  tokenFromSearch,
} from '../lib/auth-flow';
import { AppLink, navigate } from '../lib/router';
import type { AuthMe, MagicLinkResponse } from '../lib/types';
import type { Mode } from '../theme';

export interface LoginPageProps {
  pathname: string;
  search: string;
  mode: Mode;
  locale: Locale;
  messages: Messages;
  /** Shown above the form, e.g. after a data route answered 401. */
  notice?: string | null;
  onModeChange: (mode: Mode) => void;
  onLocaleChange: (locale: Locale) => void;
  onSignedIn: (auth: AuthMe) => void;
}

export function LoginPage({
  pathname,
  search,
  mode,
  locale,
  messages,
  notice = null,
  onModeChange,
  onLocaleChange,
  onSignedIn,
}: LoginPageProps) {
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState<string | undefined>(undefined);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [magicResult, setMagicResult] = useState<MagicLinkResponse | null>(null);

  useEffect(() => {
    if (pathname !== '/login/confirm') return;
    const token = tokenFromSearch(search);
    if (!token) {
      setFormError(messages.login.confirmFailed);
      return;
    }

    let active = true;
    setConfirming(true);
    setFormError(null);

    confirmMagicLinkOnce(token)
      .then((auth) => {
        if (!active) return;
        navigate('/', { replace: true });
        onSignedIn(auth);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setConfirming(false);
        setFormError(formatApiError(error, locale));
        navigate('/login', { replace: true });
      });

    return () => {
      active = false;
    };
  }, [pathname, search, locale, messages.login.confirmFailed, onSignedIn]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setEmailError(undefined);
    setFormError(null);
    setMagicResult(null);
    setSubmitting(true);

    try {
      const response = await api.requestMagicLink(email.trim());
      if (response.autoLogin && response.link) {
        const parsed = new URL(response.link, window.location.origin);
        const token = parsed.searchParams.get('token');
        if (token) {
          setConfirming(true);
          const auth = await confirmMagicLinkOnce(token);
          navigate('/', { replace: true });
          onSignedIn(auth);
          return;
        }
      }
      setMagicResult(response);
    } catch (error) {
      if (error instanceof ApiError && error.fields.email) {
        setEmailError(formatFieldError('email', error.fields.email, locale));
      } else {
        setFormError(formatApiError(error, locale));
      }
    } finally {
      setSubmitting(false);
    }
  }

  const resultNotice = magicResult ? magicLinkNotice(magicResult) : null;

  return (
    <div className="sf-login-shell">
      <div className="sf-login-bar">
        <div className="sf-locale-switch" role="group" aria-label={messages.common.languageLabel}>
          <button
            type="button"
            onClick={() => onLocaleChange('de')}
            aria-pressed={locale === 'de'}
            className={locale === 'de' ? 'sf-locale-btn sf-locale-btn-active' : 'sf-locale-btn'}
          >
            DE
          </button>
          <button
            type="button"
            onClick={() => onLocaleChange('en')}
            aria-pressed={locale === 'en'}
            className={locale === 'en' ? 'sf-locale-btn sf-locale-btn-active' : 'sf-locale-btn'}
          >
            EN
          </button>
        </div>
        <Button
          variant="secondary"
          size="icon"
          aria-label={mode === 'dark' ? messages.common.lightMode : messages.common.darkMode}
          aria-pressed={mode === 'dark'}
          onClick={() => onModeChange(mode === 'dark' ? 'light' : 'dark')}
        >
          {mode === 'dark' ? <SunIcon size={15} /> : <MoonIcon size={15} />}
        </Button>
      </div>

      <main className="sf-login-center">
        <div className="sf-login-box">
          <div className="sf-login-logo">
            <BrandLogo size="lg" />
          </div>

          <Card>
            <div className="sf-card-body">
              {confirming ? (
                <>
                  <h1 className="sf-login-title">{messages.login.confirmTitle}</h1>
                  <p className="sf-login-subtitle">{messages.login.confirmChecking}</p>
                </>
              ) : (
                <>
                  <h1 className="sf-login-title">{messages.login.title}</h1>
                  <p className="sf-login-subtitle">{messages.login.subtitle}</p>

                  {notice ? (
                    <div className="sf-alert sf-alert-bad" role="alert">
                      <span>{notice}</span>
                    </div>
                  ) : null}

                  <form className="sf-login-form" onSubmit={handleSubmit}>
                    {formError ? (
                      <div className="sf-alert sf-alert-bad" role="alert">
                        <span>{formError}</span>
                      </div>
                    ) : null}

                    <Field
                      label={messages.login.emailLabel}
                      hint={messages.login.emailRequiredHint}
                      error={emailError}
                      htmlFor="sf-login-email"
                    >
                      <Input
                        id="sf-login-email"
                        type="email"
                        autoComplete="email"
                        value={email}
                        onChange={(event) => setEmail(event.target.value)}
                        placeholder={messages.login.emailPlaceholder}
                        invalid={Boolean(emailError)}
                        disabled={submitting}
                        required
                      />
                    </Field>

                    <Button
                      type="submit"
                      variant="primary"
                      fullWidth
                      disabled={submitting || email.trim().length === 0}
                    >
                      <KeyIcon size={14} />
                      <span>{submitting ? messages.login.submitting : messages.login.submit}</span>
                    </Button>
                  </form>

                  {resultNotice ? (
                    <div className="sf-login-result">
                      {resultNotice.kind === 'dev_link' ? (
                        <>
                          <div className="sf-alert sf-alert-info" role="status">
                            <span>{messages.login.devLinkNotice}</span>
                          </div>
                          <AppLink
                            to={toAppHref(resultNotice.link, window.location.origin)}
                            className="sf-btn sf-btn-secondary sf-btn-full"
                          >
                            <span>{messages.login.devLinkAction}</span>
                            <ArrowRightIcon size={14} />
                          </AppLink>
                        </>
                      ) : resultNotice.kind === 'sent' ? (
                        <div className="sf-alert sf-alert-info" role="status">
                          <span>{messages.login.sentNotice}</span>
                        </div>
                      ) : (
                        // No transport: "check your inbox" would be a lie. The
                        // alert role is deliberate, the operator has to act.
                        <div className="sf-alert sf-alert-bad" role="alert">
                          <span>{messages.login.noTransportNotice}</span>
                        </div>
                      )}
                    </div>
                  ) : null}
                </>
              )}
            </div>
          </Card>

          <p className="sf-login-footer">{messages.login.footerNote}</p>
        </div>
      </main>
    </div>
  );
}
