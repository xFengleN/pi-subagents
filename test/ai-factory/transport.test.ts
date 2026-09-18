/**
 * ai-factory/transport.test.ts — spec test 16: the Factory spawns role children
 * over the direct cross-extension RPC, never via the model-mediated Agent tool,
 * and never inherits the parent conversation.
 */

import { describe, expect, it } from "vitest";
import { packetSchema } from "../../src/ai-factory/packets.js";
import { BusFactoryTransport, classifyError, type EventBus, type ManagerRegistry } from "../../src/ai-factory/transport.js";

/** An in-process bus that records every emit and dispatches to handlers. */
function makeBus() {
  const handlers = new Map<string, (data: any) => void>();
  const emitted: Array<{ channel: string; data: any }> = [];
  const bus: EventBus = {
    on: (channel, handler) => {
      handlers.set(channel, handler);
      return () => handlers.delete(channel);
    },
    emit: (channel, data) => {
      emitted.push({ channel, data });
      handlers.get(channel)?.(data);
    },
  };
  return { bus, handlers, emitted };
}

function makeRegistry(records: Record<string, any> = {}): ManagerRegistry {
  return { getRecord: (id) => records[id] };
}

/** A stand-in for pi-subagents' RPC side that answers spawn/consume. */
function fakeSubagentsSide(bus: EventBus, handlers: Map<string, (d: any) => void>) {
  const spawns: Array<{ type: string; prompt: string; options: any }> = [];
  const consumes: string[] = [];
  handlers.set("subagents:rpc:spawn", (data: any) => {
    spawns.push({ type: data.type, prompt: data.prompt, options: data.options });
    bus.emit(`subagents:rpc:spawn:reply:${data.requestId}`, { success: true, data: { id: "child-1" } });
  });
  handlers.set("subagents:rpc:consume", (data: any) => {
    consumes.push(data.agentId);
    bus.emit(`subagents:rpc:consume:reply:${data.requestId}`, { success: true });
  });
  return { spawns, consumes };
}

describe("AI Factory transport — direct RPC spawning", () => {
  it("16. spawns directly over subagents:rpc:spawn with no parent-context inheritance", async () => {
    const { bus, handlers, emitted } = makeBus();
    const { spawns } = fakeSubagentsSide(bus, handlers);
    const transport = new BusFactoryTransport({ events: bus, getRegistry: () => makeRegistry() });
    transport.markReady();

    const outcome = await transport.spawn({
      role: "engineer",
      phase: "execution.engineer",
      agentType: "general-purpose",
      prompt: "implement",
      description: "factory run — engineer",
      model: "faux/engineer",
      maxTurns: 100,
      isolated: true,
      schema: packetSchema("engineer"),
    });

    expect(outcome).toEqual({ ok: true, agentId: "child-1" });
    // The ONLY channels this transport ever emits are the documented RPC
    // channels — never the Agent tool, never a model-mediated dispatch.
    for (const e of emitted) expect(e.channel).toMatch(/^subagents:rpc:/);

    const [spawn] = spawns;
    expect(spawn.type).toBe("general-purpose");
    expect(spawn.options.model).toBe("faux/engineer");
    expect(spawn.options.isolated).toBe(true);
    expect(spawn.options.description).toContain("factory run");
    // Fresh context by default: no inheritContext option is ever sent.
    expect(spawn.options.inheritContext).toBeUndefined();
    expect(spawn.options).not.toHaveProperty("inheritContext");
    // The packet schema is carried so the child reports via StructuredOutput.
    expect(spawn.options.structuredOutput).toBeDefined();
  });

  it("consume goes over the documented consume channel", async () => {
    const { bus, handlers } = makeBus();
    const { consumes } = fakeSubagentsSide(bus, handlers);
    const transport = new BusFactoryTransport({ events: bus, getRegistry: () => makeRegistry() });
    transport.markReady();

    transport.consume("child-1");
    await new Promise((r) => setImmediate(r));
    expect(consumes).toEqual(["child-1"]);
  });

  it("enriches lifecycle events with the settled record's packet and model", () => {
    const { bus } = makeBus();
    const registry = makeRegistry({
      "child-1": {
        id: "child-1",
        status: "completed",
        structuredJson: '{"verdict":"PASS"}',
        invocation: { modelName: "faux/reviewer", modelId: "reviewer-x" },
        compactionCount: 1,
      },
    });
    const transport = new BusFactoryTransport({ events: bus, getRegistry: () => registry });
    let got: any;
    transport.onCompleted((info) => { got = info; });
    transport.markReady();

    bus.emit("subagents:completed", {
      id: "child-1",
      type: "general-purpose",
      status: "completed",
      result: "ok",
      toolUses: 7,
      tokens: { input: 10, output: 20, total: 31 },
    });

    expect(got.agentId).toBe("child-1");
    expect(got.ok).toBe(true);
    expect(got.structuredJson).toBe('{"verdict":"PASS"}');
    expect(got.modelName).toBe("faux/reviewer");
    expect(got.compactionCount).toBe(1);
    expect(got.tokens.total).toBe(31);
  });

  it("classifies failures provider-neutrally", () => {
    expect(classifyError("upstream request timed out")).toBe("transient");
    expect(classifyError("502 Bad Gateway")).toBe("transient");
    expect(classifyError("quota exhausted")).toBe("quota");
    expect(classifyError("capacity blocked")).toBe("quota");
    expect(classifyError("Model not found: nope")).toBe("hard");
    // Connectivity/transport failures are transient availability problems.
    expect(classifyError("Connection error.")).toBe("transient");
    expect(classifyError("ECONNREFUSED")).toBe("transient");
    expect(classifyError("connect ECONNREFUSED 127.0.0.1:8080")).toBe("transient");
    expect(classifyError("network unreachable")).toBe("transient");
    expect(classifyError("connection refused")).toBe("transient");
    expect(classifyError("temporary provider transport failure")).toBe("transient");
    // Configuration/auth failures stay hard — hopping models cannot fix them.
    expect(classifyError("401 Unauthorized: invalid API key")).toBe("hard");
    expect(classifyError("invalid provider configuration")).toBe("hard");
  });
});
