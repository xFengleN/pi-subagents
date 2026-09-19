/**
 * ai-factory/live-view.ts — The Factory's dedicated live agent view.
 *
 * Pi has no safe way to render a live streaming transcript inline in the main
 * conversation. Custom session entries do not enter LLM context, but they are
 * append-only and their renderers are not re-invoked live; custom *messages*
 * would enter the parent model's context. The supported live surfaces are
 * `ctx.ui.setWidget` (a small, non-scrollable, non-interactive widget) and
 * `ctx.ui.custom` (a focused, scrollable overlay that receives the TUI).
 *
 * Detail therefore lives in this focused overlay, which reuses pi-subagents'
 * own ConversationViewer — the same live, scrollable surface `/agents → Enter`
 * opens — instead of a second agent tree in the tiny widget. This wrapper adds
 * the one Factory-specific behaviour: it re-resolves and switches the displayed
 * agent as the run advances, so `active`/`on` follow the running agent across
 * phases, and a role/phase target appears when that agent spawns.
 *
 * It is deliberately read-only: the Factory controller owns stop/steer, so no
 * stop or steer affordances are wired. It makes no model calls and never
 * touches the parent session's context.
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import type { AgentRecord } from "../types.js";
import type { Theme } from "../ui/agent-widget.js";
import { ConversationViewer } from "../ui/conversation-viewer.js";
import type { ViewerKeybindings } from "../ui/viewer-keys.js";

/** The agent the view is currently showing, resolved fresh from the run state. */
export interface FocusTarget {
  agentId: string;
  record: AgentRecord;
  session: AgentSession;
}

export interface FactoryFocusDeps {
  /** Resolve the agent to show now, or `undefined` when none exists yet. */
  resolveTarget(): FocusTarget | undefined;
}

/** How often the view re-checks which agent the run is on. */
const RETARGET_MS = 700;

export class FactoryFocusView implements Component {
  private inner: ConversationViewer | undefined;
  private innerAgentId: string | undefined;
  private interval: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keybindings: ViewerKeybindings | undefined,
    private readonly done: (result: undefined) => void,
    private readonly deps: FactoryFocusDeps,
  ) {
    this.retarget();
    this.interval = setInterval(() => this.retarget(), RETARGET_MS);
  }

  /** Switch the inner viewer when the resolved target agent changes. */
  private retarget(): void {
    const target = this.deps.resolveTarget();
    if (!target) {
      if (this.inner === undefined) return;
      this.inner.dispose();
      this.inner = undefined;
      this.innerAgentId = undefined;
      this.tui.requestRender();
      return;
    }
    if (target.agentId === this.innerAgentId) return;
    this.inner?.dispose();
    this.innerAgentId = target.agentId;
    this.inner = new ConversationViewer(
      this.tui,
      target.session,
      target.record,
      undefined, // activity: the Factory has no pi-subagents activity tracker
      this.theme,
      this.done,
      undefined, // onStop: the controller owns stopping
      this.keybindings,
      undefined, // onSteer: the controller owns steering
      false,
    );
    this.tui.requestRender();
  }

  render(width: number): string[] {
    if (this.inner) return this.inner.render(width);
    return [
      this.theme.fg("dim", truncateToWidth("Waiting for a Factory agent to inspect…", width)),
      this.theme.fg("dim", truncateToWidth("The view follows the run automatically. Esc closes it.", width)),
    ];
  }

  handleInput(data: string): void {
    if (this.inner) {
      this.inner.handleInput(data);
      return;
    }
    // No agent yet: still let the user close the view.
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "q")) {
      this.done(undefined);
    }
  }

  invalidate(): void {
    this.inner?.invalidate();
  }

  dispose(): void {
    if (this.interval !== undefined) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
    this.inner?.dispose();
    this.inner = undefined;
  }
}
