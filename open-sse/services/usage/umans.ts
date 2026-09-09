/**
 * usage/umans.ts — Umans AI prepaid-wallet usage fetcher.
 *
 * Reuses the already-registered preflight/monitor fetcher
 * (`../umansQuotaFetcher.ts`) instead of re-implementing the two HTTP calls, so
 * the Limits page shares its 60s in-memory cache and its fail-open semantics.
 *
 * Three separate signals, deliberately NOT collapsed into one bar:
 *   • `wallet` — the authoritative prepaid cash balance, rendered as USD. It
 *     never resets (only a top-up refills it), so `resetAt` is null and the
 *     ledger's `asOf` travels as freshness metadata, not as a reset instant.
 *     `remaining` carries the absolute dollar figure so the credits-row
 *     renderer (quotaParsing.ts::parseUmansQuota) formats it as money instead
 *     of a meaningless percentage bar.
 *   • `requests` — the rolling soft-cap window, with the upstream reset when
 *     one is supplied.
 *   • `concurrency` — a concurrent-session cap. Saturation, not depletion: it
 *     is rendered as an open display row and never becomes a percentage.
 *
 * Rolling spend and the per-model `breakdown[]` ride along as display metadata.
 * Neither is a wallet denominator — a prepaid balance has none.
 */
import { fetchUmansQuota, type UmansQuota } from "../umansQuotaFetcher.ts";
import { type UsageQuota } from "./quota.ts";

type JsonRecord = Record<string, unknown>;

/** Cents → USD, preserving the fractional precision the ledger reports. */
function centsToUsd(cents: number): number {
  return cents / 100;
}

function buildWalletQuota(quota: UmansQuota): UsageQuota {
  const balanceCents = quota.balanceCents;
  const remaining = balanceCents === null ? 0 : Math.max(0, centsToUsd(balanceCents));
  // Two-state signal only — a prepaid balance has no ceiling to divide by, so
  // this drives the card's bar color, never a claim about how much is left.
  const remainingPercentage = quota.walletExhausted ? 0 : 100;

  return {
    used: 0,
    total: 0,
    remaining,
    remainingPercentage,
    // A wallet never resets. `asOf` below is ledger freshness, not a reset.
    resetAt: null,
    // NOT unlimited: the balance IS the spend limit, and marking it unlimited
    // would hide the exhausted/cutoff state behind an "unlimited" label.
    unlimited: false,
    currency: "USD",
    displayName:
      balanceCents === null
        ? "Wallet Balance (USD) — unavailable"
        : `Wallet Balance: $${remaining.toFixed(4)}`,
    asOf: quota.asOf,
    spendCents: {
      last24h: quota.spend?.last24hCents ?? null,
      last7d: quota.spend?.last7dCents ?? null,
      last30d: quota.spend?.last30dCents ?? null,
    },
    breakdown: quota.breakdown,
  };
}

function buildRequestsQuota(quota: UmansQuota): UsageQuota | null {
  const requests = quota.requests;
  if (!requests || requests.limit === null || requests.limit <= 0) return null;

  const used = Math.max(0, requests.used ?? 0);
  const total = requests.limit;
  const remaining =
    requests.remaining !== null ? Math.max(0, requests.remaining) : Math.max(0, total - used);

  return {
    used,
    total,
    remaining,
    remainingPercentage: total > 0 ? Math.max(0, Math.min(100, (remaining / total) * 100)) : 0,
    // Only what the upstream actually supplied — never a synthesized window.
    resetAt: requests.resetsAt,
    unlimited: false,
    displayName: `Requests: ${used} of ${total}`,
    details: [
      ...(requests.hardCap !== null ? [{ name: "hard_cap", used: requests.hardCap }] : []),
      // Weighting is materially heavier than the raw count in practice, so the
      // binding constraint can be either — surface both.
      ...(requests.weightedUsed !== null
        ? [{ name: "weighted_used", used: requests.weightedUsed }]
        : []),
      ...(requests.weightedRemaining !== null
        ? [{ name: "weighted_remaining", used: requests.weightedRemaining }]
        : []),
    ],
  };
}

function buildConcurrencyQuota(quota: UmansQuota): UsageQuota | null {
  const concurrency = quota.concurrency;
  if (!concurrency || concurrency.limit === null) return null;

  const sessions = concurrency.sessions ?? 0;
  return {
    used: sessions,
    total: concurrency.limit,
    remaining: Math.max(0, concurrency.limit - sessions),
    // Open display row: a concurrency cap is instantaneous saturation, not a
    // depleting bucket, so it must not read as a quota that runs out.
    resetAt: null,
    unlimited: true,
    displayName: `Concurrency: ${sessions} of ${concurrency.limit} sessions`,
    details:
      concurrency.hardCap !== null ? [{ name: "hard_cap", used: concurrency.hardCap }] : undefined,
  };
}

/**
 * Umans balance + rolling window → dashboard usage shape.
 *
 * Returns `{ message }` when the fetcher yields nothing (no key, or both
 * upstream signals failed), which Provider Limits renders as a graceful
 * per-row status instead of failing the page.
 */
export async function getUmansUsage(connectionId: string | undefined, connection: JsonRecord) {
  // An absent id is passed through as "" on purpose: the fetcher treats a blank
  // id as "do not cache" rather than sharing one global entry, so a caller with
  // no connection id still gets live data without leaking another credential's
  // snapshot. See umansQuotaFetcher.ts::fetchUmansQuota.
  const quota = (await fetchUmansQuota(connectionId || "", connection)) as UmansQuota | null;

  if (!quota) {
    return {
      message: "Umans usage not available. Add an API key to the connection to view the wallet.",
    };
  }

  const quotas: Record<string, UsageQuota> = {};
  // Only claim a wallet when the wallet summary actually answered.
  if (quota.balanceCents !== null || quota.funded !== null) {
    quotas.wallet = buildWalletQuota(quota);
  }
  const requests = buildRequestsQuota(quota);
  if (requests) quotas.requests = requests;
  const concurrency = buildConcurrencyQuota(quota);
  if (concurrency) quotas.concurrency = concurrency;

  const remainingUsd =
    quota.balanceCents === null ? null : Math.max(0, centsToUsd(quota.balanceCents));

  return {
    plan: quota.walletMode ? "Umans (pay-per-token wallet)" : "Umans",
    quotas,
    remainingUsd,
    balanceCents: quota.balanceCents,
    funded: quota.funded,
    asOf: quota.asOf,
    limitReached: quota.limitReached,
  };
}
