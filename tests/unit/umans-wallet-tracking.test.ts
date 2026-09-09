import assert from "node:assert/strict";
import test from "node:test";

import {
  buildUmansQuota,
  fetchUmansQuota,
  invalidateUmansQuotaCache,
  isUmansConnection,
  parseUmansUsage,
  parseUmansWalletSummary,
  registerUmansQuotaFetcher,
  UMANS_BASE_URL,
  UMANS_PROVIDER_KEY,
} from "../../open-sse/services/umansQuotaFetcher.ts";
import { resolveQuotaProviderKey } from "../../open-sse/services/umansConnection.ts";
import {
  evaluateQuotaCutoff,
  getQuotaFetcher,
  getQuotaWindows,
  mayHaveQuotaFetcher,
  preflightQuota,
} from "../../open-sse/services/quotaPreflight.ts";
import {
  isWalletBalanceBelowCutoff,
  resolveWalletCutoffCents,
} from "../../open-sse/services/walletCutoff.ts";
import { normalizeQuotaPreflightSettings } from "../../src/lib/resilience/settings/normalize.ts";
import { getUmansUsage } from "../../open-sse/services/usage/umans.ts";
import { parseQuotaData } from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/quotaParsing.ts";

/**
 * The real provider id of a Umans connection: it is configured as a generic
 * OpenAI-compatible custom node, so nothing in the id says "umans". Every
 * provider-id-keyed lookup has to resolve it through the base-URL predicate.
 */
const GENERIC_PROVIDER_ID = "openai-compatible-chat-2f1b8c6a-0000-4000-8000-abcdef123456";

function umansConnection(extra: Record<string, unknown> = {}) {
  return {
    apiKey: "test-key",
    provider: GENERIC_PROVIDER_ID,
    providerSpecificData: { baseUrl: UMANS_BASE_URL },
    ...extra,
  };
}

function walletResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

/** Install a mocked fetch for the two Umans endpoints; returns a call counter. */
function mockUmansFetch(handlers: { wallet: () => Response; usage: () => Response }): {
  calls: { wallet: number; usage: number };
  restore: () => void;
} {
  const originalFetch = globalThis.fetch;
  const calls = { wallet: 0, usage: 0 };
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.includes("/wallet/summary")) {
      calls.wallet += 1;
      return handlers.wallet();
    }
    calls.usage += 1;
    return handlers.usage();
  }) as typeof globalThis.fetch;
  return { calls, restore: () => (globalThis.fetch = originalFetch) };
}

test("Umans wallet parser preserves decimal cents and wallet metadata", () => {
  const wallet = parseUmansWalletSummary({
    balance: { balanceCents: 769.004324, funded: true, asOf: "balance-time" },
    asOf: "summary-time",
    spend: { last24hCents: 1.25, last7dCents: 2.5, last30dCents: 3.75 },
    usage30d: { requests: 4, tokensIn: 5, tokensOut: 6, tokensCachedRead: 7 },
    breakdown: [{ model: "m", requests: 8, spendCents: 9.5 }],
  });

  assert.equal(wallet?.balanceCents, 769.004324);
  assert.equal(wallet?.funded, true);
  assert.equal(wallet?.balanceAsOf, "balance-time");
  assert.equal(wallet?.spend.last30dCents, 3.75);
  assert.equal(wallet?.breakdown[0]?.spendCents, 9.5);
});

test("Umans usage parser and quota mapping keep wallet and request signals separate", () => {
  const usage = parseUmansUsage({
    billing: { mode: "pay_by_token" },
    plan: { slug: "service_account" },
    limits: {
      requests: { limit: 2000, hard_cap: 4000, window_seconds: 18000 },
      concurrency: { limit: 12, hard_cap: 24 },
    },
    usage: {
      requests_in_window: 10,
      remaining_requests: 1990,
      weighted_in_window: 20,
      weighted_remaining_requests: 1980,
      concurrent_sessions: 2,
    },
    window: { resets_at: "reset-time" },
  });
  const wallet = parseUmansWalletSummary({
    balance: { balanceCents: 500, funded: true },
  });
  const quota = buildUmansQuota(wallet, usage);

  assert.equal(quota?.walletMode, true);
  assert.equal(quota?.balanceCents, 500);
  assert.equal(quota?.resetAt, null);
  assert.equal(quota?.windows?.wallet?.resetAt, null);
  assert.equal(quota?.windows?.requests?.resetAt, "reset-time");
  assert.equal(quota?.concurrency?.sessions, 2);
});

