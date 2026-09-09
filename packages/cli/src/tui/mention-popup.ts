import { BoxRenderable, type CliRenderer, TextRenderable } from "@opentui/core";
import { styled, theme } from "./theme.js";

/** Rows shown at once; the search already caps candidates to this. */
export const MAX_ROWS = 8;
export const POPUP_HINT = "↕ select · Tab/Enter accept · Esc close";
const INDENT = "  ";
/** The hint is 39 cells wide, so a 2-cell indent would clip its last
 * character on an 80/40-column terminal; one cell keeps it whole. */
const HINT_INDENT = " ";

/** Candidate list for an `@` mention, drawn inline below the input (the
 * parent's next child after the input, before the status row). Hidden it
 * takes no rows. Purely presentational: the view decides what the keys do.
 * Rows are created once and re-labelled, so show/hide never churns
 * renderables. */
export class MentionPopup {
  private readonly box: BoxRenderable;
  private readonly rows: TextRenderable[] = [];
  private candidates: string[] = [];
  private index = 0;

  constructor(
    private readonly renderer: CliRenderer,
    parent: BoxRenderable,
  ) {
    this.box = new BoxRenderable(renderer, {
      id: "mention-popup",
      flexDirection: "column",
      flexShrink: 0,
      visible: false,
    });
    for (let i = 0; i < MAX_ROWS; i++) {
      const row = new TextRenderable(renderer, {
        content: "",
        visible: false,
        wrapMode: "none",
      });
      this.rows.push(row);
      this.box.add(row);
    }
    this.box.add(
      new TextRenderable(renderer, {
        content: styled(theme.muted(`${HINT_INDENT}${POPUP_HINT}`)),
        wrapMode: "none",
      }),
    );
    parent.add(this.box);
  }

  get visible(): boolean {
    return this.box.visible;
  }

  get selected(): string | undefined {
    return this.candidates[this.index];
  }

  /** Replaces the list and selects the first row. Empty list hides. */
  show(candidates: string[]): void {
    this.candidates = candidates.slice(0, MAX_ROWS);
    this.index = 0;
    if (this.candidates.length === 0) {
      this.hide();
      return;
    }
    this.box.visible = true;
    this.paint();
  }

  hide(): void {
    this.candidates = [];
    this.index = 0;
    this.box.visible = false;
  }

  /** Moves the selection, wrapping at both ends. */
  move(delta: 1 | -1): void {
    const n = this.candidates.length;
    if (n === 0) return;
    this.index = (this.index + delta + n) % n;
    this.paint();
  }

  destroy(): void {
    this.box.visible = false;
  }

  private paint(): void {
    const width = Math.max(1, this.renderer.terminalWidth - INDENT.length);
    this.rows.forEach((row, i) => {
      const label = this.candidates[i];
      if (label === undefined) {
        row.visible = false;
        return;
      }
      row.visible = true;
      const text = label.slice(0, width);
      if (i === this.index) {
        row.content = styled(theme.selected(`${INDENT}${text}`));
        return;
      }
      const slash = text.lastIndexOf("/");
      row.content =
        slash === -1
          ? styled(`${INDENT}${text}`)
          : styled(
              INDENT,
              theme.muted(text.slice(0, slash + 1)),
              text.slice(slash + 1),
            );
    });
  }
}
