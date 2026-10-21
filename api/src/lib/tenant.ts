/**
 * Which account (tenant) a request belongs to.
 *
 * The multi-tenant foundation (users, logins per account) isn't built yet —
 * see docs/plano-multicliente.md. Until then every logged-in request is the
 * original owner, account "tenant_default". New code must always go through
 * tenantIdOf() so it keeps working unchanged once the JWT carries tenantId.
 */
import { FastifyRequest } from 'fastify';

export const DEFAULT_TENANT_ID = 'tenant_default';

export function tenantIdOf(request: FastifyRequest): string {
  const user = (request as { user?: { tenantId?: string } }).user;
  return user?.tenantId || DEFAULT_TENANT_ID;
}
