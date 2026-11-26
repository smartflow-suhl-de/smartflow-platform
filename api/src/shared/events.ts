/**
 * Platform events. A plugin emits one of these instead of importing another
 * plugin; the kernel persists the event and calls the listeners.
 */
export interface PlatformEvents {
  'tenant.created': { tenantId: string; name: string; slug: string };
  'tenant.suspended': { tenantId: string };
  'tenant.resumed': { tenantId: string };
  'auth.signed_in': { userId: string; role: string };
  'auth.signed_out': { userId: string };
}

export type EventName = keyof PlatformEvents;

export interface EventRecord {
  id: string;
  name: EventName;
  payload: PlatformEvents[EventName];
  createdAt: string;
}