// ─── Finding #9: request window from remaining-only counters ─────────────────

test("request window is derived from remaining counters when the used counters are absent", () => {
  const usage = parseUmansUsage({
    limits: { requests: { limit: 200 } },
    // Only what is LEFT — no requests_in_window / weighted_in_window at all.
    usage: { remaining_requests: 150, weighted_remaining_requests: 50 },
  });
  const quota = buildUmansQuota(null, usage);

  // Worst of raw (1 - 150/200 = 0.25) and weighted (1 - 50/200 = 0.75).
  assert.equal(quota?.windows?.requests?.percentUsed, 0.75);
  assert.equal(quota?.percentUsed, 0.75);
});

test("a remaining counter above the limit clamps to a fully-replenished window", () => {
  const quota = buildUmansQuota(
    null,
    parseUmansUsage({
      limits: { requests: { limit: 100 } },
      usage: { remaining_requests: 250 },
    })
  );
  assert.equal(quota?.windows?.requests?.percentUsed, 0);
});

test("no denominator still means no request window at all", () => {
  const quota = buildUmansQuota(
    null,
    parseUmansUsage({ limits: { requests: {} }, usage: { remaining_requests: 5 } })
  );
  assert.equal(quota?.windows?.requests, undefined);
});

// ─── Registration + connection-aware resolution ──────────────────────────────

test("Umans registers under the canonical key and resolves a generic openai-compatible id", () => {
  registerUmansQuotaFetcher();
  const connection = { providerSpecificData: { baseUrl: `${UMANS_BASE_URL}/` } };

  assert.equal(UMANS_PROVIDER_KEY, "umans");
  assert.equal(isUmansConnection(connection), true);
  // The whole point of round 2: the REAL provider id resolves, given the connection.
  assert.equal(getQuotaFetcher(GENERIC_PROVIDER_ID, connection), fetchUmansQuota);
  assert.deepEqual(getQuotaWindows(GENERIC_PROVIDER_ID, connection), [
    "wallet",
    "requests",
    "concurrency",
  ]);
  // The canonical key is also directly addressable (settings/UI lookups).
  assert.equal(getQuotaFetcher(UMANS_PROVIDER_KEY), fetchUmansQuota);
  assert.deepEqual(getQuotaWindows(UMANS_PROVIDER_KEY), ["wallet", "requests", "concurrency"]);
  // A look-alike base URL must NOT inherit the wallet fetcher.
  assert.equal(
    getQuotaFetcher(GENERIC_PROVIDER_ID, {
      providerSpecificData: { baseUrl: "https://api.code.umans.ai.evil.example" },
    }),
    undefined
  );
  assert.equal(
    getQuotaFetcher(GENERIC_PROVIDER_ID, {
      providerSpecificData: { baseUrl: "https://other.example" },
    }),
    undefined
  );
});

test("resolveQuotaProviderKey maps a generic Umans connection onto the canonical key", () => {
  registerUmansQuotaFetcher();
  assert.equal(resolveQuotaProviderKey(GENERIC_PROVIDER_ID, umansConnection()), "umans");
  assert.equal(resolveQuotaProviderKey(GENERIC_PROVIDER_ID, {}), GENERIC_PROVIDER_ID);
  assert.equal(resolveQuotaProviderKey("openai", undefined), "openai");
});

test("mayHaveQuotaFetcher lets compatible-provider ids through without a connection", () => {
  registerUmansQuotaFetcher();
  // The connection-less gate that decides whether to LOAD connections at all.
  assert.equal(getQuotaFetcher(GENERIC_PROVIDER_ID), undefined);
  assert.equal(mayHaveQuotaFetcher(GENERIC_PROVIDER_ID), true);
  // A built-in provider with no fetcher still short-circuits.
  assert.equal(mayHaveQuotaFetcher("definitely-not-a-provider"), false);
});

// ─── Wallet cutoff resolution (Finding #7: canonical settings key) ───────────

