// Turn Engaging Networks API records into compact objects an assistant can read quickly.
// Field names follow the response schemas and examples in the ENS OpenAPI document (listPages,
// getPageDetails, getSupporterByEmail, supporterDetail, supporterQuery, listTransactions,
// listRecurringTransactions, listSupporterFields, listSupporterQuestions, viewQuestion,
// getAutomations, viewAutomation, automationStats).

type Rec = Record<string, any>;

// Email addresses, also URL-encoded ("otto%40example.com", as echoed back in an error about a query filter).
const EMAIL = /[A-Za-z0-9._%+-]+(?:@|%40)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Phone-number-like sequences, a heuristic. Five shapes, digits optionally separated by a space, dot
// or hyphen:
//   international: "+" or "00", a 1-3 digit country code, an optional "(0)" trunk prefix, then 6-14
//     digits (+44 7700 900123, +447700900321, +44 (0)7700 900123, 0044 20 7946 0958, +1 613 555 0142);
//   bracketed UK area code: "(0...)" then 5-10 digits ((020) 7946 0958, (0117) 496 0000);
//   UK national: "0" then 8-10 more digits (07700 900789, 020 7946 0958, 07700.900123);
//   North American with a bracketed area code, optionally after "1": (613) 555-0142, (202)555.0100,
//     1 (800) 555 0199;
//   North American in three groups with the same separator, optionally after "1" and a separator:
//     613-555-0142, 416.555.0199, 202 555 0173, 1-800-555-0199.
// North American area codes and exchanges start with 2-9. Bounded by characters other than letters,
// digits, "_" and "-", so numeric IDs and hyphenated references are left alone. Any other 9-11 digit
// string starting with 0 is redacted too. Ten digits written without separators (6135550142) are not
// recognised. The raw text is available with include_contact_details.
const PHONE =
  /(?<![\w-])(?:(?:\+|00)[ .-]?[1-9]\d{0,2}(?:[ .-]?\(0\))?(?:[ .-]?\d){6,14}|\(0\d{0,4}\)(?:[ .-]?\d){5,10}|0(?:[ .-]?\d){8,10}|(?:1[ .-]?)?\([2-9]\d{2}\)[ .-]?[2-9]\d{2}[ .-]?\d{4}|(?:1[ .-])?[2-9]\d{2}([ .-])[2-9]\d{2}\1\d{4})(?![\w-])/g;
// Postcodes, upper case only so ordinary words are left alone, and not touching other letters or digits:
//   UK (EC1M 5PX, SW1A 1AA, M1 1AE, EC1M5PX): one or two capitals, a digit, an optional letter or digit,
//     an optional space, a digit and two capitals;
//   Canadian (K1A 0A2, K1A0B1): letter digit letter, an optional space, digit letter digit, with the
//     letters Canada Post uses;
//   US ZIP+4 anywhere (20500-0003), and a five-digit ZIP (optionally +4) directly after a US state or
//     territory code ("DC 20500", "Washington, DC 20500"). A lone five-digit number is not treated as a
//     ZIP code: it would catch amounts and IDs. Idaho's "ID" is left out of the list, because
//     "ID 12345" is far more often an identifier than an address.
const US_STATES = "AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|PR|GU|VI|AS|MP";
const POSTCODE = new RegExp(
  [
    "(?<![A-Za-z0-9])[A-Z]{1,2}\\d[A-Z\\d]? ?\\d[A-Z]{2}(?![A-Za-z0-9])",
    "(?<![A-Za-z0-9])[ABCEGHJ-NPRSTVXY]\\d[ABCEGHJ-NPRSTV-Z] ?\\d[ABCEGHJ-NPRSTV-Z]\\d(?![A-Za-z0-9])",
    "(?<![\\w-])\\d{5}-\\d{4}(?![\\w-])",
    `(?<=(?<![A-Za-z])(?:${US_STATES}),? )\\d{5}(?:-\\d{4})?(?![\\w-])`,
  ].join("|"),
  "g",
);
// A payment card number typed into free text: 13 to 19 digits, optionally in groups separated by
// spaces or hyphens, that pass the Luhn check. Runs first, and runs even when contact details were
// requested: this server never returns card data.
const CARD = /(?<![\w-])\d(?:[ -]?\d){12,18}(?![\w-])/g;
const luhn = (digits: string): boolean => {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (double) n = n > 4 ? n * 2 - 9 : n * 2;
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
};
export const redactCards = (text: string) => text.replace(CARD, (m) => (luhn(m.replace(/\D/g, "")) ? "[card number redacted]" : m));

const redactString = (text: string) => redactCards(text).replace(EMAIL, "[email redacted]").replace(PHONE, "[phone redacted]").replace(POSTCODE, "[postcode redacted]");

