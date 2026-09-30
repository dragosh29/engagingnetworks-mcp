// Built at run time so secret scanners do not read a test value as a real password.
export const FAKE_PASSWORD = ["not", "a", "real", "pw"].join("-");
// Fake Engaging Networks data shaped like the response schemas and examples in the ENS OpenAPI document
// (validated in e2e.mjs). Supporter records use the account's field names as keys, as in the
// supporterDetail and getSupporterByEmail examples. Every name, email and number here is invented;
// phone numbers use the UK drama range (07700 900xxx) or the North American fictional 555-01xx range, and
// emails example.org/example.com/example.net.
const DAY = 86_400_000;
export const TODAY = Date.UTC(2026, 8, 30); // 2026-09-30, the mock's "now" for daysBack
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);

// ---- Pages (listPages items / getPageDetails) ----
export const AUTUMN = 946;
export const PETITION = 1210;
export const GALA = 1302;
export const WINTER = 1405;
const pageBase = (id, campaignId, name, title, type, subType, status, created, modified, locale = "en-GB") => ({
  id,
  campaignId,
  name,
  title,
  type,
  ...(subType ? { subType } : {}),
  clientId: 94,
  createdOn: created,
  modifiedOn: modified,
  campaignBaseUrl: "https://donate.example.org",
  campaignStatus: status,
  defaultLocale: locale,
});
export const pages = [
  pageBase(AUTUMN, 3557, "Autumn Rise (live iats)", "Autumn Rise", "nd", undefined, "live", 1465981693000, 1696332536000),
  // North American contact details in a title: a bracketed area code, a Canadian postcode and a ZIP+4.
  pageBase(951, 3560, "Monthly giving 2026", "Give monthly: text GIVE to (202) 555-0100, or write to Ottawa ON K1A 0B1 / Washington, DC 20500-0003", "nd", "PREMIUM", "live", 1735689600000, 1756684800000),
  pageBase(PETITION, 11534, "We Want Change", "Sign: we want change", "dc", "PET", "live", 1719792000000, 1722470400000),
  pageBase(1211, 11041, "Create Supporter", "Join us", "dc", "DCF", "live", 1719792000000, 1719792000000),
  pageBase(GALA, 65371, "Anniversary Gala - FINAL", "Anniversary Gala", "ev", undefined, "close", 1704067200000, 1717200000000),
  // A title with contact details typed into it, to prove page names and titles are redacted.
  pageBase(WINTER, 3601, "Winter appeal draft (call 1-800-555-0199 or winter@example.org)", "Winter appeal (queries: donations@example.org or 0117 496 0000)", "nd", undefined, "new", 1756684800000, 1759190400000),
  pageBase(1500, 3700, "Carbon survey", "Tell us what you think", "dc", "SURVEY", "tested", 1740787200000, 1740787200000, "fr-CA"),
];
// getPageDetails adds trackingParameters, campaignAttributes and template.
export const pageDetails = Object.fromEntries(
  pages.map((p) => [p.id, { ...p, trackingParameters: ["facebook", "email"], campaignAttributes: p.type === "nd" ? ["animal", "health"] : [], template: "Main Template - Relaunch" }]),
);

