# Engaging Networks MCP server

An [MCP](https://modelcontextprotocol.io) server that lets Claude, ChatGPT and other MCP clients work with an Engaging Networks (ENS) account: campaign pages, supporters, their transaction history and recurring gifts, supporter fields and questions, and marketing automation statistics, and (when enabled) updating a supporter's opt-ins. It is built from Engaging Networks' public developer documentation: the OpenAPI 3.1 document "Engaging Networks Services REST API" v6.5.0 at `developer.engagingnetworks.net/api/rest/engagingnetworks.app.json`, and the knowledge-base pages on the REST services.

Once it's connected, someone at the organisation can ask things like:

- "Which donation pages are live right now, and which petitions have we closed?"
- "Is otto.nv@example.com still opted in to email? Is he a member?"
- "What has supporter 212200 done with us: gifts, petitions, events? Does he have a monthly gift running?"
- "Who signed up in the last week?" / "Find supporters called Bob in the UK or US."
- "How is the welcome journey doing this year: open rate, donations, unsubscribes?"
- With writes enabled: "Otto asked by phone to stop texts: opt him out of SMS."

## Tools

| Tool | What it does | API calls |
|---|---|---|
| `list_pages` | Campaign pages of one type (`nd` donation, `pet` petition, `ev` event, `dcf` data capture, `survey`, `et` email to target, `mem` membership and the other documented types), optionally with one status (`new`, `live`, `close`, `tested`, `block`, `delete`). | `GET /page` |
| `get_page` | One page: type, subtype, status, locale, base URL, template, tracking parameters, attributes. | `GET /page/{id}` |
| `find_supporter` | One supporter by email address or supporter ID: ID, suppression flag, name, and optionally question and opt-in answers and memberships. Every other field only on request (see Safety defaults). The supporter field list is fetched once per session to recognise name fields. | `GET /supporter` or `GET /supporter/{supporterId}`, `GET /supporter/fields` |
| `query_supporters` | The API's supporter queries: `latestCreated`, `latestModified` (with `daysBack` 1-32), `suppressed`, `profile` (with `profileId`) and `search` (with a `filter` such as `firstName:Bob~country:GB\|\|US`). Returns supporter IDs with created and modified dates, paged 100 at a time. | `GET /supporter/query` |
| `get_supporter_transactions` | A supporter's history (donations, event tickets, petition signatures, emails to targets, data captures, email broadcasts, peer-to-peer) with page names, dates and statuses, plus their recurring schedules (amount, currency, frequency, status, next payment date). The history list has no amounts; only the recurring schedules do. `max_results` (default 100) caps each list, with counts and totals. | `GET /supporter/{supporterId}/transactions`, `GET /supporter/{supporterId}/transactions/recurring` |
| `list_supporter_fields` | The account's supporter fields: name, tag and standard property. | `GET /supporter/fields` |
| `list_supporter_questions` | Questions and opt-ins with their type (`OPT`, `CONF` for double opt-in, `GEN`). At most `max_results` (default 100), with the total. | `GET /supporter/questions` |
| `get_supporter_question` | How one question is presented per locale: label, field type, answer options or range. At most 50 locales and `max_options` (default 100) options per locale, with the totals. | `GET /supporter/questions/{id}` |
| `list_marketing_automations` | Marketing automations with status, filtered by dashboard folder (the API defaults to the Home folder) and part of the name. At most `max_results` (default 100), with the total. | `GET /ma` |
| `get_marketing_automation` | One automation and its statistics (journey starts, open and click rates, actions, donations, objective reached, unsubscribes, SMS delivery rate, jumps), optionally for a range of months. | `GET /ma/{id}`, `GET /ma/{id}/stats` |
| `update_supporter_opt_ins` | Sets named opt-ins to `Y` or `N` for one supporter and changes nothing else. The names are checked against the account's questions first: general questions are refused, and so is setting a double opt-in (`CONF`) question to `Y`. Writes only. | `GET /supporter/questions`, `PUT /supporter/{supporterId}` |

Authentication uses `POST /authenticate` (see Setup).

Not covered on purpose: page processing (donations, actions and card payments through `/page/{id}/process`), survey responses (the response schema and the example for `GET /page/{id}/survey` disagree on its shape), single-transaction detail (`GET /supporter/{supporterId}/transactions/{transactionId}` takes the payment gateway's transaction ID, which the history list does not return, and answers with card digits and expiry), page components, import formats, creating, updating or deleting supporters beyond opt-ins, bulk suppression, origin sources, migrating or changing recurring gifts, export jobs and their downloads, adding supporters to automations in bulk, the audit log, and the token validation and retirement endpoints.

## Setup

Requires Node 18 or later.

```bash
npm install
npm run build
```

You need the token of an **API User**. An administrator of your Engaging Networks account creates the API user in the dashboard, gives it permissions (for example view permission on supporter data), and whitelists the IP address of the machine this server runs on. The server posts that token to `/authenticate`, receives a session token, and sends it in the `ens-auth-token` header of every other call. The session token is cached, renewed a minute before its documented expiry, and fetched again once if a call answers 401 "Invalid ens-auth-token".

**Claude Desktop:** add this to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "engagingnetworks": {
      "command": "node",
      "args": ["/absolute/path/to/engagingnetworks-mcp/dist/index.js"],
      "env": { "ENGAGINGNETWORKS_API_TOKEN": "your-api-user-token", "ENGAGINGNETWORKS_REGION": "ca" }
    }
  }
}
```

**Claude Code:**

```bash
claude mcp add engagingnetworks -e ENGAGINGNETWORKS_API_TOKEN=your-api-user-token -e ENGAGINGNETWORKS_REGION=ca -- node /absolute/path/to/engagingnetworks-mcp/dist/index.js
```

| Variable | Required | Meaning |
|---|---|---|
| `ENGAGINGNETWORKS_API_TOKEN` | yes | The API User token. |
| `ENGAGINGNETWORKS_REGION` | no | The datacentre your account is on, from the spec's server list: `ca` (Canada / Europe, `https://ca.engagingnetworks.app/ens/service`, the default), `us` (`https://us.engagingnetworks.app/ens/service`) or `us2` (`https://us2.engagingnetworks.app/ens/service`). |
| `ENGAGINGNETWORKS_BASE_URL` | no | Overrides the region's base URL. Used by the tests. |
| `ENGAGINGNETWORKS_ALLOW_WRITES` | no | `true` to register `update_supporter_opt_ins`. Off by default. |

