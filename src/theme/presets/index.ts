/**
 * The 8 theme preset bundles — data only, zero selectors, zero CSS
 *. Each JSON passes {@link assertThemeTokens} once at
 * module init so a malformed preset fails loudly, not silently on the page.
 */

import { assertThemeTokens, type ThemeTokens } from "../tokens";

import defaultJson from "./default.json";
import classicJson from "./classic.json";
import bookJson from "./book.json";
import compactJson from "./compact.json";
import focusJson from "./focus.json";
import trueBlackJson from "./true-black.json";
import codeJson from "./code.json";
import whatsappJson from "./whatsapp.json";

/** Display order in the gear-menu picker. */
export const PRESET_LIST: readonly ThemeTokens[] = [
  assertThemeTokens(defaultJson, "default.json"),
  assertThemeTokens(classicJson, "classic.json"),
  assertThemeTokens(bookJson, "book.json"),
  assertThemeTokens(compactJson, "compact.json"),
  assertThemeTokens(focusJson, "focus.json"),
  assertThemeTokens(trueBlackJson, "true-black.json"),
  assertThemeTokens(codeJson, "code.json"),
  assertThemeTokens(whatsappJson, "whatsapp.json"),
];

export const PRESETS: ReadonlyMap<string, ThemeTokens> = new Map(
  PRESET_LIST.map((p) => [p.id, p]),
);

export const DEFAULT_PRESET_ID = "default";

export function presetById(id: string): ThemeTokens {
  return PRESETS.get(id) ?? (PRESETS.get(DEFAULT_PRESET_ID) as ThemeTokens);
}