/**
 * Replace email addresses, phone-number-like sequences and UK, Canadian and US postcodes inside free
 * text (names, page titles, question answers, change reasons, error messages) unless contact details
 * were requested. Luhn-valid card numbers are replaced either way. Street addresses and dates typed
 * into free text are not recognised.
 */
export function redactContacts(text: unknown, includeContact: boolean): string | undefined {
  if (typeof text !== "string") return undefined;
  if (text === "") return undefined;
  return includeContact ? redactCards(text) : redactString(text);
}

const str = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : String(v));
const num = (v: unknown) => {
  const n = Number(v);
  return v === undefined || v === null || v === "" || typeof v === "boolean" || !Number.isFinite(n) ? undefined : n;
};
const bool = (v: unknown) => (typeof v === "boolean" ? v : v === "Y" ? true : v === "N" ? false : undefined);
// Timestamps are documented as UNIX epoch milliseconds (createdOn 1576167575000); some transaction
// examples carry seconds (createdDate 1519918699). Values below 1e11 are read as seconds.
const iso = (v: unknown) => {
  const n = num(v);
  if (n === undefined || n <= 0) return undefined;
  return new Date(n < 1e11 ? n * 1000 : n).toISOString();
};
const strings = (v: unknown) => (Array.isArray(v) ? v.map(str).filter((x): x is string => x !== undefined) : undefined);

// ---- Pages (listPages / getPageDetails) ----
// Page names and titles are the account's own content, but free text: contact details typed into them
// are redacted (the page tools have no include_contact_details switch).
export function page(p: Rec) {
  return {
    id: num(p.id),
    campaign_id: num(p.campaignId),
    name: redactContacts(p.name, false),
    title: redactContacts(p.title, false),
    type: str(p.type),
    sub_type: str(p.subType), // the spec's examples carry "" for a page without a subtype
    status: str(p.campaignStatus),
    default_locale: str(p.defaultLocale),
    base_url: str(p.campaignBaseUrl),
    created: iso(p.createdOn),
    modified: iso(p.modifiedOn),
    tracking_parameters: strings(p.trackingParameters),
    attributes: strings(p.campaignAttributes),
    template: str(p.template),
  };
}

// ---- Supporter fields (listSupporterFields) ----
export interface FieldDef {
  id?: number;
  name?: string;
  tag?: string;
  property?: string;
}

export function field(f: Rec) {
  return { id: num(f.id), name: str(f.name), tag: str(f.tag), property: str(f.property) };
}

// A supporter record's keys are the account's field names ("Email Address", "First Name", ...: see the
// supporterDetail example), which differ from account to account. Each key is matched against
// GET /supporter/fields (by name or tag) to find its standard `property`.
const NAME_PROPERTIES: Record<string, string> = { title: "title", firstName: "first_name", middleName: "middle_name", lastName: "last_name" };
// Standard tags, used when the fields list does not know a key.
const DEFAULT_PROPERTIES: Record<string, string> = { Title: "title", "First Name": "firstName", "Middle Name": "middleName", "Last Name": "lastName" };
// Never returned, with or without include_contact_details: the payment-related fields listed in the
// spec's listSupporterFields example (card holder name, bank account number, routing number, account
// type, the PayPal billing agreement) and the supporter password, plus anything whose name or tag looks
// like card, bank or payment data. Names are split into words first: "_", "-" and "." are separators
// and camelCase is split ("ccExpiry" is read as "cc Expiry", "CCNumber" as "CC Number"). Then a field is
// dropped when a word is card/cards, or it mentions credit card, cc with num/number/no/exp/expiry/
// expiration/cvv/cvc/holder/type, expiry or expiration, token, mandate, debit, CVV/CVC, bank, IBAN,
// BIC, SWIFT, sort code, routing, account number/no/type, PayPal, billing agreement, password, PAR,
// BIN or last 4/four. This errs towards dropping (a "Membership Expiry" field is dropped too; the
// memberships list carries term dates anyway).
const NEVER_PROPERTIES = new Set(["creditCardHolderName", "bankAccountNumber", "bankRoutingNumber", "bankAccountType", "password", "creditCardNumber", "creditCardExpiry", "creditCardVerificationValue"]);
const NEVER_NAME =
  /\bcredit ?card|\bcards?\b|\bcc ?(num|number|no|exp|expiry|expiration|cvv|cvc|holder|type)\b|\bexpir(y|ation|es)\b|\btokens?\b|\bmandates?\b|\bdebit\b|\bcvv2?\b|\bcvc2?\b|\bbank\b|\biban\b|\bbic\b|\bswift\b|\bsort ?code|\brouting\b|\baccount ?(number|no|type)\b|\bpay ?pal\b|billing ?agreement|\bpassword\b|\bpar\b|\bbin\b|\blast ?(4|four)\b/i;
