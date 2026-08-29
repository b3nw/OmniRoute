import test from "node:test";
import assert from "node:assert/strict";
import { saveCallLog, getCallLogs } from "../../src/lib/usageDb";
import { getDbInstance } from "../../src/lib/db/core";

test("call_logs records and retrieves ttft_ms", async () => {
  const testId = "test-ttft-" + Date.now();
  await saveCallLog({
    id: testId,
    method: "POST",
    path: "/v1/chat/completions",
    status: 200,
    model: "test-model",
    provider: "test-provider",
    duration: 1500,
    timeToFirstTokenMs: 250,
    tokens: { in: 100, out: 50 },
  });

  const logs = await getCallLogs({ limit: 10 });
  const entry = logs.find((l: any) => l.id === testId);
  assert.ok(entry, "Entry should be found in call_logs");
  assert.equal(entry.timeToFirstTokenMs, 250, "timeToFirstTokenMs should match saved value");
  assert.equal(entry.duration, 1500, "duration should match saved value");
});
