/**
 * Delay before reconnect attempt `attempt` (0-based): exponential backoff with
 * full jitter, uniform in [base, min(cap, base·2^attempt)]. After an
 * authentication failure it goes straight to [cap/2, cap] so a wrong access
 * code doesn't hammer the printer (which may lock the client out).
 */
export function nextDelay(
  attempt: number,
  rng: () => number,
  { base, cap, authFailed = false }: { base: number; cap: number; authFailed?: boolean },
) {
  if (authFailed) return Math.round(cap / 2 + rng() * (cap / 2));
  const ceiling = Math.min(cap, base * 2 ** Math.min(attempt, 30));
  return Math.round(base + rng() * (ceiling - base));
}