// ---- Supporter fields (listSupporterFields), including the payment-related fields of the spec's example ----
export const fields = [
  { id: 5253, name: "SFDC_Contact_ID", tag: "Not Tagged", property: "NOT_TAGGED_19" },
  { id: 2913, name: "Email Address", tag: "Email Address", property: "emailAddress" },
  { id: 2906, name: "Title", tag: "Title", property: "title" },
  { id: 2907, name: "First Name", tag: "First Name", property: "firstName" },
  { id: 2908, name: "Last Name", tag: "Last Name", property: "lastName" },
  { id: 2909, name: "Address 1", tag: "Address 1", property: "address1" },
  { id: 2914, name: "Postcode", tag: "Postcode", property: "postcode" },
  { id: 2911, name: "City", tag: "City", property: "city" },
  { id: 2915, name: "Country", tag: "Country", property: "country" },
  { id: 2917, name: "Appeal Code", tag: "Appeal Code", property: "appealCode" },
  { id: 2920, name: "Phone Number", tag: "Phone Number", property: "phoneNumber" },
  { id: 2930, name: "Credit Card Holder Name", tag: "Credit Card Holder Name", property: "creditCardHolderName" },
  { id: 2928, name: "Bank Account Number", tag: "Bank Account Number", property: "bankAccountNumber" },
  { id: 2929, name: "Bank Routing Transit Number", tag: "Bank Routing Transit Number", property: "bankRoutingNumber" },
  { id: 2926, name: "Password", tag: "Password", property: "password" },
  { id: 3244, name: "Supporter Birthday", tag: "Supporter Birthday", property: "dateOfBirth" },
  { id: 5036, name: "PayPal Billing Agreement", tag: "Not Tagged", property: "NOT_TAGGED_15" },
  // Custom payment fields an account might add, named in ways the old card/bank pattern missed.
  { id: 5301, name: "Payment Token", tag: "Not Tagged", property: "NOT_TAGGED_21" },
  { id: 5302, name: "cc_num_last4", tag: "Not Tagged", property: "NOT_TAGGED_22" },
  // A renamed standard field: the record key is the field name, the tag says what it is.
  { id: 2919, name: "constituent_middle_name", tag: "Middle Name", property: "middleName" },
];

// ---- Questions (listSupporterQuestions / viewQuestion) ----
export const Q_DOUBLE = 15084;
export const Q_EMAIL = 1531;
export const Q_SMS = 1532;
export const Q_FEEDBACK = 42004;
export const questions = [
  { id: Q_DOUBLE, questionId: 784, name: "Email Opt-in (double)", type: "CONF" },
  { id: Q_EMAIL, questionId: 279, name: "Opt-in Email (single)", type: "OPT" },
  { id: Q_SMS, questionId: 280, name: "Opt-in SMS", type: "OPT" },
  { id: Q_FEEDBACK, questionId: 1064, name: "Consultation Feedback Question", type: "GEN" },
];
export const questionDetails = {
  [Q_EMAIL]: [
    { id: Q_EMAIL, questionId: 279, name: "Opt-in Email (single)", type: "OPT", locale: "en-GB", label: "", htmlFieldType: "checkbox", content: { data: [{ selected: false, value: "Y", label: "Yes, please sign me up to receive electronic mail communication.", forId: "", imageUrl: "" }] } },
    { id: Q_EMAIL, questionId: 279, name: "Opt-in Email (single)", type: "OPT", locale: "fr-CA", label: "", htmlFieldType: "checkbox", content: { data: [{ selected: false, value: "Y", label: "Oui, je veux recevoir des courriels.", forId: "", imageUrl: "" }] } },
  ],
  [Q_DOUBLE]: [
    { id: Q_DOUBLE, questionId: 784, name: "Email Opt-in (double)", type: "CONF", locale: "en-GB", label: "Would you like sign up to our newsletter?", htmlFieldType: "radio", content: { data: [{ selected: false, value: "Y", label: "Yes", forId: "", imageUrl: "" }, { selected: false, value: "N", label: "No", forId: "", imageUrl: "" }] } },
  ],
  [Q_SMS]: [{ id: Q_SMS, questionId: 280, name: "Opt-in SMS", type: "OPT", locale: "en-GB", label: "Texts", htmlFieldType: "checkbox", content: { data: [{ selected: false, value: "Y", label: "Yes, text me", forId: "", imageUrl: "" }] } }],
  [Q_FEEDBACK]: [
    { id: Q_FEEDBACK, questionId: 1064, name: "Consultation Feedback Question", type: "GEN", locale: "en-GB", label: "Choose a range", htmlFieldType: "range", content: { rangeData: { min: "1", max: "10", minLabel: "Min", maxLabel: "Max", step: "1", showCurrent: true }, value: "1" } },
  ],
};

