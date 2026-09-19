/**
 * ai-factory/live-view.test.ts — the Factory's focused live view wrapper.
 *
 * Pi has no safe inline live-transcript surface, so the Factory opens a focused
 * `ctx.ui.custom` overlay that reuses pi-subagents' ConversationViewer. This
 * test drives the wrapper with a fake TUI and fake agent records/sessions: it
 * must show the resolved agent, switch when the run advances, show a placeholder
 * when nothing resolves, and clean up its interval/subscription on dispose.
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FactoryFocusView, type FocusTarget } from "../../src/ai-factory/live-view.js";
import type { AgentRecord } from "../../src/types.js";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

function fakeTui(): TUI {
  return { terminal: { columns: 100, rows: 40 }, requestRender: vi.fn() } as unknown as TUI;
}

function fakeSession(messages: unknown[], onSubscribe?: () => () => void): AgentSession {
  return {
    messages,
    subscribe: () => {
      if (onSubscribe) return onSubscribe();
      return () => {};
    },
  } as unknown as AgentSession;
}

function makeTarget(
  agentId: string,
  assistantText: string,
  session?: AgentSession,
  status: AgentRecord["status"] = "running",
): FocusTarget {
  const record = {
    id: agentId,
    type: "general-purpose",
    description: `agent ${agentId}`,
    status,
    toolUses: 0,
    startedAt: 1_000,
  } as unknown as AgentRecord;
  const resolved = session ?? fakeSession([
    { role: "user", content: `task for ${agentId}` },
    { role: "assistant", content: [{ type: "text", text: assistantText }] },
  ]);
  return { agentId, record, session: resolved };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("AI Factory live view — focused transcript", () => {
  it("renders the resolved agent's visible transcript", () => {
    const view = new FactoryFocusView(fakeTui(), theme, undefined, vi.fn(), {
      resolveTarget: () => makeTarget("a1", "alpha output"),
    });
    const out = view.render(100).join("\n");
    expect(out).toContain("alpha output");
    expect(out).toContain("agent a1");
    view.dispose();
  });

  it("switches to the new agent when the run advances (active follows)", () => {
    let current: FocusTarget | undefined = makeTarget("a1", "alpha output");
    const view = new FactoryFocusView(fakeTui(), theme, undefined, vi.fn(), { resolveTarget: () => current });
    expect(view.render(100).join("\n")).toContain("alpha output");

    current = makeTarget("a2", "beta output");
    vi.advanceTimersByTime(1_000);
    const out = view.render(100).join("\n");
    expect(out).toContain("beta output");
    expect(out).not.toContain("alpha output");
    view.dispose();
  });

  it("shows a waiting placeholder until a target resolves, then its transcript", () => {
    let current: FocusTarget | undefined;
    const view = new FactoryFocusView(fakeTui(), theme, undefined, vi.fn(), { resolveTarget: () => current });

    expect(view.render(100).join("\n")).toContain("Waiting for a Factory agent");

    current = makeTarget("a1", "late output");
    vi.advanceTimersByTime(1_000);
    expect(view.render(100).join("\n")).toContain("late output");
    view.dispose();
  });

  it("lets Esc close the view while it is still waiting", () => {
    const done = vi.fn();
    const view = new FactoryFocusView(fakeTui(), theme, undefined, done, { resolveTarget: () => undefined });
    view.handleInput("\x1b");
    expect(done).toHaveBeenCalledWith(undefined);
    view.dispose();
  });

  it("dispose unsubscribes the session and stops retargeting", () => {
    let subscriptions = 0;
    const session = fakeSession([], () => {
      subscriptions++;
      return () => {
        subscriptions--;
      };
    });
    let current: FocusTarget | undefined = makeTarget("a1", "alpha", session);
    const tui = fakeTui();
    const view = new FactoryFocusView(tui, theme, undefined, vi.fn(), { resolveTarget: () => current });
    expect(subscriptions).toBe(1);

    view.dispose();
    expect(subscriptions).toBe(0);

    // After disposal the interval no longer re-resolves or re-renders.
    const renders = (tui.requestRender as ReturnType<typeof vi.fn>).mock.calls.length;
    current = makeTarget("a2", "beta");
    vi.advanceTimersByTime(5_000);
    expect(subscriptions).toBe(0);
    expect((tui.requestRender as ReturnType<typeof vi.fn>).mock.calls.length).toBe(renders);
  });
});
