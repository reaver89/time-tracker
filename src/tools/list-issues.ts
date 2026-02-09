/**
 * "list_issues" tool — list Jira issues (assigned, recent, or by project).
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getConfig } from "../config.js";
import { JiraClient } from "../jira-client.js";

export function registerListIssuesTool(server: McpServer): void {
  server.registerTool(
    "list_issues",
    {
      title: "List Jira Issues",
      description:
        "List Jira issues. By default shows open issues assigned to you. " +
        'Use filter "project" with a project_key to filter by project, ' +
        'or "recent" to show recently updated issues.',
      inputSchema: {
        filter: z
          .enum(["assigned", "recent", "project"])
          .default("assigned")
          .describe('Filter type: "assigned" (default), "recent", or "project".'),
        project_key: z
          .string()
          .optional()
          .describe('Required when filter is "project". The Jira project key, e.g. "PROJ".'),
      },
    },
    async ({ filter, project_key }) => {
      try {
        const config = getConfig();
        const jira = new JiraClient(
          config.jira_base_url,
          config.jira_email,
          config.jira_api_token
        );

        let issues;
        if (filter === "project") {
          if (!project_key) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: 'project_key is required when filter is "project".',
                },
              ],
              isError: true,
            };
          }
          issues = await jira.projectIssues(project_key.toUpperCase());
        } else if (filter === "recent") {
          issues = await jira.recentIssues();
        } else {
          issues = await jira.myOpenIssues();
        }

        if (issues.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No issues found." }],
          };
        }

        // Format as a markdown table
        const header = "| Key | Type | Status | Summary |";
        const separator = "|-----|------|--------|---------|";
        const rows = issues.map(
          (i) =>
            `| ${i.key} | ${i.issueType} | ${i.status} | ${i.summary} |`
        );

        return {
          content: [
            {
              type: "text" as const,
              text: [header, separator, ...rows].join("\n"),
            },
          ],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `Failed to list issues: ${msg}` }],
          isError: true,
        };
      }
    }
  );
}
