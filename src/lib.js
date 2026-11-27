// Red Hat Support Case Management API (v3) client, input validation, and Markdown formatters
// for mcp-redhat-support. Kept separate from src/index.js, which starts the stdio transport,
// so tests can import it.

import { mkdir, open, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { htmlToMarkdown } from "./html.js";

export const TOKEN_URL = "https://sso.redhat.com/auth/realms/redhat-external/protocol/openid-connect/token";
export const API_BASE = "https://api.access.redhat.com/support";
export const PORTAL_CASE_URL = "https://access.redhat.com/support/cases/#/case";
const CLIENT_ID = "rhsm-api";
export const UPLOAD_CLIENT_ID = "mcp-redhat-support";

export const FETCH_TIMEOUT_MS = 30000;
export const TRANSFER_TIMEOUT_MS = 600000;

// --- HTTP ---

export async function fetchWithTimeout(url, init = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err?.name === "TimeoutError") {
      throw new Error(`Request to ${new URL(url).host} timed out after ${timeoutMs / 1000}s`);
    }
    throw err;
  }
}

// --- Authentication ---

let cachedToken = null;
let tokenExpiry = 0;

export function clearTokenCache() {
  cachedToken = null;
  tokenExpiry = 0;
  currentAccount = null;
}

export async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry) {
    return cachedToken;
  }

  const offlineToken = process.env.REDHAT_TOKEN;
  if (!offlineToken) {
    throw new Error("REDHAT_TOKEN environment variable is required (Red Hat offline API token)");
  }

  const res = await fetchWithTimeout(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: offlineToken,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  if (!data.access_token) {
    throw new Error("Token exchange returned no access_token");
  }
  const lifetime = Number.isFinite(data.expires_in) ? data.expires_in : 300;
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + Math.max(lifetime - 60, 0) * 1000;
  return cachedToken;
}

// Turn an API error body ({ message, detailMessage } or similar) into one readable line
function apiErrorText(text) {
  try {
    const j = JSON.parse(text);
    const parts = [j.message, j.detailMessage, j.error, j.detail].filter((x) => typeof x === "string" && x);
    if (parts.length) return [...new Set(parts)].join(": ");
  } catch {
    // not JSON
  }
  return text.trim().slice(0, 500);
}

export class ApiError extends Error {
  constructor(status, message) {
    super(`Red Hat Support API error ${status}: ${message}`);
    this.status = status;
  }
}

// Call the Support API. path starts with "/" (e.g. "/v3/cases/01234567"). Retries once on a
// 401 with a fresh access token. Returns parsed JSON, or null for an empty body.
export async function apiRequest(path, { method = "GET", body, query, headers = {}, timeoutMs } = {}) {
  const url = new URL(`${API_BASE}${path}`);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }

  const send = async () => {
    const token = await getAccessToken();
    return fetchWithTimeout(url.href, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }, timeoutMs);
  };

  let res = await send();
  if (res.status === 401) {
    cachedToken = null;
    tokenExpiry = 0;
    res = await send();
  }

  const text = await res.text();
  if (!res.ok) throw new ApiError(res.status, apiErrorText(text) || res.statusText);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// --- Account scoping ---

let currentAccount = null;

// The account of the token's user (cached). Case listing and creation default to it, so a
// token with wide access (e.g. a Red Hat associate's) never lists other accounts' cases
// unless an account number is passed explicitly.
export async function getCurrentAccount() {
  if (!currentAccount) currentAccount = await apiRequest("/v1/accounts/current");
  return currentAccount;
}

export async function resolveAccountNumbers(accountNumbers) {
  const list = [accountNumbers ?? []].flat().map((a) => normalizeAccountNumber(a));
  if (list.length) return list;
  const account = await getCurrentAccount();
  if (!account?.accountNumber) throw new Error("Could not determine the account of the REDHAT_TOKEN user; pass accountNumber explicitly");
  return [String(account.accountNumber)];
}

// --- Identifier validation ---

