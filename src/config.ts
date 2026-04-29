import { homedir } from "node:os";
import { join } from "node:path";

export const PRIMER_HOME = process.env.CODE_AGENT_PRIMER_HOME ?? join(homedir(), ".code-agent-primer");
export const TOKENS_PATH = join(PRIMER_HOME, "tokens.json");
export const SNAPSHOT_PATH = join(PRIMER_HOME, "usage_snapshot.json");
export const CONFIG_PATH = join(PRIMER_HOME, "config.json");

export const PROVIDER_IDS = ["codex", "claude"] as const;
export type ProviderId = typeof PROVIDER_IDS[number];

export const CODEX = {
	clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
	issuer: "https://auth.openai.com",
	authorizeUrl: "https://auth.openai.com/oauth/authorize",
	tokenUrl: "https://auth.openai.com/oauth/token",
	redirectUri: "http://localhost:1455/auth/callback",
	loopbackPort: 1455,
	scope: "openid profile email offline_access",
} as const;

export const CLAUDE = {
	// Public Claude Code client_id (matches the proven-working `claude-code-login`
	// reference and ChatGPT/Anthropic CLI flows).
	clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
	authorizeUrl: "https://claude.ai/oauth/authorize",
	tokenUrl: "https://console.anthropic.com/v1/oauth/token",
	// Anthropic only accepts the hosted callback for this public client; the user
	// pastes the `<code>#<state>` value back into the CLI.
	redirectUri: "https://console.anthropic.com/oauth/code/callback",
	scope: "org:create_api_key user:profile user:inference",
	betaHeader: "oauth-2025-04-20",
} as const;
