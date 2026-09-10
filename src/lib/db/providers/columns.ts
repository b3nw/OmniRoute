/**
 * db/providers/columns.ts — Pure column-normalizer helpers for provider_connections rows.
 * No DB access; no imports — JSON/Object/builtins only.
 */

export type JsonRecord = Record<string, unknown>;

export function withNullableMaxConcurrent(
  record: JsonRecord,
  source: JsonRecord | null | undefined
): JsonRecord {
  if (!source || !Object.hasOwn(source, "maxConcurrent")) {
    return record;
  }

  const sourceMaxConcurrent = source.maxConcurrent;
  const normalizedMaxConcurrent =
    typeof sourceMaxConcurrent === "number" || sourceMaxConcurrent === null
      ? sourceMaxConcurrent
      : record.maxConcurrent;

  return {
    ...record,
    maxConcurrent: normalizedMaxConcurrent,
  };
}

// Always surface `quotaWindowThresholds` (possibly null) on the returned
// object — `cleanNulls` strips null values, but the UI needs to see null so
// it can distinguish "no overrides on this connection" from "field was
// never read." Mirrors `withNullableMaxConcurrent`'s contract so create and
// update return the same shape regardless of whether the source had the key
// stripped or carried forward.
export function withNullableQuotaWindowThresholds(
  record: JsonRecord,
  source: JsonRecord | null | undefined
): JsonRecord {
  return {
    ...record,
    quotaWindowThresholds: (source?.quotaWindowThresholds ?? null) as Record<string, number> | null,
  };
}

// Always surface `rateLimitOverrides` (possibly null) — matches the pattern
// used by withNullableMaxConcurrent and withNullableQuotaWindowThresholds.
export function withNullableRateLimitOverrides(
  record: JsonRecord,
  source: JsonRecord | null | undefined
): JsonRecord {
  return {
    ...record,
    rateLimitOverrides: (source?.rateLimitOverrides ?? null) as Record<string, number> | null,
  };
}

/**
 * Read the per-connection wallet money cutoff (absolute remaining-cash reserve,
 * in cents). It has no dedicated column: it persists inside the existing
 * `provider_specific_data` JSON blob, next to the sibling per-connection
 * quota-preflight knobs (`quotaPreflightEnabled`, `quotaMonitorEnabled`). This
 * accepts either shape so a caller that already lifted it to the top level (the
 * API/read path, credential objects) and a raw row both resolve.
 */
export function readWalletCutoffCents(source: JsonRecord | null | undefined): number | null {
  if (!source) return null;
  const direct = source.walletCutoffCents;
  if (typeof direct === "number" && Number.isFinite(direct) && direct >= 0) return direct;
  const psd = source.providerSpecificData;
  if (psd && typeof psd === "object" && !Array.isArray(psd)) {
    const nested = (psd as JsonRecord).walletCutoffCents;
    if (typeof nested === "number" && Number.isFinite(nested) && nested >= 0) return nested;
  }
  return null;
}

// Always surface `walletCutoffCents` (possibly null) on the returned object,
// mirroring withNullableQuotaWindowThresholds: the UI needs to tell "no wallet
// cutoff on this connection" apart from "field was never read."
export function withNullableWalletCutoffCents(
  record: JsonRecord,
  source: JsonRecord | null | undefined
): JsonRecord {
  return {
    ...record,
    walletCutoffCents: readWalletCutoffCents(source),
  };
}

/**
 * Sanitize an incoming wallet cutoff. `null`/`undefined` clears it; a finite
 * non-negative number (fractional allowed — cents are fractional upstream) is
 * kept as-is; anything else is REJECTED so the write path can fail loudly
 * instead of silently disabling the operator's money cutoff.
 */
export function sanitizeWalletCutoffCents(value: unknown): {
  sanitized: number | null;
  rejected: boolean;
} {
  if (value === null || value === undefined) return { sanitized: null, rejected: false };
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return { sanitized: value, rejected: false };
  }
  return { sanitized: null, rejected: true };
}