test("wallet cutoff resolves connection override over provider default and compares cents directly", () => {
  assert.equal(resolveWalletCutoffCents("umans", { walletCutoffCents: 25 }, { umans: 50 }), 25);
  assert.equal(resolveWalletCutoffCents("umans", { walletCutoffCents: null }, { umans: 50 }), 50);
  assert.equal(resolveWalletCutoffCents("umans", {}, {}), null);
  assert.equal(isWalletBalanceBelowCutoff(25, 25), true);
  assert.equal(isWalletBalanceBelowCutoff(25.01, 25), false);
  assert.equal(isWalletBalanceBelowCutoff(null, 25), false);
});

test("walletCutoffCentsByProvider.umans applies to a generic openai-compatible connection", () => {
  // Before round 2 this returned null: the map is keyed "umans" while routing
  // uses `openai-compatible-<uuid>`, so the documented key never applied.
  assert.equal(
    resolveWalletCutoffCents(GENERIC_PROVIDER_ID, umansConnection(), { umans: 500 }),
    500
  );
  // The connection override still wins over the canonical provider default.
  assert.equal(
    resolveWalletCutoffCents(GENERIC_PROVIDER_ID, umansConnection({ walletCutoffCents: 10 }), {
      umans: 500,
    }),
    10
  );
  // An explicit raw-provider-id entry keeps working too.
  assert.equal(
    resolveWalletCutoffCents(GENERIC_PROVIDER_ID, umansConnection(), {
      [GENERIC_PROVIDER_ID]: 42,
    }),
    42
  );
  // The canonical key wins over the raw id when both are configured.
  assert.equal(
    resolveWalletCutoffCents(GENERIC_PROVIDER_ID, umansConnection(), {
      umans: 500,
      [GENERIC_PROVIDER_ID]: 42,
    }),
    500
  );
  // A non-Umans connection must NOT pick up the "umans" default.
  assert.equal(resolveWalletCutoffCents(GENERIC_PROVIDER_ID, {}, { umans: 500 }), null);
});

// ─── evaluateQuotaCutoff matrix ──────────────────────────────────────────────

test("evaluateQuotaCutoff blocks below/at the wallet reserve and proceeds above or unknown", () => {
  const thresholds = (cents: number | null) => ({
    resolveMinRemainingPercent: () => 0,
    resolveWarnRemainingPercent: () => 0,
    resolveWalletCutoffCents: () => cents,
  });
  const quotaWith = (balanceCents: number | null) => ({
    used: 0,
    total: 100,
    percentUsed: 0,
    windows: { wallet: { percentUsed: 0, resetAt: null } },
    balanceCents,
  });

  // below
  assert.equal(evaluateQuotaCutoff(quotaWith(499), thresholds(500)).proceed, false);
  // equal (inclusive — "stop at $5 remaining" means $5 already stops it)
  const equal = evaluateQuotaCutoff(quotaWith(500), thresholds(500));
  assert.equal(equal.proceed, false);
  assert.equal(equal.reason, "quota_exhausted");
  assert.equal(equal.resetAt, null, "a prepaid wallet never resets");
  // above
  assert.equal(evaluateQuotaCutoff(quotaWith(500.02), thresholds(500)).proceed, true);
  // unknown balance fails OPEN
  assert.equal(evaluateQuotaCutoff(quotaWith(null), thresholds(500)).proceed, true);
  // no cutoff configured → never blocks, however low the balance
  assert.equal(evaluateQuotaCutoff(quotaWith(0.5), thresholds(null)).proceed, true);
  // an authoritative exhausted signal blocks with no cutoff configured at all
  assert.equal(
    evaluateQuotaCutoff({ ...quotaWith(0), limitReached: true }, thresholds(null)).proceed,
    false
  );
});

// ─── preflightQuota end-to-end on the REAL provider id ───────────────────────

test("auth preflight blocks a generic Umans connection whose wallet is at the provider-default reserve", async () => {
  registerUmansQuotaFetcher();
  const connectionId = "umans-preflight-below";
  invalidateUmansQuotaCache(connectionId);
  const mock = mockUmansFetch({
    wallet: () => walletResponse({ balance: { balanceCents: 400, funded: true } }),
    usage: () => walletResponse({ billing: { mode: "pay_by_token" } }),
  });
  try {
    const blocked = await preflightQuota(GENERIC_PROVIDER_ID, connectionId, umansConnection(), {
      resolveMinRemainingPercent: () => 0,
      resolveWarnRemainingPercent: () => 0,
      resolveWalletCutoffCents: () =>
        resolveWalletCutoffCents(GENERIC_PROVIDER_ID, umansConnection(), { umans: 500 }),
    });
    assert.equal(blocked.proceed, false);
    assert.equal(blocked.reason, "quota_exhausted");
    assert.ok(mock.calls.wallet > 0, "the wallet summary must actually be fetched");
  } finally {
    mock.restore();
    invalidateUmansQuotaCache(connectionId);
  }
});

