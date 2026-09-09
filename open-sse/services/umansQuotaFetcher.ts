/**
 * umansQuotaFetcher.ts — Umans AI prepaid-wallet + rolling-window quota fetcher
 *
 * Implements QuotaFetcher for Umans connections (quotaPreflight.ts +
 * quotaMonitor.ts). Umans is reached through the generic OpenAI-compatible
 * custom node, so registration is keyed by the CANONICAL key
 * (`UMANS_PROVIDER_KEY`) plus the base-URL connection predicate — never by the
 * routing provider id, which is a per-install `openai-compatible-<uuid>`.
 * Umans Code is pay-per-token: the operator prepays a wallet
 * and every request bills against it, so **the cash balance is the real spend
 * limit** — the tier's request/concurrency caps only bound bursts.
 *
 * Two independent, best-effort upstream signals (same Bearer API key):
 *
 *   GET https://app.umans.ai/api/v1/wallet/summary   (dashboard host)
 *     { balance: { balanceCents, funded, asOf }, spend: { last24hCents, … },
 *       usage30d: {…}, breakdown: [ { model, spendCents, … } ], asOf }
 *     Amounts are in cents and MAY be fractional (e.g. 769.004324) — the field
 *     name ends in "Cents" but the value is not an integer. Never round it.
 *     A key with no wallet behind it gets `404 wallet_not_found`.
 *
 *   GET https://api.code.umans.ai/v1/usage           (gateway host)
 *     { billing: { mode }, plan: { slug }, limits: { requests, concurrency },
 *       usage: { requests_in_window, remaining_requests, weighted_*, … },
 *       window: { resets_at, remaining_minutes } }
 *
 * Neither call may erase the other: wallet-only, usage-only and both-succeed
 * all produce a usable snapshot; only "neither signal" returns null.
 *
 * Mapping to QuotaInfo:
 *   • `wallet` window — a depleting cash balance, so `resetAt` is ALWAYS null.
 *     `percentUsed` is informational (0 funded / 1 depleted): `balanceCents`
 *     alone has no denominator, and historical spend / request caps / top-ups
 *     are not valid ones. The authoritative number is `balanceCents`, which
 *     the money-aware cutoff in ./walletCutoff.ts compares directly.
 *   • `requests` window — real soft-cap denominator from limits.requests.limit,
 *     worst of the raw and weighted remaining fractions (weighting is materially
 *     heavier in practice, so either can be the binding constraint).
 *   • concurrency — a saturation signal, NOT a depletion window. Exposed as a
 *     detail only; it must never become a percentage or a wallet denominator.
 *
 * Wallet mode is detected from `billing.mode === "pay_by_token"`, with the
 * `plan.slug === "service_account"` compatibility backstop.
 *
 * Fail-open: missing key, timeout, network error, malformed JSON, 404 and any
 * non-2xx return null (or drop just that signal). Quota telemetry must never
 * disable routing. 401/403 additionally invalidates the connection cache.
 *
 * Cache: 60s in-memory TTL keyed by connectionId. A snapshot missing a signal
 * because the key was rejected (401/403) is NEVER cached — caching it would
 * suppress the retry for the whole TTL and delay credential recovery. A call
 * without a connection id skips the cache entirely rather than sharing one
 * global entry across credentials.
 *
 * Registration: registerUmansQuotaFetcher() via the quotaTrackersBatch
 * side-effect import (before registerGenericQuotaFetchers).
 */

import { registerQuotaFetcher, registerQuotaWindows, type QuotaInfo } from "./quotaPreflight.ts";
import {
  isUmansConnection,
  UMANS_PROVIDER_KEY,
  UMANS_QUOTA_WINDOWS,
  UMANS_WINDOW_REQUESTS,
  UMANS_WINDOW_WALLET,
} from "./umansConnection.ts";
import { registerMonitorFetcher } from "./quotaMonitor.ts";
import { throttleQuotaFetch } from "./quotaFetchThrottle.ts";

/** Wallet summary lives on the dashboard host, not the gateway host. */
export const UMANS_WALLET_SUMMARY_URL = "https://app.umans.ai/api/v1/wallet/summary";
/** Rolling request/concurrency window lives on the gateway host. */
export const UMANS_USAGE_URL = "https://api.code.umans.ai/v1/usage";

