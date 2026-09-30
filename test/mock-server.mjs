// Local stand-in for https://<region>.engagingnetworks.app/ens/service: POST /authenticate (plus the
// documented GET/DELETE /authenticate/{ens-auth-token}) and the endpoints this server uses, serving the
// fixtures with the documented session-token header, the documented `type`/`status`, query and
// automation filters, and supporter-query pagination with start/rows.
import http from "node:http";
import * as fx from "./fixtures.mjs";

// Obviously fake, low-entropy values. Never the example token printed in the spec: secret scanners flag
// such values in a public repository.
export const API_TOKEN = "en-test-api-user-token-not-real";
export const BASE_PATH = "/ens/service";

// Documented error bodies: 401 { message } ("Invalid ens-auth-token", or the usage-limit message), the
// POST /authenticate 401 { message, messageId } ("Invalid api key [<token>]", messageId 10000000) and
// the POST /supporter 400 { message, messageId } (10000005). The spec documents no 404 and no 429 for
// any endpoint: the 404 body below reuses the { message } shape and its text is this mock's own.
const notFound = (what) => ({ message: `No ${what} was found with that identifier.` });
export const USAGE_LIMIT_BODY = { message: "The user with username [apiuser@example.com] has exceeded its api limit." };

export function startMock() {
  const requests = [];
  const sessions = new Map(); // token -> expiresAt
  const everIssued = new Set();
  let issued = 0;
  let expiresMs = 3_600_000; // the spec's example `expires`
  // Injected failures: { method, path, status, times, headers, body, text }. Each matching request consumes
  // one "time" and gets that status instead of the normal answer (`body` as JSON, `text` as HTML, neither
  // as a generic HTML gateway page). The suite starts with one 429 on GET /ma so the retry path is
  // exercised by the schema check and the MCP run alike.
  const failure429 = () => ({ method: "GET", path: "/ma", status: 429, times: 1, headers: { "Retry-After": "1" }, body: { message: "Too many requests." } });
  let failures = [failure429()];
  // When set, GET /supporter/query ignores `rows` and returns this many rows per page.
  let queryRowsOverride;
  // Opt-in answers written through PUT /supporter/{id}.
  const written = new Map();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname.startsWith(BASE_PATH) ? url.pathname.slice(BASE_PATH.length) || "/" : `(outside ${BASE_PATH}) ${url.pathname}`;
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const contentType = req.headers["content-type"] ?? "";
    let body;
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }
    requests.push({ method: req.method, path, query: Object.fromEntries(url.searchParams), token: req.headers["ens-auth-token"], authorization: req.headers.authorization, contentType, raw, body, t: Date.now() });

    const send = (status, json, headers = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      return res.end(json === undefined ? "" : JSON.stringify(json));
    };

    const failure = failures.find((f) => f.times > 0 && f.method === req.method && f.path === path);
    if (failure) {
      failure.times--;
      if (failure.body === undefined) {
        res.writeHead(failure.status, { "Content-Type": "text/html", ...(failure.headers ?? {}) });
        return res.end(failure.text ?? `<html><body><h1>${failure.status}</h1></body></html>`);
      }
      return send(failure.status, failure.body, failure.headers ?? {});
    }

    const seg = path.split("/").filter(Boolean);
    const m = req.method;

    // ---- Authentication (no ens-auth-token header on these three) ----
    if (seg[0] === "authenticate") {
      if (m === "POST" && seg.length === 1) {
        // Request body: the API User token (schema type string, application/json). The spec can be read
        // as the raw token or as a JSON-encoded string ("..."); this mock accepts both, so the suite does
        // not pass one reading off as conformance.
        if (!/^application\/json/.test(contentType)) return send(415, { message: "Content-Type must be application/json." });
        const presented = typeof body === "string" ? body.trim() : raw.trim();
        if (presented !== API_TOKEN) return send(401, { message: `Invalid api key [${presented}]`, messageId: 10000000 });
        issued++;
        const token = `en-test-session-${issued}-not-real`;
        sessions.set(token, Date.now() + expiresMs);
        everIssued.add(token);
        return send(200, { expires: expiresMs, "ens-auth-token": token });
      }
      if (seg.length === 2 && m === "GET") {
        const exp = sessions.get(seg[1]);
        return send(200, { valid: exp !== undefined && exp > Date.now(), "ens-auth-token": seg[1] });
      }
      if (seg.length === 2 && m === "DELETE") {
        sessions.delete(seg[1]);
        return send(200, 1);
      }
    }

    // ---- Everything else needs a live session token ----
    const token = req.headers["ens-auth-token"];
    const exp = typeof token === "string" ? sessions.get(token) : undefined;
    if (exp === undefined || exp <= Date.now()) return send(401, { message: "Invalid ens-auth-token" });

    const q = (name) => url.searchParams.get(name);
    const idOf = (s) => (/^\d+$/.test(s ?? "") ? Number(s) : NaN);

    if (seg[0] === "page" && m === "GET") {
      if (seg.length === 1) {
        // The `type` query values map onto page type + subtype (components.parameters.pageType descriptions).
        const type = q("type");
        const status = q("status");
        const bySubtype = { premium: ["nd", "PREMIUM"], ecommerce: ["nd", "ECOMMERCE"], mem: ["nd", "MEMBERSHIP"], dcf: ["dc", "DCF"], pet: ["dc", "PET"], ems: ["dc", "EMS"], survey: ["dc", "SURVEY"], unsub: ["dc", "UNSUB"] };
        if (!type) return send(400, { message: "The parameter [type] is required.", messageId: 10000005 });
        const match = (p) => (bySubtype[type] ? p.type === bySubtype[type][0] && p.subType === bySubtype[type][1] : p.type === type);
        return send(200, fx.pages.filter((p) => match(p) && (!status || p.campaignStatus === status)));
      }
      if (seg.length === 2) {
        const p = fx.pageDetails[idOf(seg[1])];
        return p ? send(200, p) : send(404, notFound("page"));
      }
    }

    if (seg[0] === "supporter") {
      const rows = () => fx.supporterRows.map((s) => {
        const w = written.get(s.supporterId);
        if (!w || !s.questions) return s;
        return { ...s, questions: s.questions.map((x) => (x.name in w ? { ...x, response: w[x.name] } : x)) };
      });
      const withIncludes = (s) => fx.supporterRecord(s, { questions: q("includeQuestions") === "true", memberships: q("includeMemberships") === "true" });

      if (m === "GET" && seg.length === 2 && seg[1] === "fields") return send(200, fx.fields);
      if (m === "GET" && seg[1] === "questions") {
        if (seg.length === 2) return send(200, fx.questions);
        const d = fx.questionDetails[idOf(seg[2])];
        return d ? send(200, d) : send(404, notFound("question"));
      }
      if (m === "GET" && seg.length === 2 && seg[1] === "query") return query(url, send, queryRowsOverride);
      if (m === "GET" && seg.length === 1) {
        const email = q("email");
        const s = rows().find((x) => x["Email Address"]?.toLowerCase() === email?.toLowerCase());
        return s ? send(200, withIncludes(s)) : send(404, notFound("supporter"));
      }
      const sid = idOf(seg[1]);
      const s = rows().find((x) => x.supporterId === sid);
      if (!s) return send(404, notFound("supporter"));
      if (m === "GET" && seg.length === 2) return send(200, withIncludes(s));
      if (m === "PUT" && seg.length === 2) {
        if (!body || typeof body !== "object" || Array.isArray(body)) return send(400, { message: "The request body must be a JSON object.", messageId: 10000005 });
        const unknown = Object.keys(body.questions ?? {}).filter((n) => !fx.questions.some((x) => x.name === n));
        const unknownFields = Object.keys(body).filter((k) => k !== "questions" && !fx.fields.some((f) => f.name === k));
        if (unknown.length || unknownFields.length) return send(400, { message: `The following fields are not present in the account, please review: ${[...unknownFields, ...unknown].join(", ")}`, messageId: 10000005 });
        written.set(sid, { ...(written.get(sid) ?? {}), ...(body.questions ?? {}) });
        return send(200, { id: sid });
      }
      if (m === "GET" && seg[2] === "transactions") {
        if (seg.length === 3) return send(200, fx.transactions[sid] ?? []);
        if (seg.length === 4 && seg[3] === "recurring") return send(200, fx.recurringSchedules[sid] ?? []);
      }
    }

    if (seg[0] === "ma" && m === "GET") {
      if (seg.length === 1) {
        // folderId: "The default value of 0 denotes the 'Home' folder". name: "reference name contains a string".
        const folder = q("folderId") === null ? 0 : Number(q("folderId"));
        const name = q("name")?.toLowerCase();
        return send(200, fx.automations.filter((a) => a.folderId === folder && (!name || a.name.toLowerCase().includes(name))));
      }
      const a = fx.automations.find((x) => x.id === idOf(seg[1]));
      if (!a) return send(404, notFound("automation"));
      if (seg.length === 2) return send(200, a);
      if (seg.length === 3 && seg[2] === "stats") return send(200, fx.automationStats[a.id]);
    }

    return send(404, { message: `No route for ${m} ${path}.` });
  });

  /** GET /supporter/query with the five documented query types and start/rows paging (0-based start). */
  function query(url, send, rowsOverride) {
    const q = (name) => url.searchParams.get(name);
    const type = q("type");
    const daysBack = q("daysBack") === null ? undefined : Number(q("daysBack"));
    const within = (ms) => daysBack === undefined || ms >= fx.TODAY - daysBack * 86_400_000;
    let list;
    if (type === "latestCreated") list = [...fx.supporterRows].filter((s) => within(s.createdOn)).sort((a, b) => b.createdOn - a.createdOn || a.supporterId - b.supporterId);
    else if (type === "latestModified") list = [...fx.supporterRows].filter((s) => within(s.modifiedOn)).sort((a, b) => b.modifiedOn - a.modifiedOn || a.supporterId - b.supporterId);
    else if (type === "suppressed") list = fx.supporterRows.filter((s) => s.suppressed);
    else if (type === "profile") {
      if (!q("profileId")) return send(400, { message: "A profileId is required for a profile query.", messageId: 10000005 });
      list = Number(q("profileId")) === fx.PROFILE ? fx.supporterRows.filter((s) => fx.profileMembers.includes(s.supporterId)) : [];
    } else if (type === "search") {
      const filter = q("filter");
      if (!filter) return send(400, { message: "A filter is required for a search query.", messageId: 10000005 });
      // "fieldName:value", "||" for OR between values, "~" for an additional (AND) filter. Field names are
      // the standard property names (firstName, country) mapped to the record keys through /supporter/fields.
      const clauses = filter.split("~").map((c) => {
        const [fieldName, values = ""] = c.split(":");
        const key = fx.fields.find((f) => f.property === fieldName)?.name ?? fieldName;
        return { key, values: values.split("||").map((v) => v.toLowerCase()) };
      });
      list = fx.supporterRows.filter((s) => clauses.every((c) => c.values.includes(String(s[c.key] ?? "").toLowerCase())));
    } else return send(400, { message: "Unknown query type.", messageId: 10000005 });
    // rows: default 20, maximum 100.
    const rows = rowsOverride ?? Math.min(100, Math.max(1, Number(q("rows") ?? 20) || 20));
    const start = Math.max(0, Number(q("start") ?? 0) || 0);
    const data = list.slice(start, start + rows).map(fx.queryRow);
    return send(200, { pagination: { start, rows, total: list.length }, data, scores: [], summary: {} });
  }

  /** Queue a failure for the next `times` requests matching method+path. */
  const arm = ({ method, path, status, times = 1, headers, body, text }) => {
    failures.push({ method, path, status, times, headers, body, text });
  };
  const arm429 = ({ persistent = false, retryAfter = "1" } = {}) => {
    failures = [{ ...failure429(), times: persistent ? Infinity : 1, headers: { "Retry-After": retryAfter } }];
  };
  const disarm = () => {
    failures = [];
  };
  /** Invalidate every session token issued so far (as if they had expired or been retired). */
  const revokeSessions = () => sessions.clear();
  const setExpires = (ms) => {
    expiresMs = ms;
  };
  const sessionsIssued = () => issued;
  const wasIssued = (t) => everIssued.has(t);
  const writtenOptIns = (sid) => written.get(sid);
  /** Make GET /supporter/query ignore `rows` and return `n` rows per page; undefined restores the normal behaviour. */
  const overrideQueryRows = (n) => {
    queryRowsOverride = n;
  };
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, requests, arm, arm429, disarm, revokeSessions, setExpires, sessionsIssued, wasIssued, writtenOptIns, overrideQueryRows })),
  );
}
