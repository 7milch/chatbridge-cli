import {
  BoxRenderable,
  type CliRenderer,
  TextAttributes,
  TextRenderable,
} from "@opentui/core";

/** Rows shown at once; the search already caps candidates to this. */
export const MAX_ROWS = 8;
/** Left/right border cells. */
const BORDER = 2;

export interface MentionPopupOptions {
  /** Distance from the parent's bottom edge, in rows — the height of
   * everything below the history area (input box + status line). */
  bottom: number;
}

/** Candidate list for an `@` mention, drawn over the bottom of the history
 * area. Purely presentational: the view decides what the keys do. Rows are
 * created once and re-labelled, so show/hide never churns renderables. */
export class MentionPopup {
  private readonly box: BoxRenderable;
  private readonly rows: TextRenderable[] = [];
  private candidates: string[] = [];
  private index = 0;
  private inner = 0;

  constructor(
    private readonly renderer: CliRenderer,
    parent: BoxRenderable,
    opts: MentionPopupOptions,
  ) {
    this.box = new BoxRenderable(renderer, {
      id: "mention-popup",
      position: "absolute",
      bottom: opts.bottom,
      left: 0,
      zIndex: 10,
      border: true,
      flexDirection: "column",
      visible: false,
    });
    for (let i = 0; i < MAX_ROWS; i++) {
      const row = new TextRenderable(renderer, { content: "", visible: false });
      this.rows.push(row);
      this.box.add(row);
    }
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
    this.inner = Math.max(
      1,
      Math.min(
        this.renderer.terminalWidth - BORDER,
        Math.max(...this.candidates.map((c) => c.length)),
      ),
    );
    this.box.width = this.inner + BORDER;
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
    this.rows.forEach((row, i) => {
      const label = this.candidates[i];
      if (label === undefined) {
        row.visible = false;
        return;
      }
      row.visible = true;
      row.content = label.slice(0, this.inner).padEnd(this.inner);
      row.attributes =
        i === this.index ? TextAttributes.INVERSE : TextAttributes.NONE;
    });
  }
}
