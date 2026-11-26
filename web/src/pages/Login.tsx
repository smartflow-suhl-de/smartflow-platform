import { useEffect, useRef, useState, type FormEvent } from 'react';
import { BrandLogo } from '../components/BrandLogo';
import { KeyIcon, MoonIcon, SunIcon } from '../components/icons';
import { Button, Card, Field, Input } from '../components/ui';
import { ApiError, api, isAbortError } from '../lib/api';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  createSubmitGuard,
  passwordProblem,
} from '../lib/auth-flow';
import { formatApiError, formatFieldError, type Locale, type Messages } from '../lib/i18n';
import { navigate } from '../lib/router';
import type { AuthMe } from '../lib/types';
import type { Mode } from '../theme';

export interface LoginPageProps {
  mode: Mode;
  locale: Locale;
  messages: Messages;
  /** Shown above the form, e.g. after a data route answered 401. */
  notice?: string | null;
  onModeChange: (mode: Mode) => void;
  onLocaleChange: (locale: Locale) => void;
  onSignedIn: (auth: AuthMe) => void;
}

/** What the page is showing: a probe first, then exactly one form. */
type FormMode = 'checking' | 'setup' | 'login' | 'unavailable';

type FieldName = 'email' | 'name' | 'password' | 'passwordRepeat';
type FieldErrors = Partial<Record<FieldName, string>>;

const FIELD_ORDER: FieldName[] = ['email', 'name', 'password', 'passwordRepeat'];

function firstFieldWithError(errors: FieldErrors): FieldName | null {
  return FIELD_ORDER.find((field) => Boolean(errors[field])) ?? null;
}

