/**
 * "time_summary" tool — view logged time for a period.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getConfig } from "../config.js";
import { TempoClient } from "../tempo-client.js";
import { formatSeconds, parseDate, formatDate, getWeekBounds } from "../utils.js";

export function registerTimeSummaryTool(server: McpServer): void {
  server.registerTool(
    "time_summary",
    {
      title: "Time Summary",
      description:
        "View logged time for a period. " +
        '"today" shows today\'s worklogs, "week" shows the current week (Mon-Fri), ' +
        '"custom" uses the provided date or week_start.',
      inputSchema: {
        period: z
          .enum(["today", "week", "custom"])
          .default("week")
          .describe('Period: "today", "week" (default), or "custom".'),
        date: z
          .string()
          .optional()
          .describe('Specific date (YYYY-MM-DD) when period is "custom". Shows that single day.'),
        week_start: z
          .string()
          .optional()
          .describe('Monday date (YYYY-MM-DD) when period is "custom". Shows that full week.'),
      },
    },
    async ({ period, date, week_start }) => {
      try {
        const config = getConfig();
        const tempo = new TempoClient(config.tempo_api_token);
        const accountId = config.jira_account_id;

        let fromDate: Date;
        let toDate: Date;
        let title: string;

        if (period === "today") {
          fromDate = new Date();
          toDate = new Date();
          title = `Worklogs for ${formatDate(fromDate)}`;
        } else if (period === "custom") {
          if (date) {
            const d = parseDate(date);
            fromDate = d;
            toDate = d;
            title = `Worklogs for ${formatDate(d)}`;
          } else if (week_start) {
            const monday = parseDate(week_start);
            [fromDate, toDate] = getWeekBounds(monday);
            title = `Worklogs for week ${formatDate(fromDate)} → ${formatDate(toDate)}`;
          } else {
            return {
              content: [
                {
                  type: "text" as const,
                  text: 'When period is "custom", provide either "date" or "week_start".',
                },
              ],
              isError: true,
            };
          }
        } else {
          // "week" — current week
          [fromDate, toDate] = getWeekBounds();
          title = `Worklogs for week ${formatDate(fromDate)} → ${formatDate(toDate)}`;
        }

        const worklogs = await tempo.getWorklogs(fromDate, toDate, accountId);

        if (worklogs.length === 0) {
          return {
            content: [
              { type: "text" as const, text: "No worklogs found for this period." },
            ],
          };
        }

        // Sort by date then issue
        worklogs.sort((a, b) =>
          a.startDate === b.startDate
            ? a.issueKey.localeCompare(b.issueKey)
            : a.startDate.localeCompare(b.startDate)
        );

        // Detail table
        const header = "| Date | Issue | Duration | Description |";
        const separator = "|------|-------|----------|-------------|";
        const rows = worklogs.map(
          (w) =>
            `| ${w.startDate} | ${w.issueKey} | ${formatSeconds(w.timeSpentSeconds)} | ${w.description || "—"} |`
        );

        // Daily totals
        const dailyTotals = new Map<string, number>();
        let grandTotal = 0;
        for (const w of worklogs) {
          dailyTotals.set(
            w.startDate,
            (dailyTotals.get(w.startDate) ?? 0) + w.timeSpentSeconds
          );
          grandTotal += w.timeSpentSeconds;
        }

        const totalsHeader = "\n| Date | Total |";
        const totalsSep = "|------|-------|";
        const totalsRows = Array.from(dailyTotals.entries())
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([d, s]) => `| ${d} | ${formatSeconds(s)} |`);

        const grandTotalRow = `| **Grand Total** | **${formatSeconds(grandTotal)}** |`;

        const output = [
          `### ${title}`,
          "",
          header,
          separator,
          ...rows,
          "",
          "### Daily Totals",
          totalsHeader,
          totalsSep,
          ...totalsRows,
          grandTotalRow,
        ].join("\n");

        return {
          content: [{ type: "text" as const, text: output }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `Failed to get summary: ${msg}` }],
          isError: true,
        };
      }
    }
  );
}
