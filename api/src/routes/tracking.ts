import { FastifyInstance, FastifyPluginAsync } from 'fastify';

const META_PIXEL_ID = '1036050992396935';
// Token provided by user for CAPI
const META_CAPI_TOKEN = 'EAAUFNPFwJ70BR7r3XKT3Hcqh5WUC7JKFW4hxEsZCqaVY9eZAJq5MZBa1R7vavvkwOjmtreJ5L7OgZBD56jygNsLFQOlgZCP9VSJbRVAg5My9LOeH5hVlwz4tKh3AtUVlHmgqLuEBzMccvG3l9PdWlwYs3wjdaPqaw3YymPC0ShJALKbbOihEcv9obR5LIhAZDZD';

export const trackingRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // Public endpoint for Meta CAPI events
  fastify.post('/meta-event', async (request, reply) => {
    const { eventName, eventId, sourceUrl, userAgent, clientIp, fbc, fbp } = request.body as any;

    if (!eventName) {
      return reply.code(400).send({ error: 'eventName is required' });
    }

    try {
      const userData: Record<string, string> = {
        client_ip_address: clientIp || request.ip,
        client_user_agent: userAgent || (request.headers['user-agent'] as string),
      };
      if (fbc) userData.fbc = fbc;
      if (fbp) userData.fbp = fbp;

      const payload = {
        data: [
          {
            event_name: eventName,
            event_time: Math.floor(Date.now() / 1000),
            event_id: eventId,
            event_source_url: sourceUrl,
            action_source: 'website',
            user_data: userData,
          }
        ]
      };

      const res = await fetch(`https://graph.facebook.com/v19.0/${META_PIXEL_ID}/events?access_token=${META_CAPI_TOKEN}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const fbData = await res.json();
      
      if (!res.ok) {
        request.log.error({ fbData }, 'Meta CAPI returned an error');
      }

      return reply.send({ success: true, fbData });
    } catch (err) {
      request.log.error({ err }, 'Failed to send Meta CAPI event');
      return reply.code(500).send({ error: 'Internal Server Error' });
    }
  });
};
