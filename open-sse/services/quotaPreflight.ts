/**
 * quotaPreflight.ts — Feature 04
 * Quota Preflight & Troca Proativa de Conta
 *
 * Providers register quota fetchers via registerQuotaFetcher(). The caller
 * (`src/sse/services/auth.ts::getProviderCredentialsWithQuotaPreflight`) is
 * responsible for deciding WHEN to invoke preflight — calling it adds the
 * latency of an upstream usage fetch, so it should only run when there's
 * something to enforce (per-connection overrides, per-(provider, window)
 * defaults, or the legacy `quotaPreflightEnabled` flag).
 *
 * Threshold semantics are "minimum remaining %" — matching the dashboard's
 * quota bars, which show remaining (not used). A cutoff of 10 means "stop
 * using this connection when it has 10% or less remaining."
 *
 * `isQuotaPreflightEnabled` remains exported for back-compat so the caller
 * can honor the legacy flag, but `preflightQuota` itself no longer gates on
 * it — once you invoke preflight, it runs the fetcher and evaluates.
 */

import { isCompatibleProviderConnectionId } from "@/shared/utils/compatibleProviderId";
import { isFeatureFlagEnabled } from "@/shared/utils/featureFlags";
import { fetchNewApiAggregatorQuota } from "./newApiAggregatorQuotaFetcher.ts";
import { isWalletBalanceBelowCutoff } from "./walletCutoff.ts";

export interface PreflightQuotaResult {
  proceed: boolean;
  reason?: string;
  quotaPercent?: number;
  resetAt?: string | null;
}

export interface QuotaWindowInfo {
  percentUsed: number;
  resetAt?: string | null;
}

export interface QuotaInfo {
  used: number;
  total: number;
  /** Worst-case percentUsed across all known windows (legacy, single-signal). */
  percentUsed: number;
  resetAt?: string | null;
  /**
   * Optional per-window breakdown. When present, preflight evaluates each
   * window against its own threshold (block if ANY window has dropped to or
   * below its min-remaining cutoff) instead of using `percentUsed`. Keys are
   * window names that match the quota keys surfaced by getUsageForProvider
   * (e.g. "session", "weekly", "monthly").
   */
  windows?: Record<string, QuotaWindowInfo>;
  /**
   * Structural, canonical window snapshots used by reset-aware / reset-window
   * scoring. Providers that expose time-based windows (5h, weekly, monthly)
   * populate these in addition to the provider-native `windows` map so the
   * scorer does not need to know every provider's key naming convention.
   */
  window5h?: QuotaWindowInfo;
  window7d?: QuotaWindowInfo;
  windowWeekly?: QuotaWindowInfo;
  windowMonthly?: QuotaWindowInfo;
  /** True when the upstream usage endpoint explicitly reports exhausted quota. */
  limitReached?: boolean;
  /**
   * Authoritative remaining prepaid cash, in cents, for providers billed from a
   * wallet (Umans). Fractional values are meaningful and must not be rounded.
   * A wallet has no denominator, so this is compared DIRECTLY against the
   * operator's configured money cutoff — never converted to a percentage.
   * `null`/absent means "unknown", which fails open (never "exhausted").
   */
  balanceCents?: number | null;
}

export type QuotaFetcher = (
  connectionId: string,
  connection?: Record<string, unknown>
) => Promise<QuotaInfo | null>;

/**
 * Registry of named quota windows per provider. Used by the dashboard to
 * discover which inputs to render in the cutoffs modal. Providers without
 * multiple windows can skip registration — preflight falls back to the
 * single-signal `percentUsed` path in that case.
 */
type QuotaWindowRegistration = {
  windows: readonly string[];
  connectionPredicate?: (connection: Record<string, unknown>) => boolean;
};

const quotaWindowsRegistry = new Map<string, QuotaWindowRegistration>();

export function registerQuotaWindows(
  provider: string,
  windows: readonly string[],
  connectionPredicate?: (connection: Record<string, unknown>) => boolean
): void {
  quotaWindowsRegistry.set(provider, { windows: [...windows], connectionPredicate });
}

export function getQuotaWindows(
  provider: string,
  connection?: Record<string, unknown>
): readonly string[] {
  const exact =
    quotaWindowsRegistry.get(provider) || quotaWindowsRegistry.get(provider.toLowerCase());
  if (exact && (!exact.connectionPredicate || !connection || exact.connectionPredicate(connection))) {
    return exact.windows;
  }
  if (!connection) return [];
  for (const registration of quotaWindowsRegistry.values()) {
    if (registration.connectionPredicate?.(connection)) return registration.windows;
  }
  return [];
}

