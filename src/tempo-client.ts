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
}

export interface WorklogResult {
  tempoWorklogId: number;
  issueKey: string;
  timeSpentSeconds: number;
  startDate: string;
  description: string;
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

    const data = await this.request<{
      tempoWorklogId: number;
      issue: { key: string };
      timeSpentSeconds: number;
      startDate: string;
      description?: string;
    }>("POST", "worklogs", body);

    return {
      tempoWorklogId: data.tempoWorklogId,
      issueKey: data.issue?.key ?? payload.issueKey,
      timeSpentSeconds: data.timeSpentSeconds,
      startDate: data.startDate,
      description: data.description ?? "",
    };
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

  /** Retrieve worklogs for a user within a date range. */
  async getWorklogs(
    fromDate: Date,
    toDate: Date,
    accountId?: string,
    limit = 1000
  ): Promise<WorklogResult[]> {
    const params: Record<string, string> = {
      from: formatDate(fromDate),
      to: formatDate(toDate),
      limit: String(limit),
    };

    const path = accountId ? `worklogs/user/${accountId}` : "worklogs";

    const data = await this.request<{
      results: Array<{
        tempoWorklogId: number;
        issue: { key: string };
        timeSpentSeconds: number;
        startDate: string;
        description?: string;
      }>;
    }>("GET", path, undefined, params);

    return (data.results || []).map((item) => ({
      tempoWorklogId: item.tempoWorklogId,
      issueKey: item.issue?.key ?? "",
      timeSpentSeconds: item.timeSpentSeconds,
      startDate: item.startDate,
      description: item.description ?? "",
    }));
  }
}
