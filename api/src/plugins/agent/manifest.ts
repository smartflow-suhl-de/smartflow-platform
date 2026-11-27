import type { PluginManifest } from '../../shared/contract.ts';

export const manifest: PluginManifest = {
  id: 'agent',
  label: 'Chat',
  description: 'Answers operator questions from live, read-only platform sources.',
  version: '0.1.0',
  apiVersion: 1,
  scope: 'platform',
  dependsOn: ['tenants', 'llm-providers'],
  nav: {
    label: 'Chat',
    path: '/agent',
    group: 'tools',
    icon: 'message',
    order: 15,
    roles: ['operator'],
    aliases: ['/assistent', '/chat'],
  },
};

export default manifest;
