/**
 * Secret guard — pure draft-scanning functions for the status bar's line 2
 * No DOM, no state — trivially testable.
 *
 * Behavior: names the secret TYPE in inline
 * red text (var(--cc-danger)); clears when the draft clears.
 *
 * Design notes:
 * - PATTERNS is ordered critical → high → medium and, within a severity,
 *   most-specific first. Provider-prefix patterns (sk-ant-…, AKIA…, ghp_…)
 *   are the near-zero-false-positive backbone.
 * - Generic patterns (credential assignments, high-entropy blobs, credit
 *   cards) are keyword-gated and validated (Luhn / Shannon entropy /
 *   placeholder guards) so they stay quiet on prose, dash-form UUIDs, git
 *   SHAs, MD5/SHA digests, base64 data-URIs, version strings and obvious
 *   placeholders (`xxxx`, `<your-key>`, `YOUR_API_KEY`, `example`, …).
 * - detectSecret() keeps the original single-hit contract (now the
 *   highest-severity hit); detectSecrets() returns all distinct hits,
 *   severity-ordered and capped at MAX_HITS.
 */

export type SecretSeverity = "critical" | "high" | "medium";

export interface SecretHit {
  /** Machine id of the pattern. */
  type: string;
  /** Human label shown in the status bar ("OpenAI API key (sk-…)"). */
  label: string;
  /** Ranking used to pick which hit the status bar surfaces first. */
  severity: SecretSeverity;
}

interface SecretPattern {
  type: string;
  label: string;
  severity: SecretSeverity;
  /** Pure predicate — true when the draft contains this secret type. */
  test: (draft: string) => boolean;
}

/** Max distinct hits returned by detectSecrets (patterns are severity-ordered, so the cap keeps the worst offenders). */
const MAX_HITS = 4;

// ---------------------------------------------------------------------------
// Shared guards + helpers (pure)
// ---------------------------------------------------------------------------

/** Obvious placeholder/example values — never worth an alarm. */
const PLACEHOLDER_RE =
  /x{5,}|\*{3,}|•{3,}|\.{3}|…|<[^<>\n]{1,48}>|\{\{[^{}\n]{1,48}\}\}|\byour[_-]?[a-z0-9_-]*\b|example|sample|placeholder|redacted|change[_-]?me|dummy|insert[_-]/i;

/** Same character repeated 8+ times — placeholder padding, not a secret. */
const REPEAT_RE = /(.)\1{7,}/;

