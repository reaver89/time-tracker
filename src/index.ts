/**
 * Jira Tempo Time Tracking MCP Server
 *
 * Entry point: creates an MCP server with stdio transport and
 * registers all tools (log_time, bulk_log_time, list_issues,
 * time_summary, team_worklogs, plans).
 *
 * Credentials are read from environment variables. The Jira account ID
 * is auto-fetched at startup by calling GET /rest/api/3/myself.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { JiraClient } from "./jira-client.js";
import { registerLogTimeTool } from "./tools/log-time.js";
import { registerBulkLogTimeTool } from "./tools/bulk-log.js";
import { registerListIssuesTool } from "./tools/list-issues.js";
import { registerTimeSummaryTool } from "./tools/summary.js";
import { registerTeamWorklogsTool } from "./tools/team-worklogs.js";
import { registerPlansTool } from "./tools/plans.js";

// Auto-fetch Jira account ID at startup
const baseUrl = process.env.JIRA_BASE_URL;
const email = process.env.JIRA_EMAIL;
const token = process.env.JIRA_API_TOKEN;

if (baseUrl && email && token) {
  try {
    const jira = new JiraClient(baseUrl, email, token);
    const myself = await jira.getMyself();
    process.env.JIRA_ACCOUNT_ID = myself.accountId;
    console.error(
      `[jira-tempo] Authenticated as ${myself.displayName} (${myself.accountId})`
    );
  } catch (err) {
    console.error(
      `[jira-tempo] Warning: could not auto-fetch Jira account ID: ${err}`
    );
  }
}

const server = new McpServer({
  name: "jira-tempo-tracker",
  version: "1.0.0",
});

// Register all tools
registerLogTimeTool(server);
registerBulkLogTimeTool(server);
registerListIssuesTool(server);
registerTimeSummaryTool(server);
registerTeamWorklogsTool(server);
registerPlansTool(server);

// Connect via stdio transport (used by Cursor and other MCP clients)
const transport = new StdioServerTransport();
await server.connect(transport);
