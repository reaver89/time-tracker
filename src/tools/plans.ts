/**
 * "plans" tool — view resource allocation plans from Tempo Capacity Planner.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getConfig } from "../config.js";
import { JiraClient } from "../jira-client.js";
import { TempoClient, type PlanResult } from "../tempo-client.js";
import { formatSeconds, parseDate, formatDate, getWeekBounds } from "../utils.js";

export function registerPlansTool(server: McpServer): void {
  server.registerTool(
    "plans",
    {
      title: "Resource Plans",
      description:
        "View resource allocation plans from Tempo Capacity Planner. " +
        "Shows planned time per issue/project for a given period. " +
        '"today" shows plans active today, "week" shows the current week, ' +
        '"custom" uses the provided date or week_start. ' +
        "Optionally view plans for a different user by providing account_id.",
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
        account_id: z
          .string()
          .optional()
          .describe("Optional Jira account ID to view another user's plans. Defaults to your own."),
      },
    },
    async ({ period, date, week_start, account_id }) => {
      try {
        const config = getConfig();
        const tempo = new TempoClient(config.tempo_api_token);
        const jira = new JiraClient(
          config.jira_base_url,
          config.jira_email,
          config.jira_api_token
        );
        const targetAccountId = account_id || config.jira_account_id;

        // --- Resolve date range ---
        let fromDate: Date;
        let toDate: Date;
        let title: string;

        if (period === "today") {
          fromDate = new Date();
          toDate = new Date();
          title = `Plans for ${formatDate(fromDate)}`;
        } else if (period === "custom") {
          if (date) {
            const d = parseDate(date);
            fromDate = d;
            toDate = d;
            title = `Plans for ${formatDate(d)}`;
          } else if (week_start) {
            const monday = parseDate(week_start);
            [fromDate, toDate] = getWeekBounds(monday);
            title = `Plans for week ${formatDate(fromDate)} → ${formatDate(toDate)}`;
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
          title = `Plans for week ${formatDate(fromDate)} → ${formatDate(toDate)}`;
        }

        const from = formatDate(fromDate);
        const to = formatDate(toDate);

        // --- Fetch plans ---
        const plans = await tempo.getPlansForUser(targetAccountId, from, to);

        if (plans.length === 0) {
          return {
            content: [
              { type: "text" as const, text: `No plans found for this period (${from} → ${to}).` },
            ],
          };
        }

        // --- Resolve plan item names (issue keys / project names) ---
        const itemLabels = new Map<string, string>();
        await Promise.all(
          plans.map(async (plan) => {
            const cacheKey = `${plan.planItem.type}:${plan.planItem.id}`;
            if (itemLabels.has(cacheKey)) return;

            try {
              if (plan.planItem.type === "ISSUE") {
                const issue = await jira.getIssueById(plan.planItem.id);
                itemLabels.set(cacheKey, `${issue.key} — ${issue.summary}`);
              } else if (plan.planItem.type === "PROJECT") {
                const project = await jira.getProjectById(plan.planItem.id);
                itemLabels.set(cacheKey, `${project.key} — ${project.name}`);
              } else {
                itemLabels.set(cacheKey, `${plan.planItem.type} #${plan.planItem.id}`);
              }
            } catch {
              itemLabels.set(cacheKey, `${plan.planItem.type} #${plan.planItem.id}`);
            }
          })
        );

        // --- Resolve user display name ---
        let displayName = targetAccountId;
        try {
          const user = await jira.getUser(targetAccountId);
          displayName = user.displayName;
        } catch {
          // keep accountId as fallback
        }

        // --- Format output ---
        const outputParts: string[] = [];
        outputParts.push(`### ${title} — ${displayName}\n`);

        // Sort plans by start date then plan item
        plans.sort((a, b) =>
          a.startDate === b.startDate
            ? a.planItem.id.localeCompare(b.planItem.id)
            : a.startDate.localeCompare(b.startDate)
        );

        const header = "| Issue / Project | Date Range | Planned/Day | Total Planned | Description |";
        const sep = "|-----------------|------------|-------------|---------------|-------------|";
        const rows = plans.map((p) => {
          const label = itemLabels.get(`${p.planItem.type}:${p.planItem.id}`) ?? p.planItem.id;
          const range = p.startDate === p.endDate
            ? p.startDate
            : `${p.startDate} → ${p.endDate}`;
          const perDay = p.plannedSecondsPerDay > 0
            ? formatSeconds(p.plannedSecondsPerDay)
            : "—";
          const total = p.totalPlannedSecondsInScope > 0
            ? formatSeconds(p.totalPlannedSecondsInScope)
            : (p.totalPlannedSeconds > 0 ? formatSeconds(p.totalPlannedSeconds) : "—");
          const desc = p.description?.slice(0, 60) || "—";
          return `| ${label} | ${range} | ${perDay} | ${total} | ${desc} |`;
        });

        outputParts.push([header, sep, ...rows].join("\n"));

        // Grand total of planned time in scope
        const grandTotalSeconds = plans.reduce(
          (sum, p) => sum + (p.totalPlannedSecondsInScope || p.totalPlannedSeconds || 0),
          0
        );
        outputParts.push(`\n**Total planned: ${formatSeconds(grandTotalSeconds)}**`);

        return {
          content: [{ type: "text" as const, text: outputParts.join("\n") }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [
            { type: "text" as const, text: `Failed to get plans: ${msg}` },
          ],
          isError: true,
        };
      }
    }
  );
}
