// End-to-end test: fixtures are validated against the schemas in the Engaging Networks Services OpenAPI
// 3.1 document, the mock's responses likewise, then the built MCP server is driven over stdio by a real
// MCP client against a local mock of the API (POST /authenticate included).
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fx from "./fixtures.mjs";
import { startMock, API_TOKEN, BASE_PATH, USAGE_LIMIT_BODY } from "./mock-server.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const started = Date.now();
let passed = 0;
const check = async (name, fn) => {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
};

// 1. Fixtures match the published spec (so the mock returns what the real API documents).
const SPEC_URL = "https://developer.engagingnetworks.net/api/rest/engagingnetworks.app.json";
if (!existsSync(`${root}spec.json`)) {
  try {
    const text = await (await fetch(SPEC_URL, { headers: { Accept: "application/json" } })).text();
    JSON.parse(text); // fail here, not later, if the download was an error page
    writeFileSync(`${root}spec.json`, text);
  } catch (err) {
    console.error(`Could not download the Engaging Networks spec (${err?.cause?.code ?? err.message}). Save it manually:\n  curl -o spec.json ${SPEC_URL}`);
    process.exit(1);
  }
}
const spec = JSON.parse(readFileSync(`${root}spec.json`, "utf8"));
assert.equal(spec.openapi, "3.1.0", "the ENS document is OpenAPI 3.1");
// Three settings the document needs, each for a defect in it:
// - unicodeRegExp: false, because the locale pattern ^[a-z]{2,3}\-[A-Z]{2}$ escapes "-", which is a syntax
//   error in a Unicode regular expression;
// - validateSchema: false, because some schemas carry `examples` as an object instead of an array
//   (transaction `status`, `transactionStatus`), which the JSON Schema meta-schema rejects;
// - strict: false, for the OpenAPI keywords (nullable, discriminator, example, summary) that are not JSON Schema.
const ajv = new Ajv2020({ strict: false, allErrors: true, unicodeRegExp: false, validateSchema: false, logger: false });
addFormats(ajv);
ajv.addSchema({ $id: "en", components: spec.components });
const inline = (schema) => JSON.parse(JSON.stringify(schema).replaceAll('"#/components/', '"en#/components/'));
const compiled = new Map();
const validator = (schema) => {
  const key = JSON.stringify(schema);
  if (!compiled.has(key)) compiled.set(key, ajv.compile(inline(schema)));
  return compiled.get(key);
};
const validateWith = (schema, obj, label) => {
  const v = validator(schema);
  assert.ok(v(obj), `${label}: ${ajv.errorsText(v.errors)}`);
};
const op = (path, method) => spec.paths[path][method];
const responseSchema = (path, method, status = "200") => {
  let r = op(path, method).responses[status];
  if (r.$ref) r = r.$ref.split("/").slice(1).reduce((a, k) => a[k], spec);
  return r.content["application/json"].schema;
};
const requestSchema = (path, method) => op(path, method).requestBody.content["application/json"].schema;
const items = (schema) => schema.items;
// The supporter record schemas give questions[].response the pattern ^([^NnYyPpDd]{1})(\w|\s){1,2000}$,
// which rejects the opt-in answers "Y" and "N" and any answer with punctuation: the spec's own
// getSupporterByEmail example ("Y") and the pattern's own example value ("Sent the email as requested.")
// both fail it. The fixtures are validated against a copy with that one pattern removed.
const withoutResponsePattern = (schema) => {
  const copy = JSON.parse(JSON.stringify(schema));
  assert.equal(typeof copy.properties.questions.items.properties.response.pattern, "string");
  delete copy.properties.questions.items.properties.response.pattern;
  return copy;
};
const supporterBy = { email: responseSchema("/supporter", "get"), id: responseSchema("/supporter/{supporterId}", "get") };
const keys = (obj, ...names) => names.forEach((k) => assert.ok(k in obj, `record is missing "${k}"`));

console.log("fixtures vs OpenAPI schemas");
await check("pages, fields, questions, supporters, query rows, transactions, recurring schedules, automations and stats", async () => {
  const pageItem = items(responseSchema("/page", "get"));
  fx.pages.forEach((p) => validateWith(pageItem, p, `page ${p.id}`));
  Object.values(fx.pageDetails).forEach((p) => validateWith(responseSchema("/page/{id}", "get"), p, `page detail ${p.id}`));
  fx.fields.forEach((f) => validateWith(items(responseSchema("/supporter/fields", "get")), f, `field ${f.name}`));
  fx.questions.forEach((q) => validateWith(items(responseSchema("/supporter/questions", "get")), q, `question ${q.id}`));
  Object.values(fx.questionDetails).forEach((d) => validateWith(responseSchema("/supporter/questions/{id}", "get"), d, `question detail ${d[0].id}`));
  for (const s of fx.supporterRows) {
    const rec = fx.supporterRecord(s, { questions: true, memberships: true });
    validateWith(withoutResponsePattern(supporterBy.email), rec, `supporter ${s.supporterId} (by email)`);
    validateWith(withoutResponsePattern(supporterBy.id), rec, `supporter ${s.supporterId} (by id)`);
    validateWith(items(responseSchema("/supporter/query", "get").properties.data), fx.queryRow(s), `query row ${s.supporterId}`);
  }
  // The documented defect, shown on the spec's own example rather than assumed.
  const strict = validator(supporterBy.email);
  const specExample = spec.paths["/supporter"].get.responses["200"].content["application/json"].example;
  assert.equal(strict(specExample), false, "the spec's own getSupporterByEmail example fails the response pattern");
  assert.ok(strict.errors.every((e) => e.instancePath.endsWith("/response") && e.keyword === "pattern"), "and fails only on that pattern");
  assert.equal(validator(supporterBy.id)({ supporterId: 1, questions: [{ response: "Sent the email as requested." }] }), false, "the pattern also rejects its own example value");
  const txItem = items(responseSchema("/supporter/{supporterId}/transactions", "get"));
  // Peer-to-peer payments (ppay, pacs, pacr) are mapped by the spec's discriminator to
  // transactionP2Pdonation, but every transaction schema's own `type` enum leaves those values out, so
  // the list schema rejects them. They are validated against that schema's properties instead. Two of
  // those properties cannot be satisfied as written: campaignId is a oneOf of four integer/number
  // schemas and status a oneOf of two string schemas that both allow "success", so any ordinary value
  // matches more than one branch. The fixture is validated against a copy with those two oneOf read as
  // anyOf. Each defect is asserted, so a corrected spec would be noticed.
  const p2pDonation = spec.components.schemas.transactionP2Pdonation;
  assert.equal(p2pDonation.allOf[0].discriminator.mapping.ppay, "#/components/schemas/transactionP2Pdonation");
  const p2pProps = JSON.parse(JSON.stringify(p2pDonation.allOf[1]));
  for (const k of ["campaignId", "status"]) {
    p2pProps.properties[k].anyOf = p2pProps.properties[k].oneOf;
    delete p2pProps.properties[k].oneOf;
  }
  Object.values(fx.transactions).flat().forEach((t) => {
    keys(t, "type");
    if (["ppay", "pacs", "pacr"].includes(t.type)) {
      validateWith(p2pProps, t, `P2P payment ${t.id}`);
      const strict = validator(p2pDonation.allOf[1]);
      assert.equal(strict(t), false);
      assert.deepEqual(strict.errors.filter((e) => e.keyword === "oneOf").map((e) => e.instancePath).sort(), ["/campaignId", "/status"], "the documented schema fails only on the two ambiguous oneOf");
      assert.equal(validator(txItem)(t), false, "the list schema's type enum does not include ppay");
      return;
    }
    validateWith(txItem, t, `transaction ${t.id ?? t.broadcastId}`);
  });
  // The list schema is an anyOf of loosely typed objects with nothing required, so also check each
  // fixture carries the keys of the spec's example for its type.
  for (const t of fx.transactions[fx.OTTO]) {
    if (t.type === "nd" || t.type === "ev") keys(t, "createdDate", "campaignId", "exportType", "name", "id", "txType", "recurringPayment", "status");
    if (t.type === "et" || t.type === "dc") keys(t, "campaignId", "name", "id", "xref1", "xref2", "createdOn", "createdDate");
    if (t.type === "p2p") keys(t, "lastName", "role", "campaignId", "primaryParticipant", "siteName", "pageId", "pageName", "firstName", "teamPageName", "exportType", "siteId", "id", "email");
  }
  Object.values(fx.recurringSchedules).flat().forEach((r) => validateWith(items(responseSchema("/supporter/{supporterId}/transactions/recurring", "get")), r, `recurring ${r.id}`));
  fx.automations.forEach((a) => {
    validateWith(items(responseSchema("/ma", "get")), a, `automation ${a.id}`);
    validateWith(responseSchema("/ma/{id}", "get"), a, `automation detail ${a.id}`);
  });
  Object.values(fx.automationStats).forEach((s) => validateWith(responseSchema("/ma/{id}/stats", "get"), s, "automation stats"));
  // Negative controls, so a schema that accepted anything would be noticed.
  assert.equal(validator(pageItem)({ ...fx.pages[0], type: "zz" }), false, "an undocumented page type is rejected");
  assert.equal(validator(pageItem)({ ...fx.pages[0], subType: "" }), false, "the spec's own example subType \"\" is rejected by its schema, which is why the fixtures omit subType instead");
  assert.equal(validator(items(responseSchema("/supporter/{supporterId}/transactions/recurring", "get")))({ ...fx.recurringSchedules[fx.OTTO][0], frequency: "WEEKLY" }), false, "an undocumented frequency is rejected");
  // The mock's credentials are obviously fake values, never the example token printed in the spec.
  const text = JSON.stringify(spec);
  assert.match(API_TOKEN, /^en-test-[a-z-]+-not-real$/);
  assert.ok(!text.includes(API_TOKEN), "the API token must not be a value printed in the spec");
});

