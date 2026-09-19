/**
 * ai-factory/render.ts — Small rendering helpers that reuse pi's normal message
 * renderers: pi-tui's `Markdown` (rich assistant-style output) and `Text`
 * (plain command-result output). Both are used as `registerMessageRenderer`
 * bodies so the Factory's transcript entries render like normal Pi messages.
 */

import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, type MarkdownOptions, type MarkdownTheme, Text } from "@earendil-works/pi-tui";

/** The minimal themed surface an extension widget/theme exposes. */
export interface WidgetTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

const MARKDOWN_OPTIONS: MarkdownOptions = {
  preserveOrderedListMarkers: true,
  preserveBackslashEscapes: true,
};

/**
 * Pi's own Markdown theme when available, else a theme built from the widget
 * theme. Probed rather than try/caught: `getMarkdownTheme()` returns arrows that
 * read pi's global theme lazily, so an uninitialized theme throws inside
 * `render()` long after this returns.
 */
export function resolveMarkdownTheme(theme: WidgetTheme): MarkdownTheme {
  try {
    const piTheme = getMarkdownTheme();
    piTheme.heading("probe");
    return piTheme;
  } catch {
    const sgr = (on: number, off: number) => (text: string) => `\x1b[${on}m${text}\x1b[${off}m`;
    return {
      heading: (text) => theme.bold(theme.fg("accent", text)),
      link: (text) => theme.fg("accent", text),
      linkUrl: (text) => theme.fg("muted", text),
      code: (text) => theme.fg("muted", text),
      codeBlock: (text) => theme.fg("muted", text),
      codeBlockBorder: (text) => theme.fg("dim", text),
      quote: (text) => theme.fg("muted", text),
      quoteBorder: (text) => theme.fg("dim", text),
      hr: (text) => theme.fg("dim", text),
      listBullet: (text) => theme.fg("accent", text),
      bold: (text) => theme.bold(text),
      italic: sgr(3, 23),
      underline: sgr(4, 24),
      strikethrough: sgr(9, 29),
    };
  }
}

/** A Markdown-rendered message component (rich, assistant-style). */
export function markdownMessage(content: string, theme: WidgetTheme): Markdown {
  return new Markdown(content, 0, 0, resolveMarkdownTheme(theme), undefined, MARKDOWN_OPTIONS);
}

/** A plain-text message component (command-result style). */
export function textMessage(content: string): Text {
  return new Text(content, 0, 0);
}
