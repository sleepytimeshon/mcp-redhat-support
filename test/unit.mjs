#!/usr/bin/env node
// Offline tests of src/lib.js: validation, account scoping, the API client, attachment file
// safety, and the Markdown formatters, with a stubbed fetch and synthetic data. Case content is
// customer data: never put real case text, comments, or attachments in these fixtures.

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import * as lib from "../src/lib.js";

const realFetch = globalThis.fetch;
const realEnv = { token: process.env.REDHAT_TOKEN, dir: process.env.REDHAT_SUPPORT_ATTACHMENT_DIR };
let dir;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "support-test-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});
beforeEach(() => {
  process.env.REDHAT_TOKEN = "offline";
  process.env.REDHAT_SUPPORT_ATTACHMENT_DIR = join(dir, "attachments");
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const [key, value] of [["REDHAT_TOKEN", realEnv.token], ["REDHAT_SUPPORT_ATTACHMENT_DIR", realEnv.dir]]) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  lib.clearTokenCache();
});

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// Stub fetch: the token exchange always succeeds; other calls go to handler(url, init)
function stubFetch(handler) {
  const calls = [];
  let issued = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u === lib.TOKEN_URL) {
      issued += 1;
      return json({ access_token: `access-${issued}`, expires_in: 900 });
    }
    return handler(u, init);
  };
  return calls;
}

describe("validation and picklists", () => {
  it("accepts only well-formed identifiers", () => {
    assert.equal(lib.normalizeCaseNumber(" 04371920 "), "04371920");
    for (const bad of ["../x", "0437192a", "", "1234"]) assert.throws(() => lib.normalizeCaseNumber(bad), /Invalid case number/);
    assert.equal(lib.normalizeAttachmentUuid("0f8fad5b-d9cb-469f-a165-70867728950e"), "0f8fad5b-d9cb-469f-a165-70867728950e");
    assert.throws(() => lib.normalizeAttachmentUuid("../../etc"), /Invalid attachment UUID/);
    assert.throws(() => lib.normalizeCommentId("a/b"), /Invalid comment ID/);
    assert.throws(() => lib.normalizeSsoUsername("a/b"), /Invalid SSO username/);
    assert.throws(() => lib.normalizeDate("2026/01/01"), /Invalid date/);
  });

  it("maps severity spellings to the API's values and rejects unknown ones", () => {
    assert.equal(lib.normalizeSeverity("3 (Normal)"), "3 (Medium)");
    assert.equal(lib.normalizeSeverity("normal"), "3 (Medium)");
    assert.equal(lib.normalizeSeverity("2"), "2 (High)");
    assert.equal(lib.normalizeSeverity("urgent"), "1 (Urgent)");
    assert.equal(lib.normalizeSeverity("4 (low)"), "4 (Low)");
    assert.throws(() => lib.normalizeSeverity("critical"), /Invalid severity/);
  });

  it("checks statuses and case types case-insensitively", () => {
    assert.equal(lib.normalizeStatus("waiting on engineering"), "Waiting on Engineering");
    assert.throws(() => lib.normalizeStatus("Open"), /Invalid status "Open": expected one of In Progress/);
    assert.equal(lib.normalizeCaseType("defect / bug"), "Defect / Bug");
  });
});

