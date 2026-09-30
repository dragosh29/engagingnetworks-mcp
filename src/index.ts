#!/usr/bin/env node
// Engaging Networks MCP server: lets Claude, ChatGPT and other MCP clients work with an Engaging Networks (ENS) account.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { EngagingNetworksClient, EngagingNetworksError, REGIONS } from "./client.js";
import * as fmt from "./format.js";

const apiToken = process.env.ENGAGINGNETWORKS_API_TOKEN?.trim();
if (!apiToken) {
  console.error("ENGAGINGNETWORKS_API_TOKEN is not set. Use the token of an API User created by an administrator of your Engaging Networks account.");
  process.exit(1);
}
const region = (process.env.ENGAGINGNETWORKS_REGION?.trim() || "ca").toLowerCase();
if (!REGIONS[region]) {
  console.error(`ENGAGINGNETWORKS_REGION must be one of ${Object.keys(REGIONS).join(", ")} (the datacentre your account is on).`);
  process.exit(1);
}
const allowWrites = /^(1|true|yes)$/i.test(process.env.ENGAGINGNETWORKS_ALLOW_WRITES ?? "");
const api = new EngagingNetworksClient(apiToken, process.env.ENGAGINGNETWORKS_BASE_URL?.trim() || REGIONS[region]);

const server = new McpServer(
  { name: "engagingnetworks", version: "0.1.0" },
  {
    instructions: [
      "Tools for an Engaging Networks (ENS) account: campaign pages, supporters, their transaction history and recurring schedules, supporter fields and questions, and marketing automations.",
      "Pages, supporters, questions and automations are identified by numeric IDs.",
      "Page types for list_pages: nd (donation), premium, ecommerce, dcf (data capture), pet (petition), ems, survey, unsub, mem (membership), sp (static), ss (split test), sh (supporter hub), cc (click to call), tp (post to target), ev (event), ec (e-card), et (email to target), leadgen.",
      "Supporter records return names, the suppression flag, opt-in answers and memberships on request; the email address, phone number, postal address, date of birth and every other supporter field only with include_contact_details. Card and bank data are never returned.",
      "In free text (names, question answers, page names and titles, change reasons, error messages) email addresses, phone numbers (international, UK and North American formats) and UK, Canadian and US postcodes are redacted unless include_contact_details is set. This is pattern matching: street addresses and dates typed into free text are not recognised.",
      "Typical flow for 'what has this supporter given?': find_supporter by email, then get_supporter_transactions with the supporter_id.",
    ].join("\n"),
  },
);

const READ = { readOnlyHint: true, openWorldHint: true } as const;

// Every ID in the spec is an integer path parameter.
const id = (what: string) => z.number().int().positive().max(Number.MAX_SAFE_INTEGER).describe(`${what} (numeric)`);
const contactSwitch = (what: string) => z.boolean().default(false).describe(what);

// The `type` values documented for GET /page (components.parameters.pageType).
const PAGE_TYPES = ["nd", "premium", "ecommerce", "dcf", "pet", "ems", "survey", "unsub", "mem", "sp", "ss", "sh", "cc", "tp", "ev", "ec", "et", "leadgen"] as const;
const PAGE_STATUSES = ["new", "live", "close", "tested", "block", "delete"] as const;

type Json = Record<string, unknown> | unknown[];
const ok = (data: Json) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (err: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: err instanceof EngagingNetworksError ? err.message : `Unexpected error: ${fmt.redactContacts((err as Error)?.message ?? String(err), false)}` }],
});
const safe = <A>(fn: (args: A) => Promise<Json>) => async (args: A) => {
  try {
    return ok(await fn(args));
  } catch (err) {
    return fail(err);
  }
};
// ENS accounts run in a handful of locales; a question never realistically has more than this.
const MAX_LOCALES = 50;
const asArray = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const maxResults = (what: string) => z.number().int().min(1).max(1000).default(100).describe(`Maximum number of ${what} to return`);
/** Cap a list the API returns whole: the first `max` entries with count, total and whether that is all. */
const capped = <T>(all: T[], max: number) => ({ count: Math.min(all.length, max), total: all.length, complete: all.length <= max, items: all.slice(0, max) });

// GET /supporter/fields maps the account's field names to standard properties; supporter records use
// the field names as keys. Fetched once per session.
let fieldsCache: fmt.FieldDef[] | undefined;
const supporterFields = async (): Promise<fmt.FieldDef[]> => {
  if (!fieldsCache) fieldsCache = asArray(await api.get("/supporter/fields")).map(fmt.field);
  return fieldsCache;
};

