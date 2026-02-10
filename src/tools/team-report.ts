/**
 * "team_report" tool — generate a Tempo-style timesheet report for multiple users.
 *
 * Fetches worklogs + required hours for each worker over a date range,
 * then produces a grouped summary (by worker) with daily/total breakdowns.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getConfig } from "../config.js";
import { JiraClient } from "../jira-client.js";
import { TempoClient, type WorklogResult, type UserScheduleDay } from "../tempo-client.js";
import { formatSeconds, parseDate, formatDate, getWeekBounds, weekdayRange } from "../utils.js";

export function registerTeamReportTool(server: McpServer): void {
  server.registerTool(
    "team_report",
    {
      title: "Team Timesheet Report",
      description:
        "Generate a Tempo-style timesheet report for one or more users. " +
        "Provide worker account IDs directly, or search by display name. " +
        "Returns per-worker breakdown with logged vs required hours, daily totals, " +
        "and issue-level detail. Similar to the Tempo Reports > Logged Time view.",
      inputSchema: {
        period: z
          .enum(["today", "week", "month", "custom"])
          .default("month")
          .describe(
            'Period: "today", "week" (current week), "month" (current month), or "custom". ' +
            "Defaults to current month."
          ),
        from: z
          .string()
          .optional()
          .describe('Start date (YYYY-MM-DD) when period is "custom".'),
        to: z
          .string()
          .optional()
          .describe('End date (YYYY-MM-DD) when period is "custom".'),
        worker_account_ids: z
          .array(z.string())
          .optional()
          .describe(
            "Array of Jira account IDs to include in the report. " +
            "If omitted, searches by worker_names instead."
          ),
        worker_names: z
          .array(z.string())
          .optional()
          .describe(
            "Array of display names to search for in Jira. " +
            'Used when worker_account_ids is not provided. E.g. ["Vladimir Makhnevich", "John Smith"].'
          ),
        group_by: z
          .enum(["worker", "issue"])
          .default("worker")
          .describe('Group results by "worker" (default) or "issue".'),
        include_details: z
          .boolean()
          .default(true)
          .describe("Include per-issue detail rows for each worker. Defaults to true."),
      },
    },
    async ({ period, from, to, worker_account_ids, worker_names, group_by, include_details }) => {
      try {
        const config = getConfig();
        const tempo = new TempoClient(config.tempo_api_token);
        const jira = new JiraClient(
          config.jira_base_url,
          config.jira_email,
          config.jira_api_token
        );

        // --- Resolve date range ---
        let fromDate: Date;
        let toDate: Date;

        if (period === "today") {
          fromDate = new Date();
          toDate = new Date();
        } else if (period === "week") {
          [fromDate, toDate] = getWeekBounds();
        } else if (period === "month") {
          const now = new Date();
          fromDate = new Date(now.getFullYear(), now.getMonth(), 1);
          toDate = new Date(now.getFullYear(), now.getMonth() + 1, 0);
        } else {
          // custom
          if (!from || !to) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: 'When period is "custom", both "from" and "to" dates are required.',
                },
              ],
              isError: true,
            };
          }
          fromDate = parseDate(from);
          toDate = parseDate(to);
        }

        const fromStr = formatDate(fromDate);
        const toStr = formatDate(toDate);

        // --- Resolve worker account IDs ---
        let accountIds: string[] = worker_account_ids ?? [];

        if (accountIds.length === 0 && worker_names && worker_names.length > 0) {
          // Search Jira for each name
          for (const name of worker_names) {
            const users = await jira.searchUsers(name, 5);
            if (users.length === 0) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `Could not find Jira user matching "${name}". Try providing worker_account_ids directly.`,
                  },
                ],
                isError: true,
              };
            }
            // Pick exact match if available, otherwise first result
            const exact = users.find(
              (u) => u.displayName.toLowerCase() === name.toLowerCase()
            );
            accountIds.push((exact ?? users[0]).accountId);
          }
        }

        if (accountIds.length === 0) {
          // Default to self
          accountIds = [config.jira_account_id];
        }

        // --- Fetch worklogs, display names, and schedules for all workers in parallel ---
        // Uses GET /worklogs/user/{accountId} per user — this endpoint reliably
        // returns ALL worklogs including account-based/internal entries (Holiday, etc.).
        // The POST /worklogs/search endpoint was previously used but it misses
        // worklogs logged to Tempo accounts rather than Jira issues.
        const worklogsByAuthor = new Map<string, WorklogResult[]>();
        const nameMap = new Map<string, string>();
        const scheduleMap = new Map<string, UserScheduleDay[]>();

        await Promise.all(
          accountIds.map(async (id) => {
            // Fetch worklogs
            try {
              const wls = await tempo.getWorklogs(fromDate, toDate, id);
              worklogsByAuthor.set(id, wls);
            } catch {
              worklogsByAuthor.set(id, []);
            }

            // Resolve display name
            try {
              const user = await jira.getUser(id);
              nameMap.set(id, user.displayName);
            } catch {
              nameMap.set(id, id);
            }

            // Fetch required hours (user schedule)
            try {
              const schedule = await tempo.getUserSchedule(id, fromStr, toStr);
              scheduleMap.set(id, schedule);
            } catch {
              scheduleMap.set(id, []);
            }
          })
        );

        // Collect all worklogs into a flat list (needed for group_by=issue)
        const allWorklogs: WorklogResult[] = [];
        for (const wls of worklogsByAuthor.values()) {
          allWorklogs.push(...wls);
        }

        // --- Build output ---
        const outputParts: string[] = [];
        outputParts.push(`## Timesheet Report: ${fromStr} → ${toStr}\n`);

        if (group_by === "worker") {
          // --- Per-worker summary table ---
          const days = weekdayRange(fromDate, toDate);
          const showDailyGrid = days.length <= 31; // Only show daily grid for up to a month

          // Grand totals across all workers
          let grandLoggedSeconds = 0;
          let grandRequiredSeconds = 0;
          let grandBillableSeconds = 0;

          for (const accountId of accountIds) {
            const name = nameMap.get(accountId) ?? accountId;
            const wls = worklogsByAuthor.get(accountId) ?? [];
            const schedule = scheduleMap.get(accountId) ?? [];

            // Totals
            const totalLogged = wls.reduce((sum, w) => sum + w.timeSpentSeconds, 0);
            const totalBillable = wls.reduce((sum, w) => sum + w.billableSeconds, 0);
            const totalNonBillable = totalLogged - totalBillable;
            const totalRequired = schedule.reduce((sum, d) => sum + d.requiredSeconds, 0);
            grandLoggedSeconds += totalLogged;
            grandRequiredSeconds += totalRequired;
            grandBillableSeconds += totalBillable;

            const diff = totalLogged - totalRequired;
            const diffStr =
              diff === 0 ? "0h" : diff > 0 ? `+${formatSeconds(diff)}` : `-${formatSeconds(Math.abs(diff))}`;
            const billablePct = totalLogged > 0 ? Math.round((totalBillable / totalLogged) * 100) : 0;

            outputParts.push(
              `### ${name}\n` +
              `**Logged:** ${formatSeconds(totalLogged)} | ` +
              `**Required:** ${formatSeconds(totalRequired)} | ` +
              `**Difference:** ${diffStr}\n` +
              `**Billable:** ${formatSeconds(totalBillable)} (${billablePct}%) | ` +
              `**Non-billable:** ${formatSeconds(totalNonBillable)} (${100 - billablePct}%)\n`
            );

            // Daily aggregate for this worker
            if (showDailyGrid && days.length > 1) {
              const dailyLogged = new Map<string, number>();
              const dailyBillable = new Map<string, number>();
              for (const w of wls) {
                dailyLogged.set(w.startDate, (dailyLogged.get(w.startDate) ?? 0) + w.timeSpentSeconds);
                dailyBillable.set(w.startDate, (dailyBillable.get(w.startDate) ?? 0) + w.billableSeconds);
              }

              const requiredMap = new Map<string, number>();
              for (const s of schedule) {
                requiredMap.set(s.date, s.requiredSeconds);
              }

              const dayHeader = "| Date | Logged | Billable | Required | Diff |";
              const daySep = "|------|--------|----------|----------|------|";
              const dayRows: string[] = [];

              for (const d of days) {
                const ds = formatDate(d);
                const logged = dailyLogged.get(ds) ?? 0;
                const billable = dailyBillable.get(ds) ?? 0;
                const required = requiredMap.get(ds) ?? 0;
                // Skip days with zero logged and zero required (weekends/no schedule)
                if (logged === 0 && required === 0) continue;
                const dayDiff = logged - required;
                const dayDiffStr =
                  dayDiff === 0
                    ? "—"
                    : dayDiff > 0
                    ? `+${formatSeconds(dayDiff)}`
                    : `-${formatSeconds(Math.abs(dayDiff))}`;
                dayRows.push(
                  `| ${ds} | ${logged > 0 ? formatSeconds(logged) : "—"} | ${billable > 0 ? formatSeconds(billable) : "—"} | ${required > 0 ? formatSeconds(required) : "—"} | ${dayDiffStr} |`
                );
              }

              if (dayRows.length > 0) {
                outputParts.push([dayHeader, daySep, ...dayRows].join("\n") + "\n");
              }
            }

            // Issue-level detail
            if (include_details && wls.length > 0) {
              // Aggregate by issue key (or description when no issue)
              const issueTotals = new Map<string, number>();
              for (const w of wls) {
                const key = w.issueKey || "(no issue)";
                issueTotals.set(key, (issueTotals.get(key) ?? 0) + w.timeSpentSeconds);
              }

              const sorted = Array.from(issueTotals.entries()).sort(
                ([, a], [, b]) => b - a
              );

              const issueHeader = "| Issue | Total Time |";
              const issueSep = "|-------|------------|";
              const issueRows = sorted.map(
                ([issueKey, secs]) => `| ${issueKey} | ${formatSeconds(secs)} |`
              );

              outputParts.push("**Breakdown by issue:**\n");
              outputParts.push([issueHeader, issueSep, ...issueRows].join("\n") + "\n");

              // Aggregate by description / activity (with billable tracking)
              const activityTotals = new Map<string, { total: number; billable: number }>();
              for (const w of wls) {
                const activity = w.description?.trim() || "(no description)";
                const existing = activityTotals.get(activity) ?? { total: 0, billable: 0 };
                existing.total += w.timeSpentSeconds;
                existing.billable += w.billableSeconds;
                activityTotals.set(activity, existing);
              }

              if (activityTotals.size > 0) {
                const sortedActivities = Array.from(activityTotals.entries()).sort(
                  ([, a], [, b]) => b.total - a.total
                );

                const actHeader = "| Activity / Description | Total | Billable | % of Total |";
                const actSep = "|------------------------|-------|----------|------------|";
                const actRows = sortedActivities.map(([desc, { total, billable }]) => {
                  const pct = totalLogged > 0 ? Math.round((total / totalLogged) * 100) : 0;
                  const billStr = billable > 0 ? formatSeconds(billable) : "—";
                  return `| ${desc.slice(0, 80)} | ${formatSeconds(total)} | ${billStr} | ${pct}% |`;
                });

                outputParts.push("**Breakdown by activity:**\n");
                outputParts.push([actHeader, actSep, ...actRows].join("\n") + "\n");
              }
            }
          }

          // Grand totals
          const grandDiff = grandLoggedSeconds - grandRequiredSeconds;
          const grandDiffStr =
            grandDiff === 0
              ? "0h"
              : grandDiff > 0
              ? `+${formatSeconds(grandDiff)}`
              : `-${formatSeconds(Math.abs(grandDiff))}`;
          const grandNonBillable = grandLoggedSeconds - grandBillableSeconds;
          const grandBillablePct = grandLoggedSeconds > 0 ? Math.round((grandBillableSeconds / grandLoggedSeconds) * 100) : 0;

          outputParts.push(
            `---\n### Grand Total (${accountIds.length} workers)\n` +
            `**Logged:** ${formatSeconds(grandLoggedSeconds)} | ` +
            `**Required:** ${formatSeconds(grandRequiredSeconds)} | ` +
            `**Difference:** ${grandDiffStr}\n` +
            `**Billable:** ${formatSeconds(grandBillableSeconds)} (${grandBillablePct}%) | ` +
            `**Non-billable:** ${formatSeconds(grandNonBillable)} (${100 - grandBillablePct}%)\n`
          );
        } else {
          // --- Group by issue ---
          const issueWorkerTotals = new Map<
            string,
            Map<string, number>
          >();
          let grandTotal = 0;

          for (const wl of allWorklogs) {
            const issueKey = wl.issueKey || "(no issue)";
            if (!issueWorkerTotals.has(issueKey)) {
              issueWorkerTotals.set(issueKey, new Map());
            }
            const workerMap = issueWorkerTotals.get(issueKey)!;
            const authorId = wl.authorAccountId ?? "";
            workerMap.set(authorId, (workerMap.get(authorId) ?? 0) + wl.timeSpentSeconds);
            grandTotal += wl.timeSpentSeconds;
          }

          // Sort issues by total time descending
          const sortedIssues = Array.from(issueWorkerTotals.entries()).sort(
            ([, a], [, b]) => {
              const totalA = Array.from(a.values()).reduce((s, v) => s + v, 0);
              const totalB = Array.from(b.values()).reduce((s, v) => s + v, 0);
              return totalB - totalA;
            }
          );

          const header = "| Issue | Worker | Time |";
          const sep = "|-------|--------|------|";
          const rows: string[] = [];

          for (const [issueKey, workerMap] of sortedIssues) {
            const issueTotal = Array.from(workerMap.values()).reduce((s, v) => s + v, 0);
            rows.push(`| **${issueKey}** | | **${formatSeconds(issueTotal)}** |`);
            for (const [authorId, secs] of workerMap.entries()) {
              const name = nameMap.get(authorId) ?? authorId;
              rows.push(`| | ${name} | ${formatSeconds(secs)} |`);
            }
          }

          outputParts.push([header, sep, ...rows].join("\n"));
          outputParts.push(`\n**Grand total: ${formatSeconds(grandTotal)}**`);
        }

        return {
          content: [{ type: "text" as const, text: outputParts.join("\n") }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [
            { type: "text" as const, text: `Failed to generate team report: ${msg}` },
          ],
          isError: true,
        };
      }
    }
  );
}
