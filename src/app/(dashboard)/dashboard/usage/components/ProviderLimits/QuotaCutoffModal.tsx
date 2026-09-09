"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import Modal from "@/shared/components/Modal";
import Button from "@/shared/components/Button";
import { translateUsageOrFallback, type UsageTranslationValues } from "./i18nFallback";

/**
 * Cents → the dollar string shown in the input. Trailing zeros are trimmed so a
 * whole-dollar reserve reads "5", not "5.0000", while fractional cents (which
 * upstream balances genuinely have) survive a round-trip.
 */
export function centsToDollarString(cents: number): string {
  const dollars = cents / 100;
  return String(Number(dollars.toFixed(6)));
}

/**
 * Parse the operator's dollar input into the CENTS the API expects.
 * Returns `null` for blank ("inherit the provider default") and `"invalid"` for
 * anything that is not a non-negative decimal amount. Deliberately NOT the
 * integer 0-100 percent parser — this is money.
 */
export function dollarsToCents(raw: string): number | null | "invalid" {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === ".") return "invalid";
  const dollars = Number(trimmed);
  if (!Number.isFinite(dollars) || dollars < 0) return "invalid";
  // Round to a thousandth of a cent so float noise cannot smuggle in a value
  // the API's finite/non-negative validation would then reject.
  return Number((dollars * 100).toFixed(3));
}

export interface QuotaCutoffModalWindow {
  /** Stable key — must match the quota name surfaced by the usage fetcher. */
  key: string;
  /** Human-readable label rendered next to the input. */
  displayName: string;
}

interface QuotaCutoffModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Stable identity used to distinguish refreshes from connection changes. */
  connectionId: string;
  /** Label shown in the modal title. */
  connectionName: string;
  /** Used in the modal title for context (e.g. "(codex)"). */
  provider: string;
  /**
   * Windows this connection exposes — discovered from its live quota cache
   * so the modal works for any provider with usage data, not just providers
   * that registered with quotaPreflight at startup.
   */
  windows: QuotaCutoffModalWindow[];
  /** Currently persisted per-window overrides on the connection. */
  current: Record<string, number> | null;
  /** Per-(provider, window) defaults from resilience settings. */
  providerDefaults: Record<string, number>;
  /** Global fallback used when no provider/window default exists. */
  globalDefaultPercent: number;
  /**
   * True when this connection's provider is billed from a prepaid wallet (its
   * quota fetcher registered the `wallet` window). Adds the money field below
   * the percentage windows.
   */
  supportsWallet?: boolean;
  /**
   * Persisted per-connection money cutoff, in CENTS. `null` = inherit the
   * per-provider default.
   */
  walletCutoffCents?: number | null;
  /** Per-provider default money cutoff (cents), or null when none is set. */
  walletProviderDefaultCents?: number | null;
  /**
   * Called when the user clicks Save. Receives the percentage patch in the
   * shape the API expects: each window key is either a number (set override) or
   * null (clear that window's override). `null` for the whole patch means
   * "clear every override" — invoked via the "Reset all" button.
   *
   * `walletCutoffCents` travels alongside it (not inside it): the percent map
   * is 0-100 integers only, so a dollar amount must never share that channel.
   * `undefined` = unchanged, a number = set, `null` = clear the override.
   */
  onSave: (
    patch: Record<string, number | null> | null,
    walletCutoffCents?: number | null
  ) => Promise<void>;
}

