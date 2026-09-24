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
} from "@opentui/core";
import {
  CURSOR_FALLBACK,
  DEFAULT_FG,
  MUTED_COLOR,
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
 * its private fields are set; the table selection test pins this.
 *
 * A fenced code block gets a muted left border so it stands apart from a
 * paragraph even when its language has no bundled grammar. OpenTUI does not
 * frame code itself, and a block `renderNode` replaces loses in-place
 * updates: it would be rebuilt on every streamed chunk and draw nothing
 * until its highlight resolves. So the frame is added only once the body is
 * settled, i.e. not streaming. */
function renderBlock(
  ctx: RenderContext,
  settled: () => boolean,
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
    if (token.type === "code" && block instanceof CodeRenderable && settled()) {
      const frame = new BoxRenderable(ctx, {
        id: `${block.id}-frame`,
        width: "100%",
        border: ["left"],
        borderColor: MUTED_COLOR,
        paddingLeft: 1,
        flexShrink: 0,
      });
      frame.add(block);
      return frame;
    }
    return block;
  };
}

/** Leaving streaming mode (0.5.10) reuses every block whose source did not
 * change without asking `renderNode`, so a code block would never get its
 * frame. Handing it a fresh `renderNode` is the public way to rebuild every
 * block through the hook, which is done once as streaming ends. */
class SettlingMarkdownRenderable extends MarkdownRenderable {
  constructor(
    ctx: RenderContext,
    options: MarkdownOptions,
    private readonly freshRenderNode: () => MarkdownOptions["renderNode"],
  ) {
    super(ctx, options);
  }

  override get streaming(): boolean {
    return super.streaming;
  }

  override set streaming(value: boolean) {
    const settling = super.streaming && !value;
    super.streaming = value;
    if (settling) this.renderNode = this.freshRenderNode();
  }
}

export function markdown(
  ctx: RenderContext,
  options: MarkdownOptions,
): MarkdownRenderable {
  const ref: { body?: MarkdownRenderable } = {};
  // The constructor builds the first blocks before `ref.body` is assigned,
  // so until then the option says whether the body starts settled.
  const settled = () => !(ref.body ? ref.body.streaming : options.streaming);
  ref.body = new SettlingMarkdownRenderable(
    ctx,
    { fg: DEFAULT_FG, renderNode: renderBlock(ctx, settled), ...options },
    () => renderBlock(ctx, settled),
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