/** Dash-form UUID (all versions). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isPlaceholder(s: string): boolean {
  return PLACEHOLDER_RE.test(s) || REPEAT_RE.test(s);
}

/** Shannon entropy in bits/char over the string's own alphabet. */
function shannonEntropy(s: string): number {
  if (!s) return 0;
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / s.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/** Luhn checksum — true for valid card-shaped digit strings. */
function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Regex-backed predicate with the placeholder guard applied per match.
 * Every regex passed here MUST carry the `g` flag (matchAll requirement).
 */
function rx(re: RegExp): (draft: string) => boolean {
  return (draft: string): boolean => {
    for (const m of draft.matchAll(re)) {
      const text = m[0];
      if (text && !isPlaceholder(text)) return true;
    }
    return false;
  };
}

// ---------------------------------------------------------------------------
// Custom validated detectors (Luhn / entropy / keyword gating)
// ---------------------------------------------------------------------------

/** 13–19 digit runs (spaces/dashes allowed) that pass Luhn AND start with a real card-network digit (2–6). */
const CC_RE = /(?<![\d-])(?:\d[ -]?){12,18}\d(?!\d)/g;

function hasCreditCard(draft: string): boolean {
  for (const m of draft.matchAll(CC_RE)) {
    const digits = (m[0] ?? "").replace(/\D/g, "");
    if (digits.length < 13 || digits.length > 19) continue;
    // Real networks (Visa/MC/Amex/Discover/Diners/JCB/Maestro) start 2–6;
    // this drops Luhn-coincident timestamps, ISBNs (978…) and random ids.
    const first = digits.charCodeAt(0) - 48;
    if (first < 2 || first > 6) continue;
    if (luhnValid(digits)) return true;
  }
  return false;
}

/**
 * Generic credential assignment, keyword-gated. password/passwd/pwd keep the
 * historical loose behavior via their own dedicated pattern below — here the
 * value must additionally look secret-ish (length, charset mix, entropy).
 */
const GENERIC_ASSIGN_RE =
  /\b(api[_-]?key|api[_-]?secret|client[_-]?secret|access[_-]?token|auth[_-]?token|secret[_-]?key|secret|token)\b["'`]?\s*[:=]\s*["'`]?([^\s"'`,;]{6,})/gi;

function hasGenericCredential(draft: string): boolean {
  for (const m of draft.matchAll(GENERIC_ASSIGN_RE)) {
    const value = m[2] ?? "";
    if (isPlaceholder(m[0] ?? "") || isPlaceholder(value)) continue;
    if (UUID_RE.test(value)) continue; // dash-form UUIDs are ids, not secrets
    if (value.length < 8) continue;
    // Secrets virtually always mix digits, symbols or both cases; prose doesn't.
    const secretish =
      /\d/.test(value) || /[^A-Za-z0-9]/.test(value) || (/[a-z]/.test(value) && /[A-Z]/.test(value));
    if (!secretish) continue;
    if (shannonEntropy(value) < 3) continue;
    return true;
  }
  return false;
}

/**
 * High-entropy fallback: a base64/hex-ish blob ≥32 chars, only when a secret
 * keyword appears in the 48 chars before it, with digest/data-URI/UUID guards.
 */
const BLOB_RE = /[A-Za-z0-9+/=_-]{32,}/g;
const BLOB_KEYWORD_RE = /key|token|secret|password|passwd|credential|auth|api/i;
const BLOB_DIGEST_RE = /sha-?\d*|md-?5|digest|checksum|hash|hmac|commit|integrity|etag|base64,/i;

function hasHighEntropyBlob(draft: string): boolean {
  for (const m of draft.matchAll(BLOB_RE)) {
    const blob = m[0] ?? "";
    const start = m.index ?? 0;
    const context = draft.slice(Math.max(0, start - 48), start);
    if (!BLOB_KEYWORD_RE.test(context)) continue; // must sit near a secret keyword
    if (BLOB_DIGEST_RE.test(context)) continue; // "…sha256:", "commit …", "…;base64," etc.
    if (UUID_RE.test(blob) || isPlaceholder(blob)) continue;
    // Random secrets mix digits or both cases; kebab/snake prose does not.
    if (!(/\d/.test(blob) || (/[a-z]/.test(blob) && /[A-Z]/.test(blob)))) continue;
    const threshold = /^[0-9a-fA-F]+$/.test(blob) ? 3.4 : 4.0;
    if (shannonEntropy(blob) >= threshold) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Pattern catalog — ordered critical → high → medium, specific before generic
// ---------------------------------------------------------------------------

const PATTERNS: readonly SecretPattern[] = [
  // ── critical ─────────────────────────────────────────────────────────────
  {
    type: "private-key",
    label: "private key block",
    severity: "critical",
    // RSA / EC / DSA / OPENSSH / ENCRYPTED / PGP (… KEY BLOCK) variants.
    test: rx(/-----BEGIN\s+[A-Z0-9 ]*PRIVATE KEY(?:\s+BLOCK)?-----/g),
  },
  {
    type: "gcp-service-account",
    label: "GCP service-account JSON",
    severity: "critical",
    test: rx(/"type"\s*:\s*"service_account"|"private_key"\s*:\s*"-----BEGIN/g),
  },
  {
    type: "aws-secret-key",
    label: "AWS secret access key",
    severity: "critical",
    // 40-char base64 value, keyword-gated on aws_secret… / secret_access_key.
    test: rx(
      /\b(?:aws[_-]?secret[_-]?(?:access[_-]?)?key|secret[_-]?access[_-]?key)\b["'`]?\s*[:=]\s*["'`]?[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])/gi,
    ),
  },
  {
    type: "stripe-live-key",
    label: "Stripe live secret key",
    severity: "critical",
    test: rx(/\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/g),
  },
  {
    type: "connection-string",
    label: "connection string with credentials",
    severity: "critical",
    // postgres/mysql/mongodb(+srv)/redis(s)/amqp(s)/… — any scheme://user:pass@host.
    test: rx(/\b[a-z][a-z0-9+.-]{1,24}:\/\/[^\s:@/]{0,64}:[^\s@/]{1,128}@[^\s"'`]+/gi),
  },

  // ── high ─────────────────────────────────────────────────────────────────
  {
    type: "anthropic-key",
    label: "Anthropic API key",
    severity: "high",
    test: rx(/\bsk-ant-[A-Za-z0-9_-]{24,}/g),
  },
  {
    type: "openai-key",
    label: "OpenAI API key (sk-…)",
    severity: "high",
    // Covers sk-, sk-proj-, sk-svcacct-, sk-admin-; sk-ant- is Anthropic's.
    test: rx(/\bsk-(?!ant-)[A-Za-z0-9_-]{16,}\b/g),
  },
  {
    type: "google-api-key",
    label: "Google API key",
    severity: "high",
    test: rx(/\bAIza[0-9A-Za-z_-]{35}\b/g),
  },
  {
    type: "hf-token",
    label: "Hugging Face token",
    severity: "high",
    test: rx(/\bhf_[A-Za-z0-9]{30,}\b/g),
  },
  {
    type: "replicate-token",
    label: "Replicate API token",
    severity: "high",
    test: rx(/\br8_[A-Za-z0-9]{30,}\b/g),
  },
  {
    type: "cohere-key",
    label: "Cohere API key",
    severity: "high",
    // No distinctive prefix — keyword-gated on a cohere… assignment.
    test: rx(/\bcohere[a-z0-9_-]*["'`]?\s*[:=]\s*["'`]?[A-Za-z0-9]{32,}\b/gi),
  },
  {
    type: "aws-access-key-id",
    label: "AWS access key",
    severity: "high",
    test: rx(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g),
  },
  {
    type: "google-oauth-token",
    label: "Google OAuth access token",
    severity: "high",
    test: rx(/\bya29\.[A-Za-z0-9_-]{30,}/g),
  },
  {
    type: "azure-storage-key",
    label: "Azure storage account key",
    severity: "high",
    test: rx(/\bAccountKey=[A-Za-z0-9+/=]{40,}/g),
  },
  {
    type: "azure-sas",
    label: "Azure SAS token",
    severity: "high",
    test: rx(/\bSharedAccessSignature=[^\s;"'`]{16,}/gi),
  },
  {
    type: "digitalocean-token",
    label: "DigitalOcean token",
    severity: "high",
    test: rx(/\bdo[por]_v1_[0-9a-f]{64}\b/g),
  },
  {
    type: "github-token",
    label: "GitHub token",
    severity: "high",
    test: rx(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/g),
  },
  {
    type: "gitlab-token",
    label: "GitLab token",
    severity: "high",
    test: rx(/\bglpat-[A-Za-z0-9_-]{20,}\b/g),
  },
  {
    type: "npm-token",
    label: "npm token",
    severity: "high",
    test: rx(/\bnpm_[A-Za-z0-9]{36}\b/g),
  },
  {
    type: "pypi-token",
    label: "PyPI token",
    severity: "high",
    test: rx(/\bpypi-[A-Za-z0-9_-]{40,}\b/g),
  },
  {
    type: "dockerhub-token",
    label: "Docker Hub token",
    severity: "high",
    test: rx(/\bdckr_pat_[A-Za-z0-9_-]{20,}\b/g),
  },
  {
    type: "circleci-token",
    label: "CircleCI token",
    severity: "high",
    test: rx(/\bCCIPAT_[A-Za-z0-9_-]{20,}\b/g),
  },
  {
    type: "databricks-token",
    label: "Databricks token",
    severity: "high",
    test: rx(/\bdapi[0-9a-f]{32}\b/g),
  },
  {
    type: "postman-key",
    label: "Postman API key",
    severity: "high",
    test: rx(/\bPMAK-[0-9a-f]{24}-[0-9a-f]{34}\b/g),
  },
  {
    type: "stripe-key",
    label: "Stripe secret key",
    severity: "high",
    test: rx(/\b(?:sk|rk)_test_[A-Za-z0-9]{16,}\b/g),
  },
  {
    type: "stripe-webhook-secret",
    label: "Stripe webhook secret",
    severity: "high",
    test: rx(/\bwhsec_[A-Za-z0-9]{24,}\b/g),
  },
  {
    type: "square-token",
    label: "Square token",
    severity: "high",
    test: rx(/\bsq0(?:atp|csp)-[A-Za-z0-9_-]{22,50}\b|\bEAAA[A-Za-z0-9_-]{40,}\b/g),
  },
  {
    type: "shopify-token",
    label: "Shopify token",
    severity: "high",
    test: rx(/\bshp(?:at|ss|ca|pa)_[0-9a-fA-F]{32}\b/g),
  },
  {
    type: "paypal-token",
    label: "PayPal/Braintree access token",
    severity: "high",
    test: rx(/\baccess_token\$(?:production|sandbox)\$[0-9a-z]{10,}\$[0-9a-f]{16,}/gi),
  },
  {
    type: "slack-token",
    label: "Slack token",
    severity: "high",
    test: rx(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g),
  },
  {
    type: "slack-webhook",
    label: "Slack webhook URL",
    severity: "high",
    test: rx(/https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9]+\/B[A-Za-z0-9]+\/[A-Za-z0-9]{16,}/g),
  },
  {
    type: "discord-bot-token",
    label: "Discord bot token",
    severity: "high",
    test: rx(/\b[MNO][A-Za-z0-9_-]{23,25}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{25,}\b/g),
  },
  {
    type: "telegram-bot-token",
    label: "Telegram bot token",
    severity: "high",
    test: rx(/\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g),
  },
  {
    type: "twilio-credential",
    label: "Twilio credential",
    severity: "high",
    test: rx(/\b(?:AC|SK)[0-9a-f]{32}\b/g),
  },
  {
    type: "sendgrid-key",
    label: "SendGrid API key",
    severity: "high",
    test: rx(/\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g),
  },
  {
    type: "mailgun-key",
    label: "Mailgun API key",
    severity: "high",
    test: rx(/\bkey-[0-9a-f]{32}\b/g),
  },
  {
    type: "notion-token",
    label: "Notion token",
    severity: "high",
    test: rx(/\bsecret_[A-Za-z0-9]{43}\b|\bntn_[A-Za-z0-9]{40,}\b/g),
  },
  {
    type: "linear-key",
    label: "Linear API key",
    severity: "high",
    test: rx(/\blin_api_[A-Za-z0-9]{32,}\b/g),
  },
  {
    type: "supabase-token",
    label: "Supabase access token",
    severity: "high",
    test: rx(/\bsbp_[0-9a-f]{40}\b/g),
  },
  {
    type: "figma-token",
    label: "Figma token",
    severity: "high",
    test: rx(/\bfigd_[A-Za-z0-9_-]{20,}\b/g),
  },
  {
    type: "newrelic-key",
    label: "New Relic API key",
    severity: "high",
    test: rx(/\bNRAK-[A-Z0-9]{27}\b/g),
  },
  {
    type: "datadog-key",
    label: "Datadog API key",
    severity: "high",
    // 32/40-hex value, keyword-gated on a datadog/dd api/app key assignment.
    test: rx(/\b(?:datadog|dd)[_-]?(?:api|app)[_-]?key\b["'`]?\s*[:=]\s*["'`]?[0-9a-f]{32,40}\b/gi),
  },
  {
    type: "cloudflare-token",
    label: "Cloudflare API token",
    severity: "high",
    test: rx(/\b(?:cloudflare|cf)[_-]?(?:api[_-]?)?(?:token|key)\b["'`]?\s*[:=]\s*["'`]?[A-Za-z0-9_-]{32,}/gi),
  },
  {
    type: "jwt",
    label: "JWT",
    severity: "high",
    // Signed JWTs: base64url JSON header AND payload both start with eyJ.
    test: rx(/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{10,}\b/g),
  },
  {
    type: "http-auth",
    label: "Authorization header credential",
    severity: "high",
    test: rx(/\bAuthorization\s*:\s*(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi),
  },
  {
    type: "credit-card",
    label: "credit card number",
    severity: "high",
    test: hasCreditCard,
  },
  {
    type: "password",
    label: "password assignment",
    severity: "high",
    // Historical loose behavior (any 6+ chars) kept, plus the placeholder guard.
    test: rx(/\b(?:password|passwd|pwd)\s*[:=]\s*\S{6,}/gi),
  },

  // ── medium ───────────────────────────────────────────────────────────────
  {
    type: "stripe-publishable-key",
    label: "Stripe publishable key",
    severity: "medium",
    test: rx(/\bpk_live_[A-Za-z0-9]{16,}\b/g),
  },
  {
    type: "google-oauth-client",
    label: "Google OAuth client ID",
    severity: "medium",
    test: rx(/\b\d+-[a-z0-9_]{16,}\.apps\.googleusercontent\.com\b/gi),
  },
  {
    type: "generic-credential",
    label: "credential assignment",
    severity: "medium",
    test: hasGenericCredential,
  },
  {
    type: "high-entropy-string",
    label: "high-entropy secret",
    severity: "medium",
    test: hasHighEntropyBlob,
  },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const SEVERITY_RANK: Record<SecretSeverity, number> = { critical: 0, high: 1, medium: 2 };

/**
 * All distinct secret types found in the draft, ordered by severity
 * (then catalog order — stable sort), capped at MAX_HITS.
 */
export function detectSecrets(draft: string): SecretHit[] {
  if (!draft) return [];
  const hits: SecretHit[] = [];
  for (const p of PATTERNS) {
    if (p.test(draft)) {
      hits.push({ type: p.type, label: p.label, severity: p.severity });
      if (hits.length >= MAX_HITS) break; // catalog is severity-ordered
    }
  }
  hits.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  return hits;
}

/** Highest-severity secret in the draft, or null (original status-bar contract). */
export function detectSecret(draft: string): SecretHit | null {
  return detectSecrets(draft)[0] ?? null;
}
