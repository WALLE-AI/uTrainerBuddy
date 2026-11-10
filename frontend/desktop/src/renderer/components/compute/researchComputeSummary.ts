import type { BindingData } from './ProjectPublish';

/** A connection observation is not a reservation or a training readiness check. */
export function researchComputeSummary(data: BindingData, now = Date.now()) {
  const { binding, target } = data;
  const matches = !!binding && binding.target_id === target.target_id;
  const observedAt = matches ? target.snapshot_at : null;
  const fresh = !!observedAt && observedAt <= now && now - observedAt <= 60000;
  const live = matches && target.status === 'reachable' && !!target.connection_id && !!target.snapshot && fresh;
  return {
    state: !binding ? 'unbound' : !matches ? 'targetChanged' : live ? 'observed' : 'unconfirmed',
    matches,
    live,
    observedAt,
    snapshot: matches ? target.snapshot : null,
    // Never label the currently selected host as the project's bound host after a switch.
    host: matches ? target.profile?.host ?? null : null,
    targetId: binding?.target_id ?? null,
    remoteRoot: binding?.remote_root ?? null,
    commit: binding?.last_snapshot?.commit ?? null,
  } as const;
}
