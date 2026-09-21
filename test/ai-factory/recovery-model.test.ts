import { afterEach, describe, expect, it } from "vitest";
import { defaultFactoryConfig } from "../../src/ai-factory/config.js";
import { FactoryController } from "../../src/ai-factory/controller.js";
import { createFactoryCheckpoint, planFactoryRecovery, validatePersistedFactoryRunState } from "../../src/ai-factory/recovery-model.js";
import { FactoryStore } from "../../src/ai-factory/store.js";
import type { FactoryRunState } from "../../src/ai-factory/types.js";
import { FakeClock, FakeTransport, flush, packets, tempStore } from "./fakes.js";

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function makeRun(runId: string) {
  const transport = new FakeTransport();
  const clock = new FakeClock();
  const temp = tempStore();
  cleanups.push(temp.cleanup);
  const controller = FactoryController.create({ transport, clock, store: temp.store, config: defaultFactoryConfig() }, runId, "task", temp.dir);
  return { controller, transport, store: temp.store, dir: temp.dir };
}

describe("persisted recovery model", () => {
  it("rejects malformed and traversal run ids before path construction", () => {
    const temp = tempStore();
    cleanups.push(temp.cleanup);
    const store = new FactoryStore(temp.dir);
    expect(() => store.pathFor("../outside")).toThrow();
    expect(() => store.pathFor("factory/x")).toThrow();
    expect(() => store.pathFor(".")).toThrow();
  });

  it("rejects corrupt state and validates the canonical project directory", () => {
    const run = makeRun("factory_validation");
    const state = run.controller.getSnapshot();
    const corrupt = structuredClone(state);
    corrupt.config.roles.engineer.maxTransientRetries = -1;
    expect(validatePersistedFactoryRunState(corrupt).ok).toBe(false);
    expect(validatePersistedFactoryRunState(state, "/tmp").ok).toBe(false);
  });

  it("binds checkpoints to run, exact phase, progress, invocation, and revision", () => {
    const one = makeRun("factory_one").controller.getSnapshot();
    const two = makeRun("factory_two").controller.getSnapshot();
    const laterRound = { ...one, state: "EXECUTION", repairRound: 1 } as FactoryRunState;
    const first = createFactoryCheckpoint({ ...one, state: "EXECUTION" }, 7);
    const second = createFactoryCheckpoint(laterRound, 7);
    const otherRun = createFactoryCheckpoint({ ...two, state: "EXECUTION" }, 7);
    expect(first.id).not.toBe(second.id);
    expect(first.id).not.toBe(otherRun.id);
    expect(first.phase).toBe("execution.engineer");
    expect(first.runId).toBe("factory_one");
  });

  it("keeps a spawned Engineer risky after persistence and reload", async () => {
    const run = makeRun("factory_risk");
    run.controller.start();
    await flush();
    run.transport.completeLastPacket(packets.proposal);
    await flush();
    run.transport.completeLastPacket(packets.approve);
    await flush();
    const persisted = run.store.load(run.controller.getRunId())!;
    expect(persisted.attempts?.at(-1)?.provenance).toBe("spawned");
    expect(planFactoryRecovery(persisted).decision).toBe("approval_required");
    expect(planFactoryRecovery(structuredClone(persisted)).decision).toBe("approval_required");
  });

  it("does not automatically replay an ambiguous legacy Engineer state", () => {
    const run = makeRun("factory_legacy");
    const legacy = run.controller.getSnapshot();
    legacy.version = 1;
    legacy.state = "EXECUTION";
    delete legacy.stateRevision;
    delete legacy.checkpoint;
    delete legacy.attempts;
    const plan = planFactoryRecovery(legacy);
    expect(plan.legacy).toBe(true);
    expect(plan.decision).toBe("approval_required");
    expect(plan.reason).toContain("ambiguous");
  });

  it("is pure: planning does not alter the snapshot or invoke infrastructure", () => {
    const run = makeRun("factory_pure");
    const state = run.controller.getSnapshot();
    const before = JSON.stringify(state);
    planFactoryRecovery(state);
    expect(JSON.stringify(state)).toBe(before);
  });
});