/**
 * Fold the top-level wallet cutoff into the providerSpecificData blob that
 * actually persists it, and normalize the top-level mirror. A `null` deletes
 * the key so the connection falls back to the per-provider default.
 */
export function applyWalletCutoffCents(connection: JsonRecord): void {
  const result = sanitizeWalletCutoffCents(connection.walletCutoffCents);
  if (result.rejected) {
    throw new Error(
      `Refusing to persist walletCutoffCents with an invalid value: ${JSON.stringify(
        connection.walletCutoffCents
      )}`
    );
  }
  const psd =
    connection.providerSpecificData &&
    typeof connection.providerSpecificData === "object" &&
    !Array.isArray(connection.providerSpecificData)
      ? { ...(connection.providerSpecificData as JsonRecord) }
      : {};
  if (result.sanitized === null) {
    delete psd.walletCutoffCents;
  } else {
    psd.walletCutoffCents = result.sanitized;
  }
  connection.providerSpecificData = Object.keys(psd).length > 0 ? psd : undefined;
  connection.walletCutoffCents = result.sanitized;
}

export function normalizeBooleanColumn(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "1" || normalized === "true") return true;
    if (normalized === "0" || normalized === "false") return false;
  }
  return fallback;
}

// Result of sanitizing a per-connection overrides/threshold map. `sanitized`
// is the cleaned value (or null when it collapses to nothing); `rejected`
// lists every key that was refused so callers can fail loudly
// instead of silently dropping the operator's input.
export type SanitizeResult = {
  sanitized: Record<string, number> | null;
  rejected: string[];
};

// Sanitize the per-connection rate limit overrides map: keep only known
// fields with valid non-negative integer values. Called once at each
// write-path boundary. Unknown keys and invalid values go into `rejected`
// rather than being dropped in silence.
export function sanitizeRateLimitOverrides(value: unknown): SanitizeResult {
  if (value === null || value === undefined) return { sanitized: null, rejected: [] };
  if (typeof value !== "object" || Array.isArray(value)) return { sanitized: null, rejected: [] };
  const allowedKeys = new Set([
    "rpm",
    "rpd",
    "tpm",
    "tpd",
    "minTime",
    "maxConcurrent",
    "maxWaitMs",
  ]);
  const rejected: string[] = [];
  const map: Record<string, number> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (!allowedKeys.has(key)) {
      rejected.push(key);
      continue;
    }
    if (typeof v === "number" && Number.isInteger(v) && v >= 0) {
      map[key] = v;
    } else {
      rejected.push(key);
    }
  }
  return { sanitized: Object.keys(map).length === 0 ? null : map, rejected };
}

// Serialize an already-sanitized map for SQLite TEXT storage.
export function serializeJsonField(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) return null;
  return JSON.stringify(value);
}

export function toRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" ? (value as JsonRecord) : {};
}

// Sanitize the per-window threshold map: keep only 0-100 integer values with
// keys no longer than 64 chars. Called once at each write-path boundary
// (createProviderConnection + updateProviderConnection) so both the in-memory
// return and the persisted row share the same shape. Serialization below
// trusts this output. Invalid keys/values go into `rejected` rather than being
// dropped in silence.
export function sanitizeQuotaWindowThresholds(value: unknown): SanitizeResult {
  if (value === null || value === undefined) return { sanitized: null, rejected: [] };
  if (typeof value !== "object" || Array.isArray(value)) return { sanitized: null, rejected: [] };
  const rejected: string[] = [];
  const map: Record<string, number> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (key.length > 64) {
      rejected.push(key);
      continue;
    }
    if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 100) {
      map[key] = v;
    } else {
      rejected.push(key);
    }
  }
  return { sanitized: Object.keys(map).length === 0 ? null : map, rejected };
}

export function toStringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function toNumberOrZero(value: unknown): number {
  return typeof value === "number" ? value : 0;
}
