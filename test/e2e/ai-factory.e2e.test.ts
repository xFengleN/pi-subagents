/**
 * ai-factory.e2e.test.ts — the AI Factory pipeline driven end to end, for real.
 *
 * Boots a headless pi session with BOTH extensions of this package (pi-subagents
 * + the AI Factory), scripts the parent to start a run and block on its status,
 * and scripts each role child to answer through its StructuredOutput packet
 * schema. No network and no keys: the faux backend answers every model call.
 *
 * This is the section-29 happy-path smoke: Lead → initial Architect → Engineer
 * → Reviewer → Lead integration → final Architect → final Lead synthesis →
 * DONE, with every link (bus RPC spawn, fresh child contexts, structured
 * packets, deterministic transitions, consume-on-settle) exercised for real.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { FACTORY_DIR } from "../../src/ai-factory/store.js";
import { type PrintModeRun, runPrintMode, toolCallsNamed, toolResultsNamed } from "../helpers/print-mode-runner.js";

const TASK = "Implement a small widgets package with tests.";

/** The exact packets each role child must emit (schemas in src/ai-factory/packets.ts). */
const PACKETS = {
  proposal: {
    goal: TASK,
    repositoryFindings: "src/ exists, package.json present",
    currentArchitecture: "single module",
    assumptions: ["repo is green"],
    proposedSolution: "add a widgets/ package",
    constraints: ["no new deps"],
    workPackages: ["wp-1"],
    dependencies: "none",
    risks: [],
    acceptanceCriteria: ["tests pass"],
    architecturalQuestions: [],
  },
  approve: { verdict: "APPROVE", approvedArchitecture: "widgets package", constraints: [], correctedWorkPackages: [], importantRisks: [] },
  engineer: {
    status: "completed",
    workPackageId: "wp-1",
    summary: "implemented widgets",
    changedFiles: ["src/widgets.ts"],
    importantDecisions: [],
    testsRun: ["npm test"],
    testResults: "pass",
    deviations: [],
    knownLimitations: [],
    unresolvedQuestions: [],
    architecturalEscalationRequired: false,
  },
  pass: { verdict: "PASS", blockingFindings: [], nonBlockingFindings: [], requiredRepairs: [], testConcerns: [], architecturalIssue: false },
  integration: {
    goal: TASK,
    approvedArchitecture: "widgets package",
    completedWorkPackages: ["wp-1"],
    importantDecisions: [],
    deviations: [],
    systemVerification: "npm test green",
    reviewerFindingsResolved: [],
    reviewerFindingsAcceptedRisk: [],
    reviewerFindingsUnresolved: [],
    selectedFiles: ["src/widgets.ts"],
    factualAssessment: "complete",
  },
  accept: { verdict: "ACCEPT", blockingIssues: [], requiredChanges: [], doNotChange: [], requiredEvidence: [] },
  finalReport: {
    result: "ACCEPT",
    summary: "Implemented and validated the widgets package.",
    delivered: ["widgets package with tests"],
    architecture: ["single module"],
    reviewerFindings: [],
    validation: ["npm test: pass"],
    commits: [],
    endingHead: "unknown",
    pushed: "unknown",
    humanVerification: ["run the widgets package by hand"],
    warnings: [],
  },
} as const;

/** A project directory with a Factory config pointing at the faux model. */
function factoryProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "subagents-af-e2e-"));
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(
    join(dir, ".pi", "factory.json"),
    JSON.stringify({
      roles: {
        lead: { targets: { primary: "faux/faux-1" } },
        architect: { targets: { primary: "faux/faux-1" } },
        engineer: { targets: { primary: "faux/faux-1" } },
        reviewer: { targets: { primary: "faux/faux-1" } },
      },
      maxRepairRounds: 1,
      maxArchitectRemediationRounds: 1,
    }, null, 2),
  );
  return dir;
}

/** Everything the faux backend was ever asked, flattened for substring checks. */
const asText = (context: { messages?: unknown[] }) => JSON.stringify(context.messages ?? []);