server.registerTool(
  "list_pages",
  {
    title: "List campaign pages",
    description:
      "List the account's campaign pages of one type (donation, petition, event, data capture and so on), optionally only those with one status, with name, title, subtype, status, locale and dates. Names and titles have contact details redacted.",
    inputSchema: {
      type: z.enum(PAGE_TYPES).describe("Page type: nd = donation, pet = petition, ev = event, dcf = data capture form, survey, et = email to target, mem = membership, ... (see the server instructions)"),
      status: z.enum(PAGE_STATUSES).optional().describe("Only pages with this status"),
      max_results: maxResults("pages").describe("Maximum number of pages to return (the API returns the whole list in one response)"),
    },
    annotations: READ,
  },
  safe(async ({ type, status, max_results }) => {
    const { items, ...counts } = capped(asArray(await api.get("/page", { type, status })), max_results);
    return { ...counts, pages: items.map(fmt.page) };
  }),
);

server.registerTool(
  "get_page",
  {
    title: "Get page details",
    description: "Details of one campaign page: type, subtype, status, locale, base URL, template, tracking parameters and attributes.",
    inputSchema: { page_id: id("Page ID, from list_pages") },
    annotations: READ,
  },
  safe(async ({ page_id }) => ({ page: fmt.page(await api.get(`/page/${page_id}`)) })),
);

server.registerTool(
  "find_supporter",
  {
    title: "Find a supporter",
    description:
      "Look up one supporter by email address or by supporter ID. Returns the supporter ID, whether they are suppressed (excluded from email), their name, and optionally their question and opt-in answers and memberships. The email, phone, postal address, date of birth and every other supporter field are only returned with include_contact_details; card and bank fields are never returned. Emails, phone numbers and postcodes typed into names and answers are redacted by pattern unless include_contact_details is set.",
    inputSchema: {
      email: z.string().email().max(500).optional().describe("The supporter's email address"),
      supporter_id: id("Supporter ID").optional(),
      include_questions: z.boolean().default(false).describe("Include question and opt-in answers (the API's includeQuestions)"),
      include_memberships: z.boolean().default(false).describe("Include memberships (the API's includeMemberships)"),
      include_contact_details: contactSwitch("Include every supporter field (email, phone, address, date of birth, custom fields) and stop redacting contact details from names and free-text answers"),
    },
    annotations: READ,
  },
  safe(async ({ email, supporter_id, include_questions, include_memberships, include_contact_details }) => {
    if ((email === undefined) === (supporter_id === undefined)) throw new EngagingNetworksError("Give either email or supporter_id (exactly one).");
    const query = { includeQuestions: include_questions ? true : undefined, includeMemberships: include_memberships ? true : undefined };
    const fields = await supporterFields();
    let record: any;
    if (email !== undefined) {
      try {
        record = await api.get("/supporter", { email, ...query });
      } catch (err) {
        // The spec does not document the answer for an unknown email address; a 404 is read as "no such supporter".
        if (!(err instanceof EngagingNetworksError && err.status === 404)) throw err;
      }
      if (!record || typeof record !== "object" || Array.isArray(record) || record.supporterId === undefined) {
        return { found: false, note: "No supporter with that email address on this account." };
      }
    } else {
      record = await api.get(`/supporter/${supporter_id}`, query);
      if (!record || typeof record !== "object" || record.supporterId === undefined) throw new EngagingNetworksError(`Not found: /supporter/${supporter_id}. The API returned no supporter record for that ID.`, 404);
    }
    return { found: true, supporter: fmt.supporter(record, fields, include_contact_details) };
  }),
);

server.registerTool(
  "query_supporters",
  {
    title: "Query supporters",
    description:
      "List supporters matching one of the API's queries: latestCreated or latestModified (optionally within days_back, 1-32), suppressed, profile (needs profile_id, a supporter profile built in the dashboard) or search (needs filter, e.g. 'firstName:Bob~country:GB||US': ':' is equals, '||' is OR between values, '~' adds another filter with AND). Returns supporter IDs with created and modified dates; email addresses only with include_contact_details. Pages through the results 100 at a time.",
    inputSchema: {
      type: z.enum(["latestCreated", "latestModified", "suppressed", "profile", "search"]).describe("The query to run"),
      days_back: z.number().int().min(1).max(32).optional().describe("Number of days of data to return (1-32)"),
      profile_id: id("Supporter profile ID (required for type 'profile')").optional(),
      filter: z.string().min(3).max(1000).optional().describe("Filter for type 'search', as fieldName:value with '||' for OR and '~' to add filters"),
      max_results: maxResults("supporters"),
      start: z.number().int().min(0).default(0).describe("Row to start from (to continue a previous call)"),
      include_contact_details: contactSwitch("Include each supporter's email address"),
    },
    annotations: READ,
  },
  safe(async ({ type, days_back, profile_id, filter, max_results, start, include_contact_details }) => {
    // The spec: "A query for a 'profile' requires a 'profileId' to be provided. A 'search' query will require a 'filter' to be provided."
    if (type === "profile" && profile_id === undefined) throw new EngagingNetworksError("A 'profile' query needs profile_id (the ID of a supporter profile from the dashboard).");
    if (type === "search" && !filter) throw new EngagingNetworksError("A 'search' query needs a filter, e.g. firstName:Bob~country:GB||US.");
    const r = await api.querySupporters({ type, daysBack: days_back, profileId: profile_id, filter }, { maxItems: max_results, maxPages: 20, start });
    return {
      count: r.items.length,
      total_matching: r.total,
      start,
      complete: r.complete,
      note: r.complete ? undefined : `More results exist; call again with start ${r.next_start} to continue.`,
      supporters: r.items.map((row) => fmt.queryRow(row, include_contact_details)),
    };
  }),
);

