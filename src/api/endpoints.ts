/**
 * Every claude.ai API path + query string lives here — the "unofficial API"
 * blast-radius file. When claude.ai changes an endpoint,
 * the fix is this one file. Nothing else in the codebase builds an API URL.
 *
 * `API_VERSION` is a human marker for when these were last verified, not a
 * server contract.
 */

export const API_VERSION = "2026-07-21";

/** All requests are same-origin (the content script runs on https://claude.ai). */
export const ORIGIN = "https://claude.ai";

export const Endpoints = {
  organizations: () => `/api/organizations`,

  account: () => `/api/account`,

  conversations: (
    orgId: string,
    opts: { starred?: boolean; limit?: number; offset?: number } = {},
  ) => {
    const q = new URLSearchParams();
    if (opts.starred) q.set("starred", "true");
    if (opts.limit != null) q.set("limit", String(opts.limit));
    if (opts.offset != null) q.set("offset", String(opts.offset));
    const qs = q.toString();
    return `/api/organizations/${orgId}/chat_conversations${qs ? `?${qs}` : ""}`;
  },

  /**
   * Full message list, immune to DOM virtualization. Verified: DOM held 2–4
   * messages, this returned all 58. `tree=True` returns the current branch path.
   */
  conversation: (orgId: string, convId: string) =>
    `/api/organizations/${orgId}/chat_conversations/${convId}` +
    `?tree=True&rendering_mode=messages&render_all_tools=false`,

  usage: (orgId: string) => `/api/organizations/${orgId}/usage`,

  rateLimits: (orgId: string) => `/api/organizations/${orgId}/rate_limits`,

  projects: (orgId: string) => `/api/organizations/${orgId}/projects`,
} as const;

export type EndpointName = keyof typeof Endpoints;

/**
 * The parameter names each endpoint's URL builder interpolates — the
 * allowlist for `{placeholder}` names in endpoint override path templates
 * (core/overrides.ts). Optional
 * query options (`conversations`' starred/limit/offset) are NOT placeholders:
 * an override template pins its own static query string instead.
 */
export const ENDPOINT_PARAMS = {
  organizations: [],
  account: [],
  conversations: ["orgId"],
  conversation: ["orgId", "convId"],
  usage: ["orgId"],
  rateLimits: ["orgId"],
  projects: ["orgId"],
} as const satisfies { readonly [K in EndpointName]: readonly string[] };
