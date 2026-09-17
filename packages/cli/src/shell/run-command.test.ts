import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_OUTPUT_BYTES, runCommand } from "./run-command.js";

const SH = "/bin/sh";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** True once `pid` is gone: kill(pid, 0) fails with ESRCH, or (Linux)
 * the process is a zombie waiting for init to reap it. */
function gone(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return true;
  }
  try {
    return readFileSync(`/proc/${pid}/stat`, "utf8").includes(") Z ");
  } catch {
    return true;
  }
}

describe("runCommand", () => {
  test("captures stdout and stderr in arrival order and the exit code", async () => {
    const r = await runCommand("echo a; echo b >&2; echo c; exit 3", {
      cwd: process.cwd(),
      shell: SH,
    }).done;
    expect(r.output).toBe("a\nb\nc\n");
    expect(r.exitCode).toBe(3);
    expect(r.interrupted).toBe(false);
    expect(r.droppedBytes).toBe(0);
    expect(r.command).toBe("echo a; echo b >&2; echo c; exit 3");
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("exit code 0 and empty output", async () => {
    const r = await runCommand("true", { cwd: process.cwd(), shell: SH }).done;
    expect(r).toMatchObject({ output: "", exitCode: 0, interrupted: false });
  });

  test("runs in the given directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "run-command-"));
    try {
      const r = await runCommand("pwd", { cwd: dir, shell: SH }).done;
      // macOS tmpdir is a symlink; compare the resolved tail only.
      expect(r.output.trim().endsWith(dir.slice(dir.lastIndexOf("/")))).toBe(
        true,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("onOutput is called with the whole output so far, more than once", async () => {
    const seen: string[] = [];
    const r = await runCommand(
      "printf one; sleep 0.25; printf two; sleep 0.25; printf three",
      { cwd: process.cwd(), shell: SH, onOutput: (t) => seen.push(t) },
    ).done;
    expect(r.output).toBe("onetwothree");
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen[0]).toBe("one");
    expect(seen[seen.length - 1]).toBe("onetwothree");
  });

  test("the cap kills the command and keeps the tail", async () => {
    // One write per line (unlike `yes`, whose block writes can split a
    // line), so the kept tail always ends on a line boundary. Finite, in
    // case the kill ever fails.
    const r = await runCommand(
      "i=0; while [ $i -lt 100000 ]; do echo 0123456789; i=$((i+1)); done",
      { cwd: process.cwd(), shell: SH, maxBytes: 32 },
    ).done;
    expect(r.interrupted).toBe(true);
    expect(r.exitCode).toBeUndefined();
    expect(Buffer.byteLength(r.output)).toBeLessThanOrEqual(32);
    expect(r.output).toMatch(/0123456789\n$/);
    expect(r.droppedBytes).toBeGreaterThan(0);
    expect(MAX_OUTPUT_BYTES).toBe(200 * 1024);
  });

  test("stop() interrupts, keeps the output so far, and done settles", async () => {
    const running = runCommand("echo started; sleep 10; echo never", {
      cwd: process.cwd(),
      shell: SH,
    });
    await sleep(150);
    const before = Date.now();
    running.stop();
    running.stop(); // idempotent
    const r = await running.done;
    expect(Date.now() - before).toBeLessThan(1_500);
    expect(r.interrupted).toBe(true);
    expect(r.exitCode).toBeUndefined();
    expect(r.output).toBe("started\n");
  });

  test("stop() after exit is a no-op", async () => {
    const running = runCommand("true", { cwd: process.cwd(), shell: SH });
    const r = await running.done;
    expect(() => running.stop()).not.toThrow();
    expect(r.interrupted).toBe(false);
  });

  test("stop() takes the whole process group with it", async () => {
    // The grandchild's pid is printed so the test can check it is gone.
    const running = runCommand("sleep 30 & echo $!; wait", {
      cwd: process.cwd(),
      shell: SH,
    });
    await sleep(200);
    running.stop();
    const r = await running.done;
    const pid = Number.parseInt(r.output.trim(), 10);
    expect(pid).toBeGreaterThan(0);
    for (let i = 0; i < 50 && !gone(pid); i++) await sleep(20);
    expect(gone(pid)).toBe(true);
  });

  test("a missing shell rejects done", async () => {
    await expect(
      runCommand("true", { cwd: process.cwd(), shell: "/no/such/shell" }).done,
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("invalid UTF-8 is replaced, not thrown", async () => {
    const r = await runCommand("printf '\\377\\376ok'", {
      cwd: process.cwd(),
      shell: SH,
    }).done;
    expect(r.output.endsWith("ok")).toBe(true);
    expect(r.output).toContain("�");
  });

  test("a command that exits on its own while being stopped reports no exit code", async () => {
    // Writes past the cap and exits by itself before SIGTERM can land, so
    // the child's own code 7 must not leak into an interrupted result.
    const r = await runCommand(
      's=0123456789; i=0; while [ $i -lt 7 ]; do s="$s$s"; i=$((i+1)); done; printf \'%s\' "$s"; exit 7',
      { cwd: process.cwd(), shell: SH, maxBytes: 32 },
    ).done;
    expect(r.interrupted).toBe(true);
    expect(r.exitCode).toBeUndefined();
    expect(r.droppedBytes).toBeGreaterThan(0);
  });

  test("a multi-line command runs every line", async () => {
    const r = await runCommand("echo a\necho b", {
      cwd: process.cwd(),
      shell: SH,
    }).done;
    expect(r.output).toBe("a\nb\n");
    expect(r.exitCode).toBe(0);
  });

  test("a leading comment line does not swallow the command", async () => {
    const r = await runCommand("# just a comment\necho ok", {
      cwd: process.cwd(),
      shell: SH,
    }).done;
    expect(r.output).toBe("ok\n");
  });

  test("shell errors keep the command's own line numbers", async () => {
    const r = await runCommand("echo one\nnosuchcmd_xyz", {
      cwd: process.cwd(),
      shell: SH,
    }).done;
    expect(r.output).toContain("nosuchcmd_xyz");
    // dash: "/bin/sh: 2: nosuchcmd_xyz: not found"
    // bash: "/bin/bash: line 2: nosuchcmd_xyz: command not found"
    expect(r.output).toMatch(/(?:^|\s)(?:line )?2:/m);
    expect(r.exitCode).toBe(127);
  });

  test("a shell that cannot be executed rejects done", async () => {
    await expect(
      runCommand("true", { cwd: process.cwd(), shell: "/etc/hostname" }).done,
    ).rejects.toMatchObject({ code: "EACCES" });
  });

  test("the stderr merge does not rely on the user's shell", async () => {
    // A stand-in for a non-POSIX shell (fish, csh): it performs no
    // redirection of its own and just reports the argv it was given, so
    // this fails if `2>&1` is handed to the user's shell rather than done
    // by the wrapper.
    const dir = mkdtempSync(join(tmpdir(), "run-command-shell-"));
    const fake = join(dir, "fakeshell");
    writeFileSync(
      fake,
      '#!/bin/sh\nprintf \'argv:%s|%s\\n\' "$1" "$2"\necho on-stderr >&2\n',
    );
    chmodSync(fake, 0o755);
    try {
      const r = await runCommand("echo untouched >&2", {
        cwd: process.cwd(),
        shell: fake,
      }).done;
      expect(r.output).toContain("argv:-c|echo untouched >&2");
      expect(r.output).toContain("on-stderr");
      expect(r.exitCode).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