function check(value, pattern, what, example) {
  const v = String(value ?? "").trim();
  if (!pattern.test(v)) throw new Error(`Invalid ${what} "${value}": expected ${example}`);
  return v;
}

export const normalizeCaseNumber = (v) => check(v, /^\d{6,10}$/, "case number", "digits only, e.g. 04371920");
export const normalizeAccountNumber = (v) => check(v, /^\d{1,12}$/, "account number", "digits only, e.g. 5551234");
export const normalizeCommentId = (v) => check(v, /^[A-Za-z0-9]{15,18}$/, "comment ID", "a 15- or 18-character ID from getCaseComments");
export const normalizeAttachmentUuid = (v) => check(v, /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/, "attachment UUID", "a UUID from getCaseAttachments");
export const normalizeSsoUsername = (v) => check(v, /^[^\s/\\?#%]{1,100}$/, "SSO username", "a Red Hat login name");
export const normalizeDate = (v) => (v ? check(v, /^\d{4}-\d{2}-\d{2}$/, "date", "YYYY-MM-DD") : undefined);

// --- Picklists (Red Hat Support case object values; the API rejects anything else) ---

export const SEVERITIES = ["1 (Urgent)", "2 (High)", "3 (Medium)", "4 (Low)"];
export const STATUSES = [
  "In Progress",
  "Needs New Owner",
  "Waiting on 3rd Party Vendor",
  "Waiting on Collab",
  "Waiting on Customer Action Required",
  "Waiting on Customer Solution Delivered",
  "Waiting on Engineering",
  "Waiting on Sales",
  "Closed",
];
export const CASE_TYPES = [
  "Account / Customer Service Request",
  "Certification",
  "Configuration Issue",
  "Defect / Bug",
  "Feature / Enhancement Request",
  "Other",
  "Proactive",
  "RCA Only",
  "Usage / Documentation Help",
];
export const REOPEN_REASONS = ["I am experiencing the same issue", "My case has been closed prematurely", "Other"];

// Accept "3", "medium", "3 (Normal)" and similar for a severity
export function normalizeSeverity(input) {
  if (!input) return undefined;
  const s = String(input).trim().toLowerCase();
  const hit = SEVERITIES.find((v) => v.toLowerCase() === s)
    || SEVERITIES.find((v) => v[0] === s[0] && /^\d/.test(s))
    || SEVERITIES.find((v) => v.toLowerCase().includes(`(${s})`))
    || (s === "normal" ? "3 (Medium)" : undefined);
  if (!hit) throw new Error(`Invalid severity "${input}": expected one of ${SEVERITIES.join(", ")}`);
  return hit;
}

function picklist(values, what) {
  return (input) => {
    if (!input) return undefined;
    const hit = values.find((v) => v.toLowerCase() === String(input).trim().toLowerCase());
    if (!hit) throw new Error(`Invalid ${what} "${input}": expected one of ${values.join(", ")}`);
    return hit;
  };
}

export const normalizeStatus = picklist(STATUSES, "status");
export const normalizeCaseType = picklist(CASE_TYPES, "case type");

// --- Local file access for attachments ---

// Attachments are read from and written to one directory, so a prompt-injected request cannot
// upload arbitrary local files (for example ~/.ssh keys) or overwrite files elsewhere.
export function attachmentDir() {
  const dir = process.env.REDHAT_SUPPORT_ATTACHMENT_DIR || join(homedir(), "redhat-support-attachments");
  return resolve(dir);
}

async function inside(root, target) {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

// Resolve a file path for upload: relative paths are taken inside the attachment directory,
// and the real path (after symlinks) must stay inside it.
export async function resolveUploadPath(filePath) {
  const root = attachmentDir();
  const candidate = resolve(root, filePath);
  let real;
  try {
    real = await realpath(candidate);
  } catch {
    throw new Error(`File not found: ${candidate}. Uploads are read from ${root} (set REDHAT_SUPPORT_ATTACHMENT_DIR to change it).`);
  }
  const realRoot = await realpath(root).catch(() => root);
  if (!(await inside(realRoot, real))) {
    throw new Error(`Refusing to upload ${candidate}: uploads must come from ${root} (set REDHAT_SUPPORT_ATTACHMENT_DIR to change it). Copy the file there first.`);
  }
  const info = await stat(real);
  if (!info.isFile()) throw new Error(`${candidate} is not a regular file`);
  return { path: real, size: info.size, name: basename(real) };
}

// Resolve a download destination inside the attachment directory (default <dir>/<case>/<file>)
export async function resolveDownloadPath(caseNumber, fileName, outputPath) {
  const root = attachmentDir();
  const safeName = basename(String(fileName || "attachment")).replace(/[\0/\\]/g, "_") || "attachment";
  const target = resolve(root, outputPath || join(caseNumber, safeName));
  if (!(await inside(root, target))) {
    throw new Error(`Refusing to write ${target}: downloads go under ${root} (set REDHAT_SUPPORT_ATTACHMENT_DIR to change it).`);
  }
  await mkdir(dirname(target), { recursive: true });
  const realParent = await realpath(dirname(target));
  const realRoot = await realpath(root);
  if (!(await inside(realRoot, realParent))) {
    throw new Error(`Refusing to write ${target}: its directory resolves outside ${root}.`);
  }
  return target;
}

// Write a fetched body to a new file; never overwrite unless asked
export async function writeResponseToFile(res, target, overwrite) {
  const handle = await open(target, overwrite ? "w" : "wx").catch((err) => {
    if (err.code === "EEXIST") throw new Error(`${target} already exists; pass overwrite: true to replace it`);
    throw err;
  });
  let bytes = 0;
  try {
    for await (const chunk of res.body) {
      await handle.write(chunk);
      bytes += chunk.length;
    }
  } finally {
    await handle.close();
  }
  return bytes;
}

// --- Requests ---

const SORT_FIELDS = { lastModifiedDate: "LastModifiedDate", createdDate: "CreatedDate", caseNumber: "CaseNumber", severity: "Priority", status: "Status" };

// Build a POST /v3/cases/filter body from listCases arguments. accountNumbers is always set,
// so a listing never spans every account the token can see.
export function buildCaseFilter(args, accountNumbers) {
  if (!accountNumbers?.length) throw new Error("buildCaseFilter needs at least one account number");
  const day = (d, end) => (d ? `${normalizeDate(d)}T${end ? "23:59:59" : "00:00:00"}Z` : undefined);
  const status = normalizeStatus(args.status);
  const body = {
    accountNumbers,
    includeClosed: Boolean(args.includeClosed) || status === "Closed",
    status,
    severity: normalizeSeverity(args.severity),
    product: args.product,
    version: args.product ? args.version : undefined,
    keyword: args.keyword,
    type: normalizeCaseType(args.caseType),
    createdBySSOName: args.createdBySSOName ? normalizeSsoUsername(args.createdBySSOName) : undefined,
    startDate: day(args.createdAfter),
    endDate: day(args.createdBefore, true),
    lastModifiedFrom: day(args.modifiedAfter),
    sortField: SORT_FIELDS[args.sortBy || "lastModifiedDate"],
    sortOrder: String(args.sortOrder || "desc").toUpperCase(),
    maxResults: args.maxResults ?? 25,
    offset: args.startAt ?? 0,
  };
  for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
  return body;
}

// Download an attachment into the attachment directory through its presigned URL
export async function downloadAttachmentFile(caseNumber, uuid, { outputPath, overwrite = false } = {}) {
  // Check an explicit destination before asking the API for the file
  if (outputPath) await resolveDownloadPath(caseNumber, uuid, outputPath);
  const link = await apiRequest(`/v3/cases/attachments/downloadFile/${caseNumber}/${uuid}`);
  const url = link?.downloadUrl;
  if (!url || !/^https:\/\//.test(url)) throw new Error("The API returned no download URL for this attachment");

  const fileName = link.fileName || uuid;
  const target = await resolveDownloadPath(caseNumber, fileName, outputPath);
  // The presigned URL carries its own authorization; never send the Red Hat token with it
  const res = await fetchWithTimeout(url, {}, TRANSFER_TIMEOUT_MS);
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
  const bytes = await writeResponseToFile(res, target, overwrite);
  return { fileName, bytes, target };
}

const FIVE_GB = 5 * 1024 ** 3;
const PART_SIZE = 512 * 1024 ** 2;

// Upload a file from the attachment directory: one presigned PUT up to 5 GB, parts above that
export async function uploadAttachmentFile(caseNumber, filePath, description) {
  const file = await resolveUploadPath(filePath);
  const totalChunks = file.size > FIVE_GB ? Math.ceil(file.size / PART_SIZE) : undefined;
  const plan = await apiRequest("/v3/cases/attachments/upload", {
    method: "POST",
    body: { fileName: file.name, fileSize: file.size, caseNumber, clientId: UPLOAD_CLIENT_ID, description, totalChunks },
  });

  if (plan?.uploadStrategy === "MULTIPART") {
    const parts = [...(plan.parts || [])].sort((a, b) => a.partNumber - b.partNumber);
    if (!parts.length || !plan.uploadId) throw new Error(`The API returned an incomplete multipart upload plan: ${JSON.stringify(plan)}`);
    const chunk = Math.ceil(file.size / parts.length);
    const handle = await open(file.path, "r");
    const etags = [];
    try {
      for (const part of parts) {
        const start = (part.partNumber - 1) * chunk;
        const length = Math.min(chunk, file.size - start);
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, start);
        const res = await fetchWithTimeout(part.presignedUrl, { method: "PUT", body: buffer }, TRANSFER_TIMEOUT_MS);
        if (!res.ok) throw new Error(`Upload of part ${part.partNumber} failed (${res.status})`);
        etags.push({ partNumber: part.partNumber, eTag: res.headers.get("etag") });
      }
    } catch (err) {
      await apiRequest("/v3/cases/attachments/upload/abort", {
        method: "DELETE",
        query: { attachmentId: plan.attachmentId, caseNumber, uploadId: plan.uploadId },
      }).catch(() => {});
      throw err;
    } finally {
      await handle.close();
    }
    await apiRequest("/v3/cases/attachments/upload/complete", {
      method: "POST",
      body: { attachmentId: plan.attachmentId, uploadId: plan.uploadId, caseNumber, parts: etags },
    });
  } else {
    if (!plan?.presignedUrl) throw new Error(`The API returned no upload URL: ${JSON.stringify(plan)}`);
    const data = await readFile(file.path);
    const res = await fetchWithTimeout(plan.presignedUrl, { method: "PUT", body: data }, TRANSFER_TIMEOUT_MS);
    if (!res.ok) throw new Error(`Upload failed (${res.status})`);
  }
  return { file, attachmentId: plan?.attachmentId };
}

// --- Formatting helpers ---

const present = (v) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0);
const date = (v) => (v ? String(v).replace(/\.\d{3}(?=Z|[+-]\d\d:?\d\d$)/, "").replace("T", " ").replace(/\+0000$|Z$/, " UTC") : "");
const oneLine = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
const cell = (v) => oneLine(v).replace(/\|/g, "\\|");

// Case text fields and comments may be HTML or plain text
export function bodyToMarkdown(text) {
  if (!present(text)) return "";
  const s = String(text);
  return /<\/?[a-z][^>]*>/i.test(s) ? htmlToMarkdown(s) : s.replace(/\r\n/g, "\n").trim();
}

// Some product names already end with their version ("OpenShift Container Platform 4.19" with
// version "4.19"); add the version only when the name lacks it
export function productLabel(product, version) {
  const p = oneLine(product);
  const v = oneLine(version);
  if (!v) return p;
  if (!p) return v;
  return p.toLowerCase().endsWith(v.toLowerCase()) ? p : `${p} ${v}`;
}

export function caseUrl(caseNumber) {
  return `${PORTAL_CASE_URL}/${caseNumber}`;
}

function fieldLines(pairs) {
  return pairs.filter(([, v]) => present(v) && v !== false).map(([k, v]) => `**${k}:** ${v === true ? "yes" : v}`);
}

// One line per case for listings
export function formatCaseList(data, { start = 0, accountNumbers } = {}) {
  const cases = data?.cases || [];
  const total = data?.totalCount ?? cases.length;
  const scope = accountNumbers?.length ? ` for account ${accountNumbers.join(", ")}` : "";
  if (cases.length === 0) return `No cases found${scope}.`;
  const lines = cases.map((c) => {
    const bits = [c.status, c.severity].filter(Boolean).join(", ");
    const product = productLabel(c.product, c.version);
    const tail = [product, c.contactName && `contact ${c.contactName}`, c.lastModifiedDate && `updated ${date(c.lastModifiedDate)}`].filter(Boolean).join(" · ");
    return `- **${c.caseNumber}** [${bits}] ${oneLine(c.summary)}${tail ? ` — ${tail}` : ""}`;
  });
  const next = start + cases.length < total ? `\n\nMore cases match: call again with startAt=${start + cases.length}.` : "";
  return `Showing cases ${start + 1}-${start + cases.length} of ${total}${scope}\n\n${lines.join("\n")}${next}\n\nUse getCase with a case number for details and comments.`;
}

// v3 comments carry visibility "Customer" (the customer can see it) or "Associate" (Red Hat
// associates only); isPublic mirrors it
export function isPrivateComment(comment) {
  if (comment.visibility) return comment.visibility !== "Customer";
  return comment.isPublic === false;
}

function visibilityLabel(comment) {
  if (comment.visibility === undefined && comment.isPublic === undefined) return "";
  return isPrivateComment(comment) ? "PRIVATE (Red Hat associates only; the customer cannot see it)" : "public";
}

export function formatComment(c) {
  const who = [c.createdBy, c.createdByType && `(${c.createdByType})`].filter(Boolean).join(" ");
  const meta = [date(c.createdDate || c.publishedDate), who, visibilityLabel(c), c.isDraft ? "DRAFT" : "", c.id && `id ${c.id}`].filter(Boolean).join(" · ");
  return `### ${meta}\n\n${bodyToMarkdown(c.commentBody) || "(empty comment)"}`;
}

export function formatComments(comments, { caseNumber } = {}) {
  const list = Array.isArray(comments) ? comments : [];
  if (list.length === 0) return `No comments on case ${caseNumber}.`;
  const privateCount = list.filter(isPrivateComment).length;
  const note = privateCount ? `\n\n> ${privateCount} of these comments are private: visible to Red Hat associates only, not to the customer. Do not repeat them in public comments.` : "";
  return `## Comments (${list.length})${note}\n\n${list.map(formatComment).join("\n\n")}`;
}

export function formatCase(c, { comments } = {}) {
  const parts = [`# Case ${c.caseNumber}: ${oneLine(c.summary)}`];
  parts.push(...fieldLines([
    ["URL", caseUrl(c.caseNumber)],
    ["Status", c.status],
    ["Severity", c.severity],
    ["Type", c.caseType],
    ["Product", productLabel(c.product, c.version)],
    ["Account", c.accountNumberRef],
    ["Contact", [c.contactName, c.contactSSOName && `(${c.contactSSOName})`].filter(Boolean).join(" ")],
    ["Owner", c.ownerId],
    ["Case group", [c.groupName, c.groupNumber && `(${c.groupNumber})`].filter(Boolean).join(" ")],
    ["Created", date(c.createdDate)],
    ["Last modified", [date(c.lastModifiedDate), c.lastModifiedById && `by ${c.lastModifiedById}`].filter(Boolean).join(" ")],
    ["Closed", date(c.lastClosedAt)],
    ["Hostname", c.hostname],
    ["OpenShift cluster", [c.openshiftClusterID, c.openshiftClusterVersion].filter(Boolean).join(" ")],
    ["Alternate ID", c.alternateId],
    ["Customer escalation", c.customerEscalation],
    ["Entitlement SLA", c.entitlementSla],
    ["Enhanced SLA", c.enhancedSLA],
    ["24x7 contact", c.contactInfo24x7],
    ["Language", c.caseLanguage],
    ["Support areas", (c.sbrGroups || []).join(", ")],
    ["Tags", (c.apiTags || []).join(", ")],
    ["Notified users", (c.notifiedUsers || []).map((u) => u?.ssoUsername).filter(Boolean).join(", ")],
    ["Notification emails", (c.notificationAddressEmails || []).join(", ")],
  ]));

  for (const [heading, key] of [
    ["Description", "description"],
    ["Issue", "issue"],
    ["Environment", "environment"],
    ["Periodicity", "periodicityOfIssue"],
    ["Time frames and urgency", "timeFramesAndUrgency"],
    ["Action plan", "actionPlan"],
    ["Resolution", "resolutionDescription"],
    ["Customer notes", "notes"],
  ]) {
    const md = bodyToMarkdown(c[key]);
    if (md) parts.push(`\n## ${heading}\n\n${md}`);
  }

  const bugs = (c.bugzillas || []).filter(Boolean);
  if (bugs.length) {
    parts.push(`\n## Linked bugs (${bugs.length})\n\n${bugs.map((b) => {
      const id = b.bugzillaNumber || b.name || b.id;
      const link = b.bugzillaLink || b.bugzillaURL;
      const label = link ? `[${id}](${link})` : id;
      return `- ${label}: ${oneLine(b.summary)}${b.status ? ` [${[b.status, b.resolution].filter(Boolean).join(" ")}]` : ""}`;
    }).join("\n")}`);
  }

  const links = (c.caseResourceLinks || []).filter(Boolean);
  if (links.length) {
    parts.push(`\n## Linked resources (${links.length})\n\n${links.map((l) => {
      const title = oneLine(l.title || l.resource || l.resourceId);
      const url = l.resourceViewURI || l.resourceURI;
      const kind = l.resourceTypeLabel || l.resourceType || l.type;
      return `- ${url ? `[${title}](${url})` : title}${kind ? ` (${kind})` : ""}`;
    }).join("\n")}`);
  }

  const chats = (c.chats || []).filter(Boolean);
  if (chats.length) {
    parts.push(`\n## Chats (${chats.length})\n\n${chats.map((ch) => `### ${date(ch.startTime)} · ${[ch.visitorName, ch.agentName].filter(Boolean).join(" with ")}\n\n${bodyToMarkdown(ch.body)}`).join("\n\n")}`);
  }

  const list = comments ?? c.comments;
  if (Array.isArray(list)) parts.push(`\n${formatComments(list, { caseNumber: c.caseNumber })}`);

  return parts.join("\n");
}

export function formatAttachments(list, { caseNumber } = {}) {
  const items = Array.isArray(list) ? list : [];
  if (items.length === 0) return `No attachments on case ${caseNumber}.`;
  const rows = items.map((a) => `| ${cell(a.fileName)} | ${a.uuid || ""} | ${a.size != null ? a.size : ""} | ${date(a.createdDate)} | ${cell(a.createdBy)} | ${cell(a.uploadStatus)} | ${cell(a.description)} |`);
  return `## Attachments on case ${caseNumber} (${items.length})\n\n| File | UUID | Bytes | Created | By | Upload status | Description |\n| --- | --- | --- | --- | --- | --- | --- |\n${rows.join("\n")}\n\nUse downloadAttachment with the UUID to save a file.`;
}

export function formatTrackerUpdates(list, { caseNumber } = {}) {
  const items = Array.isArray(list) ? list : [];
  if (items.length === 0) return `No external tracker updates on case ${caseNumber}.`;
  return `## External tracker updates on case ${caseNumber} (${items.length})\n\n${items.map((u) => {
    const tracker = u.externalTracker?.resourceKey || u.externalTracker?.name || u.externalIdentifier || u.identifier || u.name;
    const meta = [date(u.createdDate), u.originatingSystem, tracker, u.updateBy, u.customerVisible === false ? "not customer-visible" : ""].filter(Boolean).join(" · ");
    return `### ${meta}\n\n${bodyToMarkdown(u.body) || "(no text)"}`;
  }).join("\n\n")}`;
}

export function formatAccount(a) {
  const flags = [
    ["Partner", a.isPartner], ["Strategic", a.strategic], ["Has TAM", a.hasTAM], ["Secure support", a.secureSupport],
    ["Secured environment", a.securedEnvironment], ["Special handling required", a.specialHandlingRequired],
    ["Case groups control access", a.hasGroupACLs], ["Case group required on create", a.requireCGroupOnCreate],
    ["Attachment downloads restricted", a.restrictAttachmentDownloads], ["Chat available", a.hasChat],
  ].filter(([, v]) => v === true).map(([k]) => k);
  return [
    `# Account ${a.accountNumber}: ${oneLine(a.name)}`,
    ...(flags.length ? [`**Flags:** ${flags.join(", ")}`] : []),
    ...(Number.isFinite(a.escalationsInLast30DaysApi) ? [`**Escalations in the last 30 days:** ${a.escalationsInLast30DaysApi}`] : []),
  ].join("\n");
}

