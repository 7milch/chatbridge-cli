import type { StyledText } from "@opentui/core";
import { styled, theme } from "./theme.js";

export interface BannerInput {
  name: string;
  version?: string;
  providerName: string;
  /** Vendor-supplied lines; replaces the default banner when set. */
  banner?: string[];
}

export const BANNER_HINT = "Type a message, or @ to attach a file.";

/** Lines shown centred in the empty history until the first message.
 * A vendor banner is passed through verbatim (all muted); the default is
 * the CLI name (bold), its version (muted) and a one-line hint. */
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
    styled(theme.muted(`Connected to ${input.providerName}. ${BANNER_HINT}`)),
  ];
}