// Every North American form the redaction recognises: bracketed, hyphens, dots, spaces, a leading 1, a
// Canadian postcode with and without its space, a ZIP+4, and a ZIP after a state code.
export const LEE_ANSWER = "Call (613) 555-0142 or 202-555-0173 or 416.555.0199 or 1-800-555-0199 or 312 555 0123; mail Ottawa ON K1A 0A2 or K1A0B1, Washington DC 20500-0003, San Francisco, CA 94105";
export const LEE_LEAKS = ["555-0142", "555-0173", "555.0199", "555-0199", "555 0123", "K1A", "20500", "94105"];

// ---- Supporters (supporterDetail / getSupporterByEmail), keyed by the account's field names ----
export const OTTO = 212200;
export const LEE = 212201;
export const NO_HISTORY = 212202;
export const OTTO_EMAIL = "otto.nv@example.com";
// The question responses on a supporter record use the types OPTIN / GENERAL / CONFIRMATION (the list
// of questions uses OPT / GEN / CONF).
const ottoQuestions = [
  { id: 279, componentId: 0, name: "Opt-in Email (single)", type: "OPTIN", response: "Y", modifiedOn: 1709816235000, netdonorLogId: 0 },
  { id: 784, componentId: 0, name: "Email Opt-in (double)", type: "CONFIRMATION", response: "N", modifiedOn: 1709816235000, netdonorLogId: 0 },
  { id: 1064, componentId: 0, name: "Consultation Feedback Question", type: "GENERAL", response: "Contact me at otto.alt@example.com or 07700 900789, I live at EC1M 5PX", modifiedOn: 1709816235000, netdonorLogId: 0 },
];
const ottoMemberships = [
  {
    id: 2429,
    clientId: 94,
    membershipId: "ENMMIA2284272885",
    membershipName: "Free Membership (1 year)",
    donationId: 1435806,
    termStartDate: 1698292800000,
    termEndDate: 1729915200000,
    expireDays: 199,
    membershipPaid: 0,
    membershipCost: 0,
    membershipStatus: "ACTIVE",
    membershipState: "NEW",
    members: [{ firstName: "Otto", lastName: "Normalverbraucher" }],
    history: [{ termEndDate: 1729915200000, termStartDate: 1698292800000, membershipCost: 0, id: 2429, createdOn: 1698335046000, membershipPaid: 0, membershipName: "Free Membership (1 year)" }],
  },
];
export const OTTO_CARD = "4111 1111 1111 1111"; // the well-known Visa test number, typed into a custom field
const named = [
  {
    supporterId: OTTO,
    suppressed: false,
    "Email Address": OTTO_EMAIL,
    Title: "Mr",
    "First Name": "Otto",
    constituent_middle_name: "Niemand",
    "Last Name": "Normalverbraucher",
    "Address 1": "64 Clerkenwell Road",
    Postcode: "EC1M 5PX",
    City: "London",
    Country: "GB",
    "Appeal Code": "EOY",
    "Phone Number": "+44 7700 900123",
    "Supporter Birthday": "1980-04-12",
    "Credit Card Holder Name": "O NORMALVERBRAUCHER",
    "Bank Account Number": "00012345",
    "Bank Routing Transit Number": "400000",
    Password: FAKE_PASSWORD,
    "PayPal Billing Agreement": "B-TESTNOTREAL0001",
    SFDC_Contact_ID: `note: card ${OTTO_CARD}`,
    // Payment-looking custom fields: two in the fields list, three known only by their record key.
    "Payment Token": "tok-test-not-real",
    cc_num_last4: "4242",
    "Card Expiration Date": "12/29",
    ccExpiry: "1229",
    "Direct Debit Mandate": "DDM-TEST-NOT-REAL",
    "Send Offset": "+01:00",
    questions: ottoQuestions,
    memberships: ottoMemberships,
    createdOn: Date.UTC(2026, 8, 25),
    modifiedOn: Date.UTC(2026, 8, 29),
  },
  // A North American supporter whose name fields and general answer have contact details typed into them.
  {
    supporterId: LEE,
    suppressed: true,
    "Email Address": "lee.chen@example.net",
    "First Name": "Lee (lee.chen@example.net)",
    "Last Name": "Chen (cell 613-555-0142)",
    Country: "US",
    questions: [{ id: 1064, componentId: 0, name: "Consultation Feedback Question", type: "GENERAL", response: LEE_ANSWER, modifiedOn: 1709816235000, netdonorLogId: 0 }],
    createdOn: Date.UTC(2026, 8, 20),
    modifiedOn: Date.UTC(2026, 8, 28),
  },
  { supporterId: NO_HISTORY, suppressed: false, "Email Address": "sam.evans@example.org", "First Name": "Sam", "Last Name": "Evans", Country: "GB", createdOn: Date.UTC(2026, 7, 1), modifiedOn: Date.UTC(2026, 7, 1) },
].map((s) => Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined)));
// 250 more supporters so a query spans three pages of 100. createdOn / modifiedOn are kept apart from
// the record (the mock uses them for latestCreated / latestModified / daysBack).
const bulk = Array.from({ length: 250 }, (_, i) => ({
  supporterId: 300000 + i,
  suppressed: i % 50 === 0,
  "Email Address": `person${i}@example.org`,
  "First Name": i % 10 === 0 ? "Bob" : `Person${i}`,
  "Last Name": `Surname${i}`,
  Country: i % 3 === 0 ? "US" : i % 3 === 1 ? "GB" : "CA",
  createdOn: TODAY - (i % 60) * DAY,
  modifiedOn: TODAY - (i % 20) * DAY,
}));
export const supporterRows = [...named, ...bulk];
/** The record as the API returns it: without the mock-only createdOn/modifiedOn, and optionally without questions/memberships. */
export const supporterRecord = (s, { questions: withQ = false, memberships: withM = false } = {}) => {
  const { createdOn, modifiedOn, questions: q, memberships: m, ...rest } = s;
  return { ...rest, ...(withQ && q ? { questions: q } : {}), ...(withM && m ? { memberships: m } : {}) };
};
/** A supporterQuery `data` row. */
export const queryRow = (s) => ({ emailAddress: s["Email Address"], supporterId: s.supporterId, modifiedOn: ymd(s.modifiedOn), createdOn: ymd(s.createdOn) });
export const PROFILE = 1551;
export const profileMembers = bulk.slice(0, 7).map((s) => s.supporterId);