// 2. The mock's responses (authentication, lists, records, errors) match the documented schemas.
const { server: mock, port, requests, arm, arm429, disarm, revokeSessions, setExpires, sessionsIssued, wasIssued, writtenOptIns, overrideQueryRows } = await startMock();
const base = `http://127.0.0.1:${port}${BASE_PATH}`;
const rawAuth = async (token) => {
  const res = await fetch(`${base}/authenticate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: token });
  return { status: res.status, json: await res.json() };
};
await check("mock: authentication, lists, records, the opt-in update and errors match the documented schemas", async () => {
  const bad = await rawAuth("en-test-wrong-token-not-real");
  assert.equal(bad.status, 401);
  validateWith(responseSchema("/authenticate", "post", "401"), bad.json, "POST /authenticate 401");
  assert.equal(bad.json.messageId, op("/authenticate", "post").responses["401"].content["application/json"].example.messageId);
  const good = await rawAuth(API_TOKEN);
  assert.equal(good.status, 200);
  validateWith(responseSchema("/authenticate", "post"), good.json, "POST /authenticate 200");
  const token = good.json["ens-auth-token"];
  assert.match(token, /^en-test-session-\d+-not-real$/);
  // The mock takes the token raw or JSON-quoted: the spec's body schema (a string under application/json)
  // can be read either way, and the suite must not treat one reading as conformance.
  const quoted = await rawAuth(JSON.stringify(API_TOKEN));
  assert.equal(quoted.status, 200, "a JSON-quoted token is accepted too");
  assert.equal((await rawAuth(JSON.stringify(`${API_TOKEN}x`))).status, 401);
  const spare = (await rawAuth(API_TOKEN)).json["ens-auth-token"];
  const raw = async (method, path, init = {}) => {
    const res = await fetch(base + path, { method, ...init, headers: { "ens-auth-token": token, ...(init.body ? { "Content-Type": "application/json" } : {}), ...(init.headers ?? {}) } });
    return { status: res.status, json: await res.json() };
  };
  const valid = await raw("GET", `/authenticate/${spare}`);
  validateWith(responseSchema("/authenticate/{ens-auth-token}", "get"), valid.json, "GET /authenticate/{token}");
  assert.equal(valid.json.valid, true);
  validateWith(responseSchema("/authenticate/{ens-auth-token}", "delete"), (await raw("DELETE", `/authenticate/${spare}`)).json, "DELETE /authenticate/{token}");
  assert.equal((await raw("GET", `/authenticate/${spare}`)).json.valid, false, "a retired token is no longer valid");
  const unauthorised = await fetch(`${base}/page?type=nd`, { headers: { "ens-auth-token": spare } });
  assert.equal(unauthorised.status, 401);
  validateWith(responseSchema("/page", "get", "401"), await unauthorised.json(), "401 Invalid ens-auth-token");

  const cases = [
    ["/page?type=nd", "/page"],
    ["/page?type=pet&status=live", "/page"],
    [`/page/${fx.AUTUMN}`, "/page/{id}"],
    ["/supporter/fields", "/supporter/fields"],
    ["/supporter/questions", "/supporter/questions"],
    [`/supporter/questions/${fx.Q_EMAIL}`, "/supporter/questions/{id}"],
    ["/supporter/query?type=latestCreated&start=0&rows=100", "/supporter/query"],
    [`/supporter/${fx.OTTO}/transactions`, "/supporter/{supporterId}/transactions"],
    [`/supporter/${fx.OTTO}/transactions/recurring`, "/supporter/{supporterId}/transactions/recurring"],
    [`/ma/${fx.MA_DD}`, "/ma/{id}"],
    [`/ma/${fx.MA_DD}/stats?startMonth=202601&endMonth=202609`, "/ma/{id}/stats"],
  ];
  for (const [url, path] of cases) {
    const r = await raw("GET", url);
    assert.equal(r.status, 200, `${url}: ${JSON.stringify(r.json)}`);
    validateWith(responseSchema(path, "get"), r.json, `GET ${url}`);
  }
  assert.deepEqual((await raw("GET", "/page?type=pet&status=live")).json.map((p) => p.id), [fx.PETITION]);
  const limited = await raw("GET", "/ma"); // the mock answers the first automations call with a 429
  assert.equal(limited.status, 429);
  validateWith(responseSchema("/ma", "get"), (await raw("GET", "/ma")).json, "GET /ma");
  const byEmail = await raw("GET", `/supporter?email=${encodeURIComponent(fx.OTTO_EMAIL)}&includeQuestions=true&includeMemberships=true`);
  validateWith(withoutResponsePattern(supporterBy.email), byEmail.json, "GET /supporter?email");
  keys(byEmail.json, "supporterId", "suppressed", "Email Address", "First Name", "questions", "memberships");
  const byId = await raw("GET", `/supporter/${fx.OTTO}`);
  validateWith(supporterBy.id, byId.json, "GET /supporter/{id}");
  assert.equal(byId.json.questions, undefined, "questions only with includeQuestions=true");
  const q = (await raw("GET", "/supporter/query?type=latestCreated&start=200&rows=100")).json;
  keys(q, "pagination", "data", "scores", "summary");
  assert.deepEqual([q.pagination.start, q.pagination.rows, q.pagination.total, q.data.length], [200, 100, 253, 53]);
  // PUT /supporter/{id}: the spec's own "Update the supporters contact preferences" example names opt-ins
  // this account does not have, so the mock answers with the documented 400 shape of POST /supporter.
  const putBody = op("/supporter/{supporterId}", "put").requestBody.content["application/json"].examples["Update the supporters contact preferences"].value;
  validateWith(requestSchema("/supporter/{supporterId}", "put"), putBody, "the spec's PUT example");
  const refused = await raw("PUT", `/supporter/${fx.NO_HISTORY}`, { body: JSON.stringify(putBody) });
  assert.equal(refused.status, 400);
  validateWith(responseSchema("/supporter", "post", "400"), refused.json, "400");
  const put = await raw("PUT", `/supporter/${fx.NO_HISTORY}`, { body: JSON.stringify({ questions: { "Opt-in SMS": "Y" } }) });
  validateWith(responseSchema("/supporter/{supporterId}", "put"), put.json, "PUT /supporter/{id}");
  assert.deepEqual(put.json, { id: fx.NO_HISTORY });
  // The spec documents no 404 anywhere; the mock's 404 reuses the documented { message } error shape.
  const missing = await raw("GET", "/page/999999");
  assert.equal(missing.status, 404);
  validateWith(responseSchema("/page/{id}", "get", "401"), missing.json, "404 body in the { message } shape");
});
requests.length = 0; // only count what the MCP server does from here on
arm429();

// 3. Drive the server through MCP. `writes` is the literal ENGAGINGNETWORKS_ALLOW_WRITES value; null leaves it unset.
const connect = async (token, writes = "true") => {
  const client = new Client({ name: "e2e", version: "1.0.0" });
  const env = { ...process.env, ENGAGINGNETWORKS_API_TOKEN: token, ENGAGINGNETWORKS_BASE_URL: base };
  delete env.ENGAGINGNETWORKS_ALLOW_WRITES;
  delete env.ENGAGINGNETWORKS_REGION;
  if (writes !== null) env.ENGAGINGNETWORKS_ALLOW_WRITES = writes;
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [`${root}dist/index.js`], env, stderr: "ignore" }));
  return client;
};
const call = async (client, name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  return { res, data: res.isError ? undefined : JSON.parse(res.content[0].text), text: res.content[0].text };
};
const since = (n) => requests.slice(n);
const iso = (ms) => new Date(ms).toISOString();

const client = await connect(API_TOKEN);
console.log("mcp tools");

const READ_TOOLS = ["find_supporter", "get_marketing_automation", "get_page", "get_supporter_question", "get_supporter_transactions", "list_marketing_automations", "list_pages", "list_supporter_fields", "list_supporter_questions", "query_supporters"];
await check("tools/list exposes 11 tools; reads are read-only, update_supporter_opt_ins is a non-destructive, idempotent write", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [...READ_TOOLS, "update_supporter_opt_ins"].sort());
  for (const t of tools) {
    const write = t.name === "update_supporter_opt_ins";
    assert.equal(t.annotations?.readOnlyHint, !write, `${t.name} readOnlyHint`);
    if (write) assert.deepEqual([t.annotations.destructiveHint, t.annotations.idempotentHint], [false, true]);
  }
});

await check("the first call POSTs the API user token to /authenticate as a raw body (no JSON quotes) with Content-Type application/json, then sends the session token as ens-auth-token and reuses it", async () => {
  const issuedBefore = sessionsIssued();
  const { data } = await call(client, "list_supporter_fields");
  assert.deepEqual(requests.map((r) => `${r.method} ${r.path}`), ["POST /authenticate", "GET /supporter/fields"]);
  const [auth, fields] = requests;
  assert.match(auth.contentType, /^application\/json/);
  // An assumption, not conformance: the spec types the body as a JSON string, which could also mean a
  // quoted "..." value (README, Status). This pins the reading the client implements.
  assert.equal(auth.raw, API_TOKEN, "the token is the raw body, without JSON quotes");
  assert.throws(() => JSON.parse(auth.raw), SyntaxError, "the raw body is not a JSON-encoded string");
  assert.equal(auth.token, undefined, "no ens-auth-token header on /authenticate");
  assert.ok(wasIssued(fields.token), "the data call carries the issued session token");
  assert.equal(fields.authorization, undefined, "no Authorization header");
  assert.equal(data.count, fx.fields.length);
  assert.deepEqual(data.fields[1], { id: 2913, name: "Email Address", tag: "Email Address", property: "emailAddress" });
  await call(client, "list_supporter_questions");
  assert.equal(requests.filter((r) => r.path === "/authenticate").length, 1, "the session token is reused");
  assert.equal(requests.at(-1).token, fields.token);
  assert.equal(sessionsIssued(), issuedBefore + 1);
});

await check("list_pages passes type and status through exactly; names and titles are redacted; max_results caps the list", async () => {
  const nd = await call(client, "list_pages", { type: "nd" });
  assert.deepEqual(requests.at(-1).query, { type: "nd" });
  assert.deepEqual(nd.data.pages.map((p) => p.id), [fx.AUTUMN, 951, fx.WINTER]);
  assert.deepEqual([nd.data.count, nd.data.total, nd.data.complete], [3, 3, true]);
  const autumn = nd.data.pages[0];
  assert.deepEqual([autumn.name, autumn.title, autumn.type, autumn.sub_type, autumn.status, autumn.default_locale], ["Autumn Rise (live iats)", "Autumn Rise", "nd", undefined, "live", "en-GB"]);
  assert.equal(autumn.created, iso(1465981693000));
  assert.equal(nd.data.pages[1].sub_type, "PREMIUM");
  assert.equal(nd.data.pages[1].title, "Give monthly: text GIVE to [phone redacted], or write to Ottawa ON [postcode redacted] / Washington, DC [postcode redacted]");
  assert.equal(nd.data.pages[2].title, "Winter appeal (queries: [email redacted] or [phone redacted])");
  assert.equal(nd.data.pages[2].name, "Winter appeal draft (call [phone redacted] or [email redacted])", "page names are redacted too");
  for (const leak of ["donations@example.org", "winter@example.org", "0117 496", "555-0100", "555-0199", "K1A", "20500"]) assert.ok(!nd.text.includes(leak), `${leak} leaked from a page name or title`);
  const pet = await call(client, "list_pages", { type: "pet", status: "live" });
  assert.deepEqual(requests.at(-1).query, { type: "pet", status: "live" });
  assert.deepEqual(pet.data.pages.map((p) => [p.id, p.type, p.sub_type]), [[fx.PETITION, "dc", "PET"]]);
  const ev = await call(client, "list_pages", { type: "ev", status: "close" });
  assert.deepEqual(ev.data.pages.map((p) => p.id), [fx.GALA]);
  const one = await call(client, "list_pages", { type: "nd", max_results: 1 });
  assert.deepEqual([one.data.count, one.data.total, one.data.complete], [1, 3, false]);
});

await check("get_page returns details with tracking parameters, attributes and template", async () => {
  const { data } = await call(client, "get_page", { page_id: fx.AUTUMN });
  assert.equal(requests.at(-1).path, `/page/${fx.AUTUMN}`);
  assert.deepEqual([data.page.tracking_parameters, data.page.attributes, data.page.template, data.page.campaign_id], [["facebook", "email"], ["animal", "health"], "Main Template - Relaunch", 3557]);
  assert.equal(data.page.modified, iso(1696332536000));
});

const PAYMENT_LEAKS = ["Payment Token", "tok-test-not-real", "cc_num_last4", "4242", "Card Expiration", "12/29", "ccExpiry", "1229", "Mandate", "DDM-TEST"];
await check("find_supporter by email returns names only by default: other fields are listed by name, card, bank and password fields never", async () => {
  const { data, text } = await call(client, "find_supporter", { email: fx.OTTO_EMAIL });
  assert.deepEqual(requests.at(-1).query, { email: fx.OTTO_EMAIL }, "includeQuestions/includeMemberships only when asked");
  const s = data.supporter;
  assert.deepEqual([data.found, s.supporter_id, s.suppressed], [true, fx.OTTO, false]);
  assert.deepEqual(s.name, { title: "Mr", first_name: "Otto", middle_name: "Niemand", last_name: "Normalverbraucher" }, "the renamed middle-name field is recognised through /supporter/fields");
  assert.deepEqual(s.withheld_fields, ["Email Address", "Address 1", "Postcode", "City", "Country", "Appeal Code", "Phone Number", "Supporter Birthday", "SFDC_Contact_ID", "Send Offset"]);
  assert.equal(s.fields, undefined);
  assert.equal(s.payment_fields_omitted, 10, "the five payment fields of the spec's example and five custom ones (token, cc_num_last4, card expiration, ccExpiry, mandate)");
  for (const leak of [fx.OTTO_EMAIL, "07700", "EC1M", "Clerkenwell", "1980-04-12", "00012345", "400000", "O NORMALVERBRAUCHER", fx.FAKE_PASSWORD, "B-TESTNOTREAL0001", "4111", "Bank Account Number", "Password", ...PAYMENT_LEAKS]) assert.ok(!text.includes(leak), `${leak} leaked in the default output`);
  const full = await call(client, "find_supporter", { email: fx.OTTO_EMAIL, include_questions: true, include_memberships: true });
  assert.deepEqual(requests.at(-1).query, { email: fx.OTTO_EMAIL, includeQuestions: "true", includeMemberships: "true" });
  assert.deepEqual(full.data.supporter.questions.map((q) => [q.name, q.type, q.response]), [
    ["Opt-in Email (single)", "OPTIN", "Y"],
    ["Email Opt-in (double)", "CONFIRMATION", "N"],
    ["Consultation Feedback Question", "GENERAL", "Contact me at [email redacted] or [phone redacted], I live at [postcode redacted]"],
  ]);
  const m = full.data.supporter.memberships[0];
  assert.deepEqual([m.name, m.status, m.state, m.expire_days, m.members], ["Free Membership (1 year)", "ACTIVE", "NEW", 199, [{ first_name: "Otto", last_name: "Normalverbraucher" }]]);
  assert.equal(m.term_end, iso(1729915200000));
  assert.ok(!full.text.includes("otto.alt@") && !full.text.includes("900789"));
});

await check("find_supporter with include_contact_details returns every other field as stored, but never card, bank or password data", async () => {
  const { data, text } = await call(client, "find_supporter", { supporter_id: fx.OTTO, include_questions: true, include_contact_details: true });
  assert.equal(requests.at(-1).path, `/supporter/${fx.OTTO}`);
  assert.deepEqual(requests.at(-1).query, { includeQuestions: "true" });
  const f = data.supporter.fields;
  assert.deepEqual([f["Email Address"], f["Phone Number"], f["Address 1"], f.Postcode, f["Supporter Birthday"]], [fx.OTTO_EMAIL, "+44 7700 900123", "64 Clerkenwell Road", "EC1M 5PX", "1980-04-12"]);
  assert.equal(f.SFDC_Contact_ID, "note: card [card number redacted]", "a card number typed into a custom field is redacted even on request");
  assert.equal(data.supporter.withheld_fields, undefined);
  assert.equal(data.supporter.questions[2].response, "Contact me at otto.alt@example.com or 07700 900789, I live at EC1M 5PX");
  for (const leak of ["Bank", "Credit Card", "Password", "PayPal", "00012345", "400000", fx.FAKE_PASSWORD, "B-TESTNOTREAL0001", fx.OTTO_CARD, ...PAYMENT_LEAKS]) assert.ok(!text.includes(leak), `${leak} returned with include_contact_details`);
  assert.equal(data.supporter.payment_fields_omitted, 10);
});

await check("find_supporter by ID redacts contact details typed into names; unknown email is 'not found'; exactly one of email or ID", async () => {
  const lee = await call(client, "find_supporter", { supporter_id: fx.LEE, include_questions: true });
  assert.deepEqual([lee.data.supporter.name.first_name, lee.data.supporter.name.last_name, lee.data.supporter.suppressed], ["Lee ([email redacted])", "Chen (cell [phone redacted])", true]);
  assert.equal(
    lee.data.supporter.questions[0].response,
    "Call [phone redacted] or [phone redacted] or [phone redacted] or [phone redacted] or [phone redacted]; mail Ottawa ON [postcode redacted] or [postcode redacted], Washington DC [postcode redacted], San Francisco, CA [postcode redacted]",
    "North American phone numbers, Canadian postcodes and US ZIP codes are redacted by default",
  );
  for (const leak of fx.LEE_LEAKS) assert.ok(!lee.text.includes(leak), `${leak} leaked in the default output`);
  const leeRaw = await call(client, "find_supporter", { supporter_id: fx.LEE, include_questions: true, include_contact_details: true });
  assert.equal(leeRaw.data.supporter.name.first_name, "Lee (lee.chen@example.net)");
  assert.equal(leeRaw.data.supporter.questions[0].response, fx.LEE_ANSWER);
  const nobody = await call(client, "find_supporter", { email: "nobody@example.org" });
  assert.deepEqual(nobody.data, { found: false, note: "No supporter with that email address on this account." }, "a 404 for an unknown email");
  arm({ method: "GET", path: "/supporter", status: 200, body: {} });
  const empty = await call(client, "find_supporter", { email: "nobody@example.org" });
  assert.equal(empty.data.found, false, "a 200 with no supporterId is 'not found' too");
  const n = requests.length;
  for (const args of [{}, { email: fx.OTTO_EMAIL, supporter_id: fx.OTTO }]) {
    const r = await call(client, "find_supporter", args);
    assert.ok(r.res.isError);
    assert.match(r.text, /Give either email or supporter_id \(exactly one\)/);
  }
  assert.equal(requests.length, n, "no request for an ambiguous lookup");
});

await check("query_supporters pages with start/rows (0, 100, 200) until the documented total; emails hidden unless asked", async () => {
  const n = requests.length;
  const { data } = await call(client, "query_supporters", { type: "latestCreated", max_results: 1000 });
  const pages = since(n);
  assert.deepEqual(pages.map((r) => [r.path, r.query.type, r.query.start, r.query.rows]), [["/supporter/query", "latestCreated", "0", "100"], ["/supporter/query", "latestCreated", "100", "100"], ["/supporter/query", "latestCreated", "200", "100"]], "three pages, no fourth call once total is reached");
  for (let i = 1; i < pages.length; i++) {
    const gap = pages[i].t - pages[i - 1].t;
    assert.ok(gap >= 190, `requests are spaced 200 ms apart (page ${i + 1} came ${gap} ms after page ${i})`);
  }
  assert.deepEqual([data.count, data.total_matching, data.complete, data.note], [253, 253, true, undefined]);
  assert.deepEqual(Object.keys(data.supporters[0]).sort(), ["created_on", "modified_on", "supporter_id"]);
  assert.ok(!JSON.stringify(data).includes("@example"), "no email address in the default output");
  const withEmail = await call(client, "query_supporters", { type: "latestCreated", max_results: 5, include_contact_details: true });
  assert.ok(withEmail.data.supporters.every((s) => /@example\.(org|com|net)$/.test(s.email)));
});

await check("query_supporters honours max_results and reports how to continue from start", async () => {
  const n = requests.length;
  const first = await call(client, "query_supporters", { type: "latestCreated", max_results: 150 });
  assert.deepEqual(since(n).map((r) => [r.query.start, r.query.rows]), [["0", "100"], ["100", "50"]]);
  assert.deepEqual([first.data.count, first.data.complete], [150, false]);
  assert.match(first.data.note, /start 150/);
  const next = await call(client, "query_supporters", { type: "latestCreated", max_results: 150, start: 150 });
  assert.deepEqual([next.data.count, next.data.complete], [103, true]);
  assert.deepEqual(requests.slice(-2).map((r) => [r.query.start, r.query.rows]), [["150", "100"], ["250", "50"]]);
  const all = [...first.data.supporters, ...next.data.supporters].map((s) => s.supporter_id);
  assert.equal(new Set(all).size, 253, "the two calls together cover every supporter once");
});

await check("query_supporters: when the API returns more rows than asked for, the cut rows are not skipped by the continuation start", async () => {
  overrideQueryRows(100);
  try {
    const n = requests.length;
    const first = await call(client, "query_supporters", { type: "latestCreated", max_results: 150 });
    assert.deepEqual(since(n).map((r) => [r.query.start, r.query.rows]), [["0", "100"], ["100", "50"]]);
    assert.deepEqual([first.data.count, first.data.complete], [150, false]);
    assert.match(first.data.note, /call again with start 150 to continue/);
    // The last page is cut too: the API has reached its total, but 43 rows were dropped, so it is not complete.
    const tail = await call(client, "query_supporters", { type: "latestCreated", max_results: 10, start: 200 });
    assert.deepEqual([tail.data.count, tail.data.complete], [10, false]);
    assert.match(tail.data.note, /start 210/);
    overrideQueryRows(undefined);
    const next = await call(client, "query_supporters", { type: "latestCreated", max_results: 1000, start: 150 });
    const all = [...first.data.supporters, ...next.data.supporters].map((s) => s.supporter_id);
    assert.deepEqual([all.length, new Set(all).size], [253, 253], "continuing from the reported start covers every supporter once");
  } finally {
    overrideQueryRows(undefined);
  }
});

await check("query_supporters passes type, daysBack, profileId and filter through exactly; profile and search requirements are checked locally", async () => {
  const recent = await call(client, "query_supporters", { type: "latestCreated", days_back: 7 });
  assert.deepEqual(requests.at(-1).query, { type: "latestCreated", daysBack: "7", start: "0", rows: "100" });
  assert.equal(recent.data.total_matching, 41);
  const filter = "firstName:Bob~country:GB||US";
  const search = await call(client, "query_supporters", { type: "search", filter });
  assert.equal(requests.at(-1).query.filter, filter);
  assert.equal(search.data.total_matching, 17);
  const profile = await call(client, "query_supporters", { type: "profile", profile_id: fx.PROFILE });
  assert.equal(requests.at(-1).query.profileId, String(fx.PROFILE));
  assert.deepEqual(profile.data.supporters.map((s) => s.supporter_id), fx.profileMembers);
  const suppressed = await call(client, "query_supporters", { type: "suppressed", max_results: 10 });
  assert.deepEqual(requests.at(-1).query, { type: "suppressed", start: "0", rows: "10" });
  assert.equal(suppressed.data.total_matching, 6);
  const n = requests.length;
  const noProfile = await call(client, "query_supporters", { type: "profile" });
  assert.match(noProfile.text, /'profile' query needs profile_id/);
  const noFilter = await call(client, "query_supporters", { type: "search" });
  assert.match(noFilter.text, /'search' query needs a filter/);
  assert.equal(requests.length, n, "refused locally, before any request");
  // An error message that echoes the filter: the URL-encoded email and the North American number are redacted.
  arm({ method: "GET", path: "/supporter/query", status: 400, body: { message: "Bad filter emailAddress:otto%40example.com phone 202-555-0100", messageId: 10000005 } });
  const refused = await call(client, "query_supporters", { type: "search", filter: "emailAddress:otto@example.com" });
  assert.ok(refused.res.isError);
  assert.match(refused.text, /refused GET \/supporter\/query \(400\)\. Bad filter emailAddress:\[email redacted\] phone \[phone redacted\] \(messageId 10000005\)/);
});

await check("get_supporter_transactions returns history and recurring schedules; gateway references never, P2P emails only on request", async () => {
  const n = requests.length;
  const { data, text } = await call(client, "get_supporter_transactions", { supporter_id: fx.OTTO });
  assert.deepEqual(since(n).map((r) => `${r.method} ${r.path}`), [`GET /supporter/${fx.OTTO}/transactions`, `GET /supporter/${fx.OTTO}/transactions/recurring`]);
  const t = data.transactions;
  assert.equal(data.count, 8);
  assert.deepEqual([t[0].type, t[0].page_name, t[0].target, t[0].date, t[0].created_on], ["et", "Email Westminster MP", { xref1: "Mayor", xref2: "Representative" }, "2026-03-01T00:00:00.000Z", "01/03/2026"], "a createdDate in seconds is read as seconds");
  assert.deepEqual([t[2].subtype, t[2].page_name], ["PET", "We Want Change"]);
  assert.deepEqual([t[3].tx_type, t[3].status, t[3].recurring, t[3].date], ["CREDIT_SINGLE", "success", false, iso(1772496000000)]);
  assert.deepEqual([t[4].tx_type, t[4].recurring, t[4].first_recurring], ["CREDIT_RECURRING", true, true]);
  assert.deepEqual([t[5].type, t[5].status], ["ev", "refund"]);
  assert.equal(t[6].broadcast_id, 1536);
  assert.deepEqual([t[7].p2p.role, t[7].p2p.first_name, t[7].p2p.primary_participant, t[7].p2p.site_name, t[7].p2p.email], ["Team Captain", "Otto", true, "Run for Rivers 2026", undefined]);
  const r = data.recurring_schedules;
  assert.deepEqual(r.map((x) => [x.amount, x.currency, x.frequency, x.status, x.next_payment_date]), [[12, "GBP", "MONTHLY", "ACTIVE", "2026-10-22"], [50, "GBP", "ANNUAL", "CANCELED", undefined]]);
  assert.equal(r[0].reason, "Requested via phone on [phone redacted]");
  for (const leak of [fx.GATEWAY_REF, "cus_", "transactionId", fx.OTTO_EMAIL, "900456"]) assert.ok(!text.includes(leak), `${leak} leaked`);
  const raw = await call(client, "get_supporter_transactions", { supporter_id: fx.OTTO, include_contact_details: true });
  assert.equal(raw.data.transactions[7].p2p.email, fx.OTTO_EMAIL);
  assert.equal(raw.data.recurring_schedules[0].reason, "Requested via phone on 07700 900456");
  assert.ok(!raw.text.includes(fx.GATEWAY_REF) && !raw.text.includes("cus_"), "gateway references are never returned");
  const m = requests.length;
  const noRecurring = await call(client, "get_supporter_transactions", { supporter_id: fx.NO_HISTORY, include_recurring: false });
  assert.deepEqual([noRecurring.data.count, noRecurring.data.transactions, noRecurring.data.recurring_schedules], [0, [], undefined]);
  assert.deepEqual(since(m).map((x) => x.path), [`/supporter/${fx.NO_HISTORY}/transactions`]);
  const capped = await call(client, "get_supporter_transactions", { supporter_id: fx.OTTO, max_results: 2 });
  assert.deepEqual([capped.data.count, capped.data.total, capped.data.complete], [2, 8, false]);
  const oneSchedule = await call(client, "get_supporter_transactions", { supporter_id: fx.OTTO, max_results: 1 });
  assert.deepEqual([oneSchedule.data.recurring_count, oneSchedule.data.recurring_total, oneSchedule.data.recurring_complete, oneSchedule.data.recurring_schedules.length], [1, 2, false, 1], "max_results caps the recurring schedules too");
});

await check("get_supporter_transactions: page names and North American change reasons are redacted; a P2P payment (ppay) keeps its site ID", async () => {
  const { data, text } = await call(client, "get_supporter_transactions", { supporter_id: fx.LEE });
  assert.equal(data.transactions[0].page_name, "Winter appeal draft (call [phone redacted] or [email redacted])");
  assert.deepEqual([data.transactions[1].type, data.transactions[1].export_type, data.transactions[1].status, data.transactions[1].recurring, data.transactions[1].p2p?.site_id], ["ppay", "PPAY", "success", false, 77]);
  assert.equal(data.recurring_schedules[0].reason, "Donor called from [phone redacted] to change");
  for (const leak of ["555-0199", "555-0142", "winter@example.org", fx.GATEWAY_REF]) assert.ok(!text.includes(leak), `${leak} leaked`);
});

await check("list_supporter_questions and get_supporter_question show opt-in types, per-locale options and range settings", async () => {
  const { data } = await call(client, "list_supporter_questions");
  assert.deepEqual(data.questions.map((q) => [q.id, q.question_id, q.type]), [[fx.Q_DOUBLE, 784, "CONF"], [fx.Q_EMAIL, 279, "OPT"], [fx.Q_SMS, 280, "OPT"], [fx.Q_FEEDBACK, 1064, "GEN"]]);
  const email = await call(client, "get_supporter_question", { question_id: fx.Q_EMAIL });
  assert.equal(requests.at(-1).path, `/supporter/questions/${fx.Q_EMAIL}`);
  assert.deepEqual(email.data.locales.map((l) => [l.locale, l.html_field_type, l.options[0].value]), [["en-GB", "checkbox", "Y"], ["fr-CA", "checkbox", "Y"]]);
  const range = await call(client, "get_supporter_question", { question_id: fx.Q_FEEDBACK });
  assert.deepEqual(range.data.locales[0].range, { min: "1", max: "10", step: "1", min_label: "Min", max_label: "Max" });
});

await check("list_marketing_automations (after a 429 retry that waits for Retry-After) passes folderId and name through; get_marketing_automation adds stats for a month range", async () => {
  const n = requests.length;
  const home = await call(client, "list_marketing_automations");
  const tries = since(n).filter((r) => r.path === "/ma");
  assert.equal(tries.length, 2, "retried once after the 429");
  const gap = tries[1].t - tries[0].t;
  assert.ok(gap >= 1000 && gap < 1900, `retry should wait the Retry-After of 1 s, not the 2 s fallback (waited ${gap} ms)`);
  assert.deepEqual(tries[1].query, {}, "no folderId unless given (the API's default is the Home folder, 0)");
  assert.deepEqual(home.data.automations.map((a) => a.id), [fx.MA_DD]);
  const folder = await call(client, "list_marketing_automations", { folder_id: 12, name: "donors" });
  assert.deepEqual(requests.at(-1).query, { folderId: "12", name: "donors" });
  assert.deepEqual(folder.data.automations.map((a) => [a.id, a.status]), [[fx.MA_WELCOME, "ACTIVE"]]);
  const m = requests.length;
  const { data } = await call(client, "get_marketing_automation", { automation_id: fx.MA_WELCOME, start_month: "202601", end_month: "202609" });
  assert.deepEqual(since(m).map((r) => `${r.path} ${JSON.stringify(r.query)}`), [`/ma/${fx.MA_WELCOME} {}`, `/ma/${fx.MA_WELCOME}/stats {"startMonth":"202601","endMonth":"202609"}`]);
  assert.equal(data.automation.name, "Welcome journey - new DONORS");
  assert.deepEqual([data.stats.journey_starts, data.stats.average_open_rate, data.stats.donations, data.stats.unsubscribes], [412, 48.2, 21, 4]);
  const k = requests.length;
  const noStats = await call(client, "get_marketing_automation", { automation_id: fx.MA_DD, include_stats: false });
  assert.equal(noStats.data.stats, undefined);
  assert.equal(since(k).length, 1);
  const reversed = await call(client, "get_marketing_automation", { automation_id: fx.MA_DD, start_month: "202609", end_month: "202601" });
  assert.match(reversed.text, /start_month 202609 is after end_month 202601/);
  const badMonth = await client.callTool({ name: "get_marketing_automation", arguments: { automation_id: fx.MA_DD, start_month: "2026-01" } });
  assert.ok(badMonth.isError);
  assert.equal(requests.length, k + 1, "bad month ranges are refused before any request");
});

await check("update_supporter_opt_ins checks the names against /supporter/questions, then PUTs a body that validates against the documented request schema", async () => {
  const n = requests.length;
  const { data } = await call(client, "update_supporter_opt_ins", { supporter_id: fx.OTTO, opt_ins: [{ name: "Opt-in SMS", value: "Y" }, { name: "Opt-in Email (single)", value: "N" }, { name: "Email Opt-in (double)", value: "N" }] });
  assert.deepEqual(since(n).map((r) => `${r.method} ${r.path}`), ["GET /supporter/questions", `PUT /supporter/${fx.OTTO}`]);
  const put = requests.at(-1);
  assert.match(put.contentType, /^application\/json/);
  validateWith(requestSchema("/supporter/{supporterId}", "put"), put.body, "PUT /supporter/{id} body");
  assert.deepEqual(put.body, { questions: { "Opt-in SMS": "Y", "Opt-in Email (single)": "N", "Email Opt-in (double)": "N" } }, "only the opt-ins, no other field");
  assert.deepEqual([data.result, data.supporter_id], ["updated", fx.OTTO]);
  assert.deepEqual(writtenOptIns(fx.OTTO), { "Opt-in SMS": "Y", "Opt-in Email (single)": "N", "Email Opt-in (double)": "N" });
  const after = await call(client, "find_supporter", { supporter_id: fx.OTTO, include_questions: true });
  assert.equal(after.data.supporter.questions[0].response, "N");
  const m = requests.length;
  for (const [opt, pattern] of [
    [{ name: "Consultation Feedback Question", value: "Y" }, /is a general question, not an opt-in/],
    [{ name: "Email Opt-in (double)", value: "Y" }, /confirmation \(double opt-in\) question.*does not set it to Y/],
    [{ name: "Opt-in WhatsApp", value: "Y" }, /"Opt-in WhatsApp" is not a question on this account\. Opt-ins are: "Email Opt-in \(double\)", "Opt-in Email \(single\)", "Opt-in SMS"/],
  ]) {
    const r = await call(client, "update_supporter_opt_ins", { supporter_id: fx.OTTO, opt_ins: [opt] });
    assert.ok(r.res.isError);
    assert.match(r.text, /^Not updated\./);
    assert.match(r.text, pattern);
  }
  const twice = await call(client, "update_supporter_opt_ins", { supporter_id: fx.OTTO, opt_ins: [{ name: "Opt-in SMS", value: "Y" }, { name: "Opt-in SMS", value: "N" }] });
  assert.match(twice.text, /"Opt-in SMS" was given twice/);
  assert.ok(since(m).every((r) => r.method === "GET"), "no PUT for a refused update");
});

await check("answers whose type is not the documented OPTIN/CONFIRMATION are redacted too, whatever the type says", async () => {
  // Off-spec records (the spec's type enum is OPTIN, GENERAL, CONFIRMATION), injected directly.
  arm({
    method: "GET",
    path: `/supporter/${fx.NO_HISTORY}`,
    status: 200,
    body: {
      supporterId: fx.NO_HISTORY,
      suppressed: false,
      "First Name": "Sam",
      questions: [
        { id: 1, name: "Short code", type: "GEN", response: "reach me at 07700 900111 or sam@example.org" },
        { id: 2, name: "Lower case", type: "general", response: "text 613-555-0142" },
        { id: 3, name: "No type", response: "Ottawa K1A 0B1" },
        { id: 4, name: "Opt-in labelled, free text inside", type: "OPTIN", response: "Y, call 202-555-0100" },
        { id: 5, name: "Opt-in", type: "OPTIN", response: "Y" },
      ],
    },
  });
  const { data, text } = await call(client, "find_supporter", { supporter_id: fx.NO_HISTORY, include_questions: true });
  assert.deepEqual(data.supporter.questions.map((q) => q.response), ["reach me at [phone redacted] or [email redacted]", "text [phone redacted]", "Ottawa [postcode redacted]", "Y, call [phone redacted]", "Y"]);
  for (const leak of ["900111", "sam@example.org", "555-0142", "K1A", "555-0100"]) assert.ok(!text.includes(leak), `${leak} leaked`);
  disarm();
});

await check("list_supporter_questions, get_supporter_question and list_marketing_automations cap what they return and say so", async () => {
  arm({ method: "GET", path: "/supporter/questions", status: 200, body: Array.from({ length: 150 }, (_, i) => ({ id: 60000 + i, questionId: 9000 + i, name: `Question ${i}`, type: "GEN" })) });
  const qs = await call(client, "list_supporter_questions");
  assert.deepEqual([qs.data.count, qs.data.total, qs.data.complete, qs.data.questions.length], [100, 150, false, 100], "default cap 100");
  const few = await call(client, "list_supporter_questions", { max_results: 2 });
  assert.deepEqual([few.data.count, few.data.total, few.data.complete], [2, fx.questions.length, false]);
  const options = Array.from({ length: 300 }, (_, i) => ({ selected: false, value: `C${i}`, label: `Country ${i}`, forId: "", imageUrl: "" }));
  const locale = (l) => ({ id: 70001, questionId: 9101, name: "Country of residence", type: "GEN", locale: l, label: "Country", htmlFieldType: "select", content: { data: options } });
  arm({ method: "GET", path: "/supporter/questions/70001", status: 200, body: Array.from({ length: 60 }, (_, i) => locale(`l${i}-GB`)) });
  const detail = await call(client, "get_supporter_question", { question_id: 70001, max_options: 10 });
  assert.deepEqual([detail.data.locale_count, detail.data.locale_total, detail.data.locales_complete], [50, 60, false]);
  assert.deepEqual([detail.data.locales[0].options.length, detail.data.locales[0].option_total, detail.data.locales[0].options_complete], [10, 300, false]);
  arm({ method: "GET", path: "/ma", status: 200, body: Array.from({ length: 150 }, (_, i) => ({ id: 8000 + i, clientId: 94, name: `Journey ${i}`, status: "ACTIVE", folderId: 0, ownedBy: 0, createdOn: 1735689600000, modifiedOn: null })) });
  const mas = await call(client, "list_marketing_automations", { max_results: 20 });
  assert.deepEqual([mas.data.count, mas.data.total, mas.data.complete, mas.data.automations.length], [20, 150, false, 20]);
  const home = await call(client, "list_marketing_automations");
  assert.deepEqual([home.data.count, home.data.total, home.data.complete], [1, 1, true]);
  disarm();
});

await check("the current session token is scrubbed from error text the API echoes back", async () => {
  await call(client, "list_supporter_fields");
  const session = requests.at(-1).token;
  assert.ok(wasIssued(session));
  arm({ method: "GET", path: "/supporter/fields", status: 400, body: { message: `Token ${session} lacks permission`, messageId: 10000005 } });
  const { res, text } = await call(client, "list_supporter_fields");
  assert.ok(res.isError);
  assert.match(text, /Token \[redacted\] lacks permission/);
  assert.ok(!text.includes(session), "the session token must not be echoed");
  disarm();
});

await check("concurrent calls that all hit an expired session share one new authentication", async () => {
  revokeSessions();
  const issuedBefore = sessionsIssued();
  const n = requests.length;
  const results = await Promise.all(Array.from({ length: 4 }, () => call(client, "list_supporter_questions")));
  assert.ok(results.every((r) => !r.res.isError), "every call succeeds");
  const seen = since(n);
  assert.equal(seen.filter((r) => r.path === "/authenticate").length, 1, `exactly one POST /authenticate (saw ${seen.map((r) => r.method + " " + r.path).join(", ")})`);
  assert.equal(seen.filter((r) => r.path === "/supporter/questions").length, 8, "each call: a 401, then once more with the new session");
  assert.equal(sessionsIssued(), issuedBefore + 1);
});

await check("bad IDs are rejected before any API call; an unknown ID gives a clear 404", async () => {
  const before = requests.length;
  for (const [tool, args] of [
    ["get_page", { page_id: "../page" }],
    ["get_page", { page_id: -1 }],
    ["get_page", { page_id: 1.5 }],
    ["find_supporter", { supporter_id: 0 }],
    ["find_supporter", { email: "not-an-email" }],
    ["get_supporter_transactions", { supporter_id: `${fx.OTTO}/transactions` }],
    ["get_supporter_question", { question_id: "1531" }],
    ["get_marketing_automation", { automation_id: "abc" }],
    ["update_supporter_opt_ins", { supporter_id: -5, opt_ins: [{ name: "Opt-in SMS", value: "Y" }] }],
    ["update_supporter_opt_ins", { supporter_id: fx.OTTO, opt_ins: [{ name: "Opt-in SMS", value: "yes" }] }],
    ["list_pages", { type: "donation" }],
    ["list_pages", { type: "nd", max_results: 1001 }],
    ["query_supporters", { type: "latestCreated", max_results: 1001 }],
    ["get_supporter_transactions", { supporter_id: fx.OTTO, max_results: 0 }],
    ["list_supporter_questions", { max_results: 1001 }],
    ["list_marketing_automations", { max_results: 0 }],
    ["get_supporter_question", { question_id: fx.Q_EMAIL, max_options: 1001 }],
  ]) {
    const bad = await client.callTool({ name: tool, arguments: args });
    assert.ok(bad.isError, `${tool} should reject ${JSON.stringify(args)}`);
  }
  assert.equal(requests.length, before, "no request for invalid input");
  const missing = await call(client, "get_page", { page_id: 999999 });
  assert.ok(missing.res.isError);
  assert.match(missing.text, /^Not found: \/page\/999999\. Check the ID; it does not exist on this account\. No page was found/);
  const missingSupporter = await call(client, "find_supporter", { supporter_id: 999999 });
  assert.match(missingSupporter.text, /^Not found: \/supporter\/999999/);
});

await check("an expired or retired session token is replaced once and the call retried; a token near its documented expiry is renewed before it runs out", async () => {
  revokeSessions();
  const issuedBefore = sessionsIssued();
  const n = requests.length;
  const { res } = await call(client, "list_supporter_questions");
  assert.ok(!res.isError, res.content[0].text);
  const seen = since(n);
  assert.deepEqual(seen.map((r) => `${r.method} ${r.path}`), ["GET /supporter/questions", "POST /authenticate", "GET /supporter/questions"], "401, a new session, then the call again");
  assert.ok(wasIssued(seen[0].token) && wasIssued(seen[2].token) && seen[0].token !== seen[2].token);
  assert.equal(sessionsIssued(), issuedBefore + 1);
  // A session that lives 2 s is renewed after half its lifetime, before the API would reject it.
  setExpires(2000);
  revokeSessions();
  await call(client, "list_supporter_questions"); // 401, then a 2-second session
  await new Promise((r) => setTimeout(r, 1200));
  const m = requests.length;
  await call(client, "list_supporter_questions");
  assert.deepEqual(since(m).map((r) => `${r.method} ${r.path}`), ["POST /authenticate", "GET /supporter/questions"], "renewed before the call, with no 401 in between");
  setExpires(3_600_000);
  revokeSessions();
});

await check("the documented usage-limit 401 is reported as a rate limit, on a data call (without authenticating again) and on /authenticate; the API username in it is redacted", async () => {
  await call(client, "list_supporter_questions"); // a fresh session after the revoke above
  arm({ method: "GET", path: "/supporter/fields", status: 401, body: USAGE_LIMIT_BODY });
  const n = requests.length;
  const { res, text } = await call(client, "list_supporter_fields");
  assert.ok(res.isError);
  assert.deepEqual(since(n).map((r) => r.path), ["/supporter/fields"], "no new session requested");
  assert.match(text, /used up its request allowance \(documented: 5,000 requests per hour per API user; beyond that requests are blocked\)\. Try again later\. The user with username \[\[email redacted\]\] has exceeded its api limit\./);
  disarm();
  // The same message on POST /authenticate is not mistaken for a wrong token.
  revokeSessions();
  arm({ method: "POST", path: "/authenticate", status: 401, body: USAGE_LIMIT_BODY });
  const m = requests.length;
  const atAuth = await call(client, "list_supporter_fields");
  assert.deepEqual(since(m).map((r) => `${r.method} ${r.path}`), ["GET /supporter/fields", "POST /authenticate"]);
  assert.match(atAuth.text, /^Engaging Networks reports that the API user has used up its request allowance/);
  assert.ok(!atAuth.text.includes("ENGAGINGNETWORKS_API_TOKEN"), "not reported as a wrong token");
  disarm();
});

await check("a persistent 429 gives up after 3 attempts; a Retry-After above the cap makes the call give up at once", async () => {
  arm429({ persistent: true });
  const n = requests.length;
  const { res, text } = await call(client, "list_marketing_automations");
  assert.ok(res.isError);
  assert.equal(since(n).filter((r) => r.path === "/ma").length, 3, "exactly three attempts");
  assert.match(text, /Engaging Networks rate limit reached \(429\)\. The documented limit is 5,000 requests per hour per API user\. Wait a minute and try again\./);
  arm429({ retryAfter: "600" });
  const m = requests.length;
  const long = await call(client, "list_marketing_automations");
  assert.equal(since(m).filter((r) => r.path === "/ma").length, 1, "no retry when asked to wait longer than the cap");
  assert.match(long.text, /asked to wait 600 seconds before retrying GET \/ma \(HTTP 429\)/);
  disarm();
});

await check("an HTTP-date Retry-After is honoured", async () => {
  // HTTP-dates have 1 s resolution, so aim at a whole second 4 to 5 s ahead: after the first request's
  // round trip the wait is 3.5 to 5 s, clearly apart from both "retry at once" and the 2 s fallback.
  arm429({ retryAfter: new Date(Math.ceil((Date.now() + 4000) / 1000) * 1000).toUTCString() });
  const n = requests.length;
  const { res } = await call(client, "list_marketing_automations");
  assert.ok(!res.isError);
  const tries = since(n).filter((r) => r.path === "/ma");
  assert.equal(tries.length, 2);
  const gap = tries[1].t - tries[0].t;
  assert.ok(gap >= 3000 && gap < 5600, `retry should wait until the given date (3.5 to 5 s), not retry at once or use the 2 s fallback (waited ${gap} ms)`);
  disarm();
});

await check("a fractional Retry-After is read as seconds, not as a date", async () => {
  arm429({ retryAfter: "1.5" }); // Date.parse("1.5") is a date in 2001, which would mean "retry now"
  const n = requests.length;
  const { res } = await call(client, "list_marketing_automations");
  assert.ok(!res.isError);
  const tries = since(n).filter((r) => r.path === "/ma");
  assert.equal(tries.length, 2);
  const gap = tries[1].t - tries[0].t;
  assert.ok(gap >= 1400 && gap < 1900, `retry should wait 1.5 s (waited ${gap} ms)`);
  disarm();
});

await check("gateway errors: a GET failing three times with 503 gives up with advice and without HTML; a 502 on a GET or on POST /authenticate is retried; a 502 on the PUT is never retried", async () => {
  arm({ method: "GET", path: "/supporter/questions", status: 503, times: 3, headers: { "Retry-After": "0" } });
  const n = requests.length;
  const down = await call(client, "list_supporter_questions");
  assert.ok(down.res.isError);
  assert.equal(since(n).filter((r) => r.path === "/supporter/questions").length, 3);
  assert.match(down.text, /Engaging Networks returned 503 for GET \/supporter\/questions 3 times in a row\. The service may be unavailable; try again in a few minutes\./);
  assert.ok(!down.text.includes("<html>"));
  disarm();
  arm({ method: "GET", path: "/supporter/fields", status: 502, headers: { "Retry-After": "0" } });
  const m = requests.length;
  const fields = await call(client, "list_supporter_fields");
  assert.ok(!fields.res.isError, fields.text);
  assert.equal(since(m).filter((r) => r.path === "/supporter/fields").length, 2);
  disarm();
  revokeSessions();
  arm({ method: "POST", path: "/authenticate", status: 502, headers: { "Retry-After": "0" } });
  const a = requests.length;
  const afterAuth = await call(client, "list_supporter_fields");
  assert.ok(!afterAuth.res.isError, afterAuth.text);
  assert.deepEqual(since(a).map((r) => `${r.method} ${r.path}`), ["GET /supporter/fields", "POST /authenticate", "POST /authenticate", "GET /supporter/fields"]);
  disarm();
  arm({ method: "PUT", path: `/supporter/${fx.OTTO}`, status: 502, headers: { "Retry-After": "0" } });
  const k = requests.length;
  const put = await call(client, "update_supporter_opt_ins", { supporter_id: fx.OTTO, opt_ins: [{ name: "Opt-in SMS", value: "N" }] });
  assert.ok(put.res.isError, "a 502 on the update must surface as an error");
  assert.equal(since(k).filter((r) => r.method === "PUT").length, 1, "exactly one PUT");
  assert.match(put.text, /returned 502 for PUT \/supporter\/212200\. The request was not retried because it may already have been processed: check with find_supporter before repeating it\./);
  disarm();
});

await check("a 200 whose body is not JSON is an error, not an empty list; a 200 from /authenticate without a token names what came back", async () => {
  arm({ method: "GET", path: "/page", status: 200, text: "<html><body>Please log in, or call 0117 496 0000</body></html>" });
  const { res, text } = await call(client, "list_pages", { type: "nd" });
  assert.ok(res.isError, `a non-JSON 200 must not be reported as success: ${text}`);
  assert.match(text, /returned 200 for GET \/page but the body was not JSON \(starts with: "<html><body>Please log in, or call \[phone redacted\]<\/body>.*Check ENGAGINGNETWORKS_REGION/);
  disarm();
  revokeSessions();
  arm({ method: "POST", path: "/authenticate", status: 200, body: { unexpected: true } });
  const noToken = await call(client, "list_pages", { type: "nd" });
  assert.match(noToken.text, /answered .*\/authenticate with 200 but no ens-auth-token \(JSON with keys unexpected\)/);
  disarm();
  assert.ok(!(await call(client, "list_pages", { type: "nd" })).res.isError, "recovers on the next call");
});
await client.close();

await check("writes are off when ENGAGINGNETWORKS_ALLOW_WRITES is unset, and when it is 'false'", async () => {
  for (const value of [null, "false"]) {
    const ro = await connect(API_TOKEN, value);
    const { tools } = await ro.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), READ_TOOLS, `writes exposed with ENGAGINGNETWORKS_ALLOW_WRITES ${value === null ? "unset" : `= "${value}"`}`);
    await ro.close();
  }
});

const WRONG = "en-test-wrong-token-not-real";
await check("a wrong API user token gives an actionable message, and the token the API echoes back is scrubbed", async () => {
  const bad = await connect(WRONG);
  const { res, text } = await call(bad, "list_pages", { type: "nd" });
  assert.ok(res.isError);
  assert.match(text, /rejected the API user token at .*\/authenticate \(401\)\. Check ENGAGINGNETWORKS_API_TOKEN.*whitelisted.*ENGAGINGNETWORKS_REGION.* Invalid api key \[\[redacted\]\] \(messageId 10000000\)/);
  assert.ok(!text.includes(WRONG), "the rejected token must not be echoed");
  assert.equal(requests.at(-1).path, "/authenticate", "no data call without a session");
  await bad.close();
});

await check("every request carried the documented auth (raw token to /authenticate, an issued ens-auth-token elsewhere) and hit a documented method+path", async () => {
  const documented = Object.entries(spec.paths).flatMap(([p, ops]) => Object.keys(ops).filter((m) => !["parameters", "servers"].includes(m)).map((m) => ({ m: m.toUpperCase(), re: new RegExp("^" + p.replace(/\{[^}]+\}/g, "[^/]+") + "$") })));
  assert.ok(requests.length > 60);
  for (const r of requests) {
    assert.ok(documented.some((t) => t.m === r.method && t.re.test(r.path)), `undocumented call ${r.method} ${r.path}`);
    assert.equal(r.authorization, undefined);
    if (r.path === "/authenticate") {
      assert.equal(r.method, "POST");
      assert.equal(r.token, undefined);
      assert.ok(r.raw === API_TOKEN || r.raw === WRONG);
    } else assert.ok(wasIssued(r.token), `${r.method} ${r.path} must carry a session token the mock issued`);
  }
  const used = new Set(requests.map((r) => `${r.method} ${r.path.replace(/\/\d+(?=\/|$)/g, "/{id}")}`));
  assert.deepEqual([...used].sort(), [
    "GET /ma", "GET /ma/{id}", "GET /ma/{id}/stats", "GET /page", "GET /page/{id}", "GET /supporter", "GET /supporter/fields", "GET /supporter/query", "GET /supporter/questions", "GET /supporter/questions/{id}",
    "GET /supporter/{id}", "GET /supporter/{id}/transactions", "GET /supporter/{id}/transactions/recurring", "POST /authenticate", "PUT /supporter/{id}",
  ]);
});

mock.close();
console.log(`\n${passed} checks passed, ${requests.length} API calls made against the mock, in ${((Date.now() - started) / 1000).toFixed(1)} s.`);
