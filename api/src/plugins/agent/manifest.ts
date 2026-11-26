import type { PluginManifest } from '../../shared/contract.ts';

export const manifest: PluginManifest = {
  id: 'agent',
  label: 'Agent',
  description: 'Answers operator questions from live, read-only platform sources.',
  version: '0.1.0',
  apiVersion: 1,
  scope: 'platform',
  dependsOn: ['tenants'],
  nav: {
    label: 'Agent',
    path: '/agent',
    group: 'work',
    icon: 'compass',
    order: 15,
    roles: ['operator'],
    aliases: ['/assistent'],
  },
};

export default manifest;
