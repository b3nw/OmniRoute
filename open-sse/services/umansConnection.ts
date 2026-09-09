/**
 * umansConnection.ts — identity of an Umans AI connection. No I/O, no imports.
 *
 * Umans Code is consumed through the generic OpenAI-compatible custom-provider
 * node, so a real connection's runtime provider id is
 * `openai-compatible-chat-<uuid>` — a per-install UUID, never the literal
 * string "umans". Every lookup that is nominally keyed by provider id (the
 * quota fetcher / window registry, the usage dispatcher, the
 * `walletCutoffCentsByProvider` resilience map, the dashboard capability
 * checks) therefore cannot recognize Umans from the id alone: it has to detect
 * it from the connection's configured base URL, and then use ONE canonical key
 * so the operator has a stable name to configure.
 *
 * This leaf is that single source of truth — base URL, canonical key,
 * predicate, named windows — and is deliberately import-free so the routing hot
 * path, the DB layer and client components can all share it.
 */

/** Base URL of the Umans OpenAI-compatible gateway. */
export const UMANS_BASE_URL = "https://api.code.umans.ai";

/**
 * Canonical key for everything keyed by "which upstream is this connection
 * talking to" rather than by routing identity: the quota fetcher/window
 * registry, `resilience.quotaPreflight.walletCutoffCentsByProvider`, and the
 * dashboard's capability lookup. Routing keeps using the real
 * `openai-compatible-<uuid>` provider id — this key never replaces it.
 */
export const UMANS_PROVIDER_KEY = "umans";

/** Depleting prepaid cash balance. Never resets — only top-ups refill it. */
export const UMANS_WINDOW_WALLET = "wallet";
/** Rolling request soft cap (5h window on every current tier). */
export const UMANS_WINDOW_REQUESTS = "requests";
/** Concurrent-session cap. Saturation, not depletion — detail only. */
export const UMANS_WINDOW_CONCURRENCY = "concurrency";

export const UMANS_QUOTA_WINDOWS = [
  UMANS_WINDOW_WALLET,
  UMANS_WINDOW_REQUESTS,
  UMANS_WINDOW_CONCURRENCY,
] as const;

/**
 * Match only the exact Umans API base URL (allowing a harmless trailing
 * slash). Substring matching is deliberately avoided: a look-alike host must
 * not inherit wallet cutoffs that stop routing at a dollar amount.
 */
export function isUmansConnection(connection: Record<string, unknown> | null | undefined): boolean {
  const providerSpecificData = connection?.providerSpecificData;
  if (!providerSpecificData || typeof providerSpecificData !== "object") return false;
  const baseUrl = (providerSpecificData as Record<string, unknown>).baseUrl;
  return typeof baseUrl === "string" && baseUrl.trim().replace(/\/+$/, "") === UMANS_BASE_URL;
}

/**
 * The canonical registry/settings/UI key for a (provider id, connection) pair.
 *
 * Returns the routing provider id unchanged for every ordinary provider, and
 * the canonical key for connections whose upstream is only identifiable from
 * the connection itself (currently just Umans). Call sites that resolve quota
 * capability, named windows or money cutoffs MUST go through this instead of
 * using the raw provider id, or a generic custom-node connection silently gets
 * no quota telemetry at all.
 */
export function resolveQuotaProviderKey(
  provider: string,
  connection?: Record<string, unknown> | null
): string {
  if (isUmansConnection(connection)) return UMANS_PROVIDER_KEY;
  return provider;
}