// ---- Transactions (listTransactions), shaped like the spec's examples for each type ----
export const GATEWAY_REF = "ND-test-gateway-ref-not-real__cus_testnotreal";
export const transactions = {
  [OTTO]: [
    { campaignId: 10432, type: "et", name: "Email Westminster MP", id: 7857947, xref1: "Mayor", xref2: "Representative", createdOn: "01/03/2026", createdDate: 1772323200 },
    { campaignId: 11041, type: "dc", name: "Create Supporter", id: 7857945, xref1: null, xref2: null, subtype: "DCF", createdOn: "01/03/2026", createdDate: 1772323200 },
    { campaignId: 11534, type: "dc", subtype: "PET", name: "We Want Change", id: 7857946, xref1: null, xref2: null, createdOn: "02/03/2026", createdDate: 1772409600 },
    { createdDate: 1772496000000, campaignId: 3557, exportType: "FCS", type: "nd", name: "Autumn Rise (live iats)", id: 857947, txType: "CREDIT_SINGLE", recurringPayment: "N", status: "success" },
    { createdDate: 1772582400000, firstRecurring: true, campaignId: 3560, exportType: "FCR", type: "nd", name: "Monthly giving 2026", id: 857948, txType: "CREDIT_RECURRING", recurringPayment: "Y", status: "success" },
    { createdDate: 1772668800000, campaignId: 65371, exportType: "ECS", type: "ev", name: "Anniversary Gala - FINAL", id: 857949, txType: "CREDIT_SINGLE", recurringPayment: "N", status: "refund" },
    { type: "EMAIL", broadcastId: 1536 },
    {
      type: "p2p",
      lastName: "Normalverbraucher",
      role: "Team Captain",
      campaignId: 4031,
      primaryParticipant: "Y",
      siteName: "Run for Rivers 2026",
      pageId: 5042,
      pageName: "Otto runs for rivers",
      firstName: "Otto",
      teamPageName: "Clerkenwell Striders",
      exportType: "PFTC",
      siteId: 77,
      id: 9001,
      email: OTTO_EMAIL,
    },
  ],
  [LEE]: [
    { createdDate: 1772496000000, campaignId: 3601, exportType: "FCS", type: "nd", name: "Winter appeal draft (call 1-800-555-0199 or winter@example.org)", id: 857990, txType: "CREDIT_SINGLE", recurringPayment: "N", status: "reject" },
    // A peer-to-peer payment (transactionP2Pdonation, type ppay in the spec's discriminator): siteId, no siteName.
    { createdDate: 1772582400, campaignId: 4031, exportType: "PPAY", type: "ppay", name: "Run for Rivers donation", id: 9002, siteId: 77, recurringPayment: false, status: "success" },
  ],
  [NO_HISTORY]: [],
};
export const recurringSchedules = {
  [OTTO]: [
    { amount: 12, paymentDay: 22, campaignId: 3560, currency: "GBP", id: 65952, transactionId: GATEWAY_REF, startDate: "2026-03-22", nextPaymentDate: "2026-10-22", status: "ACTIVE", frequency: "MONTHLY", reason: "Requested via phone on 07700 900456" },
    { amount: 50, paymentDay: 1, campaignId: 3557, currency: "GBP", id: 65953, transactionId: `${GATEWAY_REF}-2`, startDate: "2025-01-01", status: "CANCELED", frequency: "ANNUAL" },
  ],
  [LEE]: [{ amount: 25, paymentDay: 5, campaignId: 3560, currency: "USD", id: 65990, transactionId: `${GATEWAY_REF}-3`, startDate: "2026-01-05", nextPaymentDate: "2026-10-05", status: "ACTIVE", frequency: "MONTHLY", reason: "Donor called from 613-555-0142 to change" }],
  [NO_HISTORY]: [],
};

