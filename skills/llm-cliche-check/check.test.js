import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const checkScript = new URL("./check.js", import.meta.url);

function runCheck(input) {
  return spawnSync(process.execPath, [checkScript.pathname], {
    encoding: "utf8",
    input,
    timeout: 60_000,
  });
}

test("reports matches from Simon Willison's live highlighter", { timeout: 60_000 }, () => {
  const result = runCheck(
    "No fluff, no filler, no jargon. The release fixes a parsing bug.",
  );

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.summary, {
    matches: 1,
    flaggedSentences: 1,
    chainItems: 3,
  });
  assert.equal(report.flags.length, 1);
  assert.equal(report.flags[0].sentence, "No fluff, no filler, no jargon.");
  assert.match(report.flags[0].matches[0].pattern, /No X, no Y/);
});

test("rejects empty input", () => {
  const result = runCheck(" \n");

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Input is empty/);
});
