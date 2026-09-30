// Minimal Engaging Networks Services (ENS) REST API client used by the MCP tools.
// Docs: https://developer.engagingnetworks.net/api/rest/  Spec: https://developer.engagingnetworks.net/api/rest/engagingnetworks.app.json
// (OpenAPI 3.1.0, "Engaging Networks Services REST API" v6.5.0)
import { redactContacts } from "./format.js";

export class EngagingNetworksError extends Error {
  constructor(message: string, public readonly status?: number, public readonly messageId?: number) {
    super(message);
    this.name = "EngagingNetworksError";
  }
}

// The spec's `servers`: the account's datacentre decides the base URL.
export const REGIONS: Record<string, string> = {
  ca: "https://ca.engagingnetworks.app/ens/service", // "Canada / Europe"
  us: "https://us.engagingnetworks.app/ens/service", // "United States"
  us2: "https://us2.engagingnetworks.app/ens/service", // "United States 2"
};

// A 429 means the request was not processed, so it is safe to repeat for any method (the spec documents
// no 429 at all; see README). A 502/503/504 from a gateway does not prove the upstream did not process
// the request, so those are only retried for GET and for POST /authenticate (asking for a session token
// changes nothing on the account). A PUT /supporter/{id} is never repeated after a gateway error.
const RETRY_ANY_METHOD = new Set([429]);
const RETRY_GET_ONLY = new Set([502, 503, 504]);
const MAX_ATTEMPTS = 3;
const AUTH_PATH = "/authenticate";
// Longest single wait honoured from Retry-After. The MCP SDK's default request timeout is 60 s
// (DEFAULT_REQUEST_TIMEOUT_MSEC), so the whole retry budget (at most two waits) must stay well under
// that; a longer Retry-After makes the call give up at once with the wait time in the message.
export const MAX_RETRY_AFTER_S = 10;
// GET /supporter/query: `rows` has maximum 100 (default 20).
export const QUERY_PAGE_SIZE = 100;
// Refresh the cached session token this long before the documented `expires` (milliseconds; 3600000 in
// the spec's example), or after half its lifetime when it lives less than two minutes.
const TOKEN_REFRESH_MARGIN_MS = 60_000;
// The spec documents running out of the per-user allowance as a 401 with this message
// ("The user with username [...] has exceeded its api limit."), not as a 429.
const USAGE_LIMIT = /exceeded its api limit/i;
// Shorter values are not scrubbed from passed-on text: they would hit ordinary words.
const MIN_SCRUB_LENGTH = 8;

export type QueryValue = string | number | boolean | undefined;

export class EngagingNetworksClient {
  private readonly baseUrl: string;
  // The spec: 5,000 requests per hour per API User ("Beyond these limits, requests will be blocked").
  // Requests are spaced 200 ms apart; the hourly allowance is not counted here (other integrations
  // using the same API user share it), and running out of it is reported with the API's message.
  private nextSlot = 0;
  private readonly minIntervalMs = 200;
  private session?: { token: string; renewAt: number };
  private sessionRequest?: Promise<string>;

