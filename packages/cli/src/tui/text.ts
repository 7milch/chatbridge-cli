import {
  BoxRenderable,
  CodeRenderable,
  type MarkdownOptions,
  MarkdownRenderable,
  type RenderContext,
  type TextOptions,
  TextRenderable,
  TextTableRenderable,
  type TextareaOptions,
  TextareaRenderable,
  parseEdge,
} from "@opentui/core";
import {
  CURSOR_FALLBACK,
  DEFAULT_FG,
  MUTED_COLOR,
  SELECTION_BG,
  SELECTION_FG,
} from "./theme.js";

const BOTTOM = parseEdge("bottom");

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

/** Code blocks a body has built, shared between its `renderNode` hook and
 * its `streaming` setter. The hook runs inside the constructor, before any
 * field of the body exists, so this lives outside the instance. */
interface CodeBlocks {
  /** Bare code blocks built while streaming, framed in place on settle. */
  readonly streamed: Set<CodeRenderable>;
  /** Whether any code block has been framed. */
  framed: boolean;
}

/** Wraps a fenced code block in a muted left border. The gap to the next
 * block moves onto the frame, or the border would run on into the blank
 * line below the code. The block must not have a parent. */
function frameCodeBlock(
  ctx: RenderContext,
  block: CodeRenderable,
): BoxRenderable {
  const frame = new BoxRenderable(ctx, {
    id: `${block.id}-frame`,
    width: "100%",
    border: ["left"],
    borderColor: MUTED_COLOR,
    paddingLeft: 1,
    flexShrink: 0,
  });
  // Renderable (0.5.10) has no marginBottom getter, so the Yoga node is read.
  const gap = block.getLayoutNode().getMargin(BOTTOM).value;
  if (gap > 0) {
    frame.marginBottom = gap;
    block.marginBottom = 0;
  }
  frame.add(block);
  return frame;
}

/** MarkdownRenderable takes no selection colours; the blocks it builds do,
 * so they are set as each block is created. A table (0.5.10) takes them as
 * constructor options only and draws no selection at all without them, so
 * its private fields are set; the table selection test pins this.
 *
 * A fenced code block gets a muted left border so it stands apart from a
 * paragraph even when its language has no bundled grammar. OpenTUI does not
 * frame code itself, and a block `renderNode` replaces loses in-place
 * updates: it would be rebuilt on every streamed chunk and draw nothing
 * until its highlight resolves. So while streaming the hook only records
 * the bare block, and the body frames it in place when it settles; a body
 * built settled is framed here at once. */
function renderBlock(
  ctx: RenderContext,
  settled: () => boolean,
  code: CodeBlocks,
): NonNullable<MarkdownOptions["renderNode"]> {
  return (token, context) => {
    const block = context.defaultRender();
    if (block instanceof TextTableRenderable) {
      Object.assign(block, {
        _selectionBg: SELECTION_BG,
        _selectionFg: SELECTION_FG,
      });
    } else if (block && "selectionBg" in block) {
      Object.assign(block, SELECTION);
    }
    // A paragraph is a CodeRenderable too, so the token type picks code.
    if (token.type === "code" && block instanceof CodeRenderable) {
      if (!settled()) {
        code.streamed.add(block);
        return block;
      }
      code.framed = true;
      return frameCodeBlock(ctx, block);
    }
    return block;
  };
}

/** Leaving streaming mode (0.5.10) reuses every block whose source did not
 * change without asking `renderNode`, so a code block built while streaming
 * would never get its frame. Rebuilding every block at settle (a fresh
 * `renderNode`) would blank the prose until its highlight resolves, since a
 * settled paragraph draws nothing unhighlighted; so the setter instead moves
 * each recorded code block into a frame at the same index, keeping every
 * block object and its drawn text.
 *
 * Afterwards the body's own block state still points at the inner
 * CodeRenderable, not the frame. That is harmless because no caller updates
 * a settled body (chat-view only ever sets `streaming = false`), and
 * `destroyRecursively()` reaches the code through the frame as an ordinary child. Switching a framed
 * body back to streaming is unsupported and throws. */
class SettlingMarkdownRenderable extends MarkdownRenderable {
  constructor(
    ctx: RenderContext,
    options: MarkdownOptions,
    private readonly code: CodeBlocks,
  ) {
    super(ctx, options);
  }

  override get streaming(): boolean {
    return super.streaming;
  }

  override set streaming(value: boolean) {
    const was = super.streaming;
    if (!was && value && this.code.framed)
      throw new Error("a settled Markdown body cannot stream again");
    super.streaming = value;
    if (was && !value && !this.isDestroyed) this.frameStreamedCode();
  }

  private frameStreamedCode(): void {
    for (const block of this.code.streamed) {
      if (block.isDestroyed || block.parent !== this) continue;
      const index = this.getChildren().indexOf(block);
      this.remove(block);
      // add(obj, index) inserts before the child now at that index.
      this.add(frameCodeBlock(this.ctx, block), index);
      this.code.framed = true;
    }
    this.code.streamed.clear();
  }
}

/** A Markdown body in the terminal's colours, with selection colours on
 * every block and, once settled, a muted left border on fenced code. */
export function markdown(
  ctx: RenderContext,
  options: MarkdownOptions,
): MarkdownRenderable {
  const ref: { body?: MarkdownRenderable } = {};
  // The constructor builds the first blocks before `ref.body` is assigned,
  // so until then the option says whether the body starts settled.
  const settled = () => !(ref.body ? ref.body.streaming : options.streaming);
  const code: CodeBlocks = { streamed: new Set(), framed: false };
  ref.body = new SettlingMarkdownRenderable(
    ctx,
    { fg: DEFAULT_FG, renderNode: renderBlock(ctx, settled, code), ...options },
    code,
  );
  return ref.body;
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
