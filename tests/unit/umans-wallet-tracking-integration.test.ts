/**
 * Umans wallet tracking — integration coverage on the REAL provider id.
 *
 * Umans is configured as a generic OpenAI-compatible custom node, so a real
 * connection's provider id is `openai-compatible-chat-<uuid>`. Round 1 keyed
 * the wallet fetcher by base URL only at the auth preflight level; every other
 * call site still resolved by provider id WITHOUT the connection, so the
 * feature never activated for a real connection. These tests persist an actual
 * generic connection and drive the paths that were broken end-to-end:
 * `/api/usage/[connectionId]`, the auto-combo candidate builder, the non-auto
 * per-target cutoff, the quota-windows capability API, the connection write
 * path for `walletCutoffCents`, and the resilience settings round-trip.
 *
 * Every upstream call is mocked — no live Umans requests, no credentials read.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-umans-wallet-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.JWT_SECRET = process.env.JWT_SECRET || "umans-wallet-test-secret";

const dbCore = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const readCache = await import("../../src/lib/db/readCache.ts");
const { makeManagementSessionRequest } = await import("../helpers/managementSession.ts");

const { UMANS_BASE_URL, invalidateUmansQuotaCache, registerUmansQuotaFetcher } =
  await import("../../open-sse/services/umansQuotaFetcher.ts");
const { resolveQuotaProviderKey } = await import("../../open-sse/services/umansConnection.ts");
const { isSupportedUsageConnection } = await import("../../src/lib/usage/providerLimits.ts");
const { getUsageForProvider } = await import("../../open-sse/services/usage.ts");
const usageRoute = await import("../../src/app/api/usage/[connectionId]/route.ts");
const quotaWindowsRoute = await import("../../src/app/api/providers/quota-windows/route.ts");
const resilienceRoute = await import("../../src/app/api/resilience/route.ts");
const { buildAutoCandidates } = await import("../../open-sse/services/combo.ts");
const { resolveQuotaExhaustionCutoffForTarget } =
  await import("../../open-sse/services/combo/quotaExhaustionCutoff.ts");
const { resolveResetWindowConfig } = await import("../../open-sse/services/combo/quotaScoring.ts");
const { resolveResilienceSettings } = await import("../../src/lib/resilience/settings.ts");

test.after(() => {
  dbCore.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

registerUmansQuotaFetcher();

const MODEL = "umans-code";

/** Mock both Umans endpoints; wallet balance in cents is the only knob needed. */
function mockUmans(balanceCents: number | null, requestLimit = 100) {
  const originalFetch = globalThis.fetch;
  let walletCalls = 0;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.includes("/wallet/summary")) {
      walletCalls += 1;
      if (balanceCents === null) return new Response("not found", { status: 404 });
      return Response.json({
        balance: { balanceCents, funded: true, asOf: "2026-09-09T00:00:00Z" },
        asOf: "2026-09-09T00:00:00Z",
        spend: { last24hCents: 12.5, last7dCents: 40, last30dCents: 100 },
        breakdown: [{ model: MODEL, requests: 3, spendCents: 9.75 }],
      });
    }
    if (url.includes("/v1/usage")) {
      return Response.json({
        billing: { mode: "pay_by_token" },
        plan: { slug: "service_account" },
        limits: { requests: { limit: requestLimit }, concurrency: { limit: 4 } },
        usage: { requests_in_window: 5, remaining_requests: requestLimit - 5 },
        window: { resets_at: "2026-09-09T05:00:00Z" },
      });
    }
    // Nothing else may reach the network in this suite.
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof globalThis.fetch;
  return {
    get walletCalls() {
      return walletCalls;
    },
    restore: () => (globalThis.fetch = originalFetch),
  };
}

let providerSeq = 0;
/** Persist a real generic OpenAI-compatible connection pointed at Umans. */
async function seedUmansConnection(extra: Record<string, unknown> = {}) {
  providerSeq += 1;
  const provider = `openai-compatible-chat-0000000${providerSeq}-0000-4000-8000-abcdef123456`;
  const connection = (await providersDb.createProviderConnection({
    provider,
    authType: "apikey",
    name: `umans-${providerSeq}`,
    apiKey: "umans-test-key",
    isActive: true,
    providerSpecificData: { baseUrl: UMANS_BASE_URL },
    ...extra,
  })) as { id: string };
  readCache.invalidateDbCache("connections");
  return { provider, connectionId: connection.id };
}

