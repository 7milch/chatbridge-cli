import { describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { $ } from "bun";

const SKILLS = join(import.meta.dir, "skills");
const read = (p: string) => readFileSync(join(SKILLS, p), "utf8");
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

describe("creating-provider-repo", () => {
  test("SKILL.md is short and only triggers in its description", () => {
    const skill = read("creating-provider-repo/SKILL.md");
    expect(words(skill)).toBeLessThanOrEqual(1300);
    const description = /^description: (.+)$/m.exec(skill)?.[1] ?? "";
    expect(description.startsWith("Use when")).toBe(true);
  });

  test("is self-contained: no path into the chatbridge-cli repository", () => {
    for (const file of [
      "SKILL.md",
      "dom-discovery.md",
      "vscode-extension.md",
    ]) {
      const body = read(`creating-provider-repo/${file}`);
      expect(body, file).not.toMatch(
        /examples\/|packages\/(cli|core|runtime|vscode)\//,
      );
    }
  });

  test("every relative link and template path it names exists", () => {
    for (const file of [
      "SKILL.md",
      "dom-discovery.md",
      "vscode-extension.md",
    ]) {
      const body = read(`creating-provider-repo/${file}`);
      for (const m of body.matchAll(/`((?:templates|probes)\/[^`\s]+)`/g)) {
        const path = (m[1] ?? "").replace(/\*$/, "");
        expect(
          existsSync(join(SKILLS, "creating-provider-repo", path)),
          `${file}: ${path}`,
        ).toBe(true);
      }
    }
  });

  test("dom-discovery.md names every probe entry point and every selector constant", () => {
    const body = read("creating-provider-repo/dom-discovery.md");
    for (const call of [
      "census()",
      "recordTurn.start()",
      "recordTurn.stop()",
      "replyShape(",
      "verify(",
    ])
      expect(body).toContain(call);
    const selectors = read("creating-provider-repo/templates/src/selectors.ts");
    for (const m of selectors.matchAll(/^export const ([A-Z_]+) = "/gm))
      expect(body, m[1]).toContain(m[1] ?? "");
    expect(body).not.toContain("headless and cannot");
  });

  test("dom-notes.md cites steps that exist and that fill its constants", () => {
    const discovery = read("creating-provider-repo/dom-discovery.md");
    /** Step number → everything from that step's **Write** part to its end. */
    const writes = new Map<string, string>();
    const steps = discovery.split(/^### Step (\d+) — /m).slice(1);
    for (let i = 0; i < steps.length; i += 2) {
      const number = steps[i] ?? "";
      const body = steps[i + 1] ?? "";
      const at = body.indexOf("**Write**");
      writes.set(number, at === -1 ? "" : body.slice(at));
    }
    expect(writes.size).toBeGreaterThan(5);

    const notes = read("creating-provider-repo/templates/docs/dom-notes.md");
    for (const section of notes.split(/^## /m).slice(1)) {
      const name = (section.split("\n")[0] ?? "").trim();
      const cited = new Set<string>();
      for (const m of section.matchAll(/steps? (\d+)(?:-(\d+))?/g)) {
        const from = Number(m[1]);
        const to = Number(m[2] ?? m[1]);
        for (let n = from; n <= to; n++) cited.add(String(n));
      }
      expect(cited.size, `${name}: cites no step`).toBeGreaterThan(0);
      let filled = "";
      for (const n of cited) {
        expect(writes.has(n), `${name}: dom-discovery has no step ${n}`).toBe(
          true,
        );
        filled += writes.get(n) ?? "";
      }
      for (const m of section.matchAll(/^\| ([A-Z_]+) \|/gm))
        expect(
          filled,
          `${name}: ${m[1]} is in no cited step's Write`,
        ).toContain(m[1] ?? "");
    }
  });
});