describe("buildCaseFilter", () => {
  it("always scopes to the given accounts and maps listCases arguments", () => {
    const body = lib.buildCaseFilter({
      status: "closed", severity: "normal", product: "Red Hat Enterprise Linux", version: "9",
      keyword: "kdump", caseType: "defect / bug", createdAfter: "2026-01-01", createdBefore: "2026-02-01",
      modifiedAfter: "2026-03-01", sortBy: "severity", sortOrder: "asc", maxResults: 10, startAt: 20,
    }, ["5551234"]);
    assert.deepEqual(body, {
      accountNumbers: ["5551234"], includeClosed: true, status: "Closed", severity: "3 (Medium)",
      product: "Red Hat Enterprise Linux", version: "9", keyword: "kdump", type: "Defect / Bug",
      startDate: "2026-01-01T00:00:00Z", endDate: "2026-02-01T23:59:59Z", lastModifiedFrom: "2026-03-01T00:00:00Z",
      sortField: "Priority", sortOrder: "ASC", maxResults: 10, offset: 20,
    });
    assert.throws(() => lib.buildCaseFilter({}, []), /at least one account/);
  });

  it("lists open cases only by default and drops a version without a product", () => {
    assert.deepEqual(lib.buildCaseFilter({ version: "9" }, ["1"]), {
      accountNumbers: ["1"], includeClosed: false, sortField: "LastModifiedDate", sortOrder: "DESC", maxResults: 25, offset: 0,
    });
  });
});

describe("apiRequest and account scoping", () => {
  it("sends the bearer token and query, and parses JSON", async () => {
    const calls = stubFetch(() => json({ ok: 1 }));
    assert.deepEqual(await lib.apiRequest("/v3/businesshours", { query: { timezone: "Asia/Tokyo", empty: "" } }), { ok: 1 });
    const call = calls.at(-1);
    assert.equal(call.url, `${lib.API_BASE}/v3/businesshours?timezone=Asia%2FTokyo`);
    assert.equal(call.init.headers.Authorization, "Bearer access-1");
    assert.ok(call.init.signal);
  });

  it("retries once with a fresh token on 401", async () => {
    let first = true;
    const calls = stubFetch(() => {
      if (first) { first = false; return json({ message: "expired" }, 401); }
      return json({ ok: 1 });
    });
    await lib.apiRequest("/v3/cases/01234567");
    assert.equal(calls.filter((c) => c.url === lib.TOKEN_URL).length, 2);
    assert.equal(calls.at(-1).init.headers.Authorization, "Bearer access-2");
  });

  it("reports API errors as one readable line", async () => {
    stubFetch(() => json({ message: "Unable to fetch cases", detailMessage: "Status not provided or invalid" }, 400));
    await assert.rejects(lib.apiRequest("/v3/cases/filter", { method: "POST", body: {} }), (err) =>
      err instanceof lib.ApiError && err.status === 400 && err.message === "Red Hat Support API error 400: Unable to fetch cases: Status not provided or invalid");
  });

  it("defaults to the token user's own account and caches it", async () => {
    const calls = stubFetch((url) => (url.endsWith("/v1/accounts/current") ? json({ accountNumber: 5551234, name: "Example Corp" }) : json({})));
    assert.deepEqual(await lib.resolveAccountNumbers(undefined), ["5551234"]);
    assert.deepEqual(await lib.resolveAccountNumbers([]), ["5551234"]);
    assert.equal(calls.filter((c) => c.url.endsWith("/v1/accounts/current")).length, 1);
    assert.deepEqual(await lib.resolveAccountNumbers(["111", "222"]), ["111", "222"]);
    await assert.rejects(lib.resolveAccountNumbers("12a"), /Invalid account number/);
  });

  it("needs REDHAT_TOKEN", async () => {
    delete process.env.REDHAT_TOKEN;
    await assert.rejects(lib.apiRequest("/v3/cases/01234567"), /REDHAT_TOKEN environment variable is required/);
  });
});

