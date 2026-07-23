/**
 * Conversation Atlas — data extraction.
 *
 * Derives the map's node graph from the SAME source the outline uses: the
 * API-indexed conversation (ctx.conversation), with the shared heading/label
 * helpers in @/shared/message-outline. Hubs = the user's questions, in
 * chronological order; satellites = the answer-section headings of the
 * assistant replies that follow each question (or the reply's first-line
 * label when it has no headings). Pure functions — index in, records out.
 */

import type { ConversationIndex } from "@/core/conversation-store";
import { clip, stripMarkdown } from "@/shared/text";
import { firstLabelOf, sectionsOf } from "@/shared/message-outline";
import { classifyTopic, type TopicId } from "./topics";

/** Keep hubs readable — an answer with 30 headings becomes 8 satellites. */
const MAX_SATELLITES_PER_HUB = 8;
const SNIPPET_MAX = 220;
const HUB_LABEL_MAX = 46;
const SAT_LABEL_MAX = 28;

export interface AtlasSatellite {
  /** Unique node id (uuid + section ordinal). */
  id: string;
  /** Owning assistant message uuid — the jump target. */
  uuid: string;
  /** Heading text passed to matcher.jumpTo, null for headingless replies. */
  headingText: string | null;
  label: string;
  snippet: string;
  /** 1-based assistant-reply number in the conversation (detail panel). */
  answerNo: number;
}

export interface AtlasHub {
  /** Unique node id (the human message uuid). */
  id: string;
  uuid: string;
  /** 1-based question number ("Q3"). */
  qIndex: number;
  /** ≤2 label lines rendered under the hub. */
  labelLines: string[];
  snippet: string;
  topic: TopicId;
  satellites: AtlasSatellite[];
}

/** Word-wrap a label into at most two lines of ~`width` chars. */
function wrapLabel(text: string, width: number): string[] {
  const s = clip(text, width);
  if (s.length <= width / 2 + 4) return [s];
  const words = s.split(" ");
  let line1 = "";
  let i = 0;
  while (i < words.length && (line1 + " " + words[i]).trim().length <= width / 2 + 6) {
    line1 = (line1 + " " + words[i]).trim();
    i++;
  }
  if (i === 0 || i >= words.length) return [s];
  return [line1, words.slice(i).join(" ")];
}

function snippetOf(raw: string): string {
  return clip(stripMarkdown(raw), SNIPPET_MAX);
}

/** Build the hub/satellite graph from a conversation index. */
export function buildAtlasData(index: ConversationIndex): AtlasHub[] {
  const hubs: AtlasHub[] = [];
  let current: AtlasHub | null = null;
  let answerNo = 0;

  for (const m of index.messages) {
    if (m.sender === "human") {
      current = {
        id: m.uuid,
        uuid: m.uuid,
        qIndex: hubs.length + 1,
        labelLines: wrapLabel(m.text, HUB_LABEL_MAX),
        snippet: snippetOf(m.text),
        topic: "general",
        satellites: [],
      };
      hubs.push(current);
      continue;
    }

    answerNo++;
    // Assistant reply before any question (rare) — nothing to orbit; skip.
    if (!current) continue;
    if (current.satellites.length >= MAX_SATELLITES_PER_HUB) continue;

    const room = MAX_SATELLITES_PER_HUB - current.satellites.length;
    const sections = sectionsOf(m.text);
    if (sections.length === 0) {
      current.satellites.push({
        id: `${m.uuid}:0`,
        uuid: m.uuid,
        headingText: null,
        label: clip(firstLabelOf(m.text), SAT_LABEL_MAX),
        snippet: snippetOf(m.text),
        answerNo,
      });
    } else {
      sections.slice(0, room).forEach((sec, k) => {
        current?.satellites.push({
          id: `${m.uuid}:${k}`,
          uuid: m.uuid,
          headingText: sec.txt,
          label: clip(sec.txt, SAT_LABEL_MAX),
          snippet: snippetOf(sec.body) || sec.txt,
          answerNo,
        });
      });
    }
  }

  // Bucket each hub over its question + satellite labels (satellites inherit
  // the hub color — one hue per question keeps the map legible).
  for (const hub of hubs) {
    hub.topic = classifyTopic(
      hub.labelLines.join(" ") + " " + hub.satellites.map((s) => s.label).join(" "),
    );
  }
  return hubs;
}