test("auth preflight proceeds for a generic Umans connection comfortably above the reserve", async () => {
  registerUmansQuotaFetcher();
  const connectionId = "umans-preflight-above";
  invalidateUmansQuotaCache(connectionId);
  const mock = mockUmansFetch({
    wallet: () => walletResponse({ balance: { balanceCents: 5000, funded: true } }),
    usage: () => walletResponse({ billing: { mode: "pay_by_token" } }),
  });
  try {
    const result = await preflightQuota(GENERIC_PROVIDER_ID, connectionId, umansConnection(), {
      resolveMinRemainingPercent: () => 0,
      resolveWarnRemainingPercent: () => 0,
      resolveWalletCutoffCents: () => 500,
    });
    assert.equal(result.proceed, true);
  } finally {
    mock.restore();
    invalidateUmansQuotaCache(connectionId);
  }
});

// ─── Finding #8: partial 401/403 must not be cached ──────────────────────────

test("a 401 on one signal preserves the other but is retried on the next call", async () => {
  const connectionId = "umans-partial-401";
  invalidateUmansQuotaCache(connectionId);
  const mock = mockUmansFetch({
    wallet: () => new Response("unauthorized", { status: 401 }),
    usage: () =>
      walletResponse({
        plan: { slug: "service_account" },
        limits: { requests: { limit: 10 } },
        usage: { remaining_requests: 9 },
      }),
  });
  try {
    const first = (await fetchUmansQuota(connectionId, umansConnection())) as {
      balanceCents: number | null;
      requests?: { remaining: number | null };
    } | null;
    assert.equal(first?.balanceCents, null, "the rejected signal stays unknown");
    assert.equal(first?.requests?.remaining, 9, "the surviving signal is preserved");
    assert.equal(mock.calls.wallet, 1);

    // Credential recovery must be prompt: the partial snapshot is NOT cached, so
    // the unauthorized endpoint is hit again instead of being pinned for 60s.
    await fetchUmansQuota(connectionId, umansConnection());
    assert.equal(mock.calls.wallet, 2, "the 401 endpoint must be retried, not cached");
  } finally {
    mock.restore();
    invalidateUmansQuotaCache(connectionId);
  }
});

test("a fully successful snapshot IS cached for the TTL", async () => {
  const connectionId = "umans-full-cache";
  invalidateUmansQuotaCache(connectionId);
  const mock = mockUmansFetch({
    wallet: () => walletResponse({ balance: { balanceCents: 1234, funded: true } }),
    usage: () => walletResponse({ billing: { mode: "pay_by_token" } }),
  });
  try {
    const first = await fetchUmansQuota(connectionId, umansConnection());
    const callsAfterFirst = mock.calls.wallet + mock.calls.usage;
    assert.equal(await fetchUmansQuota(connectionId, umansConnection()), first);
    assert.equal(mock.calls.wallet + mock.calls.usage, callsAfterFirst);
  } finally {
    mock.restore();
    invalidateUmansQuotaCache(connectionId);
  }
});

// ─── Finding #10: no global cache entry for an absent connection id ──────────

test("a blank connection id never shares a cache entry across credentials", async () => {
  let balance = 100;
  const mock = mockUmansFetch({
    wallet: () => walletResponse({ balance: { balanceCents: balance, funded: true } }),
    usage: () => walletResponse({ billing: { mode: "pay_by_token" } }),
  });
  try {
    const first = (await fetchUmansQuota("", { apiKey: "key-a" })) as {
      balanceCents: number | null;
    } | null;
    assert.equal(first?.balanceCents, 100);

    balance = 7;
    const second = (await fetchUmansQuota("", { apiKey: "key-b" })) as {
      balanceCents: number | null;
    } | null;
    assert.equal(
      second?.balanceCents,
      7,
      "a second credential must not be served the first one's cached balance"
    );
  } finally {
    mock.restore();
  }
});