export default function QuotaCutoffModal({
  isOpen,
  onClose,
  connectionId,
  connectionName,
  provider,
  windows,
  current,
  providerDefaults,
  globalDefaultPercent,
  supportsWallet = false,
  walletCutoffCents = null,
  walletProviderDefaultCents = null,
  onSave,
}: QuotaCutoffModalProps) {
  const t = useTranslations("usage");
  const tr = (key: string, fallback: string, values?: UsageTranslationValues) =>
    translateUsageOrFallback(t, key, fallback, values);
  // Local draft: string per window so empty-string means "inherit".
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // The wallet draft is entered in DOLLARS (what the operator actually thinks
  // in); the wire field is `walletCutoffCents`. Kept as a string so empty means
  // "inherit the provider default", exactly like the percentage drafts.
  const [walletDraft, setWalletDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wasOpenRef = useRef(false);
  const seededConnectionIdRef = useRef<string | null>(null);

  // Reset drafts whenever the modal opens against a new connection.
  useEffect(() => {
    const shouldSeed =
      isOpen && (!wasOpenRef.current || seededConnectionIdRef.current !== connectionId);
    wasOpenRef.current = isOpen;
    if (!shouldSeed) return;

    seededConnectionIdRef.current = connectionId;
    const initial: Record<string, string> = {};
    for (const w of windows) {
      const persisted = current?.[w.key];
      initial[w.key] = typeof persisted === "number" ? String(persisted) : "";
    }
    setDrafts(initial);
    setWalletDraft(
      typeof walletCutoffCents === "number" ? centsToDollarString(walletCutoffCents) : ""
    );
    setError(null);
  }, [isOpen, connectionId, windows, current, walletCutoffCents]);

  const resolveDefaultFor = (windowKey: string): number =>
    typeof providerDefaults[windowKey] === "number"
      ? providerDefaults[windowKey]
      : globalDefaultPercent;

  const buildPatch = (): Record<string, number | null> | "invalid" => {
    const patch: Record<string, number | null> = {};
    for (const w of windows) {
      const raw = (drafts[w.key] ?? "").trim();
      if (raw === "") {
        // Only emit an explicit null when there was previously an override
        // to clear; otherwise just omit the key.
        if (current?.[w.key] !== undefined) patch[w.key] = null;
        continue;
      }
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0 || n > 100) return "invalid";
      if (current?.[w.key] !== n) patch[w.key] = n;
    }
    return patch;
  };

  // undefined = unchanged; null = clear the override; number = set (cents).
  const buildWalletPatch = (): number | null | undefined | "invalid" => {
    if (!supportsWallet) return undefined;
    const parsed = dollarsToCents(walletDraft);
    if (parsed === "invalid") return "invalid";
    if (parsed === null) {
      // Only emit an explicit clear when there was something to clear.
      return typeof walletCutoffCents === "number" ? null : undefined;
    }
    return parsed === walletCutoffCents ? undefined : parsed;
  };

  const handleSave = async () => {
    const patch = buildPatch();
    if (patch === "invalid") {
      setError(tr("quotaThresholdInvalid", "Enter a whole number from 0 to 100."));
      return;
    }
    const walletPatch = buildWalletPatch();
    if (walletPatch === "invalid") {
      setError(
        tr("quotaWalletCutoffInvalid", "Enter a dollar amount of 0 or more (for example 2.50).")
      );
      return;
    }
    if (Object.keys(patch).length === 0 && walletPatch === undefined) {
      onClose();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(patch, walletPatch);
      onClose();
    } catch (err: any) {
      setError(err?.message || "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const handleResetAll = async () => {
    setSaving(true);
    setError(null);
    try {
      // Reset all clears both channels — the percent map and the money cutoff.
      await onSave(null, supportsWallet ? null : undefined);
      onClose();
    } catch (err: any) {
      setError(err?.message || "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const hasAnyOverride =
    (current !== null && current !== undefined && Object.keys(current).length > 0) ||
    (supportsWallet && typeof walletCutoffCents === "number");

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={tr("quotaCutoffsTitle", `Quota cutoffs for ${connectionName} (${provider})`, {
        name: connectionName,
        provider,
      })}
      size="md"
      footer={
        <>
          {hasAnyOverride && (
            <Button variant="ghost" onClick={handleResetAll} disabled={saving}>
              {tr("quotaCutoffsResetAll", "Reset all")}
            </Button>
          )}
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            {tr("cancel", "Cancel")}
          </Button>
          <Button onClick={handleSave} loading={saving}>
            {tr("save", "Save")}
          </Button>
        </>
      }
    >
      <p className="text-sm text-text-muted mb-4">
        {tr(
          "quotaCutoffsExplainer",
          "Override the minimum remaining quota percentage where this account stops being selected for each quota window. Leave blank to inherit the provider default."
        )}
      </p>
      <div className="space-y-3">
        {windows.length === 0 && (
          <div className="text-sm text-text-muted italic">
            {tr("quotaCutoffsNoWindows", "No quota windows are available for this account yet.")}
          </div>
        )}
        {windows.map((w) => {
          const persisted = current?.[w.key];
          const resolvedDefault = resolveDefaultFor(w.key);
          const placeholder = `${resolvedDefault}`;
          const isOverride =
            typeof persisted === "number" && (drafts[w.key] ?? "") === String(persisted);
          return (
            <div key={w.key} className="flex items-center justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-text-main">{w.displayName}</div>
                <div className="text-[11px] text-text-muted">
                  {tr("quotaCutoffsDefaultHint", `Default min remaining: ${resolvedDefault}%`, {
                    default: resolvedDefault,
                  })}
                </div>
              </div>
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  min={0}
                  max={100}
                  step={1}
                  value={drafts[w.key] ?? ""}
                  placeholder={placeholder}
                  disabled={saving}
                  onChange={(e) => setDrafts((prev) => ({ ...prev, [w.key]: e.target.value }))}
                  className={`w-20 px-2 py-1 text-sm text-center rounded-md border bg-transparent text-text-main focus:outline-none focus:border-primary/60 disabled:opacity-50 ${
                    isOverride ? "border-primary/40" : "border-border"
                  }`}
                />
                <span className="text-xs text-text-muted">%</span>
              </div>
            </div>
          );
        })}
        {supportsWallet && (
          <div className="pt-3 mt-1 border-t border-border">
            <div className="flex items-center justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-text-main">
                  {tr("quotaWalletCutoffLabel", "Wallet reserve (USD)")}
                </div>
                <div className="text-[11px] text-text-muted">
                  {typeof walletProviderDefaultCents === "number"
                    ? tr(
                        "quotaWalletCutoffDefaultHint",
                        `Provider default: $${centsToDollarString(walletProviderDefaultCents)}`,
                        { default: centsToDollarString(walletProviderDefaultCents) }
                      )
                    : tr("quotaWalletCutoffNoDefaultHint", "No provider default — blank disables")}
                </div>
              </div>
              <div className="flex items-center gap-1">
                <span className="text-xs text-text-muted">$</span>
                <input
                  type="text"
                  inputMode="decimal"
                  aria-label={tr("quotaWalletCutoffLabel", "Wallet reserve (USD)")}
                  value={walletDraft}
                  placeholder={
                    typeof walletProviderDefaultCents === "number"
                      ? centsToDollarString(walletProviderDefaultCents)
                      : "0.00"
                  }
                  disabled={saving}
                  onChange={(e) => setWalletDraft(e.target.value)}
                  className={`w-24 px-2 py-1 text-sm text-center rounded-md border bg-transparent text-text-main focus:outline-none focus:border-primary/60 disabled:opacity-50 ${
                    typeof walletCutoffCents === "number" &&
                    walletDraft === centsToDollarString(walletCutoffCents)
                      ? "border-primary/40"
                      : "border-border"
                  }`}
                />
              </div>
            </div>
            <p className="mt-2 text-[11px] text-text-muted">
              {tr(
                "quotaWalletCutoffExplainer",
                "Stop selecting this account once its prepaid wallet drops to this amount or less. A wallet does not reset — only a top-up refills it — so this is an absolute dollar reserve, not a percentage. Leave blank to inherit the provider default."
              )}
            </p>
          </div>
        )}
      </div>
      {error && (
        <div className="mt-3 text-sm text-red-500 flex items-center gap-1.5">
          <span className="material-symbols-outlined text-[16px]">error</span>
          {error}
        </div>
      )}
    </Modal>
  );
}
