/**
 * The ordered list of feature modules — the ONLY place features are enumerated
 *. Adding a feature = one folder + one line here.
 *
 * Order matters: the theme feature mounts first so --cc-* tokens exist before
 * any companion UI renders (boot order). Otherwise order follows the tier
 * map.
 */

import type { FeatureModule } from "./feature";

import { themes } from "@/features/themes";
import { donePing } from "@/features/done-ping";
import { outline } from "@/features/outline";
import { statusBar } from "@/features/status-bar";
import { headerCluster } from "@/features/header-cluster";
import { folding } from "@/features/folding";
import { pins } from "@/features/pins";
import { miniWindow } from "@/features/mini-window";
import { scrollLock } from "@/features/scroll-lock";
import { draftKeeper } from "@/features/draft-keeper";
import { enterBehavior } from "@/features/enter-behavior";
import { highlights } from "@/features/highlights";
import { notes } from "@/features/notes";
import { metaLine } from "@/features/meta-line";
import { exportFeature } from "@/features/export";
import { answerToolbar } from "@/features/answer-toolbar";
import { mathChecker } from "@/features/math-checker";
import { findInConversation } from "@/features/find-in-conversation";
import { consoleRelay } from "@/features/console-relay";
import { undoSend } from "@/features/undo-send";
import { usage } from "@/features/usage";
import { truncationGuard } from "@/features/truncation-guard";
import { fenceFixer } from "@/features/fence-fixer";
import { regenSafetyNet } from "@/features/regen-safety-net";
import { tableExtractor } from "@/features/table-extractor";
import { imageLightbox } from "@/features/image-lightbox";
import { liveChecklists } from "@/features/live-checklists";
import { selectorHealth } from "@/features/selector-health";
import { commandPalette } from "@/features/command-palette";
import { claudeCodeBridge } from "@/features/claude-code-bridge";

export const FEATURES: readonly FeatureModule[] = [
  // Tier 1 — the spine
  themes,
  donePing,
  outline,
  statusBar,
  headerCluster,
  // Tier 2
  folding,
  pins,
  // mini-window is SESSION-scoped: its always-on-top PiP window survives
  // conversation switches (it dies with the tab). Toolbar state re-syncs
  // via its "conversation:indexed" re-broadcast.
  miniWindow,
  // Reading UX — scroll-lock suppresses claude's auto-follow yank while
  // the user reads upthread (and publishes the away-from-bottom fact).
  scrollLock,
  // Composer — enter-behavior MUST stay listed before undo-send:
  // both intercept keydown on document (capture), same-target capture
  // listeners fire in registration order, and enter-behavior's
  // stopImmediatePropagation on a rewired plain Enter is what keeps undo-send
  // from arming a countdown for a keystroke that is no longer a send.
  draftKeeper,
  enterBehavior,
  highlights,
  notes,
  metaLine,
  exportFeature,
  // Per-answer tools — listed after pins/notes/mini-window so the
  // bus handlers the toolbar drives (ui:pin-toggle, ui:note-append,
  // ui:mini-window-popout) are already subscribed when it mounts.
  answerToolbar,
  // Trust — math-checker recomputes arithmetic claims locally (no
  // network). Settings/bus-coupled, never imported.
  mathChecker,
  // Find-in-conversation — global cross-thread search over the API
  // index (bus-coupled to the gear menu + palette, never imported).
  findInConversation,
  // Tier 3
  consoleRelay,
  undoSend,
  usage,
  // Claude Code bridge — SESSION-scoped: the composer session chip rides the
  // shared #cc-composer-grp (created by undo-send/usage), so it is listed after
  // them; it survives conversation switches and mirrors the background WS
  // roster. The answer-toolbar's send action is bus-coupled to it, never
  // imported.
  claudeCodeBridge,
  // Output repair — react to Claude's broken output (cut-off
  // answers, runaway code fences, regen rerolls). truncation-guard is listed
  // after undo-send so its programmatic send-button click meets undo-send's
  // already-registered interceptors exactly like a human click would
  // (settings/bus-coupled only, never imported).
  truncationGuard,
  fenceFixer,
  regenSafetyNet,
  // Data & media — per-table toolbar + sortable expand overlay and
  // image lightbox (settings-coupled to the gear menu's Data row, never
  // imported).
  tableExtractor,
  imageLightbox,
  // Delight & memory — live-checklists ticks Claude's step lists
  // (per-chat memory).
  liveChecklists,
  // Self-healing surface — the anchor health dashboard + override
  // editor over core/overrides.ts (bus-coupled to the gear menu's
  // Self-healing row and the palette, never imported).
  selectorHealth,
  commandPalette,
];
