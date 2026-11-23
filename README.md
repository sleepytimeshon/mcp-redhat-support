# mcp-redhat-support

An [MCP](https://modelcontextprotocol.io/) server for the Red Hat Support Case Management API. Lets AI assistants list, read, comment on, and manage Red Hat support cases.

## Tools

| Tool | Description |
|------|-------------|
| `listCases` | List support cases with filtering by status, severity, and search string |
| `getCase` | Get full details of a specific case |
| `getCaseComments` | Get all comments on a case |
| `getCaseComment` | Get a single comment by comment ID |
| `addCaseComment` | Add a comment to a case |
| `getExternalTrackerUpdates` | List external tracker updates (linked Jira/Bugzilla) on a case |
| `addNotifiedUsers` | Add notified users to a case |
| `removeNotifiedUser` | Remove a notified user from a case |
| `getCaseAttachments` | List attachments on a case |
| `downloadAttachment` | Download a case attachment to a local file |
| `uploadAttachment` | Upload a local file as an attachment to a case |
| `deleteAttachment` | Delete an attachment from a case |
| `createCase` | Open a new support case |
| `updateCase` | Update case fields (severity, status, consultant engaged, contact, etc.) |
| `closeCase` | Close a case with an optional resolution comment |
| `getBusinessHours` | Get Red Hat support business hours for a given timezone |

## Pagination

The five read-only tools that return potentially-large payloads — `getCase`, `getCaseComments`, `getCaseComment`, `getCaseAttachments`, `getExternalTrackerUpdates` — accept optional `offset` (default 0) and `limit` (default 30000) parameters to chunk responses. Real-world cases with long comment threads can exceed typical MCP tool-result token caps when returned whole. When a response is truncated, the output ends with a footer like:

```
[truncated: showing chars 0-30000 of 102783. Call again with offset=30000 for the next chunk.]
```

Pass that `offset` back to fetch the next chunk. Small responses return in one call. `listCases` is not response-paginated; it has its own upstream API row-pagination via the existing `offset` parameter.

## Prerequisites

- Node.js 18.14.1+
- A Red Hat offline API token ([generate one here](https://access.redhat.com/management/api))

## Configuration

Set your Red Hat offline API token in your shell profile:

```bash
export REDHAT_TOKEN="your-offline-token-here"
```

In enterprise environments, provide `REDHAT_TOKEN` through your secrets management solution (e.g. HashiCorp Vault, Kubernetes secrets, or your CI platform's secret variables) rather than shell profiles.

The offline token expires if it is not used for 30 days; generate a new one from the same page if authentication starts failing.

### Pinning a version

The examples below run `npx -y mcp-redhat-support`, which fetches the latest published release each time the server starts. For operational use, pin a version so upgrades happen deliberately:

- Replace `mcp-redhat-support` in `args` with `mcp-redhat-support@<version>` (e.g. `mcp-redhat-support@1.3.0`), or
- Install it once with `npm install -g mcp-redhat-support@<version>` and use `mcp-redhat-support` as the `command` with no `args`.

### Gemini CLI

Add to `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "redhat-support": {
      "command": "npx",
      "args": ["-y", "mcp-redhat-support"],
      "env": {
        "REDHAT_TOKEN": "$REDHAT_TOKEN"
      }
    }
  }
}
```

### watsonx Orchestrate

```bash
# Add a connection for the Red Hat API token
orchestrate connections add --app-id "redhat-support"
orchestrate connections configure --app-id redhat-support --env draft --kind key_value --type team --url "https://access.redhat.com"
orchestrate connections set-credentials --app-id "redhat-support" --env draft -e REDHAT_TOKEN=your-offline-token-here

# Import the MCP toolkit
orchestrate toolkits import --kind mcp \
  --name redhat-support \
  --description "Red Hat Support Case Management" \
  --command "npx -y mcp-redhat-support" \
  --tools "*" \
  --app-id redhat-support
```

### Claude Code

Claude Code reads MCP servers from `~/.claude.json` (user and local scopes) or a project's `.mcp.json`, not from `settings.json`.

To make the server available in every project, add it at user scope:

```bash
claude mcp add redhat-support --scope user \
  -e REDHAT_TOKEN="$REDHAT_TOKEN" \
  -- npx -y mcp-redhat-support
```

This stores the token's value in `~/.claude.json`. To keep the token out of configuration files, add the server to a project's `.mcp.json` instead; Claude Code expands `${REDHAT_TOKEN}` from the environment when it starts the server:

```json
{
  "mcpServers": {
    "redhat-support": {
      "command": "npx",
      "args": ["-y", "mcp-redhat-support"],
      "env": {
        "REDHAT_TOKEN": "${REDHAT_TOKEN}"
      }
    }
  }
}
```

Run `claude mcp list` to confirm the server connects.

### VS Code

Add to `.vscode/mcp.json` in your workspace:

```json
{
  "servers": {
    "redhat-support": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "mcp-redhat-support"],
      "env": {
        "REDHAT_TOKEN": "${env:REDHAT_TOKEN}"
      }
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json` in your workspace, or `~/.cursor/mcp.json` for all workspaces:

```json
{
  "mcpServers": {
    "redhat-support": {
      "command": "npx",
      "args": ["-y", "mcp-redhat-support"],
      "env": {
        "REDHAT_TOKEN": "${env:REDHAT_TOKEN}"
      }
    }
  }
}
```

## Authentication

The server exchanges your Red Hat offline API token for a short-lived bearer token via Red Hat SSO. Tokens are cached and refreshed automatically.

## Releasing

Every push to `main` runs CI (`.github/workflows/ci.yml`): `npm ci`, a syntax check, and `npm test` on Node 18, 20, 22, and 24. `npm test` starts the server and checks that its tools match the tables in [Tools](#tools) and that it reports the `package.json` version.

To release, bump `version` in both `package.json` and the `McpServer` declaration in `src/index.js`, move the `[Unreleased]` entries in [CHANGELOG.md](CHANGELOG.md) under a heading for the new version, then push to `main`. When that version is not yet on npm, CI publishes it with provenance through npm trusted publishing and creates a `vX.Y.Z` GitHub release. Pushes that keep the version only run the tests.

## Related MCP Servers

- [mcp-redhat-account](https://github.com/sleepytimeshon/mcp-redhat-account) - Account management
- [mcp-redhat-knowledge](https://github.com/sleepytimeshon/mcp-redhat-knowledge) - Knowledge Base search
- [mcp-redhat-manpage](https://github.com/sleepytimeshon/mcp-redhat-manpage) - RHEL man pages
- [mcp-redhat-subscription](https://github.com/sleepytimeshon/mcp-redhat-subscription) - Subscription management

## License

MIT