const words = (s: string) =>
  s
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[_\-.]+/g, " ");
const neverName = (s: string | undefined) => !!s && NEVER_NAME.test(words(s));

type FieldClass = { kind: "name"; key: string } | { kind: "never" } | { kind: "personal" };

export function classifyField(key: string, fields: FieldDef[]): FieldClass {
  const def = fields.find((f) => f.name === key) ?? fields.find((f) => f.tag === key);
  const property = def?.property ?? DEFAULT_PROPERTIES[key];
  if ((property && NEVER_PROPERTIES.has(property)) || neverName(key) || neverName(def?.tag) || neverName(def?.name)) return { kind: "never" };
  if (property && NAME_PROPERTIES[property]) return { kind: "name", key: NAME_PROPERTIES[property] };
  return { kind: "personal" };
}

// Question responses on a supporter (the `questions` array). Every response goes through the redaction,
// whatever its type says, so an answer with an undocumented or misspelt type ("GEN", "general", none)
// cannot slip through as a consent flag. The documented opt-in values Y, N, P and D are unchanged by it.
export function supporterQuestion(q: Rec, includeContact: boolean) {
  return {
    id: num(q.id),
    name: str(q.name),
    type: str(q.type),
    response: redactContacts(str(q.response), includeContact),
    modified: iso(q.modifiedOn),
  };
}

export function membership(m: Rec, includeContact: boolean) {
  return {
    id: num(m.id),
    membership_id: str(m.membershipId),
    name: str(m.membershipName),
    status: str(m.membershipStatus),
    state: str(m.membershipState),
    term_start: iso(m.termStartDate),
    term_end: iso(m.termEndDate),
    expire_days: num(m.expireDays),
    paid: num(m.membershipPaid),
    cost: num(m.membershipCost),
    donation_id: num(m.donationId),
    members: Array.isArray(m.members) ? m.members.map((x: Rec) => ({ first_name: redactContacts(x.firstName, includeContact), last_name: redactContacts(x.lastName, includeContact) })) : undefined,
    history: Array.isArray(m.history)
      ? m.history.map((h: Rec) => ({ name: str(h.membershipName), term_start: iso(h.termStartDate), term_end: iso(h.termEndDate), paid: num(h.membershipPaid), cost: num(h.membershipCost), created: iso(h.createdOn) }))
      : undefined,
  };
}

/**
 * A supporter record (getSupporterByEmail / supporterDetail). By default: the ID, the suppression
 * flag, the name fields, opt-in answers and memberships; every other field is withheld and only its
 * name is listed. With include_contact_details the other fields are returned as stored. Card, bank
 * and password fields are never returned.
 */
export function supporter(s: Rec, fields: FieldDef[], includeContact: boolean) {
  const name: Record<string, string | undefined> = {};
  const other: Record<string, unknown> = {};
  const withheld: string[] = [];
  let omitted = 0;
  for (const [key, value] of Object.entries(s)) {
    if (["supporterId", "suppressed", "questions", "memberships"].includes(key)) continue;
    const c = classifyField(key, fields);
    if (c.kind === "never") {
      omitted++;
      continue;
    }
    if (c.kind === "name") {
      name[c.key] = redactContacts(typeof value === "string" ? value : str(value), includeContact);
      continue;
    }
    if (!includeContact) {
      if (value !== "" && value !== null && value !== undefined) withheld.push(key);
      continue;
    }
    other[key] = typeof value === "string" ? redactCards(value) : value;
  }
  return {
    supporter_id: num(s.supporterId),
    suppressed: bool(s.suppressed),
    name,
    ...(includeContact ? { fields: other } : { withheld_fields: withheld.length ? withheld : undefined }),
    payment_fields_omitted: omitted || undefined,
    questions: Array.isArray(s.questions) ? s.questions.map((q: Rec) => supporterQuestion(q, includeContact)) : undefined,
    memberships: Array.isArray(s.memberships) ? s.memberships.map((m: Rec) => membership(m, includeContact)) : undefined,
  };
}

// ---- Supporter query rows (supporterQuery `data`) ----
export function queryRow(r: Rec, includeContact: boolean) {
  return {
    supporter_id: num(r.supporterId),
    created_on: str(r.createdOn),
    modified_on: str(r.modifiedOn),
    ...(includeContact ? { email: str(r.emailAddress) } : {}),
  };
}

