import { ThemeSettings } from '../components/ThemeSettings';
import { Card, CardHeader, PageHeader } from '../components/ui';
import type { Locale, Messages } from '../lib/i18n';
import type { ThemeDefinition } from '../lib/themes';
import type { HealthResponse, SessionTenant, SessionUser } from '../lib/types';
import type { Mode } from '../theme';

export interface SettingsPageProps {
  user: SessionUser;
  tenant: SessionTenant | null;
  health: HealthResponse | null;
  mode: Mode;
  locale: Locale;
  messages: Messages;
  themes: readonly ThemeDefinition[];
  activeThemeId: string;
  onModeChange: (mode: Mode) => void;
  onLocaleChange: (locale: Locale) => void;
  onThemeChange: (theme: ThemeDefinition) => void;
  onRemoveCustomTheme: () => void;
}

export function SettingsPage({
  user,
  tenant,
  health,
  mode,
  locale,
  messages,
  themes,
  activeThemeId,
  onModeChange,
  onLocaleChange,
  onThemeChange,
  onRemoveCustomTheme,
}: SettingsPageProps) {
  return (
    <div>
      <PageHeader
        title={messages.settingsPage.title}
        description={messages.settingsPage.description}
      />

      <div className="sf-settings-grid">
        <Card>
          <CardHeader title={messages.settingsPage.accountTitle} />
          <div className="sf-card-body">
            <dl className="sf-kv-list">
              <div className="sf-kv-row">
                <dt>{messages.settingsPage.nameLabel}</dt>
                <dd>{user.name}</dd>
              </div>
              <div className="sf-kv-row">
                <dt>{messages.settingsPage.emailLabel}</dt>
                <dd className="numeric">{user.email}</dd>
              </div>
              <div className="sf-kv-row">
                <dt>{messages.settingsPage.roleLabel}</dt>
                <dd>{messages.roles[user.role]}</dd>
              </div>
              <div className="sf-kv-row">
                <dt>{messages.settingsPage.tenantLabel}</dt>
                <dd className="numeric">
                  {tenant ? `${tenant.name} (${tenant.slug})` : messages.common.noTenant}
                </dd>
              </div>
            </dl>
          </div>
        </Card>

        <Card>
          <CardHeader title={messages.settingsPage.appearanceTitle} />
          <div className="sf-card-body">
            <dl className="sf-kv-list">
              <div className="sf-kv-row">
                <dt>{messages.settingsPage.modeLabel}</dt>
                <dd>
                  <div
                    className="sf-locale-switch"
                    role="group"
                    aria-label={messages.settingsPage.modeLabel}
                  >
                    <button
                      type="button"
                      onClick={() => onModeChange('light')}
                      aria-pressed={mode === 'light'}
                      className={
                        mode === 'light' ? 'sf-locale-btn sf-locale-btn-active' : 'sf-locale-btn'
                      }
                    >
                      {messages.settingsPage.lightLabel}
                    </button>
                    <button
                      type="button"
                      onClick={() => onModeChange('dark')}
                      aria-pressed={mode === 'dark'}
                      className={
                        mode === 'dark' ? 'sf-locale-btn sf-locale-btn-active' : 'sf-locale-btn'
                      }
                    >
                      {messages.settingsPage.darkLabel}
                    </button>
                  </div>
                </dd>
              </div>
              <div className="sf-kv-row">
                <dt>{messages.settingsPage.languageLabel}</dt>
                <dd>
                  <div
                    className="sf-locale-switch"
                    role="group"
                    aria-label={messages.common.languageLabel}
                  >
                    <button
                      type="button"
                      onClick={() => onLocaleChange('de')}
                      aria-pressed={locale === 'de'}
                      className={
                        locale === 'de' ? 'sf-locale-btn sf-locale-btn-active' : 'sf-locale-btn'
                      }
                    >
                      DE
                    </button>
                    <button
                      type="button"
                      onClick={() => onLocaleChange('en')}
                      aria-pressed={locale === 'en'}
                      className={
                        locale === 'en' ? 'sf-locale-btn sf-locale-btn-active' : 'sf-locale-btn'
                      }
                    >
                      EN
                    </button>
                  </div>
                </dd>
              </div>
            </dl>
            <ThemeSettings
              themes={themes}
              activeThemeId={activeThemeId}
              mode={mode}
              locale={locale}
              messages={messages}
              onSelect={onThemeChange}
              onCustom={onThemeChange}
              onRemoveCustom={onRemoveCustomTheme}
            />
          </div>
          <div className="sf-card-foot">
            <p className="sf-card-text">{messages.settingsPage.localHint}</p>
          </div>
        </Card>

        <Card>
          <CardHeader title={messages.settingsPage.sessionTitle} />
          <div className="sf-card-body">
            <p className="sf-card-text">{messages.settingsPage.sessionText}</p>
          </div>
          {health?.version ? (
            <div className="sf-card-foot">
              <span className="label">{messages.settingsPage.apiVersionLabel}</span>
              <span className="numeric">v{health.version}</span>
            </div>
          ) : null}
        </Card>
      </div>
    </div>
  );
}