const CACHE_TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

// Connection identity lives in the import-free ./umansConnection.ts leaf so the
// DB layer, the resilience settings resolver and client components can share it
// without pulling in this fetcher. Re-exported here because this module is the
// public import path for the Umans quota surface.
export {
  isUmansConnection,
  resolveQuotaProviderKey,
  UMANS_BASE_URL,
  UMANS_PROVIDER_KEY,
  UMANS_QUOTA_WINDOWS,
  UMANS_WINDOW_CONCURRENCY,
  UMANS_WINDOW_REQUESTS,
  UMANS_WINDOW_WALLET,
} from "./umansConnection.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface UmansSpend {
  last24hCents: number | null;
  last7dCents: number | null;
  last30dCents: number | null;
}

export interface UmansUsage30d {
  requests: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  tokensCachedRead: number | null;
}

export interface UmansBreakdownEntry {
  model: string | null;
  keyName: string | null;
  keyPrefix: string | null;
  requests: number | null;
  spendCents: number | null;
}

export interface UmansWalletSnapshot {
  /**
   * Remaining prepaid balance in cents. `null` when the upstream omitted or
   * malformed the field — UNKNOWN, never "exhausted".
   */
  balanceCents: number | null;
  /** `false` is an authoritative exhausted/suspended signal. */
  funded: boolean | null;
  /** Ledger freshness for the balance block (trails real time by ~1 min). */
  balanceAsOf: string | null;
  /** Ledger freshness for the whole summary. */
  asOf: string | null;
  spend: UmansSpend;
  usage30d: UmansUsage30d;
  breakdown: UmansBreakdownEntry[];
  walletOwner: string | null;
}

export interface UmansUsageSnapshot {
  /** `pay_by_token` or `plan`; null when the field is absent. */
  billingMode: string | null;
  planSlug: string | null;
  requestLimit: number | null;
  requestHardCap: number | null;
  requestWindowSeconds: number | null;
  requestsInWindow: number | null;
  remainingRequests: number | null;
  weightedInWindow: number | null;
  weightedRemainingRequests: number | null;
  concurrencyLimit: number | null;
  concurrencyHardCap: number | null;
  concurrentSessions: number | null;
  resetsAt: string | null;
}

export interface UmansQuota extends QuotaInfo {
  /**
   * Authoritative remaining prepaid cash, in cents, preserving fractional
   * precision. `null` when the wallet read failed or the field was malformed.
   * Read directly by the money-aware cutoff — NOT via a percentage.
   */
  balanceCents: number | null;
  funded: boolean | null;
  /** True only for `funded === false` or a valid non-positive balance. */
  walletExhausted: boolean;
  /** True when this key spends from a prepaid wallet (vs an archived plan). */
  walletMode: boolean;
  asOf: string | null;
  spend: UmansSpend | null;
  usage30d: UmansUsage30d | null;
  breakdown: UmansBreakdownEntry[];
  /** Concurrency is a saturation signal, kept out of `windows` on purpose. */
  concurrency: { limit: number | null; hardCap: number | null; sessions: number | null } | null;
  requests: {
    limit: number | null;
    hardCap: number | null;
    used: number | null;
    remaining: number | null;
    weightedUsed: number | null;
    weightedRemaining: number | null;
    windowSeconds: number | null;
    resetsAt: string | null;
  } | null;
  limitReached: boolean;
}

interface CacheEntry {
  quota: UmansQuota | null;
  fetchedAt: number;
}

// ─── Cache ───────────────────────────────────────────────────────────────────

const quotaCache = new Map<string, CacheEntry>();