// ---- Transactions (listTransactions) ----
const P2P_TYPES = new Set(["p2p", "pitm", "ppay", "pacs", "pacr"]);
// An allowlist: gateway transaction IDs, card digits and expiry never appear in the list schema, and
// would not be copied if they did.
export function transaction(t: Rec, includeContact: boolean) {
  const type = str(t.type);
  const out: Rec = {
    id: num(t.id),
    type,
    subtype: str(t.subtype),
    page_name: redactContacts(t.name, false),
    campaign_id: num(t.campaignId),
    date: iso(t.createdDate),
    created_on: str(t.createdOn), // "01/03/2018" in the spec's examples, passed on as stored
    tx_type: str(t.txType),
    status: str(t.status),
    recurring: bool(t.recurringPayment),
    first_recurring: typeof t.firstRecurring === "boolean" ? t.firstRecurring : undefined,
    export_type: str(t.exportType),
    broadcast_id: num(t.broadcastId),
  };
  // Email to Target / e-card: xref1 and xref2 carry the target (a name and a role in the examples).
  if (t.xref1 !== undefined || t.xref2 !== undefined) out.target = { xref1: redactContacts(t.xref1, includeContact), xref2: redactContacts(t.xref2, includeContact) };
  // Peer-to-peer registrations, purchases and payments (transactionP2P, transactionPITM, and
  // transactionP2Pdonation, which the spec's discriminator maps from ppay, pacs and pacr and which carries
  // siteId but no siteName).
  if (P2P_TYPES.has(type ?? "") || t.siteName !== undefined || t.siteId !== undefined) {
    out.p2p = {
      site_id: num(t.siteId),
      site_name: redactContacts(t.siteName, false),
      page_id: num(t.pageId),
      page_name: redactContacts(t.pageName, false),
      team_page_name: redactContacts(t.teamPageName, false),
      role: str(t.role),
      primary_participant: bool(t.primaryParticipant),
      first_name: redactContacts(t.firstName, includeContact),
      last_name: redactContacts(t.lastName, includeContact),
      product_id: num(t.productId),
      product_price: num(t.productPrice),
      ...(includeContact ? { email: str(t.email) } : {}),
    };
  }
  return out;
}

// ---- Recurring schedules (listRecurringTransactions) ----
// The gateway transaction ID (which embeds the payment processor's customer reference) is never returned.
export function recurring(r: Rec, includeContact: boolean) {
  return {
    id: num(r.id),
    campaign_id: num(r.campaignId),
    amount: num(r.amount),
    currency: str(r.currency),
    frequency: str(r.frequency),
    status: str(r.status),
    start_date: str(r.startDate),
    next_payment_date: str(r.nextPaymentDate),
    payment_day: num(r.paymentDay),
    reason: redactContacts(r.reason, includeContact),
  };
}

// ---- Questions (listSupporterQuestions / viewQuestion) ----
export function question(q: Rec) {
  return { id: num(q.id), question_id: num(q.questionId), name: str(q.name), type: str(q.type) };
}

export function questionDetail(q: Rec, maxOptions = Infinity) {
  const c = q.content && typeof q.content === "object" ? q.content : {};
  const options: Rec[] | undefined = Array.isArray(c.data) ? c.data : undefined;
  return {
    ...question(q),
    locale: str(q.locale),
    label: str(q.label),
    html_field_type: str(q.htmlFieldType),
    option_total: options?.length,
    options_complete: options ? options.length <= maxOptions : undefined,
    options: options?.slice(0, maxOptions).map((o: Rec) => ({ value: str(o.value), label: str(o.label), selected: typeof o.selected === "boolean" ? o.selected : undefined })),
    range: c.rangeData && typeof c.rangeData === "object" ? { min: str(c.rangeData.min), max: str(c.rangeData.max), step: str(c.rangeData.step), min_label: str(c.rangeData.minLabel), max_label: str(c.rangeData.maxLabel) } : undefined,
    default_value: str(c.value),
  };
}

// ---- Marketing automations (getAutomations / viewAutomation / automationStats) ----
export function automation(a: Rec) {
  return { id: num(a.id), name: str(a.name), status: str(a.status), folder_id: num(a.folderId), owned_by: num(a.ownedBy), created: iso(a.createdOn), modified: iso(a.modifiedOn) };
}

export function automationStats(s: Rec) {
  return {
    journey_starts: num(s.journeyStarts),
    average_open_rate: num(s.averageOpenRate),
    average_click_rate: num(s.averageClickRate),
    actions: num(s.actions),
    donations: num(s.donations),
    objective_reached: num(s.objectiveReached),
    unsubscribes: num(s.unsubscribes),
    sms_delivery_rate: num(s.smsDeliveryRate),
    jumps: num(s.jumps),
  };
}