server.registerTool(
  "get_supporter_transactions",
  {
    title: "Supporter transaction history",
    description:
      "A supporter's transaction history: donations, event tickets, petition signatures, emails to targets, data captures and peer-to-peer activity, with page names, dates and statuses, plus their recurring donation schedules (amount, currency, frequency, status, next payment date). The history list carries no amounts; recurring schedules do. max_results caps each of the two lists. Card details and payment-gateway references are never returned.",
    inputSchema: {
      supporter_id: id("Supporter ID, from find_supporter or query_supporters"),
      include_recurring: z.boolean().default(true).describe("Also fetch the supporter's recurring schedules"),
      max_results: maxResults("history entries").describe("Maximum number of history entries to return, and separately of recurring schedules (the API returns each list whole)"),
      include_contact_details: contactSwitch("Include peer-to-peer fundraiser email addresses and stop redacting contact details from names, targets and change reasons"),
    },
    annotations: READ,
  },
  safe(async ({ supporter_id, include_recurring, max_results, include_contact_details }) => {
    const { items: history, ...counts } = capped(asArray(await api.get(`/supporter/${supporter_id}/transactions`)), max_results);
    const schedules = include_recurring ? capped(asArray(await api.get(`/supporter/${supporter_id}/transactions/recurring`)), max_results) : undefined;
    return {
      supporter_id,
      ...counts,
      transactions: history.map((t) => fmt.transaction(t, include_contact_details)),
      recurring_count: schedules?.count,
      recurring_total: schedules?.total,
      recurring_complete: schedules?.complete,
      recurring_schedules: schedules?.items.map((r) => fmt.recurring(r, include_contact_details)),
    };
  }),
);

server.registerTool(
  "list_supporter_fields",
  {
    title: "List supporter fields",
    description: "The supporter fields defined in the account's data structure: each field's name (as used in supporter records), tag and standard property name.",
    inputSchema: {},
    annotations: READ,
  },
  safe(async () => {
    fieldsCache = asArray(await api.get("/supporter/fields")).map(fmt.field);
    return { count: fieldsCache.length, fields: fieldsCache };
  }),
);

server.registerTool(
  "list_supporter_questions",
  {
    title: "List supporter questions",
    description: "The questions and opt-ins defined in the account: id, questionId, name and type (OPT = opt-in, CONF = opt-in needing confirmation, GEN = general question).",
    inputSchema: { max_results: maxResults("questions") },
    annotations: READ,
  },
  safe(async ({ max_results }) => {
    const { items, ...counts } = capped(asArray(await api.get("/supporter/questions")), max_results);
    return { ...counts, questions: items.map(fmt.question) };
  }),
);

server.registerTool(
  "get_supporter_question",
  {
    title: "Get question details",
    description: "How one question is presented, per locale: label, HTML field type, the answer options (value and label) or range settings. Returns at most 50 locales and max_options answer options per locale, with the totals.",
    inputSchema: {
      question_id: id("The question's `id` from list_supporter_questions"),
      max_options: z.number().int().min(1).max(1000).default(100).describe("Maximum number of answer options to return per locale"),
    },
    annotations: READ,
  },
  safe(async ({ question_id, max_options }) => {
    const { items, count, total, complete } = capped(asArray(await api.get(`/supporter/questions/${question_id}`)), MAX_LOCALES);
    return { question_id, locale_count: count, locale_total: total, locales_complete: complete, locales: items.map((l) => fmt.questionDetail(l, max_options)) };
  }),
);

server.registerTool(
  "list_marketing_automations",
  {
    title: "List marketing automations",
    description: "Marketing automations (email journeys) in the account with status (ACTIVE, INACTIVE, PAUSED), folder and dates. Filter by dashboard folder and/or part of the name. Without folder_id the API lists the Home folder (0) only.",
    inputSchema: {
      folder_id: z.number().int().min(0).optional().describe("Dashboard folder to list; the API defaults to the Home folder, 0"),
      name: z.string().min(1).max(200).optional().describe("Only automations whose reference name contains this text"),
      max_results: maxResults("automations"),
    },
    annotations: READ,
  },
  safe(async ({ folder_id, name, max_results }) => {
    const { items, ...counts } = capped(asArray(await api.get("/ma", { folderId: folder_id, name })), max_results);
    return { ...counts, automations: items.map(fmt.automation) };
  }),
);