  constructor(private readonly apiToken: string, baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  get base(): string {
    return this.baseUrl;
  }

  /**
   * Text passed on to the user (Engaging Networks' error messages, body excerpts) has the API user
   * token and the current session token replaced with "[redacted]": the spec's own 401 example for
   * POST /authenticate echoes the token it was given ("Invalid api key [...]").
   */
  private scrub(text: string | undefined): string | undefined {
    if (text === undefined) return undefined;
    let out = text;
    for (const secret of [this.apiToken, this.session?.token]) {
      if (secret && secret.length >= MIN_SCRUB_LENGTH) out = out.split(secret).join("[redacted]");
    }
    return out;
  }

  private detail(json: any, text?: string): string | undefined {
    return redactContacts(this.scrub(describeError(json) ?? (json === undefined ? text : undefined)), false)?.slice(0, 300);
  }

  private async throttle(): Promise<void> {
    const now = Date.now();
    const wait = Math.max(0, this.nextSlot - now);
    this.nextSlot = Math.max(now, this.nextSlot) + this.minIntervalMs;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }

  /** One HTTP exchange with throttling and the 429 / gateway retry policy; no session handling. */
  private async send(method: string, path: string, init: { headers: Record<string, string>; body?: string; query?: Record<string, QueryValue> }): Promise<{ status: number; headers: Headers; text: string; json: any }> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(init.query ?? {})) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    const gatewayRetry = method === "GET" || (method === "POST" && path === AUTH_PATH);
    for (let attempt = 0; ; attempt++) {
      await this.throttle();
      let res: Response;
      try {
        res = await fetch(url, { method, headers: init.headers, body: init.body });
      } catch (err) {
        throw new EngagingNetworksError(`Could not reach Engaging Networks at ${this.baseUrl}: ${(err as Error).message}. Check ENGAGINGNETWORKS_REGION (or ENGAGINGNETWORKS_BASE_URL) and the network.`);
      }
      const retryable = RETRY_ANY_METHOD.has(res.status) || (gatewayRetry && RETRY_GET_ONLY.has(res.status));
      if (retryable && attempt < MAX_ATTEMPTS - 1) {
        const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
        if (retryAfter !== undefined && retryAfter > MAX_RETRY_AFTER_S) {
          throw new EngagingNetworksError(`Engaging Networks asked to wait ${Math.ceil(retryAfter)} seconds before retrying ${method} ${path} (HTTP ${res.status}). Try again after that.`, res.status);
        }
        // A missing or unparsable header falls back to 2 s then 4 s; a Retry-After of 0 (or a date
        // already passed) means retry now, subject to the throttle.
        const delay = retryAfter !== undefined ? retryAfter * 1000 : 2000 * (attempt + 1);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      const text = res.status === 204 ? "" : await res.text();
      return { status: res.status, headers: res.headers, text, json: text ? safeJson(text) : undefined };
    }
  }

  /**
   * The cached session token, or a new one. `rejected` is a token the API has just answered 401 for:
   * a new session is requested only if that is still the cached one, so several calls that fail with
   * the same expired token (or one that another call has already replaced) share a single
   * POST /authenticate.
   */
  private async getSession(rejected?: string): Promise<string> {
    const stale = rejected !== undefined && this.session?.token === rejected;
    if (!stale && this.session && Date.now() < this.session.renewAt) return this.session.token;
    if (!this.sessionRequest) {
      this.sessionRequest = this.authenticate().finally(() => {
        this.sessionRequest = undefined;
      });
    }
    return this.sessionRequest;
  }

  /**
   * POST /authenticate (operation `authenticate`): the API User token goes in the request body with
   * Content-Type application/json, and the answer is { "ens-auth-token", "expires" (milliseconds) }.
   * The spec types the body as a JSON `string`; the knowledge base says to put "the token in the
   * body". This client sends the token as the raw body, without JSON quotes (see README, Status).
   * The session token is cached and renewed before it expires, and fetched afresh once when a call
   * answers 401 "Invalid ens-auth-token".
   */
  private async authenticate(): Promise<string> {
    const { status, json, text } = await this.send("POST", AUTH_PATH, {
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: this.apiToken,
    });
    const record = json && typeof json === "object" && !Array.isArray(json) ? json : undefined;
    const token = record?.["ens-auth-token"];
    if (status === 200 && typeof token === "string" && token) {
      const expires = Number(record.expires);
      const ttl = Number.isFinite(expires) && expires > 0 ? expires : 3_600_000;
      const margin = Math.min(TOKEN_REFRESH_MARGIN_MS, ttl / 2);
      this.session = { token, renewAt: Date.now() + ttl - margin };
      return token;
    }
    // Scrub before clearing the cache, so a message that echoed the previous session token is caught too.
    const detail = this.detail(json, text);
    this.session = undefined;
    const suffix = detail ? " " + detail : "";
    if (status === 401 && USAGE_LIMIT.test(String(record?.message ?? ""))) throw usageLimit(suffix);
    if (status === 401 || status === 403) {
      throw new EngagingNetworksError(
        `Engaging Networks rejected the API user token at ${this.baseUrl}${AUTH_PATH} (${status}). Check ENGAGINGNETWORKS_API_TOKEN: it must be the token of an API User that an account administrator created in the dashboard. The IP address this server connects from must be whitelisted for that API user, and ENGAGINGNETWORKS_REGION (or ENGAGINGNETWORKS_BASE_URL) must name the datacentre the account is on.${suffix}`,
        status,
        messageIdOf(json),
      );
    }
    if (status === 200) {
      // Say what shape came back without echoing any value.
      const shape = record ? `JSON with keys ${Object.keys(record).join(", ") || "(none)"}` : `a body starting with ${JSON.stringify((redactContacts(this.scrub(text), false) ?? "").slice(0, 60))}`;
      throw new EngagingNetworksError(`Engaging Networks answered ${this.baseUrl}${AUTH_PATH} with 200 but no ens-auth-token (${shape}). Check ENGAGINGNETWORKS_REGION and ENGAGINGNETWORKS_BASE_URL.`, status);
    }
    if (status === 429) throw new EngagingNetworksError(`Engaging Networks rate-limited ${AUTH_PATH} (429). Wait a minute and try again.${suffix}`, status);
    if (RETRY_GET_ONLY.has(status)) throw new EngagingNetworksError(`Engaging Networks returned ${status} for POST ${AUTH_PATH} ${MAX_ATTEMPTS} times in a row. The service may be unavailable; try again in a few minutes.`, status);
    throw new EngagingNetworksError(`Engaging Networks returned ${status} for POST ${AUTH_PATH}. Check ENGAGINGNETWORKS_REGION and ENGAGINGNETWORKS_BASE_URL.${suffix}`, status, messageIdOf(json));
  }

