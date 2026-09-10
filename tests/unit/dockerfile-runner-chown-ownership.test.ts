/**
 * Validates that runner stages in Dockerfile use `--chown=node:node` on all
 * `COPY --from=builder` instructions rather than a slow post-copy `RUN chown -R` layer.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dockerfile = fs.readFileSync(path.join(repoRoot, "Dockerfile"), "utf-8");
const lines = dockerfile.split("\n");

function getRunnerStageLines(): string[] {
  const start = lines.findIndex((l) => /^FROM\s+\S+\s+AS\s+runner-base\b/i.test(l.trim()));
  assert.ok(start >= 0, "Dockerfile must declare a `runner-base` stage");
  return lines.slice(start);
}

test("runner stages copy builder assets with --chown=node:node", () => {
  const runnerLines = getRunnerStageLines();
  const builderCopyLines = runnerLines.filter(
    (l) => !l.trim().startsWith("#") && /^COPY\s+.*--from=builder/i.test(l.trim())
  );

  assert.ok(builderCopyLines.length > 0, "runner stages must copy assets from builder");

  for (const copyLine of builderCopyLines) {
    assert.ok(
      copyLine.includes("--chown=node:node"),
      `Runner COPY from builder must specify --chown=node:node to avoid post-copy chown -R: ${copyLine}`
    );
  }
});

test("runner stages do not contain expensive recursive RUN chown -R node:node /app", () => {
  const runnerLines = getRunnerStageLines();
  const slowChownLine = runnerLines.find(
    (l) => !l.trim().startsWith("#") && /^RUN\s+chown\s+-R\s+node:node\s+\/app\b/i.test(l.trim())
  );

  assert.equal(
    slowChownLine,
    undefined,
    `Found recursive chown -R in runner stage (use COPY --chown=node:node instead): ${slowChownLine}`
  );
});
