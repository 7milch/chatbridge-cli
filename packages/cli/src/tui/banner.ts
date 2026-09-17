import type { StyledText } from "@opentui/core";
import { styled, theme } from "./theme.js";

export interface BannerInput {
  name: string;
  version?: string;
  providerName: string;
  /** Vendor-supplied lines; replaces the default banner when set. */
  banner?: string[];
}

/** The one-line hint under the connection line: 55 cells, so it always
 * fits an 80-column terminal on its own. */
export const BANNER_HINT =
  "Type a message, @ to attach a file, ! to run a command.";

/** Lines shown centred in the empty history until the first message.
 * A vendor banner is passed through verbatim (all muted); the default is
 * the CLI name (bold), its version (muted), the provider it is connected
 * to, and a one-line hint. */
export function resolveBanner(input: BannerInput): StyledText[] {
  if (input.banner) {
    return input.banner.map((line) => styled(theme.muted(line)));
  }
  const title =
    input.version === undefined
      ? styled(theme.title(input.name))
      : styled(theme.title(input.name), theme.muted(` v${input.version}`));
  return [
    title,
    // Banner lines do not wrap and the provider name has no length budget,
    // so the fixed-width hint gets its own line.
    styled(theme.muted(`Connected to ${input.providerName}.`)),
    styled(theme.muted(BANNER_HINT)),
  ];
}
