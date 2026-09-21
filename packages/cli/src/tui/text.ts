import {
  type MarkdownOptions,
  MarkdownRenderable,
  type RenderContext,
  type TextOptions,
  TextRenderable,
  type TextareaOptions,
  TextareaRenderable,
} from "@opentui/core";
import { DEFAULT_FG } from "./theme.js";

/** The only constructors the TUI uses for text. OpenTUI (0.5.10) defaults
 * every one of these to fixed white, which a light terminal swallows, so
 * each factory starts from the terminal's own foreground instead. */
export function text(ctx: RenderContext, options: TextOptions): TextRenderable {
  return new TextRenderable(ctx, { fg: DEFAULT_FG, ...options });
}

export function textarea(
  ctx: RenderContext,
  options: TextareaOptions,
): TextareaRenderable {
  return new TextareaRenderable(ctx, {
    textColor: DEFAULT_FG,
    focusedTextColor: DEFAULT_FG,
    cursorColor: DEFAULT_FG,
    ...options,
  });
}

export function markdown(
  ctx: RenderContext,
  options: MarkdownOptions,
): MarkdownRenderable {
  return new MarkdownRenderable(ctx, { fg: DEFAULT_FG, ...options });
}