export function getAllProviderQuotaWindows(): Record<string, readonly string[]> {
  return Object.fromEntries(
    [...quotaWindowsRegistry.entries()].map(([provider, registration]) => [provider, registration.windows])
  );
}

// Thresholds use "minimum remaining %" semantics so the numbers match the
// dashboard's quota bars (which show remaining %). A cutoff of 2 means
// "block when only 2% remaining" (= 98% used). Warn fires earlier — at
// 20% remaining (= 80% used) by default.
const DEFAULT_MIN_REMAINING_PERCENT = 2;
const DEFAULT_WARN_REMAINING_PERCENT = 20;
const REMAINING_PERCENT_EPSILON = 1e-9;

type QuotaFetcherRegistration = {
  fetcher: QuotaFetcher;
  connectionPredicate?: (connection: Record<string, unknown>) => boolean;
};

const quotaFetcherRegistry = new Map<string, QuotaFetcherRegistration>();

export function registerQuotaFetcher(
  provider: string,
  fetcher: QuotaFetcher,
  connectionPredicate?: (connection: Record<string, unknown>) => boolean
): void {
  quotaFetcherRegistry.set(provider, { fetcher, connectionPredicate });
}

export function getQuotaFetcher(
  provider: string,
  connection?: Record<string, unknown>
): QuotaFetcher | undefined {
  const exact = quotaFetcherRegistry.get(provider) || quotaFetcherRegistry.get(provider.toLowerCase());
  if (exact && (!exact.connectionPredicate || !connection || exact.connectionPredicate(connection))) {
    return exact.fetcher;
  }
  if (!connection) return undefined;
  for (const registration of quotaFetcherRegistry.values()) {
    if (registration.connectionPredicate?.(connection)) return registration.fetcher;
  }
  return undefined;
}

export function isQuotaPreflightEnabled(connection: Record<string, unknown>): boolean {
  const psd = connection?.providerSpecificData as Record<string, unknown> | undefined;
  return psd?.quotaPreflightEnabled === true;
}

export interface PreflightQuotaThresholds {
  /**
   * Resolve the minimum-remaining cutoff (0-100 integer) for a given window
   * name. The connection is blocked when its remaining quota drops to this
   * value or below — e.g. returning 10 means "stop when only 10% remaining."
   * Resolution order, low-to-high precedence:
   *   global default → per-(provider, window) default → connection override
   * Window name is `null` when the underlying fetcher only exposes a single-
   * signal `percentUsed` (legacy path).
   */
  resolveMinRemainingPercent?: (window: string | null) => number;
  /**
   * Resolve the warning threshold (0-100 integer remaining %) for a window.
   * Warn fires when remaining quota drops to this value or below — should be
   * HIGHER than the min-remaining cutoff so warnings appear before the block
   * point.
   */
  resolveWarnRemainingPercent?: (window: string | null) => number;
  /**
   * Resolve the absolute remaining-cash reserve (in cents) below which a
   * prepaid-wallet connection stops being selected. Returns `null` when no
   * money cutoff is configured. Evaluated directly against
   * `QuotaInfo.balanceCents`, independently of the percentage thresholds
   * above — a wallet has no denominator to build a percentage from.
   * Resolution order: connection override → provider default → disabled.
   */
  resolveWalletCutoffCents?: () => number | null;
}

function resolveOrDefault(
  resolver: ((window: string | null) => number) | undefined,
  window: string | null,
  fallbackPercent: number
): number {
  if (!resolver) return fallbackPercent;
  const raw = resolver(window);
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw <= 100) {
    return raw;
  }
  return fallbackPercent;
}

function remainingPercentFrom(percentUsed: number): number {
  return Math.max(0, (1 - percentUsed) * 100);
}

function isRemainingAtOrBelowThreshold(
  remainingPercent: number,
  thresholdPercent: number
): boolean {
  return remainingPercent <= thresholdPercent + REMAINING_PERCENT_EPSILON;
}

function exhaustedResult(quotaPercent: number, resetAt: string | null): PreflightQuotaResult {
  return {
    proceed: false,
    reason: "quota_exhausted",
    quotaPercent,
    resetAt,
  };
}

function limitReachedResult(quota: QuotaInfo): PreflightQuotaResult {
  return exhaustedResult(
    Number.isFinite(quota.percentUsed) ? quota.percentUsed : 1,
    quota.resetAt ?? null
  );
}

