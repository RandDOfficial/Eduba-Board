module.exports = (fastify) => {
  fastify.get('/ping', async () => 'pong');
};