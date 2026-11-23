# Changelog

All notable changes to this project are documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- This changelog, included in the published package.

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

[Unreleased]: https://github.com/sleepytimeshon/mcp-redhat-support/compare/v1.3.1...HEAD
[1.3.1]: https://www.npmjs.com/package/mcp-redhat-support/v/1.3.1
[1.3.0]: https://www.npmjs.com/package/mcp-redhat-support/v/1.3.0
[1.2.3]: https://www.npmjs.com/package/mcp-redhat-support/v/1.2.3
[1.2.2]: https://www.npmjs.com/package/mcp-redhat-support/v/1.2.2
[1.2.1]: https://www.npmjs.com/package/mcp-redhat-support/v/1.2.1
[1.2.0]: https://www.npmjs.com/package/mcp-redhat-support/v/1.2.0
