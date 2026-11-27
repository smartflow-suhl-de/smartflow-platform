import { MoonIcon, SunIcon } from './icons';
import type { Locale, Messages } from '../lib/i18n';
import type { ThemeDefinition } from '../lib/themes';
import { appearanceName, nextAppearance, type AppearancePair } from '../lib/appearance';

export interface AppearanceToggleProps {
  current: AppearancePair;
  customTheme: ThemeDefinition | null;
  locale: Locale;
  messages: Messages;
  onChange: (next: AppearancePair) => void;
}

/**
 * One icon button in the sidebar footer that steps through every appearance.
 *
 * The label names the current and the next state, the icon shows where the
 * click leads. There is no `aria-pressed`: the button has more than two states.
 */
export function AppearanceToggle({
  current,
  customTheme,
  locale,
  messages,
  onChange,
}: AppearanceToggleProps) {
  const next = nextAppearance(current, customTheme);
  const currentName = appearanceName(current, customTheme, locale, messages);
  const nextName = appearanceName(next, customTheme, locale, messages);
  const label = messages.shell.appearanceSwitch(currentName, nextName);

  return (
    <button
      type="button"
      className="sf-foot-icon-btn sf-foot-appearance"
      aria-label={label}
      title={label}
      onClick={(event) => {
        onChange(next);
        // Keep the keyboard focus on the button the user just pressed.
        event.currentTarget.focus();
      }}
    >
      {next.mode === 'light' ? <SunIcon size={15} /> : <MoonIcon size={15} />}
    </button>
  );
}
