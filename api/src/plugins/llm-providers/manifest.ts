import type { PluginManifest } from '../../shared/contract.ts';

export const manifest: PluginManifest = {
  id: 'llm-providers',
  label: 'KI-Anbieter',
  description: 'LLM-Provider, Modelle, Zwecke und Verbrauch verwalten.',
  version: '0.1.0',
  apiVersion: 1,
  scope: 'platform',
  nav: {
    label: 'KI-Anbieter',
    path: '/llm',
    group: 'management',
    icon: 'sparkles',
    order: 80,
    roles: ['operator'],
    createLabel: 'Provider verbinden',
    aliases: ['/ki', '/anbieter', '/providers'],
  },
};

export default manifest;
