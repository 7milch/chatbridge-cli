export const COMMAND_NAMES = [
  "login",
  "logout",
  "newChat",
  "installBrowser",
  "sendSelection",
  "sendFile",
  "focus",
] as const;
export type CommandName = (typeof COMMAND_NAMES)[number];

/** The `contributes` IDs a vendor extension must declare for `id`. */
export function expectedContributions(id: string): {
  viewContainers: string[];
  views: string[];
  commands: string[];
} {
  return {
    viewContainers: [id],
    views: [`${id}.chat`],
    commands: COMMAND_NAMES.map((n) => `${id}.${n}`),
  };
}

function ids(list: unknown, key: string): Set<string> {
  const out = new Set<string>();
  if (Array.isArray(list)) {
    for (const item of list) {
      const v = (item as Record<string, unknown> | null)?.[key];
      if (typeof v === "string") out.add(v);
    }
  }
  return out;
}

/**
 * The contributes entries a vendor manifest must declare for `id`, that
 * this package.json lacks. Empty when the manifest is complete.
 */
export function missingContributions(
  packageJSON: unknown,
  id: string,
): string[] {
  const c = ((packageJSON as { contributes?: Record<string, unknown> } | null)
    ?.contributes ?? {}) as Record<string, unknown>;
  const expected = expectedContributions(id);
  const containers = ids(
    (c.viewsContainers as { activitybar?: unknown } | undefined)?.activitybar,
    "id",
  );
  const views = ids(
    (c.views as Record<string, unknown> | undefined)?.[id],
    "id",
  );
  const commands = ids(c.commands, "command");
  const missing: string[] = [];
  for (const v of expected.viewContainers) {
    if (!containers.has(v)) missing.push(`viewsContainers.activitybar: ${v}`);
  }
  for (const v of expected.views) {
    if (!views.has(v)) missing.push(`views.${id}: ${v}`);
  }
  for (const v of expected.commands) {
    if (!commands.has(v)) missing.push(`commands: ${v}`);
  }
  return missing;
}
