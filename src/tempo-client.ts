/**
 * Tempo Cloud REST API v4 client.
 *
 * Handles worklog creation and retrieval via https://api.tempo.io/4.
 */

import { formatDate } from "./utils.js";

const TEMPO_BASE_URL = "https://api.tempo.io/4";

export interface TempoTeam {
  id: number;
  name: string;
  leadAccountId: string;
}

export interface TempoTeamMember {
  accountId: string;
  roleId: number;
}

export interface WorklogPayload {
  issueId: number;
  issueKey?: string;       // kept for display purposes only
  timeSpentSeconds: number;
  startDate: string;       // YYYY-MM-DD
  startTime: string;       // HH:MM:SS
  authorAccountId: string;
  description?: string;
  attributes?: Array<{ key: string; value: string }>;
}

export interface AccountLink {
  id: number;
  accountKey: string;
  accountId: number;
  isDefault: boolean;
}

export interface WorklogResult {
  tempoWorklogId: number;
  issueKey: string;
  timeSpentSeconds: number;
  billableSeconds: number;
  startDate: string;
  description: string;
  authorAccountId?: string;
}

export interface UserScheduleDay {
  date: string;
  requiredSeconds: number;
  type: string;
}

export interface PlanResult {
  id: number;
  startDate: string;
  endDate: string;
  plannedSecondsPerDay: number;
  totalPlannedSeconds: number;
  totalPlannedSecondsInScope: number;
  description: string;
  assignee: { id: string; type: string };
  planItem: { id: string; type: string }; // ISSUE or PROJECT
}

export class TempoClient {
  private token: string;

  constructor(apiToken: string) {
    this.token = apiToken;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    params?: Record<string, string>
  ): Promise<T> {
    const url = new URL(`${TEMPO_BASE_URL}/${path.replace(/^\//, "")}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
      }
    }

    const resp = await fetch(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Tempo API error ${resp.status}: ${text}`);
    }