test("wallet-only and both-signal failure follow the fail-open contract", async () => {
  const mock = mockUmansFetch({
    wallet: () => walletResponse({ balance: { balanceCents: 12, funded: true } }),
    usage: () => new Response("forbidden", { status: 403 }),
  });
  try {
    const walletOnly = (await fetchUmansQuota("umans-wallet-only", { apiKey: "test-key" })) as {
      balanceCents: number | null;
    } | null;
    assert.equal(walletOnly?.balanceCents, 12);
  } finally {
    mock.restore();
  }

  const down = mockUmansFetch({
    wallet: () => new Response("down", { status: 503 }),
    usage: () => new Response("down", { status: 503 }),
  });
  try {
    assert.equal(await fetchUmansQuota("umans-both-failed", { apiKey: "test-key" }), null);
  } finally {
    down.restore();
  }
});

// ─── Settings normalization for the money map ────────────────────────────────

test("walletCutoffCentsByProvider normalizes fractional cents and drops malformed entries", () => {
  const fallback = {
    enabled: false,
    defaultThresholdPercent: 2,
    warnThresholdPercent: 20,
    providerWindowDefaults: {},
    walletCutoffCentsByProvider: {},
  };
  const normalized = normalizeQuotaPreflightSettings(
    {
      walletCutoffCentsByProvider: {
        umans: 769.004324,
        stringy: "250",
        negative: -1,
        nan: "abc",
        nullish: null,
      },
    },
    fallback
  );
  assert.deepEqual(normalized.walletCutoffCentsByProvider, { umans: 769.004324, stringy: 250 });

  // Omitted → the stored map carries forward; explicit {} → cleared.
  assert.deepEqual(
    normalizeQuotaPreflightSettings({}, { ...fallback, walletCutoffCentsByProvider: { umans: 5 } })
      .walletCutoffCentsByProvider,
    { umans: 5 }
  );
  assert.deepEqual(
    normalizeQuotaPreflightSettings(
      { walletCutoffCentsByProvider: {} },
      { ...fallback, walletCutoffCentsByProvider: { umans: 5 } }
    ).walletCutoffCentsByProvider,
    {}
  );
});

// ─── Finding #6: monetary rendering for a generic connection ─────────────────

test("dashboard parsing renders the wallet as money for a generic Umans connection", async () => {
  const mock = mockUmansFetch({
    wallet: () =>
      walletResponse({
        balance: { balanceCents: 769.004324, funded: true, asOf: "2026-09-09T00:00:00Z" },
        spend: { last24hCents: 10 },
      }),
    usage: () =>
      walletResponse({
        billing: { mode: "pay_by_token" },
        limits: { requests: { limit: 100 }, concurrency: { limit: 4 } },
        usage: { requests_in_window: 25, concurrent_sessions: 1 },
        window: { resets_at: "2026-09-09T05:00:00Z" },
      }),
  });
  let usage: Record<string, unknown>;
  try {
    invalidateUmansQuotaCache("umans-render");
    usage = (await getUmansUsage("umans-render", umansConnection())) as Record<string, unknown>;
  } finally {
    mock.restore();
    invalidateUmansQuotaCache("umans-render");
  }

  assert.equal((usage as { remainingUsd?: number }).remainingUsd, 7.69004324);

  const connection = umansConnection();
  const parsed = parseQuotaData(GENERIC_PROVIDER_ID, usage, connection) as Array<
    Record<string, unknown>
  >;
  const wallet = parsed.find((entry) => entry.name === "wallet");
  assert.ok(wallet, "the wallet row must be present");
  assert.equal(wallet?.isCredits, true, "the wallet must render as money, not a percentage bar");
  assert.equal(wallet?.currency, "USD");

  // Without the connection the id alone cannot identify Umans — this is exactly
  // the regression: generic parsing does not mark the row as money.
  const parsedWithoutConnection = parseQuotaData(GENERIC_PROVIDER_ID, usage) as Array<
    Record<string, unknown>
  >;
  assert.notEqual(
    parsedWithoutConnection.find((entry) => entry.name === "wallet")?.isCredits,
    true
  );
});
