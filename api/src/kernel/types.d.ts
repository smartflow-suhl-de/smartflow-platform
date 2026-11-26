import type { FastifyReply } from 'fastify';
import type { Role } from '../shared/contract.ts';
import type { SessionUser } from './auth.ts';

declare module 'fastify' {
  interface FastifyRequest {
    /** Resolved from the session cookie on every API request. */
    user: SessionUser | null;
  }

  interface FastifyInstance {
    /** preHandler: answers 401 when no session is present. */
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** preHandler factory: answers 401/403 unless the user holds one of the roles. */
    requireRole: (
      ...roles: Role[]
    ) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /**
     * preHandler: answers 401 unless the request carries this process's
     * internal token. For routes a plugin calls on behalf of code that has no
     * session; never for a route a browser may reach with user data alone.
     */
    requireInternal: (request: FastifyRequest) => Promise<void>;
  }
}
