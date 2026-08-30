export function register(register) {
  // SSE: the response stays open, so this route bypasses the JSON pipeline.
  register('GET', '/api/v1/events/stream', async ({ req, res, context }) => {
    const lastEventId = req.headers['last-event-id'] ?? null;
    context.eventStreamService.addClient(res, lastEventId);
  }, { skipCsrf: true, skipIdempotency: true });
}