const dirs: string[] = [];
let run: PrintModeRun | undefined;
afterEach(async () => {
  await run?.dispose?.();
  run = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("AI Factory end to end (faux model, no network)", () => {
  it(
    "runs Lead → initial Architect → Engineer → Reviewer → integration → final Architect → final synthesis → DONE",
    async () => {
      const cwd = factoryProject();
      dirs.push(cwd);

      // At most one status poll, so a misparse can never spin the parent loop.
      let statusCalls = 0;
      run = await runPrintMode({
        prompt: "Use the Factory tool to run this task, then wait for it to finish.",
        cwd,
        maxModelCalls: 48,
        live: false, // scripted on purpose
        extensionPaths: [
          new URL("../../src/index.ts", import.meta.url).pathname,
          new URL("../../src/ai-factory/index.ts", import.meta.url).pathname,
        ],
        respond: (context) => {
          const tools = context.tools ?? [];
          const text = asText(context);

          // Role children answer through their StructuredOutput packet schema.
          if (tools.some((t) => t.name === "StructuredOutput")) {
            if (text.includes("Recorded.")) return fauxText("done");
            if (text.includes("bounded repository reconnaissance")) return fauxToolCall("StructuredOutput", PACKETS.proposal, { id: "so-proposal" });
            if (text.includes("A Technical Lead has produced")) return fauxToolCall("StructuredOutput", PACKETS.approve, { id: "so-arch" });
            if (text.includes("Implement ONE coherent work package")) return fauxToolCall("StructuredOutput", PACKETS.engineer, { id: "so-eng" });
            if (text.includes("independent implementation-correctness role")) return fauxToolCall("StructuredOutput", PACKETS.pass, { id: "so-rev" });
            if (text.includes("The implementation work is complete")) return fauxToolCall("StructuredOutput", PACKETS.integration, { id: "so-int" });
            if (text.includes("final architecture/acceptance checkpoint")) return fauxToolCall("StructuredOutput", PACKETS.accept, { id: "so-final" });
            if (text.includes("bounded synthesis of accepted evidence")) return fauxToolCall("StructuredOutput", PACKETS.finalReport, { id: "so-report" });
            return fauxText("unexpected child");
          }

          // Parent: start the run, then block exactly once on its status, then
          // report. `text` is JSON.stringify(…), so a naive `\S+` run id would
          // swallow the escaped "\nstate:" suffix and never resolve.
          if (statusCalls >= 1) return fauxText("Factory run finished.");
          if (text.includes("Factory run started")) {
            statusCalls++;
            const runId = text.match(/(factory_[A-Za-z0-9_]+)/)?.[1];
            return fauxToolCall("factory_status", { run_id: runId, wait: true }, { id: "fs-1" });
          }
          return fauxToolCall("Factory", { task: TASK }, { id: "factory-1" });
        },
        timeoutMs: 90_000,
      });

      // The parent reached for both Factory tools.
      expect(toolCallsNamed(run.parentSession, "Factory")).toHaveLength(1);
      expect(toolCallsNamed(run.parentSession, "factory_status")).toHaveLength(1);

      // The blocked status tool returned the completed run summary.
      const statusText = toolResultsNamed(run.parentSession, "factory_status").join("\n");
      expect(statusText).toContain('"state": "DONE"');
      expect(statusText).toContain('"runId"');

      // The run's persisted state reached DONE, with all seven role runs
      // recorded (six implementation roles + the final Lead synthesis).
      const runId = statusText.match(/"runId": "(\S+)"/)?.[1];
      expect(runId).toBeTruthy();
      const stateFile = join(cwd, FACTORY_DIR, `${runId}.json`);
      expect(existsSync(stateFile)).toBe(true);
      const persisted = JSON.parse(readFileSync(stateFile, "utf8")) as {
        state: string;
        results: { finalReport?: { packet?: { result?: string } } };
        metrics: { roles: Record<string, { attempts?: number }>; totals?: unknown; calls?: unknown[] };
      };
      expect(persisted.state).toBe("DONE");
      expect(persisted.results.finalReport?.packet?.result).toBe("ACCEPT");
      expect(persisted.metrics.roles.lead.attempts).toBe(3); // proposal + integration + final synthesis
      expect(persisted.metrics.roles.architect.attempts).toBe(2); // initial + final
      expect(persisted.metrics.roles.engineer.attempts).toBe(1);
      expect(persisted.metrics.roles.reviewer.attempts).toBe(1);
      // Per-call telemetry exists for the metrics command.
      expect(persisted.metrics.calls).toHaveLength(7);
    },
    120_000,
  );
});
