import {
  type MarkdownOptions,
  MarkdownRenderable,
  type RenderContext,
  type TextOptions,
  TextRenderable,
  TextTableRenderable,
  type TextareaOptions,
  TextareaRenderable,
} from "@opentui/core";
import {
  CURSOR_FALLBACK,
  DEFAULT_FG,
  SELECTION_BG,
  SELECTION_FG,
} from "./theme.js";

const SELECTION = { selectionBg: SELECTION_BG, selectionFg: SELECTION_FG };

/** The only constructors the TUI uses for text. OpenTUI (0.5.10) defaults
 * every one of these to fixed white, which a light terminal swallows, so
 * each factory starts from the terminal's own foreground instead. */
export function text(ctx: RenderContext, options: TextOptions): TextRenderable {
  return new TextRenderable(ctx, { fg: DEFAULT_FG, ...SELECTION, ...options });
}

export function textarea(
  ctx: RenderContext,
  options: TextareaOptions,
): TextareaRenderable {
  return new TextareaRenderable(ctx, {
    textColor: DEFAULT_FG,
    focusedTextColor: DEFAULT_FG,
    cursorColor: CURSOR_FALLBACK,
    ...SELECTION,
    ...options,
  });
}

/** MarkdownRenderable takes no selection colours; the blocks it builds do,
 * so they are set as each block is created. A table (0.5.10) takes them as
 * constructor options only and draws no selection at all without them, so
 * its private fields are set; the table selection test pins this. */
export function markdown(
  ctx: RenderContext,
  options: MarkdownOptions,
): MarkdownRenderable {
  return new MarkdownRenderable(ctx, {
    fg: DEFAULT_FG,
    renderNode: (_token, context) => {
      const block = context.defaultRender();
      if (block instanceof TextTableRenderable) {
        Object.assign(block, {
          _selectionBg: SELECTION_BG,
          _selectionFg: SELECTION_FG,
        });
      } else if (block && "selectionBg" in block) {
        Object.assign(block, SELECTION);
      }
      return block;
    },
    ...options,
  });
}

interface PaletteSource {
  getPalette(options?: {
    timeout?: number;
  }): Promise<{ defaultForeground?: string | null }>;
}

/** Recolours the input cursor to the terminal's foreground once the terminal
 * answers. A terminal that does not answer keeps the fallback. */
export async function adoptTerminalCursor(
  source: PaletteSource,
  input: { cursorColor: unknown; isDestroyed?: boolean },
): Promise<void> {
  try {
    const { defaultForeground } = await source.getPalette({ timeout: 1000 });
    if (defaultForeground && !input.isDestroyed)
      input.cursorColor = defaultForeground;
  } catch {
    // No OSC support: the fallback stays.
  }
}