describe("VSCode template", () => {
  test("every media file the extension and its manifest name is shipped", () => {
    const dir = "creating-provider-repo/templates/vscode";
    const named = new Set<string>();
    for (const file of ["src/extension.ts", "package.json"])
      for (const m of read(`${dir}/${file}`).matchAll(/media\/[\w.-]+/g))
        named.add(m[0]);
    expect(named.size).toBeGreaterThanOrEqual(2);
    for (const path of named)
      expect(existsSync(join(SKILLS, dir, path)), path).toBe(true);
  });

  test("the package script ships Playwright; only package:smoke skips deps", () => {
    const pkg = JSON.parse(
      read("creating-provider-repo/templates/vscode/package.json"),
    );
    expect(pkg.scripts.package).not.toContain("--no-dependencies");
    expect(pkg.scripts.package).toContain("npm install --omit=dev");
    expect(pkg.scripts["package:smoke"]).toContain("--no-dependencies");
  });

  test("setting descriptions name the real fallback, not a manifest rule", () => {
    const pkg = JSON.parse(
      read("creating-provider-repo/templates/vscode/package.json"),
    );
    const props = pkg.contributes.configuration.properties;
    for (const key of ["headless", "timeoutSec", "idleTimeoutMinutes"]) {
      const desc: string = props[`<vendor>.${key}`].description;
      expect(desc, key).toContain("Unset:");
      expect(desc, key).not.toContain("Declaring");
    }
    expect(props["<vendor>.headless"].default).toBe(true);
    expect(props["<vendor>.timeoutSec"].description).toContain("120");
  });
});

describe("the playwright-core pin", () => {
  test("both skills query a dependency that @chatbridge/runtime really has", () => {
    const runtime = JSON.parse(
      readFileSync(join(import.meta.dir, "../runtime/package.json"), "utf8"),
    );
    for (const file of [
      "creating-provider-repo/SKILL.md",
      "upgrading-provider-repo/SKILL.md",
    ]) {
      const names = Array.from(
        read(file).matchAll(
          /npm view @chatbridge\/runtime@\S+\s+dependencies\.([\w@/-]+)/g,
        ),
        (m) => m[1] ?? "",
      );
      expect(names.length, file).toBeGreaterThan(0);
      for (const name of names)
        expect(runtime.dependencies, `${file}: ${name}`).toHaveProperty(name);
    }
  });
});