// ─── Blocker #3 + #4: usage support gate and usage dispatch ─────────────────

test("a persisted generic Umans connection is a supported usage connection and yields monetary wallet output", async () => {
  const { provider, connectionId } = await seedUmansConnection();
  const stored = (await providersDb.getProviderConnectionById(connectionId)) as Record<
    string,
    unknown
  >;

  // Before round 2 this returned false (the id is in neither provider list), so
  // /api/usage/[connectionId] answered 400 for every real Umans connection.
  assert.equal(isSupportedUsageConnection(stored as never), true);

  const mock = mockUmans(769.004324);
  try {
    invalidateUmansQuotaCache(connectionId);
    const usage = (await getUsageForProvider({
      id: connectionId,
      provider,
      apiKey: "umans-test-key",
      providerSpecificData: { baseUrl: UMANS_BASE_URL },
    })) as Record<string, unknown>;

    assert.equal(
      (usage as { message?: string }).message,
      undefined,
      "the dispatcher must not fall through to 'Usage API not implemented'"
    );
    assert.equal(usage.plan, "Umans (pay-per-token wallet)");
    assert.equal(usage.remainingUsd, 7.69004324);
    const quotas = usage.quotas as Record<string, Record<string, unknown>>;
    assert.equal(quotas.wallet?.currency, "USD");
    assert.equal(quotas.wallet?.remaining, 7.69004324);
    assert.equal(quotas.wallet?.resetAt, null, "a prepaid wallet never resets");
    assert.equal(quotas.requests?.total, 100);
    assert.equal(quotas.concurrency?.unlimited, true);
  } finally {
    mock.restore();
    invalidateUmansQuotaCache(connectionId);
  }
});

test("GET /api/usage/[connectionId] returns the wallet balance as money for a generic Umans connection", async () => {
  const { connectionId } = await seedUmansConnection();
  const mock = mockUmans(2500);
  try {
    invalidateUmansQuotaCache(connectionId);
    const response = await usageRoute.GET(
      new Request(`http://localhost/api/usage/${connectionId}`),
      {
        params: Promise.resolve({ connectionId }),
      }
    );
    assert.equal(response.status, 200, "must not be the 400 'Usage not available' gate");
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.remainingUsd, 25);
    assert.equal(body.balanceCents, 2500);
    const quotas = body.quotas as Record<string, Record<string, unknown>>;
    assert.equal(quotas.wallet?.currency, "USD");
    assert.equal(quotas.wallet?.remaining, 25);
  } finally {
    mock.restore();
    invalidateUmansQuotaCache(connectionId);
  }
});

// ─── Blocker #1: auto-combo candidate builder ───────────────────────────────

async function enableQuotaCutoffWithWalletDefault(cents: number) {
  await settingsDb.updateSettings({
    resilienceSettings: {
      quotaPreflight: {
        enabled: true,
        defaultThresholdPercent: 2,
        warnThresholdPercent: 20,
        providerWindowDefaults: {},
        walletCutoffCentsByProvider: { umans: cents },
      },
    },
  });
  readCache.invalidateDbCache("settings");
  return resolveResilienceSettings(await settingsDb.getSettings());
}

function autoTarget(provider: string, connectionId: string) {
  return {
    kind: "model",
    stepId: `${provider}-${connectionId}`,
    executionKey: `${provider}/${MODEL}@${connectionId}`,
    modelStr: `${provider}/${MODEL}`,
    provider,
    providerId: provider,
    connectionId,
  };
}

test("auto combo blocks a generic Umans target whose wallet is at the configured reserve", async () => {
  const { provider, connectionId } = await seedUmansConnection();
  const resilience = await enableQuotaCutoffWithWalletDefault(500);

  const mock = mockUmans(400);
  try {
    invalidateUmansQuotaCache(connectionId);
    const candidates = (await buildAutoCandidates(
      [autoTarget(provider, connectionId)] as never,
      `umans-auto-blocked-${connectionId}`,
      null,
      resolveResetWindowConfig(null),
      resilience
    )) as Array<Record<string, unknown>>;

    assert.equal(candidates.length, 1);
    assert.ok(
      mock.walletCalls > 0,
      "the wallet fetcher must actually run — a connection-less registry lookup found nothing before round 2"
    );
    assert.equal(
      candidates[0]?.quotaCutoffBlocked,
      true,
      "a $4.00 wallet under a $5.00 reserve must be blocked"
    );
    assert.equal(candidates[0]?.quotaCutoffReason, "quota_exhausted");
  } finally {
    mock.restore();
    invalidateUmansQuotaCache(connectionId);
  }
});

test("auto combo keeps a generic Umans target whose wallet is above the reserve", async () => {
  const { provider, connectionId } = await seedUmansConnection();
  const resilience = await enableQuotaCutoffWithWalletDefault(500);

  const mock = mockUmans(9000);
  try {
    invalidateUmansQuotaCache(connectionId);
    const candidates = (await buildAutoCandidates(
      [autoTarget(provider, connectionId)] as never,
      `umans-auto-ok-${connectionId}`,
      null,
      resolveResetWindowConfig(null),
      resilience
    )) as Array<Record<string, unknown>>;

    assert.equal(candidates.length, 1);
    assert.notEqual(candidates[0]?.quotaCutoffBlocked, true);
  } finally {
    mock.restore();
    invalidateUmansQuotaCache(connectionId);
  }
});

// ─── Blocker #2: non-auto per-target cutoff ─────────────────────────────────

test("the non-auto per-target cutoff blocks a generic Umans connection below the reserve", async () => {
  const { provider, connectionId } = await seedUmansConnection();
  const resilience = await enableQuotaCutoffWithWalletDefault(500);

  const mock = mockUmans(120);
  try {
    invalidateUmansQuotaCache(connectionId);
    const decision = await resolveQuotaExhaustionCutoffForTarget(
      provider,
      connectionId,
      resilience,
      resolveResetWindowConfig(null),
      `umans-priority-${connectionId}`,
      {}
    );
    assert.deepEqual(decision, { blocked: true, reason: "quota_exhausted" });
  } finally {
    mock.restore();
    invalidateUmansQuotaCache(connectionId);
  }
});

test("the non-auto per-target cutoff is a no-op when no wallet reserve is configured", async () => {
  const { provider, connectionId } = await seedUmansConnection();
  await settingsDb.updateSettings({
    resilienceSettings: {
      quotaPreflight: {
        enabled: true,
        defaultThresholdPercent: 2,
        warnThresholdPercent: 20,
        providerWindowDefaults: {},
        walletCutoffCentsByProvider: {},
      },
    },
  });
  readCache.invalidateDbCache("settings");
  const resilience = resolveResilienceSettings(await settingsDb.getSettings());

  const mock = mockUmans(1);
  try {
    invalidateUmansQuotaCache(connectionId);
    const decision = await resolveQuotaExhaustionCutoffForTarget(
      provider,
      connectionId,
      resilience,
      resolveResetWindowConfig(null),
      `umans-priority-nocutoff-${connectionId}`,
      {}
    );
    assert.equal(
      decision.blocked,
      false,
      "a 1-cent wallet must still route when the operator configured no reserve"
    );
  } finally {
    mock.restore();
    invalidateUmansQuotaCache(connectionId);
  }
});

// ─── Major #5: capability resolution for the cutoff modal ───────────────────

test("quota-windows exposes the wallet capability under a key a generic connection can resolve", async () => {
  const { provider, connectionId } = await seedUmansConnection();
  const stored = (await providersDb.getProviderConnectionById(connectionId)) as Record<
    string,
    unknown
  >;

  const response = await quotaWindowsRoute.GET(
    await makeManagementSessionRequest("http://localhost/api/providers/quota-windows")
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    windows: Record<string, string[]>;
    defaults: { walletCutoffCentsByProvider: Record<string, number> };
  };

  // The raw provider id is (correctly) absent — the client must resolve the key.
  assert.equal(body.windows[provider], undefined);
  const key = resolveQuotaProviderKey(provider, stored);
  assert.equal(key, "umans");
  assert.ok(
    (body.windows[key] || []).includes("wallet"),
    "supportsWallet must be true for a real generic Umans connection"
  );
  assert.deepEqual(body.windows[key], ["wallet", "requests", "concurrency"]);
});

