const STALE_TICK_MS = 15 * 60_000;

/**
 * Agent health for the topbar: tick recency, CLI auth (preflight results
 * are recorded by the Skill), command backlog and uncertain actions.
 * dry_run must always be visible so a preview is never shown as a real send
 * (docs §7.2).
 */
export async function buildHealth(store) {
  const [state, policies, commands, actions, ownerConfig] = await Promise.all([
    store.loadState().catch(() => null),
    store.loadConfig('policies').catch(() => ({})),
    store.listCommands(),
    store.listActions(),
    store.loadConfig('owner').catch(() => ({}))
  ]);

  const queuedCommands = commands.filter((command) => ['queued', 'claimed', 'waiting_agent'].includes(command.status)).length;
  const uncertainActions = actions.filter((action) => ['executing', 'unknown'].includes(action.status)).length;

  const lastSuccessfulTick = state?.last_successful_tick ?? null;
  const lastTickAge = lastSuccessfulTick ? Date.now() - Date.parse(lastSuccessfulTick) : null;
  const stale = lastTickAge === null || Number.isNaN(lastTickAge) || lastTickAge > STALE_TICK_MS;

  let status = 'ok';
  if (uncertainActions > 0 || (stale && queuedCommands > 0)) status = 'degraded';

  const dryRun = policies.dry_run !== false;

  return {
    status,
    serverTime: new Date().toISOString(),
    timezone: ownerConfig.timezone ?? 'Asia/Shanghai',
    mode: dryRun ? 'dry_run' : 'live',
    agent: {
      state: state?.status ?? 'idle',
      lastSuccessfulTick,
      stale,
      queuedCommands,
      uncertainActions
    },
    capabilities: {
      attachments: false,
      artifacts: false,
      liveSend: !dryRun,
      sse: true
    }
  };
}