describe("upgrading-provider-repo", () => {
  const guide = () => read("upgrading-provider-repo/upgrade-guide.md");

  test("has an entry for the current minor version, newest first", () => {
    const { version } = JSON.parse(
      readFileSync(join(import.meta.dir, "package.json"), "utf8"),
    );
    const minor = version.split(".").slice(0, 2).join(".");
    const headings = Array.from(
      guide().matchAll(/^## (\d+\.\d+\.\d+)$/gm),
      (m) => m[1] ?? "",
    );
    expect(headings.some((h) => h.startsWith(`${minor}.`))).toBe(true);
    const sorted = [...headings].sort((a, b) =>
      b.localeCompare(a, undefined, { numeric: true }),
    );
    expect(headings).toEqual(sorted);
  });

  test("every entry has the fixed shape", () => {
    const entries = guide()
      .split(/^## \d+\.\d+\.\d+$/m)
      .slice(1);
    expect(entries.length).toBeGreaterThanOrEqual(3);
    for (const entry of entries) {
      expect(entry).toMatch(/^\*\*Required:\*\*/m);
      expect(entry).toMatch(/^\*\*Optional:\*\*/m);
      expect(entry).toMatch(/^\*\*VSCode manifest:\*\*/m);
    }
  });

  test("optional features say whether they need DOM observation and how to verify", () => {
    for (const feature of guide().split(/^### /m).slice(1)) {
      expect(feature).toMatch(/^Needs DOM observation: (yes|no)/m);
      expect(feature).toMatch(/^Verify:/m);
    }
  });

  test("the skill is short and links to its sibling by relative path", () => {
    const skill = read("upgrading-provider-repo/SKILL.md");
    expect(words(skill)).toBeLessThanOrEqual(600);
    expect(skill).toContain("../creating-provider-repo/");
    expect(skill).toContain("node_modules/@chatbridge/provider/skills");
  });

  test("every sibling step and template path it cites exists", () => {
    const discovery = read("creating-provider-repo/dom-discovery.md");
    const steps = new Set(
      Array.from(discovery.matchAll(/^### Step (\d+) — /gm), (m) => m[1] ?? ""),
    );
    expect(steps.size).toBeGreaterThan(5);
    for (const file of ["SKILL.md", "upgrade-guide.md"]) {
      const body = read(`upgrading-provider-repo/${file}`);
      for (const m of body.matchAll(
        /`\.\.\/creating-provider-repo\/((?:templates|probes)\/[^`\s]+)`/g,
      )) {
        const path = (m[1] ?? "").replace(/\*$/, "");
        expect(
          existsSync(join(SKILLS, "creating-provider-repo", path)),
          `${file}: ${path}`,
        ).toBe(true);
      }
      // Every step number must be cited as "`…/dom-discovery.md` step N",
      // including each number of a list such as "steps 2, 4 and 8". The
      // citation form is what makes it checkable, so a bare "step N" fails.
      const citation =
        /`\.\.\/creating-provider-repo\/dom-discovery\.md`\s+steps?\s+(\d+(?:\s*(?:,|and|–|-|to)\s*\d+)*)/g;
      let cited = 0;
      for (const m of body.matchAll(citation))
        for (const n of (m[1] ?? "").match(/\d+/g) ?? []) {
          cited++;
          expect(steps.has(n), `${file}: step ${n}`).toBe(true);
        }
      const bare = body.replace(citation, "").match(/\bsteps? \d+/g);
      expect(bare, `${file}: uncited step references`).toBe(null);
      if (file === "upgrade-guide.md") expect(cited).toBeGreaterThan(5);
    }
  });
});

describe("packaging", () => {
  test("the tarball carries the skills", async () => {
    const out = await $`bun pm pack --dry-run`.cwd(import.meta.dir).text();
    const packed = new Set(
      [...out.matchAll(/^packed\s+\S+\s+(\S+)$/gm)].map((m) => m[1] ?? ""),
    );
    const required = [
      "skills/creating-provider-repo/SKILL.md",
      "skills/creating-provider-repo/dom-discovery.md",
      "skills/creating-provider-repo/vscode-extension.md",
      "skills/creating-provider-repo/probes/chatbridge-probes.js",
      "skills/creating-provider-repo/templates/gitignore",
      "skills/creating-provider-repo/templates/mcp.json",
      "skills/creating-provider-repo/templates/package.json",
      "skills/creating-provider-repo/templates/src/provider.ts",
      "skills/creating-provider-repo/templates/vscode/package.json",
      "skills/creating-provider-repo/templates/vscode/vscodeignore",
      "skills/creating-provider-repo/templates/vscode/media/icon.svg",
      "skills/creating-provider-repo/templates/vscode/media/banner.svg",
      "skills/upgrading-provider-repo/SKILL.md",
      "skills/upgrading-provider-repo/upgrade-guide.md",
    ];
    for (const path of required) expect(packed.has(path), path).toBe(true);
    expect(out).not.toContain("skills.test.ts");
  });

  test("this repository reads the same files through symlinks", () => {
    const root = join(import.meta.dir, "../..");
    const link = join(root, ".claude/skills/creating-provider-repo");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(realpathSync(link)).toBe(
      realpathSync(join(SKILLS, "creating-provider-repo")),
    );
    expect(readlinkSync(link)).toBe(
      "../../packages/provider/skills/creating-provider-repo",
    );
    const upgradeLink = join(root, ".claude/skills/upgrading-provider-repo");
    expect(lstatSync(upgradeLink).isSymbolicLink()).toBe(true);
    expect(realpathSync(upgradeLink)).toBe(
      realpathSync(join(SKILLS, "upgrading-provider-repo")),
    );
    expect(readlinkSync(upgradeLink)).toBe(
      "../../packages/provider/skills/upgrading-provider-repo",
    );
    const agentsLink = join(root, ".agents/skills");
    expect(lstatSync(agentsLink).isSymbolicLink()).toBe(true);
    expect(readlinkSync(agentsLink)).toBe("../.claude/skills");
  });
});
