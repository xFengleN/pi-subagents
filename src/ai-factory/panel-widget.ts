/**
 * ai-factory/panel-widget.ts — The Factory run panel widget.
 *
 * A passive above-editor widget (the same `setWidget` mechanism pi-subagents
 * uses for its agent tree) that shows only Factory orchestration state: run id,
 * state, the active role/phase/model and the orchestration counters.
 *
 * It deliberately lists no agents and renders no transcripts. pi-subagents'
 * own agent tree is the single agent list, and the live agent transcript lives
 * in the focused viewer opened by `/factory-verbose` (see `live-view.ts`), which
 * reuses pi-subagents' ConversationViewer. Keeping the panel to a fixed few
 * lines avoids duplicating the tree and overflowing the terminal.
 */

import { truncateToWidth } from "@earendil-works/pi-tui";
import { formatPanelSummary, type VisibilityMode, visibilityModeLabel } from "./panel.js";
import type { FactoryRunState } from "./types.js";

interface WidgetTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

export interface FactoryRunPanelDeps {
  getRunState(): FactoryRunState | undefined;
  /** The current session visibility mode, shown so the preference is visible. */
  getMode(): VisibilityMode;
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

  /** Ask the TUI to re-render (used after a visibility change). */
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

    const summary = formatPanelSummary(state);
    const lines = summary.map((line, index) => (index === 0 ? theme.bold(tr(line)) : theme.fg("dim", tr(line))));
    lines.push(theme.fg("dim", tr(`Visibility: ${visibilityModeLabel(this.deps.getMode())} · /factory-verbose <mode> · /agents for full history`)));
    return lines;
  }
}

interface WidgetTui {
  terminal: { columns: number };
  requestRender(): void;
}
