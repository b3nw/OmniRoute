// @vitest-environment jsdom
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => "en",
}));
vi.mock("../../../src/shared/components/ProviderIcon", () => ({
  default: () => <span>provider-icon</span>,
}));
vi.mock("../../../src/shared/components/Card", () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import ProviderQuotaWidget from "../../../src/app/(dashboard)/home/ProviderQuotaWidget";
import QuotaCardExpanded from "../../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/parts/QuotaCardExpanded";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const wallet = {
  name: "wallet",
  isCredits: true,
  creditCount: 7.69,
  currency: "USD",
  asOf: "2026-09-09T00:00:00Z",
  spendCents: { last24h: 100, last7d: 200, last30d: 300 },
  breakdown: [{ model: "umans-model", spendCents: 42 }],
};

function render(element: React.ReactElement) {
  act(() => root.render(element));
  return container.textContent ?? "";
}

describe("Umans wallet quota rendering", () => {
  it("renders wallet telemetry and safely renders when telemetry is absent", () => {
    const props = {
      quotas: [wallet],
      loading: false,
      error: null,
      hasStaleData: false,
      onRefresh: vi.fn(),
      onOpenCutoff: vi.fn(),
      onOpenCost: vi.fn(),
      canEditCutoff: false,
      hasCutoffOverrides: false,
    };
    expect(render(<QuotaCardExpanded {...props} />)).toContain("walletAsOf");
    expect(container.textContent).toContain("walletSpend");
    expect(container.textContent).toContain("walletBreakdown");
    expect(() =>
      render(
        <QuotaCardExpanded
          {...props}
          quotas={[{ ...wallet, asOf: undefined, spendCents: undefined, breakdown: undefined }]}
        />
      )
    ).not.toThrow();
  });

  it("keeps an Umans connection in ProviderQuotaWidget while excluding another compatible node", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        Promise.resolve({
          ok: true,
          json: async () =>
            url.includes("/client")
              ? {
                  connections: [
                    {
                      id: "umans",
                      provider: "openai-compatible-umans",
                      authType: "apikey",
                      providerSpecificData: { baseUrl: "https://api.code.umans.ai" },
                    },
                    {
                      id: "other",
                      provider: "openai-compatible-other",
                      authType: "apikey",
                      providerSpecificData: { baseUrl: "https://other.example" },
                    },
                  ],
                }
              : { caches: { umans: { quotas: { wallet } } } },
        })
      )
    );
    render(<ProviderQuotaWidget />);
    await act(async () => {});
    expect(container.textContent).toContain("openai-compatible-umans");
    expect(container.textContent).not.toContain("openai-compatible-other");
  });
});
