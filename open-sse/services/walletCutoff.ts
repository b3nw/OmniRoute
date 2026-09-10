/**
 * walletCutoff.ts — money-valued quota cutoffs for prepaid-wallet providers.
 *
 * The ordinary quota cutoff is strictly percentage-based: it reads
 * `percentUsed` and compares remaining % against a threshold. A prepaid wallet
 * has no denominator — historical spend, tier request caps and `funded` are all
 * invalid ceilings — so a percentage can only ever express "funded" or
 * "depleted". That reduces enforcement to zero-only gating and gives the
 * operator no way to say "stop this account at $5 remaining".
 *
 * This leaf adds the missing contract: an absolute remaining-cash reserve in
 * cents, compared DIRECTLY against the provider's authoritative balance.
 *
 *   block when balanceCents <= walletCutoffCents
 *
 * Resolution order is strict and independent of the percent map:
 *   connection.walletCutoffCents
 *     → resilience.quotaPreflight.walletCutoffCentsByProvider[<canonical key>]
 *     → resilience.quotaPreflight.walletCutoffCentsByProvider[<provider id>]
 *     → disabled
 *
 * The canonical key matters because the only wallet provider today (Umans) is
 * reached through a generic OpenAI-compatible custom node: its routing provider
 * id is a per-install `openai-compatible-<uuid>`, which no operator could ever
 * type into a settings map. `resolveQuotaProviderKey()` maps the (provider id,
 * connection) pair onto the stable `"umans"` key, and the raw provider id is
 * still honored afterwards so an explicit per-id entry keeps working.
 *
 * `quotaWindowThresholds` stays percent-only — a `wallet` key there is still an
 * integer 0-100 percentage, never dollars. Overloading one key with two units
 * would silently corrupt existing settings.
 *
 * Leaf: no I/O and no module state; the single import is the import-free
 * connection-identity leaf.
 */

import { resolveQuotaProviderKey } from "./umansConnection.ts";

/**
 * Cents are fractional upstream (Umans reports e.g. `769.004324`), so the
 * comparison needs a tolerance to make "exactly at the cutoff" deterministic
 * rather than dependent on float representation. A thousandth of a cent is far
 * below any meaningful reserve and far above float noise at wallet magnitudes.
 */
export const WALLET_CENTS_EPSILON = 1e-3;

/**
 * Coerce an operator-supplied cutoff into a usable value.
 * Returns `null` for "not configured" (absent/null/empty) and `undefined` for
 * "supplied but invalid" so callers can reject instead of silently disabling
 * enforcement — a negative or NaN reserve must not read as "no cutoff".
 */
export function parseWalletCutoffCents(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    if (value.trim() === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  }
  return undefined;
}

/**
 * Lenient read used on hot paths: a malformed persisted value behaves as
 * "not configured" (fail-open) rather than throwing mid-routing. Write paths
 * use parseWalletCutoffCents() and reject instead.
 */
export function normalizeWalletCutoffCents(value: unknown): number | null {
  const parsed = parseWalletCutoffCents(value);
  return parsed === undefined ? null : parsed;
}

/**
 * Read the per-connection override. The canonical persisted home is
 * `providerSpecificData.walletCutoffCents` (the connection JSON blob — no new
 * column); the top-level field is what the API/DB read path surfaces and what
 * `credentials` objects carry, so both shapes resolve here.
 */
export function readConnectionWalletCutoffCents(
  connection: Record<string, unknown> | null | undefined
): number | null {
  if (!connection) return null;
  const direct = normalizeWalletCutoffCents(connection.walletCutoffCents);
  if (direct !== null) return direct;
  const psd = connection.providerSpecificData;
  if (psd && typeof psd === "object" && !Array.isArray(psd)) {
    return normalizeWalletCutoffCents((psd as Record<string, unknown>).walletCutoffCents);
  }
  return null;
}

/** Read the per-provider default map from resilience settings. */
export function readProviderWalletCutoffCents(
  provider: string,
  byProvider: Record<string, unknown> | null | undefined
): number | null {
  if (!provider || !byProvider || typeof byProvider !== "object") return null;
  return normalizeWalletCutoffCents((byProvider as Record<string, unknown>)[provider]);
}

/**
 * connection override > canonical provider default > raw-provider-id default >
 * disabled (null). A connection value of `null` means "cleared" and correctly
 * falls through to the provider default; only an explicit number wins.
 */
export function resolveWalletCutoffCents(
  provider: string,
  connection: Record<string, unknown> | null | undefined,
  byProvider: Record<string, unknown> | null | undefined
): number | null {
  const connectionValue = readConnectionWalletCutoffCents(connection);
  if (connectionValue !== null) return connectionValue;
  const canonicalKey = resolveQuotaProviderKey(provider, connection);
  const canonicalValue = readProviderWalletCutoffCents(canonicalKey, byProvider);
  if (canonicalValue !== null) return canonicalValue;
  if (canonicalKey === provider) return null;
  return readProviderWalletCutoffCents(provider, byProvider);
}

/**
 * The direct money comparison. Unknown balance or unconfigured cutoff means
 * "cannot judge" → false (fail open); routing is never blocked because the
 * wallet read failed.
 */
export function isWalletBalanceBelowCutoff(
  balanceCents: unknown,
  cutoffCents: number | null
): boolean {
  if (cutoffCents === null || !Number.isFinite(cutoffCents) || cutoffCents < 0) return false;
  if (typeof balanceCents !== "number" || !Number.isFinite(balanceCents)) return false;
  return balanceCents <= cutoffCents + WALLET_CENTS_EPSILON;
}