function quotaWindowCutoffResult(
  windows: NonNullable<QuotaInfo["windows"]>,
  thresholds?: PreflightQuotaThresholds
): PreflightQuotaResult | null {
  let worstUsedPercent = 0;
  let worstWindow: string | null = null;
  let worstResetAt: string | null = null;

  for (const [windowName, windowInfo] of Object.entries(windows)) {
    if (!Number.isFinite(windowInfo.percentUsed)) continue;
    const minRemainingPercent = resolveOrDefault(
      thresholds?.resolveMinRemainingPercent,
      windowName,
      DEFAULT_MIN_REMAINING_PERCENT
    );
    if (
      !isRemainingAtOrBelowThreshold(
        remainingPercentFrom(windowInfo.percentUsed),
        minRemainingPercent
      )
    ) {
      continue;
    }
    if (windowInfo.percentUsed <= worstUsedPercent && worstWindow !== null) continue;
    worstUsedPercent = windowInfo.percentUsed;
    worstWindow = windowName;
    worstResetAt = windowInfo.resetAt ?? null;
  }

  return worstWindow === null ? null : exhaustedResult(worstUsedPercent, worstResetAt);
}

function quotaPercentCutoffResult(
  quota: QuotaInfo,
  thresholds?: PreflightQuotaThresholds
): PreflightQuotaResult {
  if (!Number.isFinite(quota.percentUsed)) return { proceed: true };

  const minRemainingPercent = resolveOrDefault(
    thresholds?.resolveMinRemainingPercent,
    null,
    DEFAULT_MIN_REMAINING_PERCENT
  );
  const remainingPercent = remainingPercentFrom(quota.percentUsed);
  return isRemainingAtOrBelowThreshold(remainingPercent, minRemainingPercent)
    ? exhaustedResult(quota.percentUsed, quota.resetAt ?? null)
    : { proceed: true, quotaPercent: quota.percentUsed };
}

/**
 * Money-valued cutoff for prepaid wallets. Runs before the percentage windows
 * because the cash balance IS the spend limit for these providers; the tier's
 * request/concurrency caps only bound bursts. Returns null when there is no
 * configured cutoff or no readable balance (fail open).
 */
function walletCutoffResult(
  quota: QuotaInfo,
  thresholds?: PreflightQuotaThresholds
): PreflightQuotaResult | null {
  const cutoffCents = thresholds?.resolveWalletCutoffCents?.() ?? null;
  if (!isWalletBalanceBelowCutoff(quota.balanceCents, cutoffCents)) return null;
  // A wallet never resets — only a top-up refills it — so resetAt stays null.
  return exhaustedResult(Number.isFinite(quota.percentUsed) ? quota.percentUsed : 1, null);
}

/**
 * Pure cutoff evaluator used by routing paths that already fetched quota.
 * Mirrors preflightQuota threshold semantics without performing I/O or logging.
 */
export function evaluateQuotaCutoff(
  quota: QuotaInfo | null | undefined,
  thresholds?: PreflightQuotaThresholds
): PreflightQuotaResult {
  if (!quota) return { proceed: true };
  if (quota.limitReached === true) return limitReachedResult(quota);

  const walletBlocked = walletCutoffResult(quota, thresholds);
  if (walletBlocked) return walletBlocked;

  const windows = quota.windows;
  if (windows && Object.keys(windows).length > 0) {
    return (
      quotaWindowCutoffResult(windows, thresholds) ?? {
        proceed: true,
        quotaPercent: quota.percentUsed,
      }
    );
  }

  return quotaPercentCutoffResult(quota, thresholds);
}

/**
 * Resolve a dynamic quota fetcher for compatible-provider connections that
 * opt in to New-API / One-API / Sub2API aggregator balance detection.
 * Returns the fetcher when both the feature flag and the connection's
 * aggregator flag are true; otherwise returns undefined.
 */
export function resolveDynamicQuotaFetcher(
  provider: string,
  connection: Record<string, unknown>
): QuotaFetcher | undefined {
  // Dynamic dispatch only for compatible-provider connection IDs
  if (!isCompatibleProviderConnectionId(provider)) return undefined;

  // Connection must opt in via providerSpecificData.newApiAggregatorBalance
  const psd = connection?.providerSpecificData as Record<string, unknown> | undefined;
  if (!psd || psd.newApiAggregatorBalance !== true) return undefined;

  // Feature flag must be enabled
  if (!isFeatureFlagEnabled("NEWAPI_AGGREGATOR_BALANCE")) return undefined;

  return fetchNewApiAggregatorQuota;
}

