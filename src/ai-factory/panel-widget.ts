/**
 * ai-factory/panel-widget.ts — The Factory run panel widget.
 *
 * A passive above-editor widget (same `setWidget` mechanism pi-subagents uses
 * for its agent tree) that shows the active run's state and its role agents.
 * Each agent row is collapsed by default; expansion state lives in
 * `FactoryPanelState` and is toggled by `/factory-agent` (widgets are passive —
 * the host routes no keyboard input to them, so interaction is via the command,
 * the same convention pi-subagents itself uses).
 *
 * The widget reads live data each render (run state + the child's retained
 * session via the manager registry), so expanded rows stream in real time while
 * an agent runs. It never surfaces chain-of-thought: only the visible stream
 * from `extractVisibleStream`.
 */

import { truncateToWidth } from "@earendil-works/pi-tui";
import { buildExpandedLines, collectAgents, extractVisibleStream, type FactoryPanelState, formatAgentRow, formatPanelHeader, type PanelAgentView, type StreamMessageLike } from "./panel.js";
import { globalManagerRegistry } from "./transport.js";
import type { FactoryRunState } from "./types.js";

interface WidgetTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

export interface FactoryRunPanelDeps {
  panel: FactoryPanelState;
  getRunState(): FactoryRunState | undefined;
}

/** Live-update cadence while the widget is on screen. */
const REFRESH_MS = 600;

export class FactoryRunPanel {
  private tui: { terminal: { columns: number }; requestRender(): void } | undefined;
  private interval: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly deps: FactoryRunPanelDeps) {}

  /** The `setWidget` content factory. Starts the live-refresh interval once the
   * host actually renders the widget (so tests never run the timer). */
  readonly content = (tui: WidgetTui, theme: WidgetTheme): { render(): string[]; invalidate(): void; dispose(): void } => {
    this.tui = tui;
    this.ensureInterval();
    return {
      render: () => this.render(theme),
      invalidate: () => {},
      dispose: () => this.stop(),
    };
  };

  /** Ask the TUI to re-render (used after an expansion toggle). */
  refresh(): void {
    this.tui?.requestRender();
  }

  /** Stop live updates; the widget component remains registered. */
  stop(): void {
    if (this.interval !== undefined) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
  }

  dispose(): void {
    this.stop();
    this.tui = undefined;
  }

  private ensureInterval(): void {
    if (this.interval !== undefined) return;
    this.interval = setInterval(() => this.tui?.requestRender(), REFRESH_MS);
  }

  private render(theme: WidgetTheme): string[] {
    const state = this.deps.getRunState();
    if (!state) return [];
    const width = this.tui?.terminal?.columns ?? 120;
    const tr = (line: string) => truncateToWidth(line, width);
    const dim = (line: string) => theme.fg("dim", line);

    const lines = formatPanelHeader(state).map(tr);
    lines.push(tr("Agents"));
    const agents = collectAgents(state);
    if (agents.length === 0) {
      lines.push(dim(tr("  (no agents spawned yet)")));
      return lines;
    }

    for (const agent of agents) {
      const expanded = this.deps.panel.isExpanded(agent.id);
      const status = this.statusFor(agent, state);
      lines.push(dim(tr(formatAgentRow(agent, expanded, status))));
      if (expanded) {
        const messages = (this.sessionMessages(agent.id) ?? []) as StreamMessageLike[];
        const body = buildExpandedLines(extractVisibleStream(messages));
        for (const line of body) lines.push(dim(tr(`  ${line}`)));
      }
    }
    return lines;
  }

  /** The agent's retained session messages, when the record is still in memory. */
  private sessionMessages(agentId: string): unknown[] | undefined {
    const record = globalManagerRegistry()?.getRecord(agentId) as
      | { session?: { messages?: unknown[] } }
      | undefined;
    return record?.session?.messages;
  }

  private statusFor(agent: PanelAgentView, state: FactoryRunState): string {
    if (state.inFlight?.agentId === agent.id) return "running";
    const record = globalManagerRegistry()?.getRecord(agent.id) as { status?: string } | undefined;
    if (record?.status) return record.status;
    return "completed";
  }
}

interface WidgetTui {
  terminal: { columns: number };
  requestRender(): void;
}