const _cacheCleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of quotaCache) {
    if (now - entry.fetchedAt > CACHE_TTL_MS * 5) {
      quotaCache.delete(key);
    }
  }
}, 5 * 60_000);
if (typeof _cacheCleanup === "object" && _cacheCleanup && "unref" in _cacheCleanup) {
  (_cacheCleanup as { unref?: () => void }).unref?.();
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Finite number or null. Strings are accepted (upstream sends both shapes). */
function finiteOrNull(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Finite, non-negative number or null. Used for counters and limits. */
function nonNegativeOrNull(value: unknown): number | null {
  const parsed = finiteOrNull(value);
  return parsed !== null && parsed >= 0 ? parsed : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function boolOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/** Fraction of a bucket consumed, clamped to 0..1. Null when unusable. */
function usedFraction(used: number | null, limit: number | null): number | null {
  if (used === null || limit === null || limit <= 0) return null;
  return Math.min(1, Math.max(0, used / limit));
}

/**
 * Same fraction, but tolerant of the payload shape that reports only what is
 * LEFT in the window. `limit` + `remaining` carries exactly as much information
 * as `limit` + `used`, so deriving `(limit - remaining) / limit` is the
 * difference between a real request window and no window at all.
 */
function consumedFraction(
  used: number | null,
  remaining: number | null,
  limit: number | null
): number | null {
  const fromUsed = usedFraction(used, limit);
  if (fromUsed !== null) return fromUsed;
  if (remaining === null || limit === null || limit <= 0) return null;
  return Math.min(1, Math.max(0, (limit - remaining) / limit));
}

// ─── Parsers (pure — unit-testable without network) ──────────────────────────

/**
 * Parse `GET /api/v1/wallet/summary`. Returns null only when the payload is not
 * an object at all; a summary with an unreadable balance still carries spend /
 * breakdown / freshness metadata and must not be mistaken for exhaustion.
 */
export function parseUmansWalletSummary(data: unknown): UmansWalletSnapshot | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const obj = data as Record<string, unknown>;
  const balance = toRecord(obj.balance);
  const spend = toRecord(obj.spend);
  const usage30d = toRecord(obj.usage30d);
  const wallet = toRecord(obj.wallet);

  const rawBalanceCents = finiteOrNull(balance.balanceCents);
  // A negative balance is not a documented state and would make a cutoff
  // comparison meaningless — treat it as unreadable rather than guessing.
  const balanceCents = rawBalanceCents !== null && rawBalanceCents >= 0 ? rawBalanceCents : null;

  const breakdown: UmansBreakdownEntry[] = Array.isArray(obj.breakdown)
    ? obj.breakdown.map((entry) => {
        const row = toRecord(entry);
        return {
          model: stringOrNull(row.model),
          keyName: stringOrNull(row.keyName),
          keyPrefix: stringOrNull(row.keyPrefix),
          requests: nonNegativeOrNull(row.requests),
          spendCents: finiteOrNull(row.spendCents),
        };
      })
    : [];

  return {
    balanceCents,
    funded: boolOrNull(balance.funded),
    balanceAsOf: stringOrNull(balance.asOf),
    asOf: stringOrNull(obj.asOf),
    spend: {
      last24hCents: finiteOrNull(spend.last24hCents),
      last7dCents: finiteOrNull(spend.last7dCents),
      last30dCents: finiteOrNull(spend.last30dCents),
    },
    usage30d: {
      requests: nonNegativeOrNull(usage30d.requests),
      tokensIn: nonNegativeOrNull(usage30d.tokensIn),
      tokensOut: nonNegativeOrNull(usage30d.tokensOut),
      tokensCachedRead: nonNegativeOrNull(usage30d.tokensCachedRead),
    },
    breakdown,
    walletOwner: stringOrNull(wallet.owner),
  };
}

/** Parse `GET /v1/usage`. Returns null when the payload is not an object. */
export function parseUmansUsage(data: unknown): UmansUsageSnapshot | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const obj = data as Record<string, unknown>;
  const limits = toRecord(obj.limits);
  const requests = toRecord(limits.requests);
  const concurrency = toRecord(limits.concurrency);
  const usage = toRecord(obj.usage);
  const window = toRecord(obj.window);

  return {
    billingMode: stringOrNull(toRecord(obj.billing).mode),
    planSlug: stringOrNull(toRecord(obj.plan).slug),
    requestLimit: nonNegativeOrNull(requests.limit),
    requestHardCap: nonNegativeOrNull(requests.hard_cap),
    requestWindowSeconds: nonNegativeOrNull(requests.window_seconds),
    requestsInWindow: nonNegativeOrNull(usage.requests_in_window),
    remainingRequests: nonNegativeOrNull(usage.remaining_requests),
    weightedInWindow: nonNegativeOrNull(usage.weighted_in_window),
    weightedRemainingRequests: nonNegativeOrNull(usage.weighted_remaining_requests),
    concurrencyLimit: nonNegativeOrNull(concurrency.limit),
    concurrencyHardCap: nonNegativeOrNull(concurrency.hard_cap),
    concurrentSessions: nonNegativeOrNull(usage.concurrent_sessions),
    resetsAt: stringOrNull(window.resets_at),
  };
}

/**
 * True when this key spends from a prepaid wallet. Primary signal is the
 * additive `billing.mode`; `plan.slug === "service_account"` is the documented
 * compatibility backstop for gateways that predate the billing field. A
 * successful wallet summary is itself proof of a wallet (archived-plan keys get
 * `404 wallet_not_found`), so it also counts.
 */
export function isUmansWalletMode(
  usage: UmansUsageSnapshot | null,
  wallet: UmansWalletSnapshot | null
): boolean {
  if (wallet) return true;
  if (!usage) return false;
  if (usage.billingMode === "pay_by_token") return true;
  return usage.planSlug === "service_account";
}

/**
 * Assemble the preflight snapshot from whichever signals survived. Returns null
 * only when neither did.
 */
export function buildUmansQuota(
  wallet: UmansWalletSnapshot | null,
  usage: UmansUsageSnapshot | null
): UmansQuota | null {
  if (!wallet && !usage) return null;

  const balanceCents = wallet?.balanceCents ?? null;
  // Authoritative exhaustion ONLY from an explicit `funded: false` or a valid
  // non-positive balance. A missing/unreadable balance is unknown — inferring
  // exhaustion from it would turn a provider schema change into account
  // switching for every Umans connection at once.
  const walletExhausted =
    wallet !== null && (wallet.funded === false || (balanceCents !== null && balanceCents <= 0));

  const windows: Record<string, { percentUsed: number; resetAt?: string | null }> = {};

  if (wallet) {
    // Informational only: there is no ceiling to divide by, so this is a
    // funded/depleted flag, not a progress bar. `resetAt` is always null —
    // a prepaid balance never resets, and `asOf` is ledger freshness, not a
    // reset instant.
    windows[UMANS_WINDOW_WALLET] = { percentUsed: walletExhausted ? 1 : 0, resetAt: null };
  }

  let requests: UmansQuota["requests"] = null;
  if (usage) {
    requests = {
      limit: usage.requestLimit,
      hardCap: usage.requestHardCap,
      used: usage.requestsInWindow,
      remaining: usage.remainingRequests,
      weightedUsed: usage.weightedInWindow,
      weightedRemaining: usage.weightedRemainingRequests,
      windowSeconds: usage.requestWindowSeconds,
      resetsAt: usage.resetsAt,
    };
    // Only emit a percentage window when the soft cap gives a real denominator.
    // Weighting is materially heavier than the raw count in practice, so the
    // binding constraint can be either — take the worst of the two.
    const rawFraction = consumedFraction(
      usage.requestsInWindow,
      usage.remainingRequests,
      usage.requestLimit
    );
    const weightedFraction = consumedFraction(
      usage.weightedInWindow,
      usage.weightedRemainingRequests,
      usage.requestLimit
    );
    const fractions = [rawFraction, weightedFraction].filter(
      (value): value is number => value !== null
    );
    if (fractions.length > 0) {
      windows[UMANS_WINDOW_REQUESTS] = {
        percentUsed: Math.max(...fractions),
        resetAt: usage.resetsAt,
      };
    }
  }

  const percentUsedValues = Object.values(windows).map((w) => w.percentUsed);
  const percentUsed = percentUsedValues.length > 0 ? Math.max(...percentUsedValues) : 0;

  return {
    used: percentUsed * 100,
    total: 100,
    percentUsed,
    // A wallet never resets; the request window's reset lives on its own entry.
    resetAt: null,
    windows,
    balanceCents,
    funded: wallet?.funded ?? null,
    walletExhausted,
    walletMode: isUmansWalletMode(usage, wallet),
    asOf: wallet?.asOf ?? wallet?.balanceAsOf ?? null,
    spend: wallet?.spend ?? null,
    usage30d: wallet?.usage30d ?? null,
    breakdown: wallet?.breakdown ?? [],
    concurrency: usage
      ? {
          limit: usage.concurrencyLimit,
          hardCap: usage.concurrencyHardCap,
          sessions: usage.concurrentSessions,
        }
      : null,
    requests,
    limitReached: walletExhausted,
  };
}

// ─── Core fetcher ────────────────────────────────────────────────────────────

function extractApiKey(connection?: Record<string, unknown>): string | null {
  const apiKey = connection?.apiKey;
  return typeof apiKey === "string" && apiKey.trim().length > 0 ? apiKey : null;
}

type SignalResult<T> = { value: T | null; unauthorized: boolean };

async function fetchJsonSignal<T>(
  url: string,
  apiKey: string,
  parse: (data: unknown) => T | null
): Promise<SignalResult<T>> {
  try {
    // #6911: space concurrent upstream quota fetches so N accounts on one IP do
    // not all hit the provider in the same second. Cache hits never reach here.
    await throttleQuotaFetch();

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (response.status === 401 || response.status === 403) {
      return { value: null, unauthorized: true };
    }
    // 404 on the wallet summary is the documented `wallet_not_found` signal for
    // an archived-plan key — drop the signal, keep the other one.
    if (!response.ok) return { value: null, unauthorized: false };

    return { value: parse(await response.json()), unauthorized: false };
  } catch {
    // Timeout, network error, malformed JSON — fail open on this signal.
    return { value: null, unauthorized: false };
  }
}

/**
 * Fetch the current wallet + window snapshot for an Umans connection.
 * Returns null when there are no credentials or neither upstream signal
 * produced usable data.
 */
export async function fetchUmansQuota(
  connectionId: string,
  connection?: Record<string, unknown>
): Promise<QuotaInfo | null> {
  // No id → no cache. Sharing one `""` entry would hand a snapshot fetched with
  // one API key to every other credential that also arrives without an id.
  const cacheKey =
    typeof connectionId === "string" && connectionId.trim() !== "" ? connectionId : null;

  if (cacheKey) {
    const cached = quotaCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return cached.quota;
    }
  }

  const apiKey = extractApiKey(connection);
  if (!apiKey) return null;

  // Independent best-effort signals: one failing must never erase the other.
  const [walletResult, usageResult] = await Promise.all([
    fetchJsonSignal(UMANS_WALLET_SUMMARY_URL, apiKey, parseUmansWalletSummary),
    fetchJsonSignal(UMANS_USAGE_URL, apiKey, parseUmansUsage),
  ]);

  const unauthorized = walletResult.unauthorized || usageResult.unauthorized;
  if (unauthorized && cacheKey) {
    quotaCache.delete(cacheKey);
  }

  const quota = buildUmansQuota(walletResult.value, usageResult.value);
  if (!quota) return null;

  // A snapshot whose missing half is missing because the key was REJECTED is
  // not a valid cache entry: storing it would pin the partial view for the full
  // TTL and delay recovery after the operator fixes the credential. The
  // surviving signal is still returned to this caller — it just isn't cached.
  if (!unauthorized && cacheKey) {
    quotaCache.set(cacheKey, { quota, fetchedAt: Date.now() });
  }
  return quota;
}

