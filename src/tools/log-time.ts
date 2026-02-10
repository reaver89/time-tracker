/**
 * "log_time" tool — log time to a single Jira issue via Tempo.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getConfig } from "../config.js";
import { JiraClient } from "../jira-client.js";
import { TempoClient } from "../tempo-client.js";
import { parseDuration, formatSeconds, today } from "../utils.js";

export function registerLogTimeTool(server: McpServer): void {
  server.registerTool(
    "log_time",
    {
      title: "Log Time",
      description:
        "Log time to a single Jira issue via the Tempo API. " +
        'Duration supports formats like "2h", "30m", "1h30m", "1.5h".',
      inputSchema: {
        issue_key: z
          .string()
          .describe('Jira issue key, e.g. "PROJ-123"'),
        duration: z
          .string()
          .describe('Time spent, e.g. "2h", "30m", "1h30m", "1.5h"'),
        date: z
          .string()
          .optional()
          .describe("Date for the worklog in ISO format (YYYY-MM-DD). Defaults to today."),
        description: z
          .string()
          .optional()
          .describe("Optional description / comment for the worklog."),
      },
    },
    async ({ issue_key, duration, date, description }) => {
      try {
        const config = getConfig();
        const seconds = parseDuration(duration);
        const startDate = date ?? today();
        const key = issue_key.toUpperCase();

        const jira = new JiraClient(config.jira_base_url, config.jira_email, config.jira_api_token);
        const { issueId, projectId } = await jira.getIssueId(key);

        const tempo = new TempoClient(config.tempo_api_token);

        // Resolve default Tempo account for the project (required work attribute)
        const attributes: Array<{ key: string; value: string }> = [];
        if (projectId) {
          const accountLink = await tempo.getDefaultAccountForProject(projectId);
          if (accountLink) {
            attributes.push({ key: "_CSMProject_", value: accountLink.accountKey });
          }
        }

        const result = await tempo.createWorklog({
          issueId,
          issueKey: key,
          timeSpentSeconds: seconds,
          startDate,
          startTime: "09:00:00",
          authorAccountId: config.jira_account_id,
          description,
          attributes,
        });

        return {
          content: [
            {
              type: "text" as const,
              text:
                `Successfully logged ${formatSeconds(seconds)} to ${issue_key.toUpperCase()} on ${startDate}.\n` +
                `Tempo worklog ID: ${result.tempoWorklogId}`,
            },
          ],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `Failed to log time: ${msg}` }],
          isError: true,
        };
      }
    }
  );
}