export async function preflightQuota(
  provider: string,
  connectionId: string,
  connection: Record<string, unknown>,
  thresholds?: PreflightQuotaThresholds
): Promise<PreflightQuotaResult> {
  // No legacy enable-flag gate here — the caller decides when to invoke us
  // (see file-level docstring). When there's no fetcher we proceed silently.
  let fetcher = getQuotaFetcher(provider, connection);
  if (!fetcher) {
    // Dynamic fallback: for compatible-provider connections with the
    // aggregator flag + feature flag, use the generalized New-API fetcher.
    fetcher = resolveDynamicQuotaFetcher(provider, connection);
    if (!fetcher) {
      return { proceed: true };
    }
  }

  let quota: QuotaInfo | null = null;
  try {
    quota = await fetcher(connectionId, connection);
  } catch {
    return { proceed: true };
  }

  if (!quota) {
    return { proceed: true };
  }

  if (quota.limitReached === true) {
    return limitReachedResult(quota);
  }

  // Money-aware wallet reserve — evaluated before the percentage windows.
  const walletBlocked = walletCutoffResult(quota, thresholds);
  if (walletBlocked) {
    console.info(
      `[QuotaPreflight] ${provider}/${connectionId} wallet: ${quota.balanceCents} cents remaining — at or below the configured cutoff, switching`
    );
    return walletBlocked;
  }

  // Per-window evaluation — only when the fetcher surfaces a windows map.
  // We block as soon as ANY single window's remaining quota drops to its
  // configured cutoff or below; warnings are logged independently per window.
  if (quota.windows && Object.keys(quota.windows).length > 0) {
    let worstUsedPercent = 0;
    let worstWindow: string | null = null;
    let worstResetAt: string | null = null;
    for (const [windowName, windowInfo] of Object.entries(quota.windows)) {
      const minRemainingPercent = resolveOrDefault(
        thresholds?.resolveMinRemainingPercent,
        windowName,
        DEFAULT_MIN_REMAINING_PERCENT
      );
      const warnRemainingPercent = resolveOrDefault(
        thresholds?.resolveWarnRemainingPercent,
        windowName,
        DEFAULT_WARN_REMAINING_PERCENT
      );
      const remainingPercent = remainingPercentFrom(windowInfo.percentUsed);

      if (isRemainingAtOrBelowThreshold(remainingPercent, minRemainingPercent)) {
        // Track the most-depleted blocking window so the response can name it.
        if (windowInfo.percentUsed > worstUsedPercent) {
          worstUsedPercent = windowInfo.percentUsed;
          worstWindow = windowName;
          worstResetAt = windowInfo.resetAt ?? null;
        } else if (worstWindow === null) {
          worstWindow = windowName;
          worstResetAt = windowInfo.resetAt ?? null;
        }
      } else if (isRemainingAtOrBelowThreshold(remainingPercent, warnRemainingPercent)) {
        console.warn(
          `[QuotaPreflight] ${provider}/${connectionId} ${windowName}: ${remainingPercent.toFixed(1)}% remaining — approaching cutoff`
        );
      }
    }

    if (worstWindow !== null) {
      const worstRemaining = remainingPercentFrom(worstUsedPercent);
      console.info(
        `[QuotaPreflight] ${provider}/${connectionId} ${worstWindow}: ${worstRemaining.toFixed(1)}% remaining — switching`
      );
      return {
        proceed: false,
        reason: "quota_exhausted",
        quotaPercent: worstUsedPercent,
        resetAt: worstResetAt,
      };
    }

    return { proceed: true, quotaPercent: quota.percentUsed };
  }

  // Legacy single-signal path for fetchers that don't expose per-window data.
  const minRemainingPercent = resolveOrDefault(
    thresholds?.resolveMinRemainingPercent,
    null,
    DEFAULT_MIN_REMAINING_PERCENT
  );
  const warnRemainingPercent = resolveOrDefault(
    thresholds?.resolveWarnRemainingPercent,
    null,
    DEFAULT_WARN_REMAINING_PERCENT
  );

  const { percentUsed } = quota;
  const remainingPercent = remainingPercentFrom(percentUsed);

  if (isRemainingAtOrBelowThreshold(remainingPercent, minRemainingPercent)) {
    console.info(
      `[QuotaPreflight] ${provider}/${connectionId}: ${remainingPercent.toFixed(1)}% remaining — switching (cutoff ${minRemainingPercent}%)`
    );
    return {
      proceed: false,
      reason: "quota_exhausted",
      quotaPercent: percentUsed,
      resetAt: quota.resetAt ?? null,
    };
  }

  if (isRemainingAtOrBelowThreshold(remainingPercent, warnRemainingPercent)) {
    console.warn(
      `[QuotaPreflight] ${provider}/${connectionId}: ${remainingPercent.toFixed(1)}% remaining — approaching cutoff`
    );
  }

  return { proceed: true, quotaPercent: percentUsed };
}
