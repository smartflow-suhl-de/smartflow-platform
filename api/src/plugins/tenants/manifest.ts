import type { PluginManifest } from '../../shared/contract.ts';

export const manifest: PluginManifest = {
  id: 'tenants',
  label: 'Tenants',
  description: 'Create, suspend and resume tenants.',
  version: '0.1.0',
  apiVersion: 1,
  scope: 'platform',
};

export default manifest;
