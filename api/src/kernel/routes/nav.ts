import type { FastifyInstance } from 'fastify';
import type { PluginManifest, NavResponse } from '../../shared/contract.ts';
import { navFor } from '../app.ts';

const navSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'plugin',
          'label',
          'path',
          'group',
          'icon',
          'order',
          'roles',
          'createLabel',
          'aliases',
        ],
        properties: {
          plugin: { type: 'string' },
          label: { type: 'string' },
          path: { type: 'string' },
          group: { type: 'string', enum: ['work', 'management'] },
          icon: { type: 'string' },
          order: { type: 'integer' },
          roles: { type: 'array', items: { type: 'string' } },
          createLabel: { type: ['string', 'null'] },
          aliases: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
} as const;

export function registerNavRoutes(
  app: FastifyInstance,
  options: { plugins: PluginManifest[] },
): void {
  app.get(
    '/nav',
    {
      preHandler: app.authenticate,
      schema: {
        summary: 'Navigation entries available to the signed-in role',
        tags: ['nav'],
        response: {
          200: navSchema,
          401: {
            type: 'object',
            additionalProperties: false,
            required: ['error'],
            properties: {
              error: {
                type: 'object',
                additionalProperties: false,
                required: ['code', 'message'],
                properties: { code: { type: 'string' }, message: { type: 'string' } },
              },
            },
          },
        },
      },
    },
    async (request): Promise<NavResponse> => {
      return navFor(
        options.plugins,
        request.user?.role ?? 'employee',
        request.user?.activeTenantId != null,
      );
    },
  );
}
