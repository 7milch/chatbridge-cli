import { randomUUID } from "node:crypto";
import {
  SESSION_RECORD_VERSION,
  type SessionRecord,
  type SessionSummary,
  type StoredMessage,
} from "./session-record.js";

/** What the recorder needs from a SessionStore; lets tests inject a fake. */
export interface SessionStoreLike {
  save(record: SessionRecord): Promise<void>;
  load(id: string): Promise<SessionRecord | undefined>;
  list(opts?: { current?: string }): Promise<SessionSummary[]>;
  prune(opts?: { current?: string }): Promise<void>;
  clear(): Promise<void>;
}

/** The settled history of the current session and its handle. */
export interface SessionSnapshot {
  conversation: string | undefined;
  messages: StoredMessage[];
}

export interface SessionRecorderOptions {
  store: SessionStoreLike;
  provider: string;
  /** Read on every call, so a setting changed mid-session applies.
   * Default: always on. */
  enabled?: () => boolean;
  /** Called once per session, the first time a save fails. */
  onSaveFailed?: () => void;
  /** Milliseconds since the epoch. Default Date.now. */
  now?: () => number;
  /** Default crypto.randomUUID. */
  newId?: () => string;
}

interface Current {
  id: string;
  createdAt: string;
  /** False until the first save landed: that one prunes. */
  created: boolean;
  /** The save-failure notice was raised for this session. */
  reported: boolean;
}

/** Which saved session the UI is in, and the queue of its saves. Shared by
 * the TUI model and the VSCode controller. No UI dependency; nothing here
 * logs, and no error carries message text or the handle. */
export class SessionRecorder {
  private current: Current | undefined;
  /** Every save chains on this, so they land in the order they were asked
   * for. It never rejects. */
  private tail: Promise<void> = Promise.resolve();
  private readonly store: SessionStoreLike;
  private readonly provider: string;
  private readonly isEnabled: () => boolean;
  private readonly onSaveFailed: () => void;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(opts: SessionRecorderOptions) {
    this.store = opts.store;
    this.provider = opts.provider;
    this.isEnabled = opts.enabled ?? (() => true);
    this.onSaveFailed = opts.onSaveFailed ?? (() => {});
    this.now = opts.now ?? Date.now;
    this.newId = opts.newId ?? randomUUID;
  }

  get enabled(): boolean {
    return this.isEnabled();
  }

  get id(): string | undefined {
    return this.current?.id;
  }

  record(snapshot: SessionSnapshot): void {
    if (!this.enabled) return;
    if (this.current === undefined) {
      // A session in which nothing was sent leaves no file.
      const started = snapshot.messages.some(
        (m) => m.role === "user" || m.role === "shell",
      );
      if (!started) return;
      this.current = {
        id: this.newId(),
        createdAt: new Date(this.now()).toISOString(),
        created: false,
        reported: false,
      };
    }
    const session = this.current;
    const record: SessionRecord = {
      version: SESSION_RECORD_VERSION,
      id: session.id,
      provider: this.provider,
      createdAt: session.createdAt,
      updatedAt: new Date(this.now()).toISOString(),
      ...(snapshot.conversation === undefined
        ? {}
        : { conversation: snapshot.conversation }),
      // Copied now: the caller's arrays keep changing while this waits.
      messages: structuredClone(snapshot.messages),
    };
    this.tail = this.tail.then(() => this.write(session, record));
  }

  private async write(session: Current, record: SessionRecord): Promise<void> {
    try {
      await this.store.save(record);
    } catch {
      if (!session.reported) {
        session.reported = true;
        this.onSaveFailed();
      }
      return;
    }
    if (session.created) return;
    session.created = true;
    // Housekeeping only: a failure here is not the user's problem.
    await this.store.prune({ current: session.id }).catch(() => {});
  }

  startNew(): void {
    this.current = undefined;
  }

  adopt(record: SessionRecord): void {
    this.current = {
      id: record.id,
      createdAt: record.createdAt,
      created: true,
      reported: false,
    };
  }

  async list(): Promise<SessionSummary[]> {
    if (!this.enabled) return [];
    await this.tail;
    const current = this.current?.id;
    const all = await this.store.list(current === undefined ? {} : { current });
    return all.filter((s) => s.id !== current);
  }

  async load(id: string): Promise<SessionRecord | undefined> {
    await this.tail;
    return this.store.load(id);
  }

  clear(): Promise<void> {
    this.current = undefined;
    // After the queue, so a save still in flight cannot recreate a file.
    const run = this.tail.then(() => this.store.clear());
    this.tail = run.catch(() => {});
    return run;
  }

  flush(): Promise<void> {
    return this.tail;
  }
}
