import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Provider, defineProvider } from "@chatbridge/core";
import { createCli } from "./create-cli.js";

const fixtures = resolve(import.meta.dir, "__fixtures__");

/** Provider stub whose methods must never be reached: argument validation
 * happens before any browser is launched. */
function stubProvider(): Provider {
  const unreachable = () => {
    throw new Error("provider must not be used");
  };
  return defineProvider({
    name: "stub",
    chatUrl: "http://127.0.0.1:1/chat",
    navigateToLogin: unreachable,
    isLoggedIn: unreachable,
    startNewChat: unreachable,
    sendMessage: unreachable,
    waitForResponse: unreachable,
  });
}

let baseDir: string;
function setup(): string {
  baseDir = mkdtempSync(join(tmpdir(), "chatbridge-cli-"));
  return baseDir;
}

const stderrChunks: string[] = [];
const originalStderr = process.stderr.write.bind(process.stderr);
function captureStderr() {
  stderrChunks.length = 0;
  process.stderr.write = ((chunk: string) => {
    stderrChunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
}
afterEach(() => {
  process.stderr.write = originalStderr;
  if (baseDir) rmSync(baseDir, { recursive: true, force: true });
});

describe("--timeout validation", () => {
  test("rejects a non-numeric value without launching a browser", async () => {
    const cli = createCli({ name: "test-cli", provider: stubProvider() });
    const code = await cli.run(["bun", "cli", "-p", "x", "--timeout", "abc"]);
    expect(code).toBe(1);
  });

  test.each([["--timeout=0"], ["--timeout=-5"], ["--timeout=Infinity"]])(
    "rejects %p",
    async (arg: string) => {
      const cli = createCli({ name: "test-cli", provider: stubProvider() });
      const code = await cli.run(["bun", "cli", "-p", "x", arg]);
      expect(code).toBe(1);
    },
  );
});

describe("argument errors", () => {
  test("unknown flag exits 1 and prints usage to stderr", async () => {
    captureStderr();
    const cli = createCli({ name: "test-cli", provider: stubProvider() });
    const code = await cli.run(["bun", "cli", "-p", "x", "--bogus"]);
    expect(code).toBe(1);
    const out = stderrChunks.join("");
    expect(out).toContain("--bogus");
    expect(out).toContain("Usage:");
  });

  test("pinned provider rejects --provider with exit 1", async () => {
    captureStderr();
    const cli = createCli({ name: "test-cli", provider: stubProvider() });
    const code = await cli.run([
      "bun",
      "cli",
      "-p",
      "x",
      "--provider",
      "./x.ts",
    ]);
    expect(code).toBe(1);
    expect(stderrChunks.join("")).toContain("fixed provider");
  });
});

describe("provider resolution (exit 5)", () => {
  test("no --provider and no config exits 5 and names the config file", async () => {
    captureStderr();
    const cli = createCli({ name: "test-cli", baseDir: setup() });
    expect(await cli.run(["bun", "cli", "-p", "x"])).toBe(5);
    expect(stderrChunks.join("")).toContain("config.json");
  });

  test("non-existent provider path exits 5", async () => {
    const cli = createCli({ name: "test-cli", baseDir: setup() });
    const code = await cli.run([
      "bun",
      "cli",
      "-p",
      "x",
      "--provider",
      resolve(fixtures, "missing.ts"),
    ]);
    expect(code).toBe(5);
  });

  test("module without Provider methods exits 5", async () => {
    const cli = createCli({ name: "test-cli", baseDir: setup() });
    const code = await cli.run([
      "bun",
      "cli",
      "-p",
      "x",
      "--provider",
      resolve(fixtures, "not-a-provider.ts"),
    ]);
    expect(code).toBe(5);
  });

  test("provider with an unsafe name exits 5", async () => {
    const cli = createCli({ name: "test-cli", baseDir: setup() });
    const code = await cli.run([
      "bun",
      "cli",
      "auth",
      "status",
      "--provider",
      resolve(fixtures, "bad-name-provider.ts"),
    ]);
    expect(code).toBe(5);
  });

  test("config defaultProvider is used when --provider is absent", async () => {
    const dir = setup();
    mkdirSync(join(dir, "test-cli"), { recursive: true });
    writeFileSync(
      join(dir, "test-cli", "config.json"),
      JSON.stringify({
        defaultProvider: resolve(fixtures, "bad-name-provider.ts"),
      }),
    );
    const cli = createCli({ name: "test-cli", baseDir: dir });
    // Reaching the name check proves the config was read and the module loaded.
    expect(await cli.run(["bun", "cli", "auth", "status"])).toBe(5);
  });

  test("broken config exits 1", async () => {
    const dir = setup();
    mkdirSync(join(dir, "test-cli"), { recursive: true });
    writeFileSync(join(dir, "test-cli", "config.json"), "{ nope");
    const cli = createCli({ name: "test-cli", baseDir: dir });
    expect(await cli.run(["bun", "cli", "auth", "status"])).toBe(1);
  });
});

describe("interactive mode gate", () => {
  test("bare invocation without a terminal exits 1 with a hint", async () => {
    captureStderr();
    const cli = createCli({
      name: "test-cli",
      provider: stubProvider(),
      isTerminal: false,
    });
    expect(await cli.run(["bun", "cli"])).toBe(1);
    expect(stderrChunks.join("")).toContain("use -p <prompt>");
  });

  test("bare invocation with a terminal but no auth exits 2 before any UI", async () => {
    captureStderr();
    const cli = createCli({
      name: "test-cli",
      provider: stubProvider(),
      baseDir: setup(),
      isTerminal: true,
    });
    expect(await cli.run(["bun", "cli"])).toBe(2);
    expect(stderrChunks.join("")).toContain("auth login");
  });
});

describe("CHATBRIDGE_DEBUG", () => {
  test("prints the cause when set", async () => {
    captureStderr();
    const previous = process.env.CHATBRIDGE_DEBUG;
    process.env.CHATBRIDGE_DEBUG = "1";
    try {
      const cli = createCli({ name: "test-cli", baseDir: setup() });
      await cli.run([
        "bun",
        "cli",
        "-p",
        "x",
        "--provider",
        resolve(fixtures, "missing.ts"),
      ]);
    } finally {
      if (previous === undefined) {
        // biome-ignore lint/performance/noDelete: the variable must be absent, not "undefined".
        delete process.env.CHATBRIDGE_DEBUG;
      } else {
        process.env.CHATBRIDGE_DEBUG = previous;
      }
    }
    expect(stderrChunks.join("")).toContain("Caused by:");
  });
});

describe("--version", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  function captureLog() {
    logs.length = 0;
    console.log = ((...args: unknown[]) => {
      logs.push(args.join(" "));
    }) as typeof console.log;
  }
  afterEach(() => {
    console.log = originalLog;
  });

  test("prints name and version and exits 0", async () => {
    captureLog();
    const cli = createCli({
      name: "test-cli",
      version: "1.2.3",
      provider: stubProvider(),
    });
    expect(await cli.run(["bun", "cli", "--version"])).toBe(0);
    expect(logs.join("\n")).toBe("test-cli v1.2.3");
  });

  test("-V without a version prints the name alone", async () => {
    captureLog();
    const cli = createCli({ name: "test-cli", provider: stubProvider() });
    expect(await cli.run(["bun", "cli", "-V"])).toBe(0);
    expect(logs.join("\n")).toBe("test-cli");
  });

  test("help lists --version", async () => {
    captureLog();
    const cli = createCli({ name: "test-cli", provider: stubProvider() });
    await cli.run(["bun", "cli", "--help"]);
    expect(logs.join("\n")).toContain("--version");
  });
});
