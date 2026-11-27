import type { PluginManifest } from '../../shared/contract.ts';

/**
 * One global sender and one global mailbox, operated by `operator` only:
 * a shared address domain cannot be separated per tenant, so handing this to
 * `tenant_admin` would blur the boundary the kernel enforces.
 */
export const manifest: PluginManifest = {
  id: 'email',
  label: 'E-Mail',
  description: 'Globaler Absender, Postausgang und lesendes Postfach (IMAP).',
  version: '0.1.0',
  apiVersion: 1,
  scope: 'platform',
  nav: {
    label: 'E-Mail',
    path: '/email',
    group: 'work',
    icon: 'mail',
    order: 25,
    roles: ['operator'],
    aliases: ['/postfach', '/mail', '/postausgang'],
  },
};

export default manifest;