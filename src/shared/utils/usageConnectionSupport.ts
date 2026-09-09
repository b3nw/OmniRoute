/**
 * usageConnectionSupport.ts — "does this connection have quota telemetry?",
 * shared by the server usage route and the two dashboard quota surfaces.
 *
 * `USAGE_SUPPORTED_PROVIDERS` is a static list of provider IDs, which is enough
 * for every provider whose identity IS its routing id. It is NOT enough for a
 * provider reached through the generic OpenAI-compatible custom node: Umans'
 * real provider id is a per-install `openai-compatible-<uuid>` that can never
 * appear in that list, so an id-only gate silently drops every real Umans
 * connection BEFORE the connection-aware `parseQuotaData()` ever runs.
 *
 * Both predicates below therefore consult the base-URL predicate first. This
 * module is a pure leaf (constants + `isUmansConnection`, no I/O, no DB) so the
 * client components can import it as-is — `src/lib/usage/providerLimits.ts`
 * pulls in executors and the DB and can never be imported from a
 * `"use client"` component.
 */
import { USAGE_SUPPORTED_PROVIDERS } from "@/shared/constants/providers";
import { isUmansConnection } from "@omniroute/open-sse/services/umansConnection.ts";

export type UsageSupportConnectionLike = {
  provider?: string;
  authType?: string;
  providerSpecificData?: unknown;
} | null;

/**
 * True when the connection's upstream publishes usage/quota data at all,
 * regardless of how it authenticates. This is the id-list gate PLUS the
 * connection-only signals — call it instead of
 * `USAGE_SUPPORTED_PROVIDERS.includes(provider)`.
 */
export function hasUsageQuotaSupport(connection: UsageSupportConnectionLike): boolean {
  if (!connection || !connection.provider) return false;
  if (isUmansConnection(connection as unknown as Record<string, unknown>)) return true;
  return USAGE_SUPPORTED_PROVIDERS.includes(connection.provider);
}

/**
 * Dashboard filter for the quota surfaces (Provider Limits + the home
 * ProviderQuotaWidget): quota support, plus the oauth/apikey auth gate those
 * pages have always applied. Umans is exempt from the auth gate for the same
 * reason `isSupportedUsageConnection()` exempts it server-side — a custom-node
 * connection carries whatever `authType` the operator's row was created with,
 * and the wallet read only ever needs the connection's API key.
 */
export function isUsageQuotaConnection(connection: UsageSupportConnectionLike): boolean {
  if (!hasUsageQuotaSupport(connection)) return false;
  if (isUmansConnection(connection as unknown as Record<string, unknown>)) return true;
  return connection!.authType === "oauth" || connection!.authType === "apikey";
}