server.registerTool(
  "get_marketing_automation",
  {
    title: "Marketing automation and its stats",
    description:
      "One marketing automation with its statistics: journey starts, average open and click rates, actions and donations completed from it, objective reached, unsubscribes, SMS delivery rate and jumps. Optionally limit the stats to a range of months.",
    inputSchema: {
      automation_id: id("Automation ID, from list_marketing_automations"),
      include_stats: z.boolean().default(true),
      start_month: z.string().regex(/^\d{4}(0[1-9]|1[0-2])$/, "Months are YYYYMM, e.g. 202601").optional().describe("First month to include in the stats, YYYYMM"),
      end_month: z.string().regex(/^\d{4}(0[1-9]|1[0-2])$/, "Months are YYYYMM, e.g. 202603").optional().describe("Last month to include in the stats, YYYYMM"),
    },
    annotations: READ,
  },
  safe(async ({ automation_id, include_stats, start_month, end_month }) => {
    if (start_month && end_month && start_month > end_month) throw new EngagingNetworksError(`start_month ${start_month} is after end_month ${end_month}.`);
    const a = fmt.automation(await api.get(`/ma/${automation_id}`));
    const stats = include_stats ? fmt.automationStats(await api.get(`/ma/${automation_id}/stats`, { startMonth: start_month, endMonth: end_month })) : undefined;
    return { automation: a, stats, stats_period: include_stats ? { start_month, end_month } : undefined };
  }),
);

if (allowWrites) {
  server.registerTool(
    "update_supporter_opt_ins",
    {
      title: "Update a supporter's opt-ins",
      description:
        "Set one or more of a supporter's opt-in answers to Y (opted in) or N (opted out), by the opt-in's name as listed by list_supporter_questions. Only opt-in questions are accepted: general questions are refused, and so is setting a confirmation (double opt-in, CONF) question to Y, because that needs the supporter's own confirmation. No other supporter field is changed. If Engaging Networks answers with a gateway error (502/503/504) the update is NOT retried: check with find_supporter before calling again. Only available when ENGAGINGNETWORKS_ALLOW_WRITES=true.",
      inputSchema: {
        supporter_id: id("Supporter ID"),
        opt_ins: z
          .array(z.object({ name: z.string().min(1).max(100).describe("Opt-in name, exactly as in list_supporter_questions"), value: z.enum(["Y", "N"]) }))
          .min(1)
          .max(50),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safe(async ({ supporter_id, opt_ins }) => {
      const questions = asArray(await api.get("/supporter/questions")).map(fmt.question);
      const problems: string[] = [];
      const seen = new Set<string>();
      for (const o of opt_ins) {
        if (seen.has(o.name)) problems.push(`"${o.name}" was given twice.`);
        seen.add(o.name);
        const q = questions.find((x) => x.name === o.name);
        if (!q) {
          const optIns = questions.filter((x) => x.type === "OPT" || x.type === "CONF").map((x) => `"${x.name}"`);
          const listed = optIns.length > 30 ? `${optIns.slice(0, 30).join(", ")} and ${optIns.length - 30} more (see list_supporter_questions)` : optIns.join(", ") || "none";
          problems.push(`"${o.name}" is not a question on this account. Opt-ins are: ${listed}.`);
        }
        else if (q.type === "GEN") problems.push(`"${o.name}" is a general question, not an opt-in.`);
        else if (q.type === "CONF" && o.value === "Y") problems.push(`"${o.name}" is a confirmation (double opt-in) question; opting a supporter in to it needs their own confirmation, so this tool does not set it to Y.`);
        else if (q.type !== "OPT" && q.type !== "CONF") problems.push(`"${o.name}" has type ${q.type ?? "unknown"}, not an opt-in.`);
      }
      if (problems.length) throw new EngagingNetworksError(`Not updated. ${problems.join(" ")}`);
      // Body shape: PUT /supporter/{supporterId}, example "Update the supporters contact preferences".
      const body = { questions: Object.fromEntries(opt_ins.map((o) => [o.name, o.value])) };
      const res = await api.request("PUT", `/supporter/${supporter_id}`, { body });
      return { result: "updated", supporter_id: res?.id ?? supporter_id, opt_ins: body.questions };
    }),
  );
}

await server.connect(new StdioServerTransport());
console.error(`Engaging Networks MCP server running (writes ${allowWrites ? "enabled" : "disabled"}).`);
