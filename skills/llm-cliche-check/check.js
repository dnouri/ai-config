#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

const TOOL_URL = "https://tools.simonwillison.net/llm-cliche-highlighter";
const TIMEOUT_MS = 30_000;

class InputError extends Error {}

function usage() {
  return `Usage: node check.js [FILE|-]

Read prose from FILE, or from standard input when FILE is omitted or is -.
Print a JSON report from Simon Willison's live LLM cliché highlighter.`;
}

function readInput(args) {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(`${usage()}\n`);
    return null;
  }
  if (args.length > 1) {
    throw new InputError(`Expected at most one input file.\n\n${usage()}`);
  }

  const filename = args[0];
  let text;
  try {
    text = filename && filename !== "-"
      ? readFileSync(resolve(filename), "utf8")
      : readFileSync(0, "utf8");
  } catch (error) {
    throw new InputError(`Could not read input: ${error.message}`);
  }

  if (!text.trim()) {
    throw new InputError("Input is empty; provide the exact prose to check.");
  }
  return text;
}

function runPlaywright(args, cwd) {
  const result = spawnSync("playwright-cli", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: TIMEOUT_MS,
  });

  if (result.error) {
    if (result.error.code === "ENOENT") {
      throw new Error(
        "playwright-cli was not found; install it before using this skill.",
      );
    }
    throw new Error(`playwright-cli failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const details = [result.stderr, result.stdout]
      .map((value) => value?.trim())
      .filter(Boolean)
      .join("\n");
    throw new Error(details || `playwright-cli exited with status ${result.status}`);
  }
  return result.stdout.trim();
}

function pageProgram(text) {
  return `async page => {
  const testSummary = page.locator('#test-summary');
  await testSummary.waitFor({ state: 'attached', timeout: 10000 });
  await page.waitForFunction(() => {
    const value = document.querySelector('#test-summary')?.textContent?.trim();
    return value && value !== 'Self-tests: running…';
  }, null, { timeout: 10000 });

  const selfTests = (await testSummary.textContent()).trim();
  if (!/^Self-tests: all \\d+ passed$/.test(selfTests)) {
    throw new Error('The highlighter is not ready: ' + selfTests);
  }

  const boxes = page.locator('#pattern-list input[type="checkbox"]');
  const patternsChecked = await boxes.count();
  const patternsEnabled = await page
    .locator('#pattern-list input[type="checkbox"]:checked')
    .count();
  if (patternsChecked === 0 || patternsEnabled !== patternsChecked) {
    throw new Error(
      'Expected every highlighter pattern to be enabled; found ' +
      patternsEnabled + ' of ' + patternsChecked + '.',
    );
  }

  // The page is fully loaded before the draft is inserted. Blocking later
  // requests keeps the supplied prose inside this ephemeral browser context.
  await page.route('**/*', route => route.abort());
  await page.getByRole('textbox', { name: 'Text to analyze' }).fill(${JSON.stringify(text)});
  await page.waitForFunction(() => {
    const stats = document.querySelector('#stats');
    return stats && !stats.hidden && stats.querySelectorAll('strong').length === 3;
  }, null, { timeout: 10000 });

  const report = await page.evaluate(patternsChecked => {
    const counts = [...document.querySelectorAll('#stats strong')]
      .map(node => Number(node.textContent));
    const flags = [...document.querySelectorAll('#output .flagged')].map(node => {
      const copy = node.cloneNode(true);
      copy.querySelectorAll('.badge').forEach(badge => badge.remove());
      const sentence = copy.textContent.replace(/\\s+/g, ' ').trim();
      const matches = [...node.querySelectorAll('mark.hit')].map(hit => {
        const [pattern, ...notes] = hit.title.split(' · ');
        const match = { text: hit.textContent, pattern };
        if (notes.length) match.note = notes.join(' · ');
        return match;
      });
      return { sentence, matches };
    });

    return {
      patternsChecked,
      summary: {
        matches: counts[0],
        flaggedSentences: counts[1],
        chainItems: counts[2],
      },
      flags,
    };
  }, patternsChecked);

  if (report.summary.flaggedSentences !== report.flags.length) {
    throw new Error('Could not reconcile the highlighter summary with its flags.');
  }
  return report;
}`;
}

function check(text) {
  const workdir = mkdtempSync(join(tmpdir(), "llm-cliche-check-"));
  const session = `llm-cliche-check-${process.pid}-${Date.now()}`;
  const programPath = join(workdir, "check-page.js");

  try {
    writeFileSync(programPath, pageProgram(text), { mode: 0o600 });
    runPlaywright([`-s=${session}`, "open", TOOL_URL], workdir);
    const output = runPlaywright(
      ["--raw", `-s=${session}`, "run-code", `--filename=${programPath}`],
      workdir,
    );
    try {
      return JSON.parse(output);
    } catch {
      throw new Error(`The highlighter returned invalid JSON: ${output}`);
    }
  } finally {
    spawnSync("playwright-cli", [`-s=${session}`, "close"], {
      cwd: workdir,
      encoding: "utf8",
      timeout: 10_000,
    });
    rmSync(workdir, { recursive: true, force: true });
  }
}

try {
  const text = readInput(process.argv.slice(2));
  if (text !== null) {
    process.stdout.write(`${JSON.stringify(check(text), null, 2)}\n`);
  }
} catch (error) {
  const inputError = error instanceof InputError;
  process.stderr.write(`${error.message}\n`);
  process.exitCode = inputError ? 2 : 1;
}
