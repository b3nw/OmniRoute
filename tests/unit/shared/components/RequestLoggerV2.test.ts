import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatTtft, getLogTtft } from "../../../../src/shared/components/RequestLoggerV2";

describe("RequestLoggerV2 - TTFT helpers", () => {
  describe("getLogTtft", () => {
    it("returns timeToFirstTokenMs if present", () => {
      assert.equal(getLogTtft({ timeToFirstTokenMs: 150 }), 150);
    });

    it("returns 0 if not present or empty object", () => {
      assert.equal(getLogTtft({}), 0);
      assert.equal(getLogTtft(null), 0);
      assert.equal(getLogTtft(undefined), 0);
    });
  });

  describe("formatTtft", () => {
    it("formats ms correctly when < 1000ms", () => {
      assert.equal(formatTtft(150), "150ms");
      assert.equal(formatTtft(999), "999ms");
    });

    it("formats seconds correctly when >= 1000ms", () => {
      assert.equal(formatTtft(1000), "1.00s");
      assert.equal(formatTtft(1500), "1.50s");
      assert.equal(formatTtft(2345), "2.35s");
    });

    it("returns dash for invalid or non-positive values", () => {
      assert.equal(formatTtft(0), "—");
      assert.equal(formatTtft(-50), "—");
      assert.equal(formatTtft(null), "—");
      assert.equal(formatTtft(undefined), "—");
    });
  });
});