describe("attachment file safety", () => {
  it("uploads only files inside the attachment directory, after resolving symlinks", async () => {
    const root = process.env.REDHAT_SUPPORT_ATTACHMENT_DIR;
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "sosreport.tar.xz"), "data");
    await writeFile(join(dir, "secret"), "key");
    await symlink(join(dir, "secret"), join(root, "link-to-secret"));

    assert.equal((await lib.resolveUploadPath("sosreport.tar.xz")).size, 4);
    await assert.rejects(lib.resolveUploadPath(join(dir, "secret")), /Refusing to upload/);
    await assert.rejects(lib.resolveUploadPath("../secret"), /Refusing to upload/);
    await assert.rejects(lib.resolveUploadPath("link-to-secret"), /Refusing to upload/);
    await assert.rejects(lib.resolveUploadPath("missing.txt"), /File not found/);
  });

  it("downloads under <dir>/<case>/<file> and refuses paths outside it", async () => {
    const root = process.env.REDHAT_SUPPORT_ATTACHMENT_DIR;
    assert.equal(await lib.resolveDownloadPath("01234567", "../../evil.sh", undefined), join(root, "01234567", "evil.sh"));
    await assert.rejects(lib.resolveDownloadPath("01234567", "x", "../../escape"), /Refusing to write/);
  });

  it("downloads through the presigned URL without the Red Hat token and never overwrites by default", async () => {
    const uuid = "0f8fad5b-d9cb-469f-a165-70867728950e";
    const calls = stubFetch((url) => {
      if (url.includes("/downloadFile/")) return json({ downloadUrl: "https://s3.example.com/file?sig=1", fileName: "log.txt", expiresInSeconds: 300 });
      if (url.startsWith("https://s3.example.com/")) return new Response("hello");
      return json({}, 404);
    });
    const out = await lib.downloadAttachmentFile("01234567", uuid);
    assert.equal(out.bytes, 5);
    assert.equal(await readFile(out.target, "utf8"), "hello");
    const s3 = calls.find((c) => c.url.startsWith("https://s3.example.com/"));
    assert.equal(s3.init.headers?.Authorization, undefined);
    await assert.rejects(lib.downloadAttachmentFile("01234567", uuid), /already exists; pass overwrite: true/);
    assert.equal((await lib.downloadAttachmentFile("01234567", uuid, { overwrite: true })).bytes, 5);
  });

  it("checks an explicit download path before calling the API", async () => {
    const calls = stubFetch(() => json({}));
    await assert.rejects(lib.downloadAttachmentFile("01234567", "0f8fad5b-d9cb-469f-a165-70867728950e", { outputPath: "../../x" }), /Refusing to write/);
    assert.equal(calls.length, 0);
  });

  it("uploads with one presigned PUT, without the Red Hat token", async () => {
    const root = process.env.REDHAT_SUPPORT_ATTACHMENT_DIR;
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "small.log"), "abc");
    const calls = stubFetch((url, init) => {
      if (url.endsWith("/v3/cases/attachments/upload")) return json({ attachmentId: "att-1", uploadStrategy: "SINGLE_PUT", presignedUrl: "https://s3.example.com/put?sig=1" });
      if (url.startsWith("https://s3.example.com/")) return new Response("", { status: 200 });
      return json({}, 500);
    });
    const out = await lib.uploadAttachmentFile("01234567", "small.log", "logs");
    assert.equal(out.attachmentId, "att-1");
    const plan = calls.find((c) => c.url.endsWith("/upload"));
    assert.deepEqual(JSON.parse(plan.init.body), { fileName: "small.log", fileSize: 3, caseNumber: "01234567", clientId: "mcp-redhat-support", description: "logs" });
    const put = calls.find((c) => c.url.startsWith("https://s3.example.com/"));
    assert.equal(put.init.method, "PUT");
    assert.equal(put.init.headers?.Authorization, undefined);
  });

  it("uploads multipart plans part by part and completes them", async () => {
    const root = process.env.REDHAT_SUPPORT_ATTACHMENT_DIR;
    await writeFile(join(root, "big.bin"), "0123456789");
    const calls = stubFetch((url) => {
      if (url.endsWith("/upload")) {
        return json({ attachmentId: "att-2", uploadStrategy: "MULTIPART", uploadId: "up-1", parts: [
          { partNumber: 2, presignedUrl: "https://s3.example.com/p2" }, { partNumber: 1, presignedUrl: "https://s3.example.com/p1" }] });
      }
      if (url.startsWith("https://s3.example.com/")) return new Response("", { status: 200, headers: { ETag: `"etag-${url.slice(-1)}"` } });
      if (url.endsWith("/upload/complete")) return json("ok");
      return json({}, 500);
    });
    await lib.uploadAttachmentFile("01234567", "big.bin");
    const puts = calls.filter((c) => c.url.startsWith("https://s3.example.com/"));
    assert.deepEqual(puts.map((c) => [c.url.slice(-2), c.init.body.toString()]), [["p1", "01234"], ["p2", "56789"]]);
    const complete = JSON.parse(calls.find((c) => c.url.endsWith("/complete")).init.body);
    assert.deepEqual(complete.parts, [{ partNumber: 1, eTag: '"etag-1"' }, { partNumber: 2, eTag: '"etag-2"' }]);
  });
});

