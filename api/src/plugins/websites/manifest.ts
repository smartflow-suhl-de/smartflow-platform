import type { PluginManifest } from '../../shared/contract.ts';

/**
 * Websites belong to the agency that runs them, not to the end customer: client
 * sites are records inside the agency's tenant database. Making a customer a
 * tenant would hand one agency's staff a reason to open another tenant's
 * database, which the kernel boundary exists to prevent.
 */
export const manifest: PluginManifest = {
  id: 'websites',
  label: 'Webseiten',
  description: 'Own and client websites: Astro projects, AI drafts, previews and approvals.',
  version: '0.3.0',
  apiVersion: 1,
  scope: 'tenant',
  dependsOn: ['llm-providers'],
  nav: {
    label: 'Webseiten',
    path: '/websites',
    group: 'work',
    icon: 'globe',
    order: 30,
    roles: ['tenant_admin', 'employee', 'operator'],
    createLabel: 'Neue Website',
    aliases: ['/webseiten'],
    // Without a tenant the operator works in the own workspace, not a 403.
    ownWorkspace: true,
  },
};

export default manifest;
