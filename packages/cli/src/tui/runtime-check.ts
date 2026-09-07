/** @opentui/core needs Bun >= 1.3 or Node >= 26.4. Bun wins when present. */
export function supportsInteractive(versions: {
  bun?: string;
  node?: string;
}): boolean {
  if (versions.bun) return atLeast(versions.bun, 1, 3);
  if (versions.node) return atLeast(versions.node, 26, 4);
  return false;
}

function atLeast(version: string, major: number, minor: number): boolean {
  const [a = 0, b = 0] = version.split(".").map((n) => Number.parseInt(n, 10));
  return a > major || (a === major && b >= minor);
}