const CASE = {
  caseNumber: "01234567",
  summary: "Service fails after update",
  status: "Waiting on Engineering",
  severity: "2 (High)",
  caseType: "Defect / Bug",
  product: "Red Hat Enterprise Linux",
  version: "9.4",
  accountNumberRef: "5551234",
  contactName: "Pat Example",
  contactSSOName: "pexample",
  createdDate: "2026-01-02T03:04:05.000Z",
  lastModifiedDate: "2026-01-03T00:00:00.000+0000",
  description: "<p>It <strong>fails</strong>.</p>",
  isClosed: false,
  customerEscalation: false,
  notifiedUsers: [{ ssoUsername: "ops-team" }],
  bugzillas: [{ bugzillaNumber: "RHEL-1", bugzillaLink: "https://issues.redhat.com/browse/RHEL-1", summary: "Crash", status: "NEW" }],
  caseResourceLinks: [{ title: "Known issue", resourceViewURI: "https://access.redhat.com/solutions/1", resourceTypeLabel: "Solution" }],
  bugzillasHldr: { bugzilla: ["duplicate"] },
  caseResourceLinksHldr: { link: ["duplicate"] },
  chats: [],
  comments: [{ commentBody: "embedded, no visibility" }],
};

const COMMENTS = [
  { id: "a0Bxx0000000001AAA", commentBody: "<p>Please collect a <code>sosreport</code>.</p>", createdBy: "Support Engineer", createdByType: "Associate", createdDate: "2026-01-02T05:00:00.000Z", isPublic: true, visibility: "Customer" },
  { id: "a0Bxx0000000002AAA", commentBody: "Internal note", createdBy: "Support Engineer", createdByType: "Associate", createdDate: "2026-01-02T06:00:00.000Z", isPublic: false, visibility: "Associate" },
];

