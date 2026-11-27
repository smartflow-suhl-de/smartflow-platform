import type { PluginManifest } from '../../shared/contract.ts';

export const manifest: PluginManifest = {
  id: 'automation-discovery',
  label: 'Automatisierungs-Scout',
  description: 'Einmal-Link, KI-Interview und priorisierte Automatisierungsideen pro Kunde.',
  version: '0.1.4',
  apiVersion: 1,
  scope: 'platform',
  nav: {
    label: 'Automatisierungs-Scout',
    path: '/discovery',
    group: 'work',
    icon: 'compass',
    order: 30,
    roles: ['operator'],
    createLabel: 'Neue Einladung',
    aliases: ['/scout', '/automatisierung'],
  },
};

export default manifest;
