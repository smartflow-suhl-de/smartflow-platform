import { useRef } from 'react';
import { BuildingIcon, CloseIcon } from './icons';
import { Badge, Button, Input } from './ui';
import { useFocusTrap } from './useFocusTrap';
import type { Messages } from '../lib/i18n';
import type { SessionTenant, Tenant } from '../lib/types';

export interface TenantSwitcherProps {
  activeTenant: SessionTenant | null;
  messages: Messages;
  onOpenModal: () => void;
  onClearContext: () => void;
}

export function TenantSwitcher({
  activeTenant,
  messages,
  onOpenModal,
  onClearContext,
}: TenantSwitcherProps) {
  return (
    <div className="sf-tenant-switcher">
      <div className="sf-tenant-switcher-head">
        <span className="label sf-tenant-switcher-label">
          {messages.tenantSwitcher.contextLabel}
        </span>
        {activeTenant ? (
          <button
            type="button"
            className="sf-tenant-clear-btn"
            onClick={onClearContext}
            aria-label={messages.tenantSwitcher.clearContextAria}
            title={messages.tenantSwitcher.clearContext}
          >
            <CloseIcon size={12} />
          </button>
        ) : (
          <span className="sf-tenant-switcher-state">{messages.tenantSwitcher.noTenantShort}</span>
        )}
      </div>

      {activeTenant ? (
        <button
          type="button"
          className="sf-tenant-switcher-btn"
          onClick={onOpenModal}
          title={messages.tenantSwitcher.switchTenant}
        >
          <span className="sf-tenant-switcher-name" title={activeTenant.name}>
            {activeTenant.name}
          </span>
          <span className="numeric sf-tenant-switcher-slug">({activeTenant.slug})</span>
        </button>
      ) : (
        <button
          type="button"
          className="sf-tenant-switcher-btn sf-tenant-switcher-empty"
          onClick={onOpenModal}
          title={messages.tenantSwitcher.chooseTenant}
        >
          <span className="sf-tenant-switcher-action">{messages.tenantSwitcher.chooseTenant}</span>
        </button>
      )}
    </div>
  );
}

export interface TenantSwitcherModalProps {
  open: boolean;
  activeTenant: SessionTenant | null;
  tenants: Tenant[];
  loading: boolean;
  error: string | null;
  query: string;
  hasNextPage: boolean;
  hasPrevPage: boolean;
  busyId: string | null;
  messages: Messages;
  onQueryChange: (query: string) => void;
  onSelect: (tenantId: string | null) => void;
  onPrevPage: () => void;
  onNextPage: () => void;
  onClose: () => void;
}

export function TenantSwitcherModal({
  open,
  activeTenant,
  tenants,
  loading,
  error,
  query,
  hasNextPage,
  hasPrevPage,
  busyId,
  messages,
  onQueryChange,
  onSelect,
  onPrevPage,
  onNextPage,
  onClose,
}: TenantSwitcherModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useFocusTrap(dialogRef, open, {
    onEscape: onClose,
    escapeDisabled: busyId !== null,
    initialFocusRef: searchInputRef,
  });

  if (!open) return null;

  return (
    <>
      <div className="sf-overlay-backdrop" onClick={onClose} aria-hidden="true" />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="sf-switcher-title"
        tabIndex={-1}
        className="sf-modal sf-switcher-modal"
      >
        <div className="sf-modal-head">
          <div>
            <h2 id="sf-switcher-title" className="sf-modal-title">
              {messages.tenantSwitcher.title}
            </h2>
            <p className="sf-modal-desc">{messages.tenantSwitcher.description}</p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label={messages.common.close}
            disabled={busyId !== null}
            onClick={onClose}
          >
            <CloseIcon size={16} />
          </Button>
        </div>

        <div className="sf-switcher-search">
          <Input
            ref={searchInputRef}
            type="search"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder={messages.tenantSwitcher.searchPlaceholder}
            aria-label={messages.tenantSwitcher.searchAria}
          />
        </div>

        {error ? (
          <div className="sf-alert sf-alert-bad" role="alert">
            {error}
          </div>
        ) : null}

        <div className="sf-switcher-body">
          {loading ? (
            <div className="sf-center-load" role="status">
              <span className="label">{messages.tenantSwitcher.loadingTenants}</span>
            </div>
          ) : tenants.length === 0 ? (
            <div className="sf-empty-desc">
              {query ? messages.tenantSwitcher.emptySearch : messages.tenantSwitcher.emptyList}
            </div>
          ) : (
            <div className="sf-table-wrap">
              <table className="sf-table">
                <thead>
                  <tr>
                    <th scope="col" className="label">
                      {messages.tenantSwitcher.colName}
                    </th>
                    <th scope="col" className="label">
                      {messages.tenantSwitcher.colSlug}
                    </th>
                    <th scope="col" className="label">
                      <span className="sr-only">{messages.tenants.colAction}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {tenants.map((t) => {
                    const isSelected = activeTenant?.id === t.id;
                    return (
                      <tr key={t.id} className={isSelected ? 'sf-tr-selected' : undefined}>
                        <td>
                          <div className="sf-tenant-row-name">
                            <BuildingIcon size={14} />
                            <span className="sf-tenant-name">{t.name}</span>
                          </div>
                        </td>
                        <td>
                          <span className="numeric sf-tenant-slug">{t.slug}</span>
                        </td>
                        <td className="sf-td-action">
                          {isSelected ? (
                            <Badge tone="good">{messages.tenantSwitcher.activeBadge}</Badge>
                          ) : (
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => onSelect(t.id)}
                              disabled={busyId !== null}
                            >
                              {busyId === t.id ? '…' : messages.tenantSwitcher.selectAction}
                            </Button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="sf-modal-foot sf-switcher-foot">
          <div className="sf-switcher-pages">
            <Button
              size="sm"
              variant="secondary"
              onClick={onPrevPage}
              disabled={!hasPrevPage || loading || busyId !== null}
            >
              {messages.tenantSwitcher.prevPage}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={onNextPage}
              disabled={!hasNextPage || loading || busyId !== null}
            >
              {messages.tenantSwitcher.nextPage}
            </Button>
          </div>
          <div className="sf-switcher-actions">
            {activeTenant ? (
              <Button
                size="sm"
                variant="danger"
                onClick={() => onSelect(null)}
                disabled={busyId !== null}
              >
                {messages.tenantSwitcher.clearContext}
              </Button>
            ) : null}
            <Button size="sm" variant="secondary" onClick={onClose} disabled={busyId !== null}>
              {messages.common.close}
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}
