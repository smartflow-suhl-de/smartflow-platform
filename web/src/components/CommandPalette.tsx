import { useEffect, useMemo, useRef, useState } from 'react';
import type { Messages } from '../lib/i18n';
import type { ResolvedNavItem } from '../lib/navigation';
import { navigate } from '../lib/router';
import { SearchIcon, navIconByName } from './icons';
import { useFocusTrap } from './useFocusTrap';

export interface CommandPaletteProps {
  open: boolean;
  items: ResolvedNavItem[];
  messages: Messages;
  onClose: () => void;
}

/**
 * Jump-to-view palette. It carries exactly one mode: searching the navigation.
 * A "create" mode used to exist without a caller — the quick-create button
 * navigates to `/tenants?create=1` instead, which focuses the form directly.
 */
export function CommandPalette({ open, items, messages, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // `onClose` is an inline arrow in the shell, so it changes identity on every
  // shell render. Keeping it in a ref lets the reset effect depend on `open`
  // only — otherwise typing (which re-renders the page behind) would clear the
  // query on every keystroke.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setCursor(0);
  }, [open]);

  useFocusTrap(dialogRef, open, {
    onEscape: () => onCloseRef.current(),
    initialFocusRef: inputRef,
  });

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return items;
    return items.filter((item) => {
      const groupLabel = messages.navGroups[item.group];
      return `${item.label} ${groupLabel} ${item.path}`.toLowerCase().includes(needle);
    });
  }, [items, query, messages.navGroups]);

  useEffect(() => {
    setCursor(0);
  }, [query]);

  if (!open) return null;

  function selectItem(item: ResolvedNavItem | undefined): void {
    if (!item) return;
    onClose();
    navigate(item.path);
  }

  function handleInputKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setCursor((prev) => Math.min(prev + 1, Math.max(filtered.length - 1, 0)));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setCursor((prev) => Math.max(prev - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      selectItem(filtered[cursor]);
    }
  }

  const title = messages.shell.paletteTitleSearch;

  return (
    <>
      <div className="sf-overlay-backdrop" onClick={onClose} aria-hidden="true" />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="sf-palette"
      >
        <div className="sf-palette-head">
          <SearchIcon size={15} />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleInputKeyDown}
            placeholder={messages.shell.palettePlaceholderSearch}
            aria-label={title}
            className="sf-palette-input"
          />
          <span className="numeric">Esc</span>
        </div>

        <div className="sf-palette-list scroll-thin">
          {filtered.length === 0 ? (
            <div className="sf-palette-empty">{messages.shell.paletteEmpty}</div>
          ) : (
            filtered.map((item, index) => {
              const active = index === cursor;
              return (
                <button
                  key={item.id}
                  type="button"
                  onMouseEnter={() => setCursor(index)}
                  onClick={() => selectItem(item)}
                  className={active ? 'sf-palette-row sf-palette-row-active' : 'sf-palette-row'}
                >
                  {navIconByName(item.icon, 15)}
                  <span>{item.label}</span>
                  <span className="sf-palette-group">{messages.navGroups[item.group]}</span>
                </button>
              );
            })
          )}
        </div>
      </div>
    </>
  );
}