export function formatContacts(list, { accountNumber, filter } = {}) {
  let items = Array.isArray(list) ? list : [];
  const total = items.length;
  if (filter) {
    const f = filter.toLowerCase();
    items = items.filter((c) => [c.ssoUsername, c.firstName, c.lastName, c.name, c.email].some((v) => String(v || "").toLowerCase().includes(f)));
  }
  if (items.length === 0) return `No contacts${filter ? ` matching "${filter}"` : ""} on account ${accountNumber}.`;
  const rows = items.map((c) => {
    const name = c.name || [c.firstName, c.lastName].filter(Boolean).join(" ");
    const roles = [c.isOrgAdmin && "org admin", c.manageSupportCases && "manages cases", c.write === false && "read-only"].filter(Boolean).join(", ");
    return `| ${cell(c.ssoUsername)} | ${cell(name)} | ${cell(c.email)} | ${cell(roles)} |`;
  });
  return `## Contacts on account ${accountNumber} (${items.length}${filter ? ` of ${total} matching "${filter}"` : ""})\n\n| SSO username | Name | Email | Roles |\n| --- | --- | --- | --- |\n${rows.join("\n")}`;
}

const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

export function formatBusinessHours(bh, timezone) {
  const hhmm = (t) => (t ? String(t).replace(/^(\d\d:\d\d).*/, "$1") : "");
  const rows = DAYS.filter((d) => bh[`${d}StartTime`] || bh[`${d}EndTime`])
    .map((d) => `| ${d[0].toUpperCase()}${d.slice(1)} | ${hhmm(bh[`${d}StartTime`])} | ${hhmm(bh[`${d}EndTime`])} |`);
  return [
    `# Red Hat support business hours: ${bh.name || timezone}`,
    ...(bh.timeZoneSidKey ? [`**Time zone:** ${bh.timeZoneSidKey}`] : []),
    "",
    rows.length ? `| Day | Start | End |\n| --- | --- | --- |\n${rows.join("\n")}` : "No hours listed.",
  ].join("\n");
}

// --- Pagination ---

export const DEFAULT_CHUNK = 30000;

export function paginate(text, offset, limit, label) {
  const total = text.length;
  const start = Math.min(offset, total);
  const end = Math.min(start + limit, total);
  const slice = text.slice(start, end);
  const header = `# ${label}\n# chars ${start}-${end} of ${total}\n\n`;
  let footer = "";
  if (end < total) {
    footer = `\n\n[truncated: showing chars ${start}-${end} of ${total}. Call again with offset=${end} for the next chunk.]`;
  } else if (offset > 0 && offset >= total) {
    footer = `[offset ${offset} is past the end of the ${total}-character response. Call again with a smaller offset.]`;
  }
  return `${header}${slice}${footer}`;
}
