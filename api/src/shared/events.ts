/**
 * Platform events. A plugin emits one of these instead of importing another
 * plugin; the kernel persists the event and calls the listeners.
 */
export interface PlatformEvents {
  'tenant.created': { tenantId: string; name: string; slug: string };
  'tenant.suspended': { tenantId: string };
  'tenant.resumed': { tenantId: string };
  /** Field names only: master-data values never go into the audit log. */
  'tenant.updated': { tenantId: string; fields: string[] };
  'auth.setup_completed': { userId: string };
  'auth.signed_in': { userId: string; role: string };
  'auth.signed_out': { userId: string };
  /** IDs only: names and slugs of tenants never go into the audit log. */
  'auth.tenant_switched': {
    userId: string;
    fromTenantId: string | null;
    toTenantId: string | null;
  };
}

export type EventName = keyof PlatformEvents;

export interface EventRecord {
  id: string;
  name: EventName;
  payload: PlatformEvents[EventName];
  createdAt: string;
}
