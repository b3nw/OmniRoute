import assert from "node:assert/strict";
import test from "node:test";

import {
  buildUmansQuota,
  fetchUmansQuota,
  isUmansConnection,
  parseUmansUsage,
  parseUmansWalletSummary,
  registerUmansQuotaFetcher,
  UMANS_BASE_URL,
  UMANS_PROVIDER_REGISTRATION_KEY,
} from "../../open-sse/services/umansQuotaFetcher.ts";
import { getQuotaFetcher, getQuotaWindows } from "../../open-sse/services/quotaPreflight.ts";
import {
  isWalletBalanceBelowCutoff,
  resolveWalletCutoffCents,
} from "../../open-sse/services/walletCutoff.ts";

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

test("wallet cutoff resolves connection over provider default and compares cents directly", () => {
  assert.equal(resolveWalletCutoffCents("umans", { walletCutoffCents: 25 }, { umans: 50 }), 25);
  assert.equal(resolveWalletCutoffCents("umans", { walletCutoffCents: null }, { umans: 50 }), 50);
  assert.equal(resolveWalletCutoffCents("umans", {}, {}), null);
  assert.equal(isWalletBalanceBelowCutoff(25, 25), true);
  assert.equal(isWalletBalanceBelowCutoff(25.01, 25), false);
  assert.equal(isWalletBalanceBelowCutoff(null, 25), false);
});

test("Umans registration matches the exact base URL and exposes named windows", () => {
  registerUmansQuotaFetcher();
  const connection = {
    providerSpecificData: { baseUrl: `${UMANS_BASE_URL}/` },
  };
  assert.equal(isUmansConnection(connection), true);
  assert.equal(getQuotaFetcher("openai-compatible-chat-abc", connection), fetchUmansQuota);
  assert.deepEqual(getQuotaWindows("openai-compatible-chat-abc", connection), ["wallet", "requests", "concurrency"]);
  assert.equal(getQuotaFetcher("openai-compatible-chat-abc", { providerSpecificData: { baseUrl: "https://other.example" } }), undefined);
  assert.equal(UMANS_PROVIDER_REGISTRATION_KEY, "__umans-base-url__");
});

test("partial signal failures preserve the successful signal and cache hits avoid duplicate calls", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (input) => {
    calls += 1;
    const url = String(input);
    if (url.includes("wallet")) return new Response("unauthorized", { status: 401 });
    return new Response(JSON.stringify({ plan: { slug: "service_account" }, limits: { requests: { limit: 10 } }, usage: { remaining_requests: 9 } }), { status: 200 });
  };
  try {
    const connection = { apiKey: "test-key", providerSpecificData: { baseUrl: UMANS_BASE_URL } };
    const first = await fetchUmansQuota("partial-signal", connection);
    assert.equal(first?.balanceCents, null);
    assert.equal((first as { requests?: { remaining: number | null } })?.requests?.remaining, 9);
    const callsAfterFirst = calls;
    assert.equal(await fetchUmansQuota("partial-signal", connection), first);
    assert.equal(calls, callsAfterFirst);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("wallet-only and both-signal failure follow fail-open contract", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    if (String(input).includes("wallet")) return new Response(JSON.stringify({ balance: { balanceCents: 12, funded: true } }), { status: 200 });
    return new Response("forbidden", { status: 403 });
  };
  try {
    const walletOnly = await fetchUmansQuota("wallet-only", { apiKey: "test-key" });
    assert.equal(walletOnly?.balanceCents, 12);
    globalThis.fetch = async () => new Response("down", { status: 503 });
    assert.equal(await fetchUmansQuota("both-failed", { apiKey: "test-key" }), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

