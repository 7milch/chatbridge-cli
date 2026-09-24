import { fileURLToPath } from "node:url";
import { type FiletypeParserOptions, addDefaultParsers } from "@opentui/core";

/** Grammars this package ships on top of the four OpenTUI (0.5.10) bundles
 * (javascript, typescript, markdown, zig). Each lives in
 * `packages/cli/assets/<lang>/`: the wasm from tree-sitter-wasms@0.1.13, the
 * grammar's own highlights.scm at the tag that wasm was built from, and its
 * LICENSE. YAML is not here: the only prebuilt wasm is language ABI 13 and
 * crashes in OpenTUI's web-tree-sitter. */
export const BUNDLED_LANGUAGES = [
  "python",
  "ruby",
  "json",
  "bash",
  "go",
] as const;

export type BundledLanguage = (typeof BUNDLED_LANGUAGES)[number];

/** Info-string names that map onto a bundled filetype. OpenTUI's
 * `infoStringToFiletype` returns an unknown name unchanged, so every alias
 * has to be declared here. */
const ALIASES: Record<BundledLanguage, string[]> = {
  python: ["py", "python3"],
  ruby: ["rb"],
  json: ["jsonc", "json5"],
  bash: ["sh", "shell", "zsh", "console"],
  go: ["golang"],
};

// `src/tui/` and `dist/tui/` both sit two levels below `packages/cli/`, so
// this resolves to `packages/cli/assets/` from the test runner and from the
// published package alike.
const ASSETS = new URL("../../assets/", import.meta.url);

function assetPath(lang: BundledLanguage, file: string): string {
  return fileURLToPath(new URL(`${lang}/${file}`, ASSETS));
}

/** The descriptors OpenTUI needs, with absolute paths: a relative path would
 * be resolved against the process cwd. */
export function bundledGrammars(): FiletypeParserOptions[] {
  return BUNDLED_LANGUAGES.map((filetype) => ({
    filetype,
    aliases: ALIASES[filetype],
    queries: { highlights: [assetPath(filetype, "highlights.scm")] },
    wasm: assetPath(filetype, `tree-sitter-${filetype}.wasm`),
  }));
}

/** Registers the bundled grammars with OpenTUI's tree-sitter client. Must run
 * before the first CodeRenderable creates the client; the worker then loads a
 * grammar lazily the first time a block names it. Calling it twice is
 * harmless: OpenTUI replaces an override with the same filetype. */
export function registerBundledGrammars(): void {
  addDefaultParsers(bundledGrammars());
}
