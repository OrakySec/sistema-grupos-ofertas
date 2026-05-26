import { FastifyReply, FastifyRequest } from 'fastify';

export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  try {
    await request.jwtVerify();
  } catch (err) {
    reply.code(401).send({ error: 'Unauthorized', message: 'Invalid or missing token' });
  }
}
