import { useEffect, useMemo, useRef, useState } from 'react';
import type { Messages } from '../lib/i18n';
import type { ResolvedNavItem } from '../lib/navigation';
import { navigate } from '../lib/router';
import { PlusIcon, SearchIcon, navIconByName } from './icons';
import { useFocusTrap } from './useFocusTrap';

export type PaletteMode = 'search' | 'create';

export interface CommandPaletteProps {
  open: boolean;
  mode: PaletteMode;
  items: ResolvedNavItem[];
  messages: Messages;
  onClose: () => void;
}

export function CommandPalette({ open, mode, items, messages, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // `onClose` is an inline arrow in the shell, so it changes identity on every
  // shell render. Keeping it in a ref lets the reset effect depend on
  // `[open, mode]` only — otherwise typing (which re-renders the page behind)
  // would clear the query on every keystroke.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setCursor(0);
  }, [open, mode]);

  useFocusTrap(dialogRef, open, {
    onEscape: () => onCloseRef.current(),
    initialFocusRef: inputRef,
  });

  const filtered = useMemo(() => {
    const pool = mode === 'create' ? items.filter((item) => item.createLabel !== null) : items;
    const needle = query.trim().toLowerCase();
    if (!needle) return pool;
    return pool.filter((item) => {
      const label = mode === 'create' && item.createLabel ? item.createLabel : item.label;
      const groupLabel = messages.navGroups[item.group];
      return `${label} ${groupLabel} ${item.path}`.toLowerCase().includes(needle);
    });
  }, [items, mode, query, messages.navGroups]);

  useEffect(() => {
    setCursor(0);
  }, [query, mode]);

  if (!open) return null;

  function selectItem(item: ResolvedNavItem | undefined): void {
    if (!item) return;
    onClose();
    navigate(mode === 'create' ? `${item.path}?create=1` : item.path);
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

  const title =
    mode === 'create' ? messages.shell.paletteTitleCreate : messages.shell.paletteTitleSearch;
  const placeholder =
    mode === 'create'
      ? messages.shell.palettePlaceholderCreate
      : messages.shell.palettePlaceholderSearch;

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
          {mode === 'create' ? <PlusIcon size={15} /> : <SearchIcon size={15} />}
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleInputKeyDown}
            placeholder={placeholder}
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
              const label = mode === 'create' && item.createLabel ? item.createLabel : item.label;
              return (
                <button
                  key={item.id}
                  type="button"
                  onMouseEnter={() => setCursor(index)}
                  onClick={() => selectItem(item)}
                  className={active ? 'sf-palette-row sf-palette-row-active' : 'sf-palette-row'}
                >
                  {navIconByName(item.icon, 15)}
                  <span>{label}</span>
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