describe("formatters", () => {
  it("formats a case with only meaningful fields, Markdown text, and links", () => {
    const out = lib.formatCase({ ...CASE, comments: undefined }, { comments: COMMENTS });
    assert.match(out, /^# Case 01234567: Service fails after update\n\*\*URL:\*\* https:\/\/access\.redhat\.com\/support\/cases\/#\/case\/01234567\n\*\*Status:\*\* Waiting on Engineering\n\*\*Severity:\*\* 2 \(High\)/);
    assert.match(out, /\*\*Product:\*\* Red Hat Enterprise Linux 9\.4/);
    assert.match(out, /\*\*Created:\*\* 2026-01-02 03:04:05 UTC/);
    assert.match(out, /\*\*Notified users:\*\* ops-team/);
    assert.match(out, /## Description\n\nIt \*\*fails\*\*\./);
    assert.match(out, /## Linked bugs \(1\)\n\n- \[RHEL-1\]\(https:\/\/issues\.redhat\.com\/browse\/RHEL-1\): Crash \[NEW\]/);
    assert.match(out, /## Linked resources \(1\)\n\n- \[Known issue\]\(https:\/\/access\.redhat\.com\/solutions\/1\) \(Solution\)/);
    assert.doesNotMatch(out, /duplicate|embedded, no visibility|Customer escalation|Chats/);
  });

  it("labels private comments and converts comment HTML", () => {
    const out = lib.formatComments(COMMENTS, { caseNumber: "01234567" });
    assert.match(out, /^## Comments \(2\)\n\n> 1 of these comments are private: visible to Red Hat associates only/);
    assert.match(out, /### 2026-01-02 05:00:00 UTC · Support Engineer \(Associate\) · public · id a0Bxx0000000001AAA\n\nPlease collect a `sosreport`\./);
    assert.match(out, /· PRIVATE \(Red Hat associates only; the customer cannot see it\) · id a0Bxx0000000002AAA\n\nInternal note/);
    assert.equal(lib.formatComments([], { caseNumber: "1" }), "No comments on case 1.");
  });

  it("lists cases one per line with the next page hint", () => {
    const out = lib.formatCaseList({ totalCount: 30, cases: [CASE] }, { start: 0, accountNumbers: ["5551234"] });
    assert.match(out, /^Showing cases 1-1 of 30 for account 5551234\n\n- \*\*01234567\*\* \[Waiting on Engineering, 2 \(High\)\] Service fails after update — Red Hat Enterprise Linux 9\.4 · contact Pat Example · updated 2026-01-03 00:00:00 UTC/);
    assert.match(out, /call again with startAt=1/);
    assert.equal(lib.formatCaseList({ totalCount: 0, cases: [] }, { accountNumbers: ["1"] }), "No cases found for account 1.");
  });

  it("formats attachments, contacts, business hours, and accounts", () => {
    assert.match(lib.formatAttachments([{ fileName: "a|b.log", uuid: "u-1", size: 10, createdBy: "Pat", uploadStatus: "Completed" }], { caseNumber: "1" }), /\| a\\\|b\.log \| u-1 \| 10 \|/);
    const contacts = [{ ssoUsername: "pexample", firstName: "Pat", lastName: "Example", email: "pat@example.com", isOrgAdmin: true }, { ssoUsername: "other", email: "o@example.com" }];
    assert.match(lib.formatContacts(contacts, { accountNumber: "1", filter: "PAT" }), /\(1 of 2 matching "PAT"\)[\s\S]*\| pexample \| Pat Example \| pat@example\.com \| org admin \|/);
    assert.match(lib.formatBusinessHours({ name: "Asia/Tokyo", mondayStartTime: "09:00:00.000Z", mondayEndTime: "18:00:00.000Z" }, "Asia/Tokyo"), /\| Monday \| 09:00 \| 18:00 \|/);
    assert.equal(lib.formatAccount({ accountNumber: 1, name: "Example Corp", hasTAM: true, isPartner: false, escalationsInLast30DaysApi: 0 }), "# Account 1: Example Corp\n**Flags:** Has TAM\n**Escalations in the last 30 days:** 0");
  });

  it("adds the product version only when the name lacks it", () => {
    assert.equal(lib.productLabel("Red Hat Enterprise Linux", "9.4"), "Red Hat Enterprise Linux 9.4");
    assert.equal(lib.productLabel("OpenShift Container Platform 4.19", "4.19"), "OpenShift Container Platform 4.19");
    assert.equal(lib.productLabel("Red Hat Customer Portal Current Version", "Current Version"), "Red Hat Customer Portal Current Version");
    assert.equal(lib.productLabel("", "9"), "9");
    assert.equal(lib.productLabel("Product", undefined), "Product");
    const out = lib.formatCaseList({ totalCount: 1, cases: [{ ...CASE, product: "OpenShift Container Platform 4.19", version: "4.19" }] }, { accountNumbers: ["1"] });
    assert.match(out, / — OpenShift Container Platform 4\.19 · contact/);
  });

  it("paginates by characters", () => {
    assert.match(lib.paginate("abcdef", 0, 4, "t"), /abcd\n\n\[truncated: showing chars 0-4 of 6\. Call again with offset=4/);
    assert.match(lib.paginate("abc", 9, 4, "t"), /offset 9 is past the end/);
  });
});
