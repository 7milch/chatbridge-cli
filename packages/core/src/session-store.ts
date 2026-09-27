import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { validateProviderName } from "@chatbridge/runtime";
import {
  type SessionRecord,
  type SessionSummary,
  isSessionId,
  parseSessionRecord,
  summarize,
} from "./session-record.js";

export const SESSION_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
export const SESSION_MAX_COUNT = 50;
export const TEMP_MAX_AGE_MS = 60 * 60 * 1000;

const JSON_EXT = ".json";
const TEMP_EXT = ".tmp";

export interface SessionStoreOptions {
  /** Directory name under the base dir, e.g. "chatbridge". */
  configDir: string;
  /** Provider name; becomes the directory the sessions live in. */
  providerName: string;
  /** Base directory; defaults to ~/.config. Overridable for tests. */
  baseDir?: string;
  /** Milliseconds since the epoch. Default Date.now; tests inject it. */
  now?: () => number;
}

/** Saved interactive sessions of one provider, one JSON file each. The
 * content is what the user and the assistant wrote plus the conversation
 * handle: never log it. No method here logs anything. */
export class SessionStore {
  private readonly parent: string;
  private readonly root: string;
  private readonly provider: string;
  private readonly now: () => number;

  constructor(opts: SessionStoreOptions) {
    validateProviderName(opts.providerName);
    const base = opts.baseDir ?? join(homedir(), ".config");
    this.parent = join(base, opts.configDir, "sessions");
    this.root = join(this.parent, opts.providerName);
    this.provider = opts.providerName;
    this.now = opts.now ?? Date.now;
  }

  dir(): string {
    return this.root;
  }

  private fileOf(id: string): string {
    return join(this.root, `${id}${JSON_EXT}`);
  }

  /** Writes the whole record to a temporary file, syncs it, and renames it
   * over the target: a crash leaves the old content or the new, never a
   * truncated file. */
  async save(record: SessionRecord): Promise<void> {
    if (!isSessionId(record.id)) throw new Error("Invalid session id.");
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    // mkdir's mode is masked by umask, and is not applied to a directory
    // that already existed; enforce both levels.
    await chmod(this.parent, 0o700);
    await chmod(this.root, 0o700);
    const temp = join(this.root, `${record.id}.${randomUUID()}${TEMP_EXT}`);
    try {
      const handle = await open(temp, "w", 0o600);
      try {
        await handle.writeFile(JSON.stringify(record));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await chmod(temp, 0o600);
      await rename(temp, this.fileOf(record.id));
    } catch (err) {
      await rm(temp, { force: true }).catch(() => {});
      throw err;
    }
  }

  /** Undefined for a malformed id, a missing file and an unreadable one:
   * the caller cannot do anything different about them. */
  async load(id: string): Promise<SessionRecord | undefined> {
    if (!isSessionId(id)) return undefined;
    let raw: string;
    try {
      raw = await readFile(this.fileOf(id), "utf8");
    } catch {
      return undefined;
    }
    let doc: unknown;
    try {
      doc = JSON.parse(raw);
    } catch {
      return undefined;
    }
    const record = parseSessionRecord(doc);
    if (record === undefined) return undefined;
    // A file renamed by hand, or copied from another provider's directory.
    if (record.id !== id || record.provider !== this.provider) return undefined;
    return record;
  }

  async list(opts: { current?: string } = {}): Promise<SessionSummary[]> {
    const records = await this.sweep(opts.current);
    return records.map(summarize);
  }

  async prune(opts: { current?: string } = {}): Promise<void> {
    await this.sweep(opts.current);
  }

  async clear(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }

  private async mtimeOf(path: string): Promise<number | undefined> {
    try {
      return (await stat(path)).mtimeMs;
    } catch {
      return undefined;
    }
  }

  /** Best effort: another process may have deleted it first. */
  private async remove(path: string): Promise<void> {
    await rm(path, { force: true }).catch(() => {});
  }

  /** One pass over the directory: deletes what the retention rules say and
   * returns the records that remain, newest first. Never throws. */
  private async sweep(current: string | undefined): Promise<SessionRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.root);
    } catch {
      return [];
    }
    const now = this.now();
    const records: SessionRecord[] = [];
    for (const name of names) {
      const path = join(this.root, name);
      if (name.endsWith(TEMP_EXT)) {
        const mtime = await this.mtimeOf(path);
        if (mtime !== undefined && now - mtime > TEMP_MAX_AGE_MS) {
          await this.remove(path);
        }
        continue;
      }
      if (!name.endsWith(JSON_EXT)) continue;
      const record = await this.load(name.slice(0, -JSON_EXT.length));
      if (record === undefined) {
        // Unreadable: never deleted on sight, since a newer build may have
        // written it. It goes by age, and the cap does not count it.
        const mtime = await this.mtimeOf(path);
        if (mtime !== undefined && now - mtime > SESSION_MAX_AGE_MS) {
          await this.remove(path);
        }
        continue;
      }
      if (
        record.id !== current &&
        now - Date.parse(record.updatedAt) > SESSION_MAX_AGE_MS
      ) {
        await this.remove(path);
        continue;
      }
      records.push(record);
    }
    records.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    const kept: SessionRecord[] = [];
    for (const record of records) {
      if (kept.length < SESSION_MAX_COUNT || record.id === current) {
        kept.push(record);
      } else {
        await this.remove(this.fileOf(record.id));
      }
    }
    return kept;
  }
}
