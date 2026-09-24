import { afterAll, expect, test } from "bun:test";
import { TreeSitterClient, getDataPaths } from "@opentui/core";
import { registerBundledGrammars } from "./grammars.js";

// The real worker, not the test renderer's MockTreeSitterClient: this is the
// only test that proves each wasm loads in OpenTUI's web-tree-sitter and
// each highlights.scm compiles against it. A grammar from the wrong tag, or
// an ABI 13 wasm (see the YAML note in grammars.ts), fails here.
registerBundledGrammars();
const client = new TreeSitterClient({
  dataPath: getDataPaths().globalDataPath,
});

afterAll(async () => {
  await client.destroy();
});

async function groups(source: string, filetype: string): Promise<Set<string>> {
  const result = await client.highlightOnce(source, filetype);
  if (result.error) throw new Error(`${filetype}: ${result.error}`);
  return new Set((result.highlights ?? []).map((h) => h[2]));
}

test.each([
  [
    "python",
    "def f(x):\n  return x + 1  # hi\n",
    ["keyword", "function", "number", "comment"],
  ],
  ["rb", "def f(x)\n  x + 1\nend\n", ["keyword", "function.method", "number"]],
  [
    "json",
    '{"a": 1, "b": true}\n',
    ["string.special.key", "number", "constant.builtin"],
  ],
  [
    "sh",
    'if [ -f "$f" ]; then\n  echo "hi $f" # c\nfi\n',
    ["keyword", "string", "comment"],
  ],
  ["go", "func main() { return }\n", ["keyword", "function"]],
] as const)(
  "%s highlights through the real worker",
  async (filetype, source, expected) => {
    const got = await groups(source, filetype);
    for (const group of expected) expect(got).toContain(group);
  },
  20_000,
);