// ---- Marketing automations (getAutomations / viewAutomation / automationStats) ----
export const MA_DD = 5234;
export const MA_WELCOME = 5240;
export const automations = [
  { id: MA_DD, clientId: 94, name: "Direct Debit FAILURE Notifications", status: "ACTIVE", folderId: 0, ownedBy: 0, createdOn: 1559036857000, modifiedOn: 1559042600000 },
  { id: MA_WELCOME, clientId: 94, name: "Welcome journey - new DONORS", status: "ACTIVE", folderId: 12, ownedBy: 223, createdOn: 1735689600000, modifiedOn: 1756684800000 },
  { id: 5301, clientId: 94, name: "Lapsed donor winback", status: "PAUSED", folderId: 12, ownedBy: 223, createdOn: 1740787200000, modifiedOn: null },
];
export const automationStats = {
  [MA_DD]: { journeyStarts: 9, averageOpenRate: 33.3, averageClickRate: 0, actions: 3, donations: 0, objectiveReached: 0, unsubscribes: 0, smsDeliveryRate: 0, jumps: 0 },
  [MA_WELCOME]: { journeyStarts: 412, averageOpenRate: 48.2, averageClickRate: 6.1, actions: 57, donations: 21, objectiveReached: 19, unsubscribes: 4, smsDeliveryRate: 0, jumps: 2 },
  5301: { journeyStarts: 0, averageOpenRate: 0, averageClickRate: 0, actions: 0, donations: 0, objectiveReached: 0, unsubscribes: 0, smsDeliveryRate: 0, jumps: 0 },
};
