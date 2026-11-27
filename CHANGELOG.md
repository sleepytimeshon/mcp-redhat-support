# Changelog

All notable changes to this project are documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.0.0] - 2026-11-27

### Added
- `getAccount`, `listAccountContacts`, and `getCaseGroupUsers` tools, for an account's support flags, its contacts' SSO usernames (for `addNotifiedUsers` and `createCase`), and case group members.
- `listCases` filters by product, version, keyword, case type, creator, and created and modified dates, sorts by several fields, and pages with `maxResults` (up to 200) and `startAt`.
- `getCaseComments` and `getExternalTrackerUpdates` filter by date; `getCaseAttachments` can include deleted attachments.
- `updateCase` changes case type, product and version, contact, case group, hostname, OpenShift cluster, and escalation, and reopens a closed case with a reason.
- `uploadAttachment` uploads files larger than 5 GB in parts.
- Offline unit tests (`test/unit.mjs`), run by `npm test`.

### Changed
- All case, comment, attachment, tracker, and business-hours tools use the Support API's v3 endpoints; every v1 endpoint they used is deprecated. The notified-user tools still use v1, which has no v3 replacement.
- Tool output is Markdown for a language model instead of raw API JSON: empty fields and duplicated API holder objects are dropped, comment HTML is converted, and a case with comments is a fraction of its former size.
- `getCase` includes the case's comments, newest first, and labels private comments (visible to Red Hat associates only).
- `listCases`, `createCase`, and the account tools default to the token user's own account; other accounts are listed only when named. `listCases` lists open cases unless `includeClosed` is set, and its record paging parameter is now `startAt`, freeing `offset` for character pagination like every other tool.
- `uploadAttachment` reads files only from the attachment directory (`REDHAT_SUPPORT_ATTACHMENT_DIR`, default `~/redhat-support-attachments`), and `downloadAttachment` writes only under it, never overwriting without `overwrite: true`. Transfers use v3 presigned URLs without sending the Red Hat token.
- `deleteAttachment` takes the attachment UUID from `getCaseAttachments`.
- `addCaseComment` drops `isPublic`, which the v3 API does not accept, and adds `doNotChangeStatus`.
- API errors are reported as one readable line, and a rejected cached access token is exchanged again once.
- API clients, validation, and formatters moved to `src/lib.js`; comment HTML conversion is in `src/html.js`, shared with mcp-redhat-knowledge.

### Fixed
- `listCases` returned no cases: the deprecated v1 filter endpoint answers every query with zero results.
- `listCases` sent `searchString`, which the API ignores; keyword search now uses `keyword`.
- Tool descriptions gave severity and status examples the API rejects (`3 (Normal)`, `Open`, `Waiting on Customer`, `Waiting on Red Hat`); values are now validated against the API's lists, and common spellings such as `3 (Normal)` or `High` map to them.
- Case numbers, comment IDs, attachment UUIDs, and usernames are validated before they are put in a request URL.
- Every Red Hat API request times out after 30 seconds (10 minutes for attachment downloads and uploads) instead of waiting indefinitely on a stalled endpoint.
- The pagination `offset` parameter is described in characters, not bytes.

## [1.3.2] - 2026-11-23

### Added
- This changelog, included in the published package.

### Security
- Upgrade `@modelcontextprotocol/sdk` to 1.32.2 and `zod` to 4.6.7, and refresh the lockfile, clearing every `npm audit` advisory (1 critical, 8 high, 2 moderate) in the SDK, zod, and their transitive dependencies.

## [1.3.1] - 2026-11-23

### Added
- Continuous integration on Node.js 18, 20, 22, and 24 for every push and pull request to `main`, with a stdio smoke test that checks the registered tools against the README and the reported server version against `package.json`.
- Automated npm publishing with provenance through npm trusted publishing, plus a GitHub release for each version.
- `engines.node` declares the supported Node.js range (18.14.1 or later).
- README sections on pagination, version pinning, and the release process.

### Changed
- The published package contains only `src/`, `README.md`, `LICENSE`, and `package.json`.

### Fixed
- README setup for Claude Code (MCP servers belong in `~/.claude.json` or `.mcp.json`, not `settings.json`), VS Code (`servers` key and `${env:...}` variables), and Cursor, now documented separately.
- The `bin` path no longer uses a `./` prefix, which npm 11 drops on publish.

## [1.3.0] - 2026-05-06

### Added
- Optional `offset` and `limit` parameters on `getCase`, `getCaseComments`, `getCaseComment`, `getCaseAttachments`, and `getExternalTrackerUpdates` split large responses into chunks; truncated responses end with a footer giving the next `offset`. `listCases` keeps its upstream `offset` row pagination.

### Fixed
- The server reports its package version; earlier releases reported 1.0.0.

## [1.2.3] - 2026-03-20

### Changed
- Repository and issue URLs point to the `sleepytimeshon` GitHub account after the repository transfer.

## [1.2.2] - 2026-03-12

### Changed
- README lists `mcp-redhat-manpage` under Related MCP Servers, in a standard order across all servers.

## [1.2.1] - 2026-03-10

### Added
- README configuration for Gemini CLI, a Related MCP Servers section, and guidance on supplying `REDHAT_TOKEN` through a secrets manager.

## [1.2.0] - 2026-03-08

### Added
- First public release: an MCP server for the Red Hat Support Case Management API with 16 tools to list, read, create, update, and close cases, manage comments, attachments, and notified users, and read external tracker updates and business hours.

[Unreleased]: https://github.com/sleepytimeshon/mcp-redhat-support/compare/v2.0.0...HEAD
[2.0.0]: https://www.npmjs.com/package/mcp-redhat-support/v/2.0.0
[1.3.2]: https://www.npmjs.com/package/mcp-redhat-support/v/1.3.2
[1.3.1]: https://www.npmjs.com/package/mcp-redhat-support/v/1.3.1
[1.3.0]: https://www.npmjs.com/package/mcp-redhat-support/v/1.3.0
[1.2.3]: https://www.npmjs.com/package/mcp-redhat-support/v/1.2.3
[1.2.2]: https://www.npmjs.com/package/mcp-redhat-support/v/1.2.2
[1.2.1]: https://www.npmjs.com/package/mcp-redhat-support/v/1.2.1
[1.2.0]: https://www.npmjs.com/package/mcp-redhat-support/v/1.2.0