export function LoginPage({
  mode,
  locale,
  messages,
  notice = null,
  onModeChange,
  onLocaleChange,
  onSignedIn,
}: LoginPageProps) {
  const [formMode, setFormMode] = useState<FormMode>('checking');
  const [checkVersion, setCheckVersion] = useState(0);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [passwordRepeat, setPasswordRepeat] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submitGuard = useRef(createSubmitGuard());

  const emailRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const repeatRef = useRef<HTMLInputElement>(null);
  const formAlertRef = useRef<HTMLDivElement>(null);
  // Set where focus belongs, then move it once the error text is rendered. A
  // straight `.focus()` during the handler would point at a field that is not
  // yet marked invalid and would miss the alert entirely.
  const pendingFocus = useRef<FieldName | 'form' | null>(null);

  useEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    pendingFocus.current = null;
    if (target === 'form') {
      formAlertRef.current?.focus();
      return;
    }
    const refs = {
      email: emailRef,
      name: nameRef,
      password: passwordRef,
      passwordRepeat: repeatRef,
    };
    refs[target].current?.focus();
  });

  useEffect(() => {
    const controller = new AbortController();

    api
      .setupStatus(controller.signal)
      .then((status) => {
        setFormMode(status.required ? 'setup' : 'login');
      })
      .catch((error: unknown) => {
        if (isAbortError(error)) return;
        setFormMode('unavailable');
      });

    return () => controller.abort();
  }, [checkVersion]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitGuard.current.busy) return;
    setFieldErrors({});
    setFormError(null);

    if (formMode === 'setup') {
      // The server enforces the same rules. Checking here keeps the message
      // local and immediate, and the repeat field never leaves the browser.
      const errors: FieldErrors = {};
      if (name.trim().length === 0) errors.name = messages.login.nameRequired;
      const problem = passwordProblem(password);
      if (problem === 'blank') errors.password = messages.login.passwordBlank;
      else if (problem === 'too_short') {
        errors.password = messages.login.passwordTooShort(PASSWORD_MIN_LENGTH);
      } else if (problem === 'too_long') {
        errors.password = messages.login.passwordTooLong(PASSWORD_MAX_LENGTH);
      }
      if (password !== passwordRepeat) {
        errors.passwordRepeat = messages.login.passwordMismatch;
      }
      if (Object.keys(errors).length > 0) {
        setFieldErrors(errors);
        pendingFocus.current = firstFieldWithError(errors) ?? 'form';
        return;
      }
    }

    setSubmitting(true);
    await submitGuard.current.run(async () => {
      try {
        const auth =
          formMode === 'setup'
            ? await api.setup({ email: email.trim(), name: name.trim(), password })
            : await api.login({ email: email.trim(), password });

        navigate('/', { replace: true });
        onSignedIn(auth);
        return;
      } catch (error) {
        if (error instanceof ApiError && error.code === 'setup_complete') {
          // Another client created the first account while this form was open.
          // The account exists now, so show the sign-in form and say why.
          setFormMode('login');
          setPassword('');
          setPasswordRepeat('');
          setFormError(messages.login.setupCompleteNotice);
          pendingFocus.current = 'form';
          return;
        }

        if (error instanceof ApiError && Object.keys(error.fields).length > 0) {
          const errors: FieldErrors = {
            email: formatFieldError('email', error.fields.email, locale),
            password: formatFieldError('password', error.fields.password, locale),
          };
          if (formMode === 'setup') {
            errors.name = error.fields.name ? messages.login.nameRequired : undefined;
          }
          setFieldErrors(errors);
          pendingFocus.current = firstFieldWithError(errors) ?? 'form';
          if (firstFieldWithError(errors) === null) {
            setFormError(formatApiError(error, locale));
          }
          return;
        }

        setFormError(formatApiError(error, locale));
        pendingFocus.current = 'form';
      } finally {
        setSubmitting(false);
      }
    });
  }

  const isSetup = formMode === 'setup';

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
              {formMode === 'checking' ? (
                <>
                  <h1 className="sf-login-title">{messages.login.title}</h1>
                  <p className="sf-login-subtitle" role="status">
                    {messages.login.setupLoading}
                  </p>
                </>
              ) : formMode === 'unavailable' ? (
                <>
                  <h1 className="sf-login-title">{messages.login.title}</h1>
                  <p className="sf-login-subtitle">{messages.login.subtitle}</p>
                  <div className="sf-alert sf-alert-bad" role="alert">
                    <span>{messages.login.setupCheckFailed}</span>
                  </div>
                  <div className="sf-login-form">
                    <Button
                      variant="secondary"
                      fullWidth
                      onClick={() => {
                        setFormMode('checking');
                        setCheckVersion((version) => version + 1);
                      }}
                    >
                      {messages.common.retry}
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <h1 className="sf-login-title">
                    {isSetup ? messages.login.setupTitle : messages.login.title}
                  </h1>
                  <p className="sf-login-subtitle">
                    {isSetup ? messages.login.setupSubtitle : messages.login.subtitle}
                  </p>

                  {notice ? (
                    <div className="sf-alert sf-alert-bad" role="alert">
                      <span>{notice}</span>
                    </div>
                  ) : null}

                  <form className="sf-login-form" onSubmit={handleSubmit} aria-busy={submitting}>
                    {formError ? (
                      <div
                        ref={formAlertRef}
                        className="sf-alert sf-alert-bad"
                        role="alert"
                        tabIndex={-1}
                      >
                        <span>{formError}</span>
                      </div>
                    ) : null}

                    <Field
                      label={messages.login.emailLabel}
                      hint={messages.login.emailRequiredHint}
                      error={fieldErrors.email}
                      htmlFor="sf-login-email"
                    >
                      <Input
                        ref={emailRef}
                        id="sf-login-email"
                        type="email"
                        autoComplete="email"
                        value={email}
                        onChange={(event) => setEmail(event.target.value)}
                        placeholder={messages.login.emailPlaceholder}
                        invalid={Boolean(fieldErrors.email)}
                        disabled={submitting}
                        required
                      />
                    </Field>

                    {isSetup ? (
                      <Field
                        label={messages.login.nameLabel}
                        error={fieldErrors.name}
                        htmlFor="sf-login-name"
                      >
                        <Input
                          ref={nameRef}
                          id="sf-login-name"
                          type="text"
                          autoComplete="name"
                          value={name}
                          onChange={(event) => setName(event.target.value)}
                          placeholder={messages.login.namePlaceholder}
                          invalid={Boolean(fieldErrors.name)}
                          disabled={submitting}
                          required
                        />
                      </Field>
                    ) : null}

                    <Field
                      label={messages.login.passwordLabel}
                      hint={isSetup ? messages.login.passwordHint : undefined}
                      error={fieldErrors.password}
                      htmlFor="sf-login-password"
                    >
                      <Input
                        ref={passwordRef}
                        id="sf-login-password"
                        type="password"
                        autoComplete={isSetup ? 'new-password' : 'current-password'}
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        placeholder={messages.login.passwordPlaceholder}
                        maxLength={PASSWORD_MAX_LENGTH}
                        invalid={Boolean(fieldErrors.password)}
                        disabled={submitting}
                        required
                      />
                    </Field>

                    {isSetup ? (
                      <Field
                        label={messages.login.passwordRepeatLabel}
                        error={fieldErrors.passwordRepeat}
                        htmlFor="sf-login-password-repeat"
                      >
                        <Input
                          ref={repeatRef}
                          id="sf-login-password-repeat"
                          type="password"
                          autoComplete="new-password"
                          value={passwordRepeat}
                          onChange={(event) => setPasswordRepeat(event.target.value)}
                          maxLength={PASSWORD_MAX_LENGTH}
                          invalid={Boolean(fieldErrors.passwordRepeat)}
                          disabled={submitting}
                          required
                        />
                      </Field>
                    ) : null}

                    <Button type="submit" variant="primary" fullWidth disabled={submitting}>
                      <KeyIcon size={14} />
                      <span>
                        {isSetup
                          ? submitting
                            ? messages.login.setupSubmitting
                            : messages.login.setupSubmit
                          : submitting
                            ? messages.login.submitting
                            : messages.login.submit}
                      </span>
                    </Button>
                  </form>
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