// ─── Invalidation ────────────────────────────────────────────────────────────

export function invalidateUmansQuotaCache(connectionId: string): void {
  quotaCache.delete(connectionId);
}

// ─── Registration ────────────────────────────────────────────────────────────

/**
 * Register the Umans wallet fetcher for preflight + active-session monitoring
 * and publish its named windows for the Provider Limits cutoff modal.
 * Called once at startup from quotaTrackersBatch, ahead of the generic
 * registration (which skips providers that already have a bespoke fetcher).
 *
 * Registered under the CANONICAL key + the base-URL predicate, which is what
 * makes a real `openai-compatible-<uuid>` connection resolve: the registry
 * tries the exact provider id first, then falls back to predicate matching
 * whenever the caller supplies the connection. Every lookup on a routing path
 * therefore has to pass the connection — see `resolveQuotaProviderKey` and
 * `mayHaveQuotaFetcher` for the call sites that cannot.
 */
export function registerUmansQuotaFetcher(): void {
  const isUmans = isUmansConnection;
  registerQuotaFetcher(UMANS_PROVIDER_KEY, fetchUmansQuota, isUmans);
  registerMonitorFetcher(UMANS_PROVIDER_KEY, fetchUmansQuota, isUmans);
  registerQuotaWindows(UMANS_PROVIDER_KEY, UMANS_QUOTA_WINDOWS, isUmans);
}
