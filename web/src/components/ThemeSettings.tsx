import { useState } from 'react';
import type { Locale, Messages } from '../lib/i18n';
import {
  NAME_MAX_LENGTH,
  buildCustomTheme,
  customThemeProblems,
  parseThemeFile,
  serializeTheme,
  themeDescription,
  themeLabel,
  themeSwatches,
  type Mode,
  type ThemeDefinition,
  type ThemeFileError,
} from '../lib/themes';
import { Button, Field, Input } from './ui';

const DEFAULT_ACCENT = '#1e3bff';
const DEFAULT_PAPER = '#f2efe7';

export interface ThemeSettingsProps {
  themes: readonly ThemeDefinition[];
  activeThemeId: string;
  mode: Mode;
  locale: Locale;
  messages: Messages;
  onSelect: (theme: ThemeDefinition) => void;
  onCustom: (theme: ThemeDefinition) => void;
  onRemoveCustom: () => void;
}

function fileErrorText(error: ThemeFileError, messages: Messages): string {
  const text = messages.settingsPage;
  switch (error) {
    case 'invalid_json':
      return text.themeErrorJson;
    case 'invalid_shape':
      return text.themeErrorShape;
    case 'invalid_version':
      return text.themeErrorVersion;
    case 'invalid_name':
      return text.themeErrorName;
    case 'invalid_color':
      return text.themeErrorColor;
    case 'paper_too_dark':
      return text.themeErrorPaperDark;
    case 'low_contrast':
      return text.themeErrorContrast;
  }
}

function customErrorText(problem: string, messages: Messages): string {
  const text = messages.settingsPage;
  if (problem === 'name') return text.themeErrorName;
  if (problem === 'paper_too_dark') return text.themeErrorPaperDark;
  return text.themeErrorColor;
}

export function ThemeSettings({
  themes,
  activeThemeId,
  mode,
  locale,
  messages,
  onSelect,
  onCustom,
  onRemoveCustom,
}: ThemeSettingsProps) {
  const text = messages.settingsPage;
  const [name, setName] = useState('');
  const [accent, setAccent] = useState(DEFAULT_ACCENT);
  const [paper, setPaper] = useState(DEFAULT_PAPER);
  const [customError, setCustomError] = useState<string | null>(null);
  const [json, setJson] = useState('');
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [jsonNotice, setJsonNotice] = useState<string | null>(null);

  const hasCustom = themes.some((theme) => theme.id === 'custom');
  const activeTheme = themes.find((theme) => theme.id === activeThemeId) ?? themes[0];

  const applyCustom = () => {
    const problems = customThemeProblems({ name, accent, paper });
    if (problems.length > 0) {
      setCustomError(customErrorText(problems[0], messages));
      return;
    }
    setCustomError(null);
    setJsonNotice(null);
    onCustom(buildCustomTheme({ name, accent, paper }));
  };

  const exportCurrent = () => {
    setJson(serializeTheme(activeTheme));
    setJsonError(null);
    setJsonNotice(null);
  };

  const importJson = () => {
    const parsed = parseThemeFile(json);
    if (!parsed.ok) {
      setJsonError(fileErrorText(parsed.error, messages));
      setJsonNotice(null);
      return;
    }
    setJsonError(null);
    setJsonNotice(text.themeJsonApplied);
    setCustomError(null);
    onCustom(parsed.theme);
  };

  return (
    <div className="sf-theme-block">
      <div className="sf-theme-head">
        <span className="label">{text.themeLabel}</span>
      </div>
      <p className="sf-card-text">{text.themeHint}</p>
      <div className="sf-theme-group" role="group" aria-label={text.themeLabel}>
        {themes.map((theme) => (
          <button
            key={theme.id}
            type="button"
            className="sf-theme-option"
            aria-pressed={theme.id === activeThemeId}
            onClick={() => onSelect(theme)}
          >
            <span className="sf-theme-swatches" aria-hidden="true">
              {themeSwatches(theme, mode).map((color, index) => (
                <span
                  key={`${color}-${index}`}
                  className="sf-theme-swatch"
                  style={{ backgroundColor: color }}
                />
              ))}
            </span>
            <span className="sf-theme-option-label">{themeLabel(theme, locale)}</span>
            <span className="sf-theme-option-desc">{themeDescription(theme, locale)}</span>
          </button>
        ))}
      </div>

      <details className="sf-theme-details">
        <summary>{text.themeCustomTitle}</summary>
        <p className="sf-card-text">{text.themeCustomHint}</p>
        <div className="sf-theme-editor">
          <Field label={text.themeNameLabel} htmlFor="sf-theme-name">
            <Input
              id="sf-theme-name"
              value={name}
              maxLength={NAME_MAX_LENGTH}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field label={text.themeAccentLabel} htmlFor="sf-theme-accent">
            <Input
              id="sf-theme-accent"
              className="sf-theme-color"
              type="color"
              value={accent}
              onChange={(event) => setAccent(event.target.value)}
            />
          </Field>
          <Field label={text.themePaperLabel} htmlFor="sf-theme-paper">
            <Input
              id="sf-theme-paper"
              className="sf-theme-color"
              type="color"
              value={paper}
              onChange={(event) => setPaper(event.target.value)}
            />
          </Field>
        </div>
        <div className="sf-theme-actions">
          <Button variant="secondary" size="sm" onClick={applyCustom}>
            {text.themeApply}
          </Button>
          {hasCustom ? (
            <Button variant="ghost" size="sm" onClick={onRemoveCustom}>
              {text.themeReset}
            </Button>
          ) : null}
        </div>
        {customError ? (
          <p className="sf-field-error" role="alert">
            {customError}
          </p>
        ) : null}
      </details>

      <details className="sf-theme-details">
        <summary>{text.themeJsonTitle}</summary>
        <p className="sf-card-text">{text.themeJsonHint}</p>
        <Field label={text.themeJsonLabel} htmlFor="sf-theme-json">
          <textarea
            id="sf-theme-json"
            className="sf-input sf-theme-json"
            value={json}
            spellCheck={false}
            onChange={(event) => setJson(event.target.value)}
          />
        </Field>
        <div className="sf-theme-actions">
          <Button variant="ghost" size="sm" onClick={exportCurrent}>
            {text.themeJsonExport}
          </Button>
          <Button variant="secondary" size="sm" onClick={importJson}>
            {text.themeJsonImport}
          </Button>
        </div>
        {jsonError ? (
          <p className="sf-field-error" role="alert">
            {jsonError}
          </p>
        ) : null}
        {jsonNotice ? (
          <p className="sf-card-text" role="status">
            {jsonNotice}
          </p>
        ) : null}
      </details>
    </div>
  );
}
