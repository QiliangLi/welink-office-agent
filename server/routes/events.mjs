export function register(register) {
  // SSE: the response stays open, so this route bypasses the JSON pipeline
  // and owns the socket — marked rawResponse so the router's no-reply
  // fail-safe does not try to write a JSON error over the open stream.
  register('GET', '/api/v1/events/stream', async ({ req, res, context }) => {
    const lastEventId = req.headers['last-event-id'] ?? null;
    await context.eventStreamService.addClient(res, lastEventId);
  }, { skipCsrf: true, skipIdempotency: true, rawResponse: true });
}
