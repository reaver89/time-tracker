/**
 * Jira Cloud REST API v3 client.
 *
 * Handles Basic auth and issue searching.
 */

export interface JiraIssue {
  key: string;
  summary: string;
  status: string;
  project: string;
  issueType: string;
  assignee: string;
}

export interface JiraUser {
  accountId: string;
  displayName: string;
  emailAddress?: string;
}

export class JiraClient {
  private baseUrl: string;
  private authHeader: string;

  constructor(baseUrl: string, email: string, apiToken: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.authHeader =
      "Basic " + Buffer.from(`${email}:${apiToken}`).toString("base64");
  }

  private async request<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(`/rest/api/3/${path.replace(/^\//, "")}`, this.baseUrl);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
      }
    }

    const resp = await fetch(url.toString(), {
      headers: {
        Authorization: this.authHeader,
        Accept: "application/json",
      },
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Jira API error ${resp.status}: ${body}`);
    }

    return resp.json() as Promise<T>;
  }

  /** Get the authenticated user's profile (for obtaining accountId). */
  async getMyself(): Promise<JiraUser> {
    return this.request<JiraUser>("myself");
  }

  /** Execute a JQL query and return a list of issues. */
  async searchIssues(
    jql: string,
    maxResults = 20
  ): Promise<JiraIssue[]> {
    const data = await this.request<{
      issues: Array<{
        key: string;
        fields: {
          summary?: string;
          status?: { name?: string };
          project?: { key?: string };
          issuetype?: { name?: string };
          assignee?: { displayName?: string };
        };
      }>;
    }>("search/jql", {
      jql,
      maxResults: String(maxResults),
      fields: "summary,status,project,issuetype,assignee",
    });

    return (data.issues || []).map((item) => ({
      key: item.key,
      summary: item.fields.summary ?? "",
      status: item.fields.status?.name ?? "",
      project: item.fields.project?.key ?? "",
      issueType: item.fields.issuetype?.name ?? "",
      assignee: item.fields.assignee?.displayName ?? "",
    }));
  }

  /** Open issues assigned to the current user. */
  async myOpenIssues(maxResults = 20): Promise<JiraIssue[]> {
    return this.searchIssues(
      "assignee = currentUser() AND status != Done ORDER BY updated DESC",
      maxResults
    );
  }

  /** Open issues in a specific project. */
  async projectIssues(projectKey: string, maxResults = 20): Promise<JiraIssue[]> {
    return this.searchIssues(
      `project = ${projectKey} AND status != Done ORDER BY updated DESC`,
      maxResults
    );
  }

  /** Retrieve a user's profile by account ID. */
  async getUser(accountId: string): Promise<JiraUser> {
    return this.request<JiraUser>("user", { accountId });
  }

  /** Resolve a Jira issue key (e.g. "PROJ-123") to its numeric issue ID and project ID. */
  async getIssueId(issueKey: string): Promise<{ issueId: number; projectId: number }> {
    const data = await this.request<{
      id: string;
      fields: { project?: { id: string } };
    }>(`issue/${issueKey}`, {
      fields: "project",
    });
    return {
      issueId: Number(data.id),
      projectId: Number(data.fields?.project?.id ?? 0),
    };
  }

  /** Recently updated issues assigned to the current user. */
  async recentIssues(maxResults = 20): Promise<JiraIssue[]> {
    return this.searchIssues(
      "assignee = currentUser() ORDER BY updated DESC",
      maxResults
    );
  }
}
