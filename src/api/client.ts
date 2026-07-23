/**
 * The same-origin claude.ai API client.
 *
 * - `fetch` with `credentials:"include"` — the user's own session reads the
 *   user's own data. No API keys. Nothing is sent anywhere else.
 * - Every method returns an {@link ApiResult}; the client never throws for
 *   expected failures (network / HTTP / schema / abort).
 * - Every response passes a runtime guard before being typed.
 * - On an `http` or `schema` failure the client emits `api:degraded` on the bus
 *   so `conversation-store` can flip to the DOM fallback. Features never branch
 *   on API availability themselves.
 *
 * In-flight dedupe and caching live in `conversation-store.ts`, NOT here.
 */

import type { EventBus } from "@/core/event-bus";
import type { OverrideStore } from "@/core/overrides";
import { Endpoints, type EndpointName } from "./endpoints";
import * as guard from "./guards";
import type {
  Account,
  ApiResult,
  Conversation,
  ConversationStub,
  Org,
  Project,
  RateLimits,
  Usage,
} from "./types";

/** Injectable fetch so the client is testable without a browser. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ClaudeApiOptions {
  bus: EventBus;
  fetch?: FetchLike;
  /** Self-healing endpoint override layer (core/overrides.ts). Optional so
   *  the client stays constructible bare in tests; without it (or with no
   *  overrides stored) every URL is the shipped `Endpoints` builder output. */
  overrides?: OverrideStore;
}

export class ClaudeApi {
  #bus: EventBus;
  #fetch: FetchLike;
  #overrides: OverrideStore | undefined;
  #primaryOrgId: string | null = null;

  constructor(opts: ClaudeApiOptions) {
    this.#bus = opts.bus;
    this.#fetch = opts.fetch ?? ((input, init) => fetch(input, init));
    this.#overrides = opts.overrides;
  }

  /** Endpoint name → URL through the one resolvePath door:
   *  override template when present (re-validated at read time), else the
   *  shipped builder. */
  #url(name: EndpointName, params: Record<string, string>, buildDefault: () => string): string {
    return this.#overrides
      ? this.#overrides.resolvePath(name, params, buildDefault)
      : buildDefault();
  }

  /**
   * Core request helper. Resolves the URL (overrides first), runs the guard,
   * maps every outcome to an ApiResult, emits `api:degraded` on http/schema
   * failure, and feeds the endpoint health ledger.
   */
  async #request<T>(
    name: EndpointName,
    params: Record<string, string>,
    buildDefault: () => string,
    check: (v: unknown) => v is T,
    signal?: AbortSignal,
  ): Promise<ApiResult<T>> {
    const endpoint = this.#url(name, params, buildDefault);
    let res: Response;
    try {
      res = await this.#fetch(endpoint, {
        credentials: "include",
        headers: { accept: "application/json" },
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      if (signal?.aborted || (err instanceof DOMException && err.name === "AbortError")) {
        return { ok: false, error: "aborted" };
      }
      return { ok: false, error: "network" };
    }

    if (!res.ok) {
      this.#bus.emit("api:degraded", { endpoint });
      this.#overrides?.noteEndpointFailure(name, { kind: "http", status: res.status });
      return { ok: false, error: "http", status: res.status };
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      this.#bus.emit("api:degraded", { endpoint });
      this.#overrides?.noteEndpointFailure(name, { kind: "schema" });
      return { ok: false, error: "schema" };
    }

    if (!check(json)) {
      this.#bus.emit("api:degraded", { endpoint });
      this.#overrides?.noteEndpointFailure(name, { kind: "schema" });
      return { ok: false, error: "schema" };
    }
    this.#overrides?.noteEndpointSuccess(name, this.#overrides.endpointOverride(name) !== undefined);
    return { ok: true, data: json };
  }

  getOrganizations(signal?: AbortSignal): Promise<ApiResult<Org[]>> {
    return this.#request("organizations", {}, () => Endpoints.organizations(), guard.isOrgArray, signal);
  }

  /** First org with the `chat` capability, else orgs[0]; cached for the page. */
  async getPrimaryOrgId(signal?: AbortSignal): Promise<ApiResult<string>> {
    if (this.#primaryOrgId) return { ok: true, data: this.#primaryOrgId };
    const orgs = await this.getOrganizations(signal);
    if (!orgs.ok) return orgs;
    const primary =
      orgs.data.find((o) => (o.capabilities ?? []).includes("chat")) ?? orgs.data[0];
    if (!primary) return { ok: false, error: "schema" };
    this.#primaryOrgId = primary.uuid;
    return { ok: true, data: primary.uuid };
  }

  async getConversations(
    opts: { starred?: boolean; limit?: number; offset?: number } = {},
    signal?: AbortSignal,
  ): Promise<ApiResult<ConversationStub[]>> {
    const org = await this.getPrimaryOrgId(signal);
    if (!org.ok) return org;
    // Note: an override template for `conversations` pins its own static
    // query string — the dynamic starred/limit/offset opts only apply on the
    // shipped-default path (templates are pure data; ENDPOINT_PARAMS).
    return this.#request(
      "conversations",
      { orgId: org.data },
      () => Endpoints.conversations(org.data, opts),
      guard.isConversationStubArray,
      signal,
    );
  }

  async getConversation(convId: string, signal?: AbortSignal): Promise<ApiResult<Conversation>> {
    const org = await this.getPrimaryOrgId(signal);
    if (!org.ok) return org;
    return this.#request(
      "conversation",
      { orgId: org.data, convId },
      () => Endpoints.conversation(org.data, convId),
      guard.isConversation,
      signal,
    );
  }

  async getUsage(signal?: AbortSignal): Promise<ApiResult<Usage>> {
    const org = await this.getPrimaryOrgId(signal);
    if (!org.ok) return org;
    return this.#request("usage", { orgId: org.data }, () => Endpoints.usage(org.data), guard.isUsage, signal);
  }

  async getRateLimits(signal?: AbortSignal): Promise<ApiResult<RateLimits>> {
    const org = await this.getPrimaryOrgId(signal);
    if (!org.ok) return org;
    return this.#request(
      "rateLimits",
      { orgId: org.data },
      () => Endpoints.rateLimits(org.data),
      guard.isRateLimits,
      signal,
    );
  }

  async getProjects(signal?: AbortSignal): Promise<ApiResult<Project[]>> {
    const org = await this.getPrimaryOrgId(signal);
    if (!org.ok) return org;
    return this.#request(
      "projects",
      { orgId: org.data },
      () => Endpoints.projects(org.data),
      guard.isProjectArray,
      signal,
    );
  }

  getAccount(signal?: AbortSignal): Promise<ApiResult<Account>> {
    return this.#request("account", {}, () => Endpoints.account(), guard.isAccount, signal);
  }
}
