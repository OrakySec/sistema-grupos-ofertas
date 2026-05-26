import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import bcrypt from 'bcryptjs';
import { requireAuth } from '../middleware/auth';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'admin@ofertas.local';
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH ?? '';

interface LoginBody {
  email: string;
  password: string;
}

interface JwtPayload {
  email: string;
}

export const authRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // POST /auth/login
  fastify.post<{ Body: LoginBody }>(
    '/login',
    {
      schema: {
        body: {
          type: 'object',
          required: ['email', 'password'],
          properties: {
            email: { type: 'string', format: 'email' },
            password: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const { email, password } = request.body;

      // Check email
      if (email !== ADMIN_EMAIL) {
        return reply.code(401).send({ error: 'Unauthorized', message: 'Invalid credentials' });
      }

      // Check password hash is configured
      if (!ADMIN_PASSWORD_HASH) {
        return reply.code(500).send({
          error: 'Server misconfiguration',
          message: 'ADMIN_PASSWORD_HASH is not set',
        });
      }

      // Compare password
      const valid = await bcrypt.compare(password, ADMIN_PASSWORD_HASH);
      if (!valid) {
        return reply.code(401).send({ error: 'Unauthorized', message: 'Invalid credentials' });
      }

      const payload: JwtPayload = { email };
      const token = fastify.jwt.sign(payload);

      return reply.send({ token, email });
    },
  );

  // GET /auth/me (requires auth)
  fastify.get(
    '/me',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const user = request.user as JwtPayload;
      return reply.send({ email: user.email });
    },
  );
};
