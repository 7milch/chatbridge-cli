export const COMMAND_NAMES = [
  "login",
  "logout",
  "newChat",
  "reopen",
  "installBrowser",
  "sendSelection",
  "sendFile",
  "focus",
] as const;
export type CommandName = (typeof COMMAND_NAMES)[number];

/** Commands the framework registers but a manifest need not declare. An
 * undeclared command is still callable; it only misses the palette and the
 * title-bar menu, so a vendor manifest written for 0.9.0 keeps working. */
export const OPTIONAL_COMMAND_NAMES = ["help"] as const;
export type OptionalCommandName = (typeof OPTIONAL_COMMAND_NAMES)[number];

/** The title-bar actions, in the order they should appear. `navigation`
 * renders as an icon; the other groups land in the `...` overflow, and
 * VSCode folds the icons in there too when the view is narrow. */
const TITLE_MENU = [
  { name: "newChat", group: "navigation@1" },
  { name: "reopen", group: "navigation@2" },
  { name: "login", group: "1_auth@1" },
  { name: "logout", group: "1_auth@2" },
  { name: "installBrowser", group: "2_setup@1" },
  { name: "help", group: "3_help@1" },
] as const;

/** Only the `navigation` entries render as icons, so only these two need
 * an `icon` on their `contributes.commands` entry. */
const ICON_COMMANDS = ["newChat", "reopen"] as const;

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
function contributesOf(packageJSON: unknown): Record<string, unknown> {
  return ((packageJSON as { contributes?: Record<string, unknown> } | null)
    ?.contributes ?? {}) as Record<string, unknown>;
}

/** Commands that carry an `icon`, by command ID. */
function iconIds(list: unknown): Set<string> {
  const out = new Set<string>();
  if (!Array.isArray(list)) return out;
  for (const item of list) {
    const e = item as Record<string, unknown> | null;
    if (typeof e?.command === "string" && typeof e.icon === "string") {
      out.add(e.command);
    }
  }
  return out;
}

/** `view/title` entries bound to this extension's chat view. A `when`
 * naming another view would put the action in someone else's title bar. */
function titleMenuIds(list: unknown, id: string): Set<string> {
  const out = new Set<string>();
  if (!Array.isArray(list)) return out;
  for (const item of list) {
    const e = item as Record<string, unknown> | null;
    const when = typeof e?.when === "string" ? e.when : "";
    if (typeof e?.command === "string" && when.includes(`view == ${id}.chat`)) {
      out.add(e.command);
    }
  }
  return out;
}

export function missingContributions(
  packageJSON: unknown,
  id: string,
): string[] {
  const c = contributesOf(packageJSON);
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

/**
 * The contributes entries a vendor manifest *should* declare for `id` but
 * that are not required: the extension works without them, it only loses
 * the native title-bar actions. Logged once at activation, never fatal —
 * a manifest written for 0.9.0 must keep activating on a patch release.
 */
export function recommendedContributions(
  packageJSON: unknown,
  id: string,
): string[] {
  const c = contributesOf(packageJSON);
  const declared = ids(c.commands, "command");
  const icons = iconIds(c.commands);
  const menu = titleMenuIds(
    (c.menus as Record<string, unknown> | undefined)?.["view/title"],
    id,
  );
  const out: string[] = [];
  for (const name of OPTIONAL_COMMAND_NAMES) {
    if (!declared.has(`${id}.${name}`)) out.push(`commands: ${id}.${name}`);
  }
  for (const name of ICON_COMMANDS) {
    if (!icons.has(`${id}.${name}`)) out.push(`commands.icon: ${id}.${name}`);
  }
  for (const { name, group } of TITLE_MENU) {
    if (!menu.has(`${id}.${name}`)) {
      out.push(`menus.view/title: ${id}.${name} (${group})`);
    }
  }
  return out;
}
