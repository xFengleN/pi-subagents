/**
 * ai-factory/finalization.test.ts — the mandatory final Lead synthesis.
 *
 * Every accepted run, including a remediated one, must pass through exactly one
 * bounded FINAL_SYNTHESIS before DONE, and that synthesis must describe the
 * ACTUAL accepted state while preserving the earlier audit packets.
 */

import { afterEach, describe, expect, it } from "vitest";
import { formatFactoryCompletion, formatFactoryReport } from "../../src/ai-factory/commands.js";
import { defaultFactoryConfig, mergeFactoryConfig } from "../../src/ai-factory/config.js";
import { FactoryController } from "../../src/ai-factory/controller.js";
import type { FactoryConfig } from "../../src/ai-factory/types.js";
import { FakeClock, FakeTransport, flush, packets, tempStore } from "./fakes.js";

let runCounter = 0;
const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function make(configOverrides: Partial<FactoryConfig> = {}) {
  const transport = new FakeTransport();
  const clock = new FakeClock();
  const store = tempStore();
  cleanups.push(store.cleanup);
  const config = mergeFactoryConfig(defaultFactoryConfig(), configOverrides as Record<string, unknown>);
  const controller = FactoryController.create(
    { transport, clock, store: store.store, config },
    `fin-${++runCounter}`,
    "Implement the widget",
    store.dir,
  );
  return { transport, clock, store: store.store, config, controller };
}

type M = ReturnType<typeof make>;
const complete = (m: M, packet: unknown): void => m.transport.completeLastPacket(packet);

/** Drive the normal path up to the FINAL_ARCHITECT gate (final.architect spawned). */
async function driveToFinalArchitect(m: M): Promise<void> {
  m.controller.start();
  await flush();
  complete(m, packets.proposal);
  await flush();
  complete(m, packets.approve);
  await flush();
  complete(m, packets.engineer);
  await flush();
  complete(m, packets.reviewerPass);
  await flush();
  complete(m, packets.integration);
  await flush();
}

/** Drive the remediation path up to and including the recheck ACCEPT. */
async function driveRemediatedToSynthesis(m: M): Promise<void> {
  await driveToFinalArchitect(m);
  complete(m, packets.remediate); // final Architect rejects
  await flush();
  complete(m, packets.engineer); // remediation engineer
  await flush();
  complete(m, packets.reviewerPass); // remediation reviewer
  await flush();
  complete(m, packets.accept); // recheck ACCEPT -> FINAL_SYNTHESIS
  await flush();
}

