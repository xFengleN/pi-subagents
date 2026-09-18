/**
 * ai-factory/wiring.test.ts — the Factory pi-extension boots and wires its
 * tools, discovers pi-subagents, and registers a `factory_status` query
 * surface. Driven with the shared mock `pi`/`ctx` harness.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultFactoryConfig } from "../../src/ai-factory/config.js";
import { FactoryController } from "../../src/ai-factory/controller.js";
import factoryExtension from "../../src/ai-factory/index.js";
import { FACTORY_DIR, FactoryStore } from "../../src/ai-factory/store.js";
import { ctx, hermeticDir, makePi } from "../helpers/boot-extension.js";
import { FakeClock, FakeTransport, flush } from "./fakes.js";

const hermetic: ReturnType<typeof hermeticDir>[] = [];
afterEach(() => {
  for (const h of hermetic.splice(0)) h.restore();
  vi.restoreAllMocks();
});

function boot() {
  const { pi, tools, lifecycle } = makePi();
  factoryExtension(pi);
  return { pi, tools, lifecycle };
}

/** A bus that actually dispatches handlers, unlike the recording mock. */
function makeDispatchingBus() {
  const handlers = new Map<string, (data: any) => void>();
  const emitted: string[] = [];
  const bus = {
    on: (channel: string, handler: (data: any) => void) => {
      handlers.set(channel, handler);
      return () => handlers.delete(channel);
    },
    emit: (channel: string, data: any) => {
      emitted.push(channel);
      handlers.get(channel)?.(data);
    },
  };
  return { bus, handlers, emitted };
}

describe("AI Factory extension wiring", () => {
  it("registers the Factory tools and subscribes to subagents:ready at factory time", () => {
    const h = hermeticDir({});
    hermetic.push(h);
    const { tools, pi } = boot();

    expect(tools.has("Factory")).toBe(true);
    expect(tools.has("factory_status")).toBe(true);
    // Discovery subscription is wired before any session so subagents:ready is
    // never missed regardless of extension registration order.
    const readyOn = pi.events.on.mock.calls.filter((c: any[]) => c[0] === "subagents:ready");
    expect(readyOn.length).toBeGreaterThan(0);
  });

  it("binds a store and probes pi-subagents on session_start", async () => {
    const h = hermeticDir({});
    hermetic.push(h);
    const { lifecycle } = boot();
    const c = ctx({ cwd: h.dir });

    await lifecycle.get("session_start")({}, c);
    // No run starts until a user calls the Factory tool, but the session is bound.
    expect(lifecycle.has("session_shutdown")).toBe(true);
    expect(lifecycle.has("session_before_switch")).toBe(true);
  });

  it("rejects a run start before pi-subagents is available", async () => {
    const h = hermeticDir({});
    hermetic.push(h);
    const { lifecycle, tools } = boot();
    await lifecycle.get("session_start")({}, ctx({ cwd: h.dir }));

    const tool = tools.get("Factory");
    const result = await tool.execute("call-1", { task: "do a thing" }, undefined, undefined, ctx({ cwd: h.dir }));
    // With no pi-subagents on the bus, the run cannot start.
    expect(result.content[0].text).toContain("pi-subagents is not available");
  });

  it("factory_status lazily restores and resumes a persisted non-terminal run", async () => {
    const h = hermeticDir({});
    hermetic.push(h);

    // A non-terminal run left on disk by a previous session, with no live
    // controller (the session switch / restart case).
    const id = "factory_restore_me";
    FactoryController.create(
      { transport: new FakeTransport(), clock: new FakeClock(), store: new FactoryStore(h.dir), config: defaultFactoryConfig() },
      id,
      "resume this run",
      h.dir,
    ).dispose();
    expect(existsSync(join(h.dir, FACTORY_DIR, `${id}.json`))).toBe(true);

    const { pi, tools, lifecycle } = makePi();
    const { bus, handlers, emitted } = makeDispatchingBus();
    pi.events = bus as typeof pi.events;
    handlers.set("subagents:rpc:ping", (d: any) => {
      bus.emit(`subagents:rpc:ping:reply:${d.requestId}`, { success: true, data: { version: 2 } });
    });
    const spawns: any[] = [];
    handlers.set("subagents:rpc:spawn", (d: any) => {
      spawns.push(d);
      bus.emit(`subagents:rpc:spawn:reply:${d.requestId}`, { success: true, data: { id: "child-restored" } });
    });

    factoryExtension(pi);
    await lifecycle.get("session_start")({}, ctx({ cwd: h.dir }));
    bus.emit("subagents:ready", {});

    // Querying the orphaned run restores it and drives it — not merely reads.
    const status = tools.get("factory_status");
    const result = await status.execute("c1", { run_id: id }, undefined, undefined, ctx({ cwd: h.dir }));
    await flush();

    expect(result.content[0].text).toContain(id);
    expect(emitted).toContain("subagents:rpc:spawn");
    expect(spawns).toHaveLength(1);
    const persisted = JSON.parse(
      readFileSync(join(h.dir, FACTORY_DIR, `${id}.json`), "utf8"),
    ) as { inFlight?: { agentId: string } };
    expect(persisted.inFlight?.agentId).toBe("child-restored");
  });
});
