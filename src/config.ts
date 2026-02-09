/**
 * Configuration management for the Jira Tempo MCP server.
 *
 * Reads credentials from environment variables passed via the MCP client
 * config (e.g. .cursor/mcp.json or Claude Desktop config).
 */

export interface Config {
  jira_base_url: string;
  jira_email: string;
  jira_api_token: string;
  tempo_api_token: string;
  jira_account_id: string;
}

const ENV_MAP: Record<keyof Config, string> = {
  jira_base_url: "JIRA_BASE_URL",
  jira_email: "JIRA_EMAIL",
  jira_api_token: "JIRA_API_TOKEN",
  tempo_api_token: "TEMPO_API_TOKEN",
  jira_account_id: "JIRA_ACCOUNT_ID",
};

/**
 * Load config from environment variables and validate that all required
 * keys are present. JIRA_ACCOUNT_ID is optional (auto-fetched at startup).
 *
 * Throws an Error if required env vars are missing.
 */
export function getConfig(): Config {
  const config: Record<string, string> = {};
  const missing: string[] = [];

  for (const [key, envVar] of Object.entries(ENV_MAP)) {
    const value = process.env[envVar] ?? "";
    if (!value && key !== "jira_account_id") {
      missing.push(envVar);
    }
    config[key] = value;
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing environment variables: ${missing.join(", ")}. ` +
        `Set them in your MCP client config (.cursor/mcp.json or Claude Desktop config).`
    );
  }

  return config as unknown as Config;
}
