/**
 * "bulk_log_time" tool — log time to multiple Jira issues at once.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getConfig } from "../config.js";
import { JiraClient } from "../jira-client.js";
import { TempoClient } from "../tempo-client.js";
import { parseDuration, formatSeconds, today } from "../utils.js";

export function registerBulkLogTimeTool(server: McpServer): void {
  server.registerTool(
    "bulk_log_time",
    {
      title: "Bulk Log Time",
      description:
        "Log time to multiple Jira issues at once via the Tempo API. " +
        "Provide an array of entries, each with an issue key and duration. " +
        "Date defaults to today if not specified per entry.",
      inputSchema: {
        entries: z.array(
          z.object({
            issue_key: z.string().describe('Jira issue key, e.g. "PROJ-123"'),
            duration: z.string().describe('Time spent, e.g. "2h", "30m", "1h30m"'),
            date: z
              .string()
              .optional()
              .describe("Date in ISO format (YYYY-MM-DD). Defaults to today."),
            description: z
              .string()
              .optional()
              .describe("Optional description for the worklog."),
          })
        ).describe("Array of worklog entries to submit."),
      },
    },
    async ({ entries }) => {
      try {
        const config = getConfig();
        const jira = new JiraClient(config.jira_base_url, config.jira_email, config.jira_api_token);
        const tempo = new TempoClient(config.tempo_api_token);
        const defaultDate = today();

        const results: string[] = [];
        let success = 0;
        let failed = 0;

        for (const entry of entries) {
          try {
            const seconds = parseDuration(entry.duration);
            const startDate = entry.date ?? defaultDate;
            const key = entry.issue_key.toUpperCase();
            const issueId = await jira.getIssueId(key);

            const result = await tempo.createWorklog({
              issueId,
              issueKey: key,
              timeSpentSeconds: seconds,
              startDate,
              startTime: "09:00:00",
              authorAccountId: config.jira_account_id,
              description: entry.description,
            });

            results.push(
              `✓ ${entry.issue_key.toUpperCase()} — ${formatSeconds(seconds)} on ${startDate} (ID: ${result.tempoWorklogId})`
            );
            success++;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            results.push(`✗ ${entry.issue_key.toUpperCase()} — ${msg}`);
            failed++;
          }
        }

        const summary = `\nBulk log complete: ${success} succeeded, ${failed} failed out of ${entries.length} entries.`;

        return {
          content: [
            {
              type: "text" as const,
              text: results.join("\n") + summary,
            },
          ],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `Failed to bulk log time: ${msg}` }],
          isError: true,
        };
      }
    }
  );
}
