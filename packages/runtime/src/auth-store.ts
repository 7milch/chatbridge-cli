import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { validateProviderName } from "./provider-name.js";

export interface AuthStoreOptions {
  /** Directory name under the base dir, e.g. "chatbridge" or "company-ai". */
  configDir: string;
  /** Provider name; becomes the state file name. */
  providerName: string;
  /** Base directory; defaults to ~/.config. Overridable for tests. */
  baseDir?: string;
}

/** Persists Playwright storageState JSON with restrictive permissions.
 * The content is sensitive (session cookies): never log it. */
export class AuthStore {
  private readonly dir: string;
  private readonly file: string;

  constructor(opts: AuthStoreOptions) {
    validateProviderName(opts.providerName);
    const base = opts.baseDir ?? join(homedir(), ".config");
    this.dir = join(base, opts.configDir, "auth");
    this.file = join(this.dir, `${opts.providerName}.json`);
  }

  path(): string {
    return this.file;
  }

  has(): boolean {
    return existsSync(this.file);
  }

  async save(state: unknown): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700); // mkdir mode is masked by umask; enforce
    await writeFile(this.file, JSON.stringify(state), { mode: 0o600 });
    await chmod(this.file, 0o600);
  }

  async load(): Promise<unknown> {
    return JSON.parse(await readFile(this.file, "utf8"));
  }

  async clear(): Promise<void> {
    await rm(this.file, { force: true });
  }
}
