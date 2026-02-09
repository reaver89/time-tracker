/**
 * "team_worklogs" tool — show worklogs for subordinates (Tempo team members).
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getConfig } from "../config.js";
import { JiraClient } from "../jira-client.js";
import { TempoClient, type TempoTeam, type WorklogResult } from "../tempo-client.js";
import { formatSeconds, parseDate, formatDate, getWeekBounds, weekdayRange } from "../utils.js";

export function registerTeamWorklogsTool(server: McpServer): void {
  server.registerTool(
    "team_worklogs",
    {
      title: "Team Worklogs",
      description:
        "Show worklogs for your subordinates (members of Tempo teams you lead). " +
        "Auto-detects teams where you are the lead, or specify a team_id. " +
        "Returns a per-member breakdown with daily totals for the given period.",
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
        team_id: z
          .number()
          .optional()
          .describe("Optional Tempo team ID. If omitted, auto-detects teams you lead."),
      },
    },
    async ({ period, date, week_start, team_id }) => {
      try {
        const config = getConfig();
        const tempo = new TempoClient(config.tempo_api_token);
        const jira = new JiraClient(
          config.jira_base_url,
          config.jira_email,
          config.jira_api_token
        );
        const myAccountId = config.jira_account_id;

        // --- Resolve date range ---
        let fromDate: Date;
        let toDate: Date;

        if (period === "today") {
          fromDate = new Date();
          toDate = new Date();
        } else if (period === "custom") {
          if (date) {
            const d = parseDate(date);
            fromDate = d;
            toDate = d;
          } else if (week_start) {
            const monday = parseDate(week_start);
            [fromDate, toDate] = getWeekBounds(monday);
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
          [fromDate, toDate] = getWeekBounds();
        }

        // --- Resolve teams ---
        let teams: TempoTeam[];
        if (team_id !== undefined) {
          const allTeams = await tempo.getTeams();
          const match = allTeams.find((t) => t.id === team_id);
          teams = match ? [match] : [{ id: team_id, name: `Team ${team_id}`, leadAccountId: myAccountId }];
        } else {
          const allTeams = await tempo.getTeams();
          teams = allTeams.filter((t) => t.leadAccountId === myAccountId);
          if (teams.length === 0) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "You are not the lead of any Tempo teams. Specify a team_id to view a specific team's worklogs.",
                },
              ],
            };
          }
        }

        const outputParts: string[] = [];
        const dateRange = `${formatDate(fromDate)} → ${formatDate(toDate)}`;

        for (const team of teams) {
          // Get team members
          const members = await tempo.getTeamMembers(team.id);
          if (members.length === 0) {
            outputParts.push(`## ${team.name}\nNo members found.\n`);
            continue;
          }

          // Resolve display names for all members
          const memberNames = new Map<string, string>();
          await Promise.all(
            members.map(async (m) => {
              try {
                const user = await jira.getUser(m.accountId);
                memberNames.set(m.accountId, user.displayName);
              } catch {
                memberNames.set(m.accountId, m.accountId);
              }
            })
          );

          // Fetch worklogs for all members in parallel
          const memberWorklogs = new Map<string, WorklogResult[]>();
          await Promise.all(
            members.map(async (m) => {
              try {
                const wls = await tempo.getWorklogs(fromDate, toDate, m.accountId);
                memberWorklogs.set(m.accountId, wls);
              } catch {
                memberWorklogs.set(m.accountId, []);
              }
            })
          );

          // Build output for this team
          outputParts.push(`## ${team.name} (${dateRange})\n`);

          // Per-member detail
          for (const member of members) {
            const name = memberNames.get(member.accountId) ?? member.accountId;
            const wls = memberWorklogs.get(member.accountId) ?? [];
            const totalSeconds = wls.reduce((sum, w) => sum + w.timeSpentSeconds, 0);

            outputParts.push(`### ${name} (${formatSeconds(totalSeconds)} total)\n`);

            if (wls.length === 0) {
              outputParts.push("No worklogs for this period.\n");
              continue;
            }

            // Sort by date then issue
            wls.sort((a, b) =>
              a.startDate === b.startDate
                ? a.issueKey.localeCompare(b.issueKey)
                : a.startDate.localeCompare(b.startDate)
            );

            const header = "| Date | Duration | Issue | Description |";
            const sep = "|------|----------|-------|-------------|";
            const rows = wls.map(
              (w) =>
                `| ${w.startDate} | ${formatSeconds(w.timeSpentSeconds)} | ${w.issueKey || "—"} | ${w.description.slice(0, 80) || "—"} |`
            );
            outputParts.push([header, sep, ...rows].join("\n") + "\n");
          }

          // Weekly summary table (only if range spans multiple days)
          const days = weekdayRange(fromDate, toDate);
          if (days.length > 1) {
            const dayLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

            const summaryHeader =
              "| Member | " + days.map((d) => dayLabels[d.getDay() === 0 ? 6 : d.getDay() - 1]).join(" | ") + " | Total |";
            const summarySep =
              "|--------|" + days.map(() => "----").join("|") + "|-------|";

            const summaryRows: string[] = [];
            for (const member of members) {
              const name = memberNames.get(member.accountId) ?? member.accountId;
              const wls = memberWorklogs.get(member.accountId) ?? [];

              // Aggregate by date
              const dailyMap = new Map<string, number>();
              for (const w of wls) {
                dailyMap.set(w.startDate, (dailyMap.get(w.startDate) ?? 0) + w.timeSpentSeconds);
              }

              let memberTotal = 0;
              const dayCells = days.map((d) => {
                const ds = formatDate(d);
                const secs = dailyMap.get(ds) ?? 0;
                memberTotal += secs;
                return secs > 0 ? formatSeconds(secs) : "—";
              });

              summaryRows.push(
                `| ${name} | ${dayCells.join(" | ")} | **${formatSeconds(memberTotal)}** |`
              );
            }

            outputParts.push("### Summary\n");
            outputParts.push([summaryHeader, summarySep, ...summaryRows].join("\n") + "\n");
          }
        }

        return {
          content: [{ type: "text" as const, text: outputParts.join("\n") }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [
            { type: "text" as const, text: `Failed to get team worklogs: ${msg}` },
          ],
          isError: true,
        };
      }
    }
  );
}
