import type { PluginManifest } from '../../shared/contract.ts';

export const manifest: PluginManifest = {
  id: 'automation-discovery',
  label: 'Automatisierungs-Check',
  description: 'Einmal-Link, KI-Interview und priorisierte Automatisierungsideen pro Kunde.',
  version: '0.1.0',
  apiVersion: 1,
  scope: 'platform',
  dependsOn: ['llm-providers'],
  nav: {
    label: 'Automatisierungs-Check',
    path: '/discovery',
    group: 'tools',
    icon: 'compass',
    order: 25,
    roles: ['operator'],
    createLabel: 'Neue Einladung',
    aliases: ['/scout', '/automatisierung'],
  },
};

export default manifest;