  /** A call with the session token in the documented `ens-auth-token` header (securitySchemes.sessionAuthToken). */
  async request<T = any>(method: string, path: string, opts: { query?: Record<string, QueryValue>; body?: unknown } = {}): Promise<T> {
    let rejected: string | undefined;
    for (let auth = 0; ; auth++) {
      const token = await this.getSession(rejected);
      const { status, text, json } = await this.send(method, path, {
        query: opts.query,
        headers: {
          "ens-auth-token": token,
          Accept: "application/json",
          ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
      const suffix = (() => {
        const d = this.detail(json, text);
        return d ? " " + d : "";
      })();
      if (status === 401) {
        // Documented 401 bodies: "Invalid ens-auth-token" and the usage-limit message. Only the first
        // is worth a new session; asking again after the limit would just spend another request.
        if (USAGE_LIMIT.test(String(json?.message ?? ""))) throw usageLimit(suffix);
        if (auth === 0) {
          rejected = token;
          continue;
        }
        throw new EngagingNetworksError(`Engaging Networks rejected the session token (401) for ${method} ${path}, even after authenticating again. Check that the API user is still active and whitelisted for this IP address.${suffix}`, 401, messageIdOf(json));
      }
      if (status === 204) return undefined as T;
      if (status >= 200 && status < 300) {
        // Every documented 2xx body used here is a JSON object or array. A 200 with HTML (a proxy, a
        // captive portal, a login page) must not be mistaken for an empty list or an empty record.
        if (!json || typeof json !== "object") {
          throw new EngagingNetworksError(
            `Engaging Networks returned ${status} for ${method} ${path} but the body was not JSON (starts with: ${JSON.stringify((redactContacts(this.scrub(text), false) ?? "").slice(0, 60))}). Check ENGAGINGNETWORKS_REGION / ENGAGINGNETWORKS_BASE_URL and whether a proxy or login page is in the way.`,
            status,
          );
        }
        return json as T;
      }
      if (status === 403) throw new EngagingNetworksError(`Engaging Networks refused ${method} ${path} (403). The API user may not have permission for this data: an account administrator sets each API user's permissions in the dashboard.${suffix}`, 403, messageIdOf(json));
      if (status === 404) throw new EngagingNetworksError(`Not found: ${path}. Check the ID; it does not exist on this account.${suffix}`, 404, messageIdOf(json));
      if (status === 400) throw new EngagingNetworksError(`Engaging Networks refused ${method} ${path} (400).${suffix}`, 400, messageIdOf(json));
      if (status === 429) throw new EngagingNetworksError(`Engaging Networks rate limit reached (429). The documented limit is 5,000 requests per hour per API user. Wait a minute and try again.${suffix}`, 429);
      if (method !== "GET" && RETRY_GET_ONLY.has(status)) {
        throw new EngagingNetworksError(
          `Engaging Networks returned ${status} for ${method} ${path}. The request was not retried because it may already have been processed: check with find_supporter before repeating it.${suffix}`,
          status,
        );
      }
      if (RETRY_GET_ONLY.has(status)) {
        // A GET that failed MAX_ATTEMPTS times in a row. The gateway body is usually HTML, so only a
        // JSON message is passed on.
        const jsonDetail = redactContacts(this.scrub(describeError(json)), false);
        throw new EngagingNetworksError(`Engaging Networks returned ${status} for ${method} ${path} ${MAX_ATTEMPTS} times in a row. The service may be unavailable; try again in a few minutes.${jsonDetail ? " " + jsonDetail : ""}`, status);
      }
      throw new EngagingNetworksError(`Engaging Networks returned ${status} for ${method} ${path}.${suffix}`, status, messageIdOf(json));
    }
  }

  get<T = any>(path: string, query?: Record<string, QueryValue>) {
    return this.request<T>("GET", path, { query });
  }

  /**
   * GET /supporter/query, paged with `start` and `rows` (maximum 100). The response carries
   * pagination { start, rows, total } and the rows in `data`. `start` is taken as the 0-based index of
   * the first row (the parameter's example is 0; see README, Status). Stops at `maxItems`, at
   * `maxPages`, at an empty page, or when start + returned reaches `total`; when no total is present a
   * short page is taken as the end. If a page holds more rows than were asked for and the result is cut
   * to `maxItems`, `next_start` points at the first row that was cut, not past it.
   */
  async querySupporters<T = any>(
    query: Record<string, QueryValue>,
    { maxItems = QUERY_PAGE_SIZE, maxPages = 10, start = 0 }: { maxItems?: number; maxPages?: number; start?: number } = {},
  ): Promise<{ items: T[]; total?: number; complete: boolean; next_start?: number }> {
    const items: T[] = [];
    let total: number | undefined;
    let cursor = start;
    for (let page = 0; page < maxPages; page++) {
      const rows = Math.max(1, Math.min(QUERY_PAGE_SIZE, maxItems - items.length));
      const res = await this.get<any>("/supporter/query", { ...query, start: cursor, rows });
      const data: T[] = Array.isArray(res?.data) ? res.data : [];
      const t = Number(res?.pagination?.total);
      if (res?.pagination?.total !== undefined && Number.isFinite(t)) total = t;
      items.push(...data);
      cursor += data.length;
      const exhausted = data.length === 0 || (total !== undefined ? cursor >= total : data.length < rows);
      if (items.length >= maxItems) {
        const dropped = items.length - maxItems;
        const complete = exhausted && dropped === 0;
        return { items: items.slice(0, maxItems), total, complete, next_start: complete ? undefined : cursor - dropped };
      }
      if (exhausted) return { items, total, complete: true };
    }
    return { items, total, complete: false, next_start: cursor };
  }
}

function usageLimit(suffix: string) {
  return new EngagingNetworksError(`Engaging Networks reports that the API user has used up its request allowance (documented: 5,000 requests per hour per API user; beyond that requests are blocked). Try again later.${suffix}`, 429);
}

/**
 * Retry-After in seconds, from either form allowed by RFC 9110 (delay-seconds or an HTTP-date).
 * A fractional number is accepted as seconds too. Anything else that is not an HTTP-date (which always
 * names a month, so contains letters) gives undefined, so the caller's fallback applies; without that
 * check Date.parse("1.5") would be read as a date in 2001 and the retry would happen at once.
 */
export function parseRetryAfter(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const h = header.trim();
  if (/^\d+(\.\d+)?$/.test(h)) return Number(h);
  if (!/[A-Za-z]/.test(h)) return undefined;
  const at = Date.parse(h);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, (at - now) / 1000);
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function messageIdOf(json: any): number | undefined {
  const id = json && typeof json === "object" ? Number(json.messageId) : NaN;
  return Number.isFinite(id) ? id : undefined;
}

// Documented error bodies: { message } (401) and { message, messageId } (400, and the 401 of POST /authenticate).
function describeError(json: any): string | undefined {
  if (!json || typeof json !== "object" || typeof json.message !== "string" || !json.message.trim()) return undefined;
  const id = messageIdOf(json);
  return id !== undefined ? `${json.message.trim()} (messageId ${id})` : json.message.trim();
}
