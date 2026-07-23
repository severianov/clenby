/**
 * Conversation Atlas — topic bucketing.
 *
 * Deliberately simple + honest: keyword counting over question/heading text,
 * fully local (nothing leaves the browser, no AI). This is a soft nicety —
 * when nothing matches, everything lands in the "general" bucket and the map
 * still works. Tune by editing {@link TOPIC_DEFS} only; colors are mapped in
 * companion.css per `data-cc-topic` (tokens only, no literals here).
 */

export type TopicId = "code" | "design" | "writing" | "data" | "general";

export interface TopicDef {
  readonly id: TopicId;
  /** Legend label. */
  readonly label: string;
  /** Keyword matcher (case-insensitive, global — used for match counting). */
  readonly re: RegExp | null;
}

/** Ordered bucket table — first match count wins ties. `general` is the
 *  default bucket and matches nothing on its own. */
export const TOPIC_DEFS: readonly TopicDef[] = [
  {
    id: "code",
    label: "Code & build",
    re: /\b(code|coding|bug|error|build|test|function|type(?:script)?|compil\w*|debug\w*|deploy\w*|install\w*|refactor\w*|api|regex|script|lint\w*|repo|git|command|terminal)\b/gi,
  },
  {
    id: "design",
    label: "Design & UI",
    re: /\b(design|theme|colou?r|css|style|styling|font|layout|ui|ux|anim\w*|icon|button|panel|responsive|mockup|dark mode|light mode|status bar)\b/gi,
  },
  {
    id: "writing",
    label: "Writing & docs",
    re: /\b(writ(?:e|ing|ten)|word(?:ing)?|draft|docs?|document\w*|essay|email|letter|translat\w*|summar\w*|nam(?:e|ing)|title|blog|story|readme|copy)\b/gi,
  },
  {
    id: "data",
    label: "Data & config",
    re: /\b(data|file|csv|json|table|database|sql|chart|graph|export\w*|import\w*|config\w*|storage|schema|spreadsheet|log)\b/gi,
  },
  { id: "general", label: "General", re: null },
];

/** Classify a blob of text (question + its answer headings) into a bucket by
 *  keyword-match count; ties go to the earlier bucket; no hits → general. */
export function classifyTopic(text: string): TopicId {
  let best: TopicId = "general";
  let bestCount = 0;
  for (const def of TOPIC_DEFS) {
    if (!def.re) continue;
    def.re.lastIndex = 0; // global regex — reset between calls
    const count = text.match(def.re)?.length ?? 0;
    if (count > bestCount) {
      bestCount = count;
      best = def.id;
    }
  }
  return best;
}

/** Legend label for a bucket id. */
export function topicLabel(id: TopicId): string {
  return TOPIC_DEFS.find((d) => d.id === id)?.label ?? "General";
}