// ─── walletCutoffCents write semantics: set / omitted-preserve / null-clear ──

test("walletCutoffCents persists, survives an unrelated update, and clears on explicit null", async () => {
  const { connectionId } = await seedUmansConnection();

  const created = (await providersDb.getProviderConnectionById(connectionId)) as Record<
    string,
    unknown
  >;
  assert.equal(created.walletCutoffCents, null, "no override by default");

  // set (fractional cents are money, not a percentage — must not be truncated)
  await providersDb.updateProviderConnection(connectionId, { walletCutoffCents: 250.5 });
  let stored = (await providersDb.getProviderConnectionById(connectionId)) as Record<
    string,
    unknown
  >;
  assert.equal(stored.walletCutoffCents, 250.5);
  assert.equal(
    (stored.providerSpecificData as Record<string, unknown>).walletCutoffCents,
    250.5,
    "persisted inside the providerSpecificData blob (no dedicated column)"
  );
  assert.equal(
    (stored.providerSpecificData as Record<string, unknown>).baseUrl,
    UMANS_BASE_URL,
    "the sibling blob keys must survive the fold-in"
  );

  // omitted → preserved
  await providersDb.updateProviderConnection(connectionId, { name: "renamed" });
  stored = (await providersDb.getProviderConnectionById(connectionId)) as Record<string, unknown>;
  assert.equal(stored.walletCutoffCents, 250.5, "an unrelated edit must not clear the reserve");

  // explicit null → cleared (falls back to the per-provider default)
  await providersDb.updateProviderConnection(connectionId, { walletCutoffCents: null });
  stored = (await providersDb.getProviderConnectionById(connectionId)) as Record<string, unknown>;
  assert.equal(stored.walletCutoffCents, null);
  assert.equal(
    (stored.providerSpecificData as Record<string, unknown>).walletCutoffCents,
    undefined
  );
  assert.equal((stored.providerSpecificData as Record<string, unknown>).baseUrl, UMANS_BASE_URL);
});

test("an invalid walletCutoffCents write is rejected instead of silently disabling the reserve", async () => {
  const { connectionId } = await seedUmansConnection();
  await assert.rejects(
    () => providersDb.updateProviderConnection(connectionId, { walletCutoffCents: -5 }),
    /walletCutoffCents/
  );
});

// ─── Settings GET/PATCH round-trip for walletCutoffCentsByProvider ──────────

test("PATCH /api/resilience round-trips walletCutoffCentsByProvider through GET", async () => {
  const patch = await resilienceRoute.PATCH(
    await makeManagementSessionRequest("http://localhost/api/resilience", {
      method: "PATCH",
      body: {
        quotaPreflight: {
          enabled: true,
          walletCutoffCentsByProvider: { umans: 769.004324 },
        },
      },
    })
  );
  assert.equal(patch.status, 200);
  const patched = (await patch.json()) as {
    quotaPreflight: { walletCutoffCentsByProvider: Record<string, number> };
  };
  assert.deepEqual(patched.quotaPreflight.walletCutoffCentsByProvider, { umans: 769.004324 });

  readCache.invalidateDbCache("settings");
  const get = await resilienceRoute.GET();
  assert.equal(get.status, 200);
  const body = (await get.json()) as {
    quotaPreflight: { walletCutoffCentsByProvider: Record<string, number> };
  };
  assert.deepEqual(
    body.quotaPreflight.walletCutoffCentsByProvider,
    { umans: 769.004324 },
    "fractional cents must survive the round-trip un-truncated"
  );

  // An unrelated quotaPreflight edit must not wipe the money map.
  const second = await resilienceRoute.PATCH(
    await makeManagementSessionRequest("http://localhost/api/resilience", {
      method: "PATCH",
      body: { quotaPreflight: { warnThresholdPercent: 30 } },
    })
  );
  const secondBody = (await second.json()) as {
    quotaPreflight: {
      warnThresholdPercent: number;
      walletCutoffCentsByProvider: Record<string, number>;
    };
  };
  assert.equal(secondBody.quotaPreflight.warnThresholdPercent, 30);
  assert.deepEqual(secondBody.quotaPreflight.walletCutoffCentsByProvider, { umans: 769.004324 });
});