describe("AI Factory — final Lead synthesis", () => {
  it("A. normal acceptance runs the final Lead synthesis exactly once, then DONE", async () => {
    const m = make();
    await driveToFinalArchitect(m);
    complete(m, packets.accept);
    await flush();

    // ACCEPT lands in FINAL_SYNTHESIS, not DONE, and the Lead was spawned once.
    expect(m.controller.getState().state).toBe("FINAL_SYNTHESIS");
    expect(m.transport.spawned.filter((s) => s.phase === "final_synthesis.lead")).toHaveLength(1);

    complete(m, packets.finalReport);
    await flush();

    const state = m.controller.getState();
    expect(state.state).toBe("DONE");
    expect(state.results.finalReport?.packet.result).toBe("ACCEPT");
    // No second synthesis, and the accepted integration packet is intact.
    expect(m.transport.spawned.filter((s) => s.phase === "final_synthesis.lead")).toHaveLength(1);
    expect(state.results.integration?.packet.systemVerification).toBe("npm test green");
  });

  it("B. remediation acceptance runs one final synthesis over the POST-remediation state", async () => {
    const m = make();
    await driveRemediatedToSynthesis(m);

    expect(m.controller.getState().state).toBe("FINAL_SYNTHESIS");
    const synthesis = m.transport.spawned.find((s) => s.phase === "final_synthesis.lead");
    // The synthesis is told what the remediation actually changed.
    expect(synthesis?.prompt).toContain("Remediation cycle");
    expect(synthesis?.prompt).toContain("implemented widgets");

    complete(m, packets.finalReportRemediated);
    await flush();

    const state = m.controller.getState();
    expect(state.state).toBe("DONE");
    expect(state.remediationRounds).toBe(1);
    expect(state.results.finalReport?.packet.result).toBe("ACCEPT (after remediation)");
    expect(m.transport.spawned.filter((s) => s.phase === "final_synthesis.lead")).toHaveLength(1);
  });

  it("C. the rejected integration/finalArchitect packets remain preserved as audit history", async () => {
    const m = make();
    await driveRemediatedToSynthesis(m);
    complete(m, packets.finalReportRemediated);
    await flush();

    const state = m.controller.getState();
    // The pre-remediation Lead integration packet is untouched.
    expect(state.results.integration?.packet.systemVerification).toBe("npm test green");
    expect(state.results.integration?.packet.goal).toBe("Implement the widget");
    // The rejection that triggered remediation is still recorded.
    expect(state.results.finalArchitect?.packet.verdict).toBe("NEEDS_REMEDIATION");
    expect(state.results.finalArchitect?.packet.requiredChanges).toEqual(["rename widgets→gadgets"]);
    // The recheck and the final report are separate, additional artifacts.
    expect(state.results.finalRecheck?.packet.verdict).toBe("ACCEPT");
    expect(state.results.finalReport?.packet.result).toBe("ACCEPT (after remediation)");
  });

  it("D. the final Lead synthesis cannot modify the repo or spawn implementation work", async () => {
    const m = make();
    await driveToFinalArchitect(m);
    complete(m, packets.accept);
    await flush();

    const synthesis = m.transport.spawned.find((s) => s.phase === "final_synthesis.lead")!;
    expect(synthesis.role).toBe("lead");
    expect(synthesis.isolated).toBe(true);
    expect(synthesis.prompt).toContain("MUST NOT modify any repository file");
    expect(synthesis.prompt).toContain("spawn any further agents");
    expect(synthesis.prompt).toContain("Do NOT resume implementation");

    const spawnsBefore = m.transport.spawned.length;
    const engineersBefore = m.controller.getState().results.engineers.length;
    complete(m, packets.finalReport);
    await flush();
    // Re-driving a terminal run is a no-op: no new implementation work.
    m.controller.start();
    await flush();

    expect(m.controller.getState().state).toBe("DONE");
    expect(m.transport.spawned.length).toBe(spawnsBefore);
    expect(m.controller.getState().results.engineers.length).toBe(engineersBefore);
  });

  it("L. automatic completion rendering uses the same persisted finalReport artifact", async () => {
    const m = make();
    await driveToFinalArchitect(m);
    complete(m, packets.accept);
    await flush();
    complete(m, packets.finalReport);
    await flush();

    const state = m.controller.getState();
    const persisted = state.results.finalReport!.packet;
    const auto = formatFactoryCompletion(state);

    expect(auto).toBe(formatFactoryReport(state));
    expect(auto).toContain(persisted.summary);
    expect(auto).toContain(persisted.delivered[0]);
    expect(auto).toContain(persisted.validation[0]);
    expect(auto).toContain(`Full report persisted: .pi/factory/${state.runId}.json`);
  });

  it("a STOPPED completion renders the rejected final outcome without changing it", async () => {
    const m = make();
    await driveToFinalArchitect(m);
    complete(m, packets.remediate);
    await flush();
    complete(m, packets.engineer);
    await flush();
    complete(m, packets.reviewerPass);
    await flush();
    complete(m, packets.remediate); // recheck rejects -> STOPPED
    await flush();

    expect(m.controller.getState().state).toBe("STOPPED");
    const report = formatFactoryCompletion(m.controller.getState());
    expect(report).toContain("Factory final report");
    expect(report).toContain("Terminal state: STOPPED");
    expect(report).toContain("Authoritative final verdict: NEEDS_REMEDIATION");
    expect(report).toContain("remediation allowance reached 1/1");
    expect(m.controller.getState().state).toBe("STOPPED");
  });
});