## Safety defaults

- Read-only unless `ENGAGINGNETWORKS_ALLOW_WRITES=true`. Read tools carry the MCP `readOnlyHint` annotation; `update_supporter_opt_ins` is marked as a write that is not destructive and is idempotent. There is no tool that sends email, processes a page or a payment, or deletes anything.
- Supporter records come back with the account's own field names as keys. By default `find_supporter` returns the supporter ID, the suppression flag, the name fields (title, first, middle and last name, recognised through `/supporter/fields` by field name or tag), opt-in and question answers when asked for, and memberships when asked for. Every other field (email address, phone numbers, postal addresses, date of birth, appeal code and custom fields) is withheld and only its name is listed; `include_contact_details` returns them as stored.
- Card and bank data are never returned, with or without `include_contact_details`: fields whose standard property is a card holder name, bank account number, routing number, bank account type or password are dropped and only counted, and so is any field whose name or tag, split into words (`_`, `-` and `.` as separators, camelCase split, so `ccExpiry` reads as "cc Expiry"), contains the word card or cards, credit card, cc followed by num, number, no, exp, expiry, expiration, cvv, cvc, holder or type, expiry or expiration, token, mandate, debit, CVV/CVC, bank, IBAN, BIC, SWIFT, sort code, routing, account number, no or type, PayPal, billing agreement, password, PAR, BIN, or last 4 / last four. This errs towards dropping: a custom "Membership Expiry" field is dropped too (the memberships list carries the term dates). A payment field named in some other way is not recognised by its name. A card number typed into any returned text (13 to 19 digits passing the Luhn check) is replaced by `[card number redacted]`, also on request. Recurring schedules never include the payment gateway's transaction ID (which embeds the processor's customer reference), and the endpoint that answers with card digits and expiry (single-transaction detail) is never called.
- In free text (question answers of every type, supporter, peer-to-peer and member names, email-to-target targets, recurring-gift change reasons, page names and titles, and Engaging Networks' own error messages) email addresses (also URL-encoded, `name%40example.org`) become `[email redacted]`, phone-number-like sequences `[phone redacted]` and postcodes `[postcode redacted]` by default. Question answers are redacted whatever their `type` says; the opt-in values `Y`, `N`, `P` and `D` are unchanged by it. Page names and titles are always redacted (the page tools have no switch). `query_supporters` returns email addresses only on request, and `get_supporter_transactions` returns a peer-to-peer fundraiser's email only on request. The free-text redaction is pattern matching, not a guarantee:
  - phone numbers: international numbers written with `+` or `00`; UK numbers with a bracketed area code and UK-style `0…` numbers of 9 to 11 digits (other digit strings starting with `0` are redacted too); North American numbers as `(613) 555-0142`, `613-555-0142`, `613.555.0142`, `613 555 0142`, optionally after `1` (`1-800-555-0199`). Ten digits written without separators are not recognised.
  - postcodes, in capitals: UK (`EC1M 5PX`), Canadian (`K1A 0A2`, `K1A0A2`), US ZIP+4 anywhere (`20500-0003`), and a five-digit ZIP only directly after a US state code (`DC 20500`, `Washington, DC 20500`; Idaho's `ID` is left out, since "ID 12345" is usually an identifier). A lone five-digit number is left alone.
  - street addresses and dates typed into free text (for example "24 Sussex Dr" or "born 04/12/1980") are not recognised.
- The API user token and the session token are scrubbed from any text passed on: the spec's own 401 example for `/authenticate` echoes the token it was given ("Invalid api key [...]").
- IDs are checked before any call is made: page, supporter, question, profile and automation IDs must be positive integers (the spec types them all as integers), months must be `YYYYMM` with the start not after the end, a `profile` query needs `profile_id` and a `search` query needs `filter` (as the spec says).
- `update_supporter_opt_ins` fetches the account's questions first and refuses, without writing anything, a name that is not a question, a general question, a name given twice, or a double opt-in (`CONF`) question set to `Y`, which would skip the supporter's own confirmation step. The body is `{ "questions": { "<opt-in name>": "Y" | "N" } }`, the shape of the spec's "Update the supporters contact preferences" example, and holds no other field.
- Lists the API returns whole are capped: `list_pages`, `list_supporter_questions`, `list_marketing_automations` and both lists of `get_supporter_transactions` return at most `max_results` entries (default 100, at most 1000) and say how many there are in total; `get_supporter_question` returns at most 50 locales and `max_options` options per locale. `query_supporters` returns at most `max_results` supporters and says which `start` to continue from; if the API returns more rows than were asked for, the continuation starts at the first row that was cut.
- Rate limits, as documented: 5,000 requests per hour per API User, and 200 page-processing requests per 5 minutes from one IP address (this server does no page processing); beyond these limits requests are blocked. The spec documents running out of the hourly allowance as a 401 with the message "... has exceeded its api limit.", not as a 429: that answer is reported as a used-up allowance, and no new session is requested for it. Requests are spaced 200 ms apart; the hourly allowance is not counted locally, because other integrations using the same API user share it. Each `query_supporters` page is one request of up to 100 rows.
- The spec documents no 429. One is still retried at most twice for any method, including the `PUT`, on the assumption that a rate-limited request was not processed (see Status). The retry waits for `Retry-After` (whole or fractional seconds, or an HTTP-date; 2 s then 4 s when the header is absent). Each wait is capped at 10 seconds; if a longer wait is asked for the call gives up at once and says how long to wait.
- 502, 503 and 504 are retried the same way for `GET` and for `POST /authenticate` only; when all three attempts fail the error says the service may be unavailable, without the gateway's HTML. The `PUT /supporter/{supporterId}` is never retried after a gateway error, because it may already have been applied; the error says to check with `find_supporter` first.
- A 200 whose body is not JSON (a proxy or a login page in the way) is reported as an error naming the region and base URL settings, never as an empty list; the excerpt goes through the redaction first.

## Tests

```bash
npm test
```

The test suite:

1. Validates every fixture record against the response schemas in the ENS OpenAPI document (pages and page details, supporter fields, questions and question details, supporter records by email and by ID, supporter query rows, transactions, recurring schedules, automations and automation stats). The spec is downloaded from `developer.engagingnetworks.net` to `spec.json` on the first run. Three Ajv settings work around defects in the document: `unicodeRegExp: false` (the locale pattern `^[a-z]{2,3}\-[A-Z]{2}$` is invalid as a Unicode regular expression), `validateSchema: false` (some schemas give `examples` as an object) and `strict: false` (OpenAPI keywords). Two schema defects are handled explicitly and asserted: the supporter schemas' `questions[].response` pattern rejects `Y`, `N` and any punctuation, including the spec's own getSupporterByEmail example and the pattern's own example value, so fixtures are validated against a copy without that one pattern; and the page `subType` schema rejects the empty string the spec's page examples use, so the fixtures omit `subType` instead. The transaction list schema is an `anyOf` of objects with nothing required, so each transaction fixture is also checked for the keys of the spec's example of its type. Peer-to-peer payments (`ppay`, `pacs`, `pacr`) are mapped by the spec's discriminator to `transactionP2Pdonation`, but every transaction schema's own `type` enum leaves those values out, and that schema's `campaignId` and `status` are `oneOf`s that any ordinary value matches more than once; the `ppay` fixture is validated against its properties with those two read as `anyOf`, and each defect is asserted. Negative controls check that the schemas reject an undocumented page type and recurring frequency.
2. Starts a local mock of the API under `/ens/service` that implements `POST /authenticate` (the API user token as the raw body or as a JSON-quoted string, since the spec can be read either way, answering 401 with the documented "Invalid api key [...]" body, messageId 10000000, for a wrong one), `GET` and `DELETE /authenticate/{ens-auth-token}`, the `ens-auth-token` check with the documented 401 "Invalid ens-auth-token", the documented `type` and `status` page filters, the five supporter query types with `start`/`rows` paging, `daysBack`, `profileId` and `filter`, the `folderId` and `name` automation filters, and the opt-in update. It answers the first `GET /ma` with a 429. Its authentication, list, record, update and error responses are validated against the documented schemas; the 404 body (the spec documents no 404) is checked against the documented `{ message }` error shape.
3. Starts the built server and drives it over stdio with the official MCP client: 31 checks covering tool annotations; the first call's `POST /authenticate` with the raw token body (asserted as the reading this client implements, not as conformance) and JSON content type, then reuse of the session token; `list_pages` passing `type` and `status` exactly, with name and title redaction (UK and North American phone numbers, Canadian postcodes, ZIP codes) and `max_results`; `get_page`; `find_supporter` by email and ID with names only by default, the renamed middle-name field recognised through `/supporter/fields`, the withheld field names, `includeQuestions` and `includeMemberships` sent only when asked, redaction of emails, UK phone numbers and postcodes in answers and names, and of North American phone numbers, Canadian postcodes and ZIP codes in a supporter's name and general answer; answers with an undocumented type (`GEN`, lower case, none) redacted too; every field returned with `include_contact_details` except the five card, bank, password and PayPal fields of the spec's example, five custom payment fields (a token, `cc_num_last4`, a card expiration date, `ccExpiry`, a direct debit mandate) and a Luhn-valid card number typed into a custom field; unknown emails (404, or 200 without a supporter) as "not found"; `query_supporters` paging at start 0, 100 and 200 up to the documented total of 253 and stopping, with requests at least 190 ms apart (the 200 ms spacing), continuing from `start`, a correct continuation when the API returns more rows than asked for, an echoed filter in an error message with its URL-encoded email and phone number redacted, and passing `daysBack`, `profileId` and `filter` through exactly, with the profile and search requirements refused locally; `get_supporter_transactions` with every documented transaction shape, seconds and milliseconds timestamps, recurring schedules without the gateway reference, the P2P email only on request, `max_results` capping the recurring schedules too, page names and a North American change reason redacted, and a `ppay` payment keeping its site ID; the question tools, and the caps on questions, question options and locales, and automations; the automation tools after a 429 retry that waits for `Retry-After`, with `folderId`, `name`, `startMonth` and `endMonth` passed through and bad month ranges refused locally; the opt-in update's body validated against the documented `PUT /supporter/{supporterId}` request schema and its local refusals; invalid IDs and out-of-range `max_results` / `max_options` refused before any request, and the 404 message; the session token scrubbed from an error the API echoes it in; four concurrent calls on an expired session sharing one `POST /authenticate`; a retired session replaced once and the call retried; a short-lived session renewed before it expires; the documented usage-limit 401 on a data call (no new session) and on `/authenticate`; a persistent 429 giving up after three attempts and a `Retry-After` above the cap giving up at once; HTTP-date and fractional `Retry-After`; a GET failing three times with 503, a 502 retried on a GET and on `POST /authenticate` and never on the `PUT`; a non-JSON 200 and a 200 from `/authenticate` without a token; the write gate with the variable unset and set to `false`; a wrong API token giving an actionable message with the echoed token scrubbed; and that every request used a documented method and path, with the raw token only on `POST /authenticate` and a mock-issued `ens-auth-token` on everything else.

The suite runs in about 35 seconds.

## Status

This is a working prototype. It has **not been run against the live API**, because it was built without an Engaging Networks account (the company offers no trial or sandbox that we could find). Everything below is taken from the published spec and knowledge base and should be confirmed on a real account:

- The body of `POST /authenticate`. The spec types it as a JSON `string` under `application/json`; the knowledge base says to put "the token in the body". This server sends the token as the raw body, without JSON quotes. If the API expects a JSON-encoded string (`"..."`), that is a one-line change. The mock accepts both forms, so the tests do not settle this.
- The session lifetime: `expires` is documented in milliseconds (example 3,600,000, one hour), and an expired or retired session is assumed to answer 401 "Invalid ens-auth-token".
- Which datacentre a UK account is on. The default region is `ca` (the first server in the spec, labelled "Canada / Europe").
- What `GET /supporter?email=` answers for an address that is not on the account, and what any endpoint answers for an unknown ID: the spec documents only 200 and 401 (and a 204 for single-transaction detail). The server treats a 404, or a 200 without `supporterId`, as "not found".
- Whether supporter record keys are the account's field names or its tags. The spec's examples use names such as "Email Address" and "First Name", which are both in its fields example; the server matches either.
- The real values in `questions[].response` (the spec's example is `Y`, while its schema's pattern forbids it), and whether general answers are returned in full. Every answer goes through the redaction whatever its type, so this does not affect what is withheld.
- Peer-to-peer payment transactions (`ppay`, `pacs`, `pacr`): the spec's discriminator maps them to a schema with `siteId`, but the `type` enums leave them out; the server reads `site_id` from any transaction that has one.
- Whether a real page list carries `subType: ""` for pages without a subtype, as the spec's examples do; the server treats an empty subtype as none.
- The `start` parameter of `GET /supporter/query`. The parameter's example is 0 and the server treats it as the 0-based index of the first row, but the response example shows `"start": 1` for a one-row result. If it is 1-based, the paging offset is one row out. Also to confirm: what `rows` above 100 does, whether a page can hold more rows than asked for (handled, but not observed), which query types honour `daysBack`, and the sort order of each query type.
- The `filter` syntax of search queries is passed on exactly as given; which field names it accepts (the example uses `firstName` and `country`) is not documented beyond that example.
- `GET /supporter/questions/{id}`: whether `{id}` is the question's `id` or its `questionId` (the list returns both; the detail example uses `id`).
- `GET /ma` without `folderId`: documented as defaulting to the Home folder, so automations in other folders need `folder_id`. Whether the `name` filter is case-sensitive is not documented; the mock matches case-insensitively.
- `createdDate` in the transaction list: the spec's examples mix seconds (1519918699) and milliseconds (1424408400000); values below 10^11 are read as seconds. `createdOn` (for example "01/03/2018") is passed on as a string because the day/month order is not documented.
- The transaction history list carries no amounts; single-gift amounts are only in the per-transaction detail, which needs the gateway's transaction ID that the list does not return. Confirm whether the list on a real account includes more than the spec shows.
- `PUT /supporter/{supporterId}` with only a `questions` object: that it changes only those opt-ins, that questions are keyed by their dashboard name, and what it answers for an unknown name (the documented 400 "The following fields are not present in the account" belongs to `POST /supporter`).
- A 429 on the `PUT` is retried on the assumption that a rate-limited request was not processed; the spec documents no 429 at all.
- Which API user permissions each endpoint needs, and what a missing permission looks like (a 403 is assumed and reported as a permission problem; it is not documented).
- The statistics' month range: whether `startMonth` and `endMonth` are inclusive and what the defaults are.

`find_supporter` cannot search by name; `query_supporters` with type `search` and a `filter` on name fields is the documented way.

## Going to production

This version runs locally over stdio, with the API user's own token, and the machine it runs on must be whitelisted for that API user. For organisations to connect from claude.ai or ChatGPT without handling tokens, the next step is a remote server (Streamable HTTP) behind OAuth, hosted by Engaging Networks, and then a listing in the Claude and ChatGPT connector directories.

## Licence

MIT. Built by Alexandru Dragoș (alexandru.dragos96@gmail.com) with an AI agent (Claude) working under his direction.