    return resp.json() as Promise<T>;
  }

  /** Create a single worklog entry. */
  async createWorklog(payload: WorklogPayload): Promise<WorklogResult> {
    const body: Record<string, unknown> = {
      issueId: payload.issueId,
      timeSpentSeconds: payload.timeSpentSeconds,
      startDate: payload.startDate,
      startTime: payload.startTime,
      authorAccountId: payload.authorAccountId,
    };
    if (payload.description) {
      body.description = payload.description;
    }
    if (payload.attributes && payload.attributes.length > 0) {
      body.attributes = payload.attributes;
    }

    const data = await this.request<{
      tempoWorklogId: number;
      issue: { key: string };
      timeSpentSeconds: number;
      billableSeconds?: number;
      startDate: string;
      description?: string;
    }>("POST", "worklogs", body);

    return {
      tempoWorklogId: data.tempoWorklogId,
      issueKey: data.issue?.key ?? payload.issueKey,
      timeSpentSeconds: data.timeSpentSeconds,
      billableSeconds: data.billableSeconds ?? 0,
      startDate: data.startDate,
      description: data.description ?? "",
    };
  }

  /**
   * Retrieve the default Tempo account linked to a Jira project.
   * The account-links endpoint only returns account.self (a URL),
   * so we extract the account ID and fetch the full account to get its key.
   */
  async getDefaultAccountForProject(projectId: number): Promise<AccountLink | null> {
    try {
      const data = await this.request<{
        results: Array<{
          id: number;
          scope: { id: number; type: string };
          account: { self: string; id?: number; key?: string };
          default: boolean;
        }>;
      }>("GET", `account-links/project/${projectId}`, undefined, { limit: "100" });

      const links = data.results || [];
      if (links.length === 0) return null;

      // Find the default link first, otherwise return the first one
      const link = links.find((l) => l.default) ?? links[0];

      // Extract account ID from self URL (e.g. ".../4/accounts/248" -> 248)
      let accountId = link.account?.id ?? 0;
      if (!accountId && link.account?.self) {
        const match = link.account.self.match(/\/accounts\/(\d+)/);
        if (match) accountId = Number(match[1]);
      }

      if (!accountId) return null;

      // Fetch the full account to get its key
      let accountKey = link.account?.key ?? "";
      if (!accountKey) {
        const account = await this.request<{ id: number; key: string }>(
          "GET", `accounts/${accountId}`
        );
        accountKey = account.key;
      }

      return {
        id: link.id,
        accountKey,
        accountId,
        isDefault: link.default ?? false,
      };
    } catch {
      return null;
    }
  }

  /** Retrieve all Tempo teams. */
  async getTeams(): Promise<TempoTeam[]> {
    const data = await this.request<{
      results: Array<{
        id: number;
        name: string;
        lead: { accountId: string };
      }>;
    }>("GET", "teams", undefined, { limit: "1000" });

    return (data.results || []).map((t) => ({
      id: t.id,
      name: t.name,
      leadAccountId: t.lead?.accountId ?? "",
    }));
  }

  /** Retrieve active members of a Tempo team. */
  async getTeamMembers(teamId: number): Promise<TempoTeamMember[]> {
    const data = await this.request<{
      results: Array<{
        member: { accountId: string };
        role?: { id: number };
      }>;
    }>("GET", `teams/${teamId}/members`, undefined, { limit: "1000" });

    return (data.results || []).map((m) => ({
      accountId: m.member?.accountId ?? "",
      roleId: m.role?.id ?? 0,
    }));
  }

  /**
   * Retrieve worklogs for a user within a date range.
   * Automatically follows pagination (metadata.next) to fetch all results.
   */
  async getWorklogs(
    fromDate: Date,
    toDate: Date,
    accountId?: string,
    limit = 1000
  ): Promise<WorklogResult[]> {
    const params: Record<string, string> = {
      from: formatDate(fromDate),
      to: formatDate(toDate),
      offset: "0",
      limit: String(limit),
    };

    const basePath = accountId ? `worklogs/user/${accountId}` : "worklogs";
    const allResults: WorklogResult[] = [];

    // First page
    let data = await this.request<{
      results: RawWorklog[];
      metadata?: { next?: string; count?: number };
    }>("GET", basePath, undefined, params);

    allResults.push(...(data.results || []).map((item) => this.mapWorklog(item, accountId)));

    // Follow pagination
    while (data.metadata?.next) {
      const resp = await fetch(data.metadata.next, {
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json",
        },
      });
      if (!resp.ok) break;
      data = await resp.json() as typeof data;
      allResults.push(...(data.results || []).map((item) => this.mapWorklog(item, accountId)));
    }

    return allResults;
  }

  private mapWorklog(item: RawWorklog, fallbackAccountId?: string): WorklogResult {
    return {
      tempoWorklogId: item.tempoWorklogId,
      issueKey: item.issue?.key ?? "",
      timeSpentSeconds: item.timeSpentSeconds,
      billableSeconds: item.billableSeconds ?? 0,
      startDate: item.startDate,
      description: item.description ?? "",
      authorAccountId: item.author?.accountId ?? fallbackAccountId,
    };
  }

  // ─── Plans (Resource Allocations) ───────────────────────────────

  private mapPlan(raw: RawPlan): PlanResult {
    return {
      id: raw.id,
      startDate: raw.startDate ?? "",
      endDate: raw.endDate ?? "",
      plannedSecondsPerDay: raw.plannedSecondsPerDay ?? 0,
      totalPlannedSeconds: raw.totalPlannedSeconds ?? 0,
      totalPlannedSecondsInScope: raw.totalPlannedSecondsInScope ?? 0,
      description: raw.description ?? "",
      assignee: {
        id: raw.assignee?.id ?? "",
        type: raw.assignee?.type ?? "USER",
      },
      planItem: {
        id: raw.planItem?.id ?? "",
        type: raw.planItem?.type ?? "ISSUE",
      },
    };
  }

  /** Retrieve plans (resource allocations) for a specific user. */
  async getPlansForUser(
    accountId: string,
    from: string,
    to: string
  ): Promise<PlanResult[]> {
    const data = await this.request<{ results: RawPlan[] }>(
      "GET",
      `plans/user/${accountId}`,
      undefined,
      { from, to, plannedTimeBreakdown: "DAILY" }
    );
    return (data.results || []).map((p) => this.mapPlan(p));
  }

  /**
   * Search worklogs using POST /4/worklogs/search.
   * Supports filtering by multiple worker account IDs, date range, etc.
   */
  async searchWorklogs(
    from: string,
    to: string,
    workerAccountIds: string[],
    limit = 5000
  ): Promise<WorklogResult[]> {
    const body: Record<string, unknown> = {
      from,
      to,
      limit,
    };
    if (workerAccountIds.length > 0) {
      body.authorIds = workerAccountIds;
    }

    const data = await this.request<{
      results: Array<{
        tempoWorklogId: number;
        issue: { key: string };
        timeSpentSeconds: number;
        billableSeconds?: number;
        startDate: string;
        description?: string;
        author: { accountId: string };
      }>;
    }>("POST", "worklogs/search", body);

    return (data.results || []).map((item) => ({
      tempoWorklogId: item.tempoWorklogId,
      issueKey: item.issue?.key ?? "",
      timeSpentSeconds: item.timeSpentSeconds,
      billableSeconds: item.billableSeconds ?? 0,
      startDate: item.startDate,
      description: item.description ?? "",
      authorAccountId: item.author?.accountId,
    }));
  }

  /**
   * Retrieve user schedule (required hours) for a date range.
   * Uses GET /4/user-schedule/{accountId}?from=...&to=...
   */
  async getUserSchedule(
    accountId: string,
    from: string,
    to: string
  ): Promise<UserScheduleDay[]> {
    const data = await this.request<{
      results: Array<{
        date: string;
        requiredSeconds: number;
        type: string;
      }>;
    }>("GET", `user-schedule/${accountId}`, undefined, { from, to });

    return (data.results || []).map((d) => ({
      date: d.date,
      requiredSeconds: d.requiredSeconds,
      type: d.type ?? "WORKING_DAY",
    }));
  }

  /** Search plans with optional filters. */
  async getPlans(
    from: string,
    to: string,
    opts?: {
      accountIds?: string[];
      projectIds?: number[];
      issueIds?: number[];
    }
  ): Promise<PlanResult[]> {
    const params: Record<string, string> = {
      from,
      to,
      limit: "5000",
      plannedTimeBreakdown: "DAILY",
    };
    if (opts?.accountIds?.length) {
      params.accountIds = opts.accountIds.join(",");
    }
    if (opts?.projectIds?.length) {
      params.projectIds = opts.projectIds.join(",");
    }
    if (opts?.issueIds?.length) {
      params.issueIds = opts.issueIds.join(",");
    }

    const data = await this.request<{
      results: RawPlan[];
    }>("GET", "plans", undefined, params);

    return (data.results || []).map((p) => this.mapPlan(p));
  }
}

/** Raw worklog shape from the Tempo API. */
interface RawWorklog {
  tempoWorklogId: number;
  issue?: { key?: string };
  timeSpentSeconds: number;
  billableSeconds?: number;
  startDate: string;
  description?: string;
  author?: { accountId?: string };
}

/** Raw plan shape from the Tempo API. */
interface RawPlan {
  id: number;
  startDate?: string;
  endDate?: string;
  plannedSecondsPerDay?: number;
  totalPlannedSeconds?: number;
  totalPlannedSecondsInScope?: number;
  description?: string;
  assignee?: { id?: string; type?: string };
  planItem?: { id?: string; type?: string; self?: string };
}
