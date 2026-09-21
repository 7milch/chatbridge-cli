import { cpSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
// `.cjs`: the manifest sets "type": "module", so a CommonJS bundle must
// carry the extension explicitly for both Node and the extension host.
const common = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["vscode", "playwright"],
  sourcemap: true,
};
await build({
  ...common,
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.cjs",
});

// The chat webview's assets ship with @chatbridge/vscode; VSCode serves them
// from the extension's own tree, so copy them next to the bundle. The
// package does not export ./package.json, so resolve its entry point (which
// already lives in dist/) and take the webview directory next to it.
const vscodeDist = dirname(require.resolve("@chatbridge/vscode"));
mkdirSync("dist/webview", { recursive: true });
cpSync(join(vscodeDist, "webview"), "dist/webview", { recursive: true });
