# Jira Tempo Time Tracking — MCP Server

An MCP (Model Context Protocol) server that provides Jira Tempo time tracking tools to AI agents in Cursor and other MCP-compatible clients.

Instead of typing CLI commands, you ask the agent naturally — "Log 2 hours to PROJ-123 for today" — and it calls the right tool automatically.

## Tools

| Tool | Description |
|------|-------------|
| `log_time` | Log time to a single Jira issue |
| `bulk_log_time` | Log time to multiple issues at once |
| `list_issues` | List Jira issues (assigned, recent, or by project) |
| `time_summary` | View logged time with daily totals (today, this week, or custom range) |
| `team_worklogs` | Show worklogs for your subordinates (Tempo teams you lead) |
| `plans` | View resource allocation plans from Tempo Capacity Planner |
| `team_report` | Multi-user timesheet report with logged vs required hours |

## Setup

### 1. Install dependencies

```bash
cd time-tracker
npm install
```

### 2. Get your API tokens

| Token | Source |
|-------|--------|
| Jira API token | [Atlassian API tokens](https://id.atlassian.com/manage-profile/security/api-tokens) |
| Tempo API token | Tempo > Settings > API Integration |

### 3. Configure your MCP client

Credentials are passed as environment variables in the MCP client config. The server reads them at startup and auto-detects your Jira account ID.

#### Cursor

Edit `.cursor/mcp.json` in the project root (already included):

```json
{
  "mcpServers": {
    "jira-tempo": {
      "command": "npx",
      "args": ["tsx", "src/index.ts"],
      "cwd": "/path/to/time-tracker",
      "env": {
        "JIRA_BASE_URL": "https://yourcompany.atlassian.net",
        "JIRA_EMAIL": "you@company.com",
        "JIRA_API_TOKEN": "your-jira-api-token",
        "TEMPO_API_TOKEN": "your-tempo-api-token"
      }
    }
  }
}
```

#### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "jira-tempo": {
      "command": "/path/to/time-tracker/run-server.sh",
      "args": [],
      "env": {
        "JIRA_BASE_URL": "https://yourcompany.atlassian.net",
        "JIRA_EMAIL": "you@company.com",
        "JIRA_API_TOKEN": "your-jira-api-token",
        "TEMPO_API_TOKEN": "your-tempo-api-token"
      }
    }
  }
}
```

### 4. Restart your client

Restart Cursor or Claude Desktop. The tools will appear automatically.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `JIRA_BASE_URL` | Yes | Jira Cloud URL, e.g. `https://company.atlassian.net` |
| `JIRA_EMAIL` | Yes | Email used to log into Jira |
| `JIRA_API_TOKEN` | Yes | Jira API token |
| `TEMPO_API_TOKEN` | Yes | Tempo API token |
| `JIRA_ACCOUNT_ID` | No | Auto-detected at startup via Jira API |

## Usage Examples

Once configured, just talk to the agent:

- **"Log 2 hours to PROJ-123 for today"** — calls `log_time`
- **"Log 4h to PROJ-100 and 4h to PROJ-200 for 2026-02-09"** — calls `bulk_log_time`
- **"Show my assigned Jira issues"** — calls `list_issues`
- **"Show my time summary for this week"** — calls `time_summary`
- **"Show my team's worklogs for last week"** — calls `team_worklogs`
- **"Show timesheet report for Vladimir Makhnevich for last month"** — calls `team_report`
- **"Generate a report for these account IDs for February"** — calls `team_report`

## Project Structure

```
src/
  index.ts             MCP server entry point (stdio transport)
  config.ts            Read credentials from environment variables
  jira-client.ts       Jira Cloud REST API v3 wrapper
  tempo-client.ts      Tempo Cloud REST API v4 wrapper
  utils.ts             Duration parsing, date helpers
  tools/
    log-time.ts        "log_time" tool
    bulk-log.ts        "bulk_log_time" tool
    list-issues.ts     "list_issues" tool
    summary.ts         "time_summary" tool
    team-worklogs.ts   "team_worklogs" tool
    plans.ts           "plans" tool
    team-report.ts     "team_report" tool
```

## Tech Stack

- **TypeScript** + **Node.js** v22
- **@modelcontextprotocol/sdk** v1.x — official MCP SDK
- **Zod** — input schema validation
- **stdio transport** — Cursor/Claude Desktop native MCP communication

## Requirements

- Node.js >= 18
- Jira Cloud instance with Tempo Timesheets
- Jira API token + Tempo API token
