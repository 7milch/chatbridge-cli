import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
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
});

describe("packaging", () => {
  test("the tarball carries the skills", async () => {
    const out = await $`bun pm pack --dry-run`.cwd(import.meta.dir).text();
    expect(out).toContain("skills/creating-provider-repo/SKILL.md");
    expect(out).toContain(
      "skills/creating-provider-repo/probes/chatbridge-probes.js",
    );
    expect(out).toContain(
      "skills/creating-provider-repo/templates/src/provider.ts",
    );
    expect(out).not.toContain("skills.test.ts");
  });

  test("this repository reads the same files through symlinks", () => {
    const root = join(import.meta.dir, "../..");
    const link = join(root, ".claude/skills/creating-provider-repo");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(realpathSync(link)).toBe(
      realpathSync(join(SKILLS, "creating-provider-repo")),
    );
    expect(lstatSync(join(root, ".agents/skills")).isSymbolicLink()).toBe(true);
  });
});
