import { randomUUID } from "node:crypto";
import { CODEX } from "../config.js";
import { saveTokens, getTokens, type CodexTokens } from "../storage/tokens.js";
import { CodeAgent } from "./agent.js";
import { flattenHeaders, num, log } from "../utils.js";
import type { ExchangeArgs, OAuthConfig, QuotaSnapshot, RawPrimerResponse, SendRequestOptions } from "./agent.js";

const RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const PREFIXES = ["x-codex-primary-", "x-codex-secondary-"] as const;

interface CodeExchangeResponse {
	access_token: string;
	refresh_token?: string;
	id_token?: string;
	expires_in?: number;
	token_type?: string;
}

interface TokenExchangeResponse {
	access_token: string;
	expires_in?: number;
	token_type?: string;
}

class CodexAgent extends CodeAgent {
	readonly id = "codex";
	readonly displayName = "Codex (OpenAI)";
	readonly defaultModel = "gpt-5.4-mini";
	readonly defaultPrimer = "ping";

	protected readonly oauth: OAuthConfig = {
		clientId: CODEX.clientId,
		authorizeUrl: CODEX.authorizeUrl,
		tokenUrl: CODEX.tokenUrl,
		redirectUri: CODEX.redirectUri,
		loopbackPort: CODEX.loopbackPort,
		loopbackPath: "/auth/callback",
		scope: CODEX.scope,
		extraAuthorizeParams: {
			id_token_add_organizations: "true",
			codex_cli_simplified_flow: "true",
		},
	};

	protected async exchangeAndPersist({ clientId, code, verifier }: ExchangeArgs): Promise<void> {
		// Step 1: exchange auth code for ChatGPT access/refresh tokens.
		const codeBody = new URLSearchParams({
			grant_type: "authorization_code",
			client_id: clientId,
			code,
			redirect_uri: this.oauth.redirectUri,
			code_verifier: verifier,
		});
		const codeRes = await fetch(this.oauth.tokenUrl, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: codeBody,
		});
		if (!codeRes.ok)
			throw new Error(`Codex code exchange failed (${codeRes.status}): ${await codeRes.text()}`);
		const codeJson = (await codeRes.json()) as CodeExchangeResponse;

		// Step 2: token-exchange the id_token for an `openai-api-key`.
		// Mirrors ChatMock: only attempt when the id_token contains both organization_id and project_id claims.
		const claims = this.decodeIdTokenClaims(codeJson.id_token);
		const orgId = claims?.["https://api.openai.com/auth"]?.organization_id;
		const projectId = claims?.["https://api.openai.com/auth"]?.project_id;
		let apiKey: string | undefined;
		if (codeJson.id_token && orgId && projectId) {
			const today = new Date().toISOString().slice(0, 10);
			const exchangeBody = new URLSearchParams({
				grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
				client_id: clientId,
				requested_token: "openai-api-key",
				subject_token: codeJson.id_token,
				subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
				name: `code-agent-primer [auto-generated] (${today})`,
			});
			const exRes = await fetch(this.oauth.tokenUrl, {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: exchangeBody,
			});
			if (exRes.ok) {
				const exJson = (await exRes.json()) as TokenExchangeResponse;
				apiKey = exJson.access_token;
			}
			else
				console.warn(`Warning: token-exchange to openai-api-key failed (${exRes.status}). Continuing with bearer access_token only.`);
		}

		const obtainedAt = Math.floor(Date.now() / 1000);
		const accountId = this.decodeChatGptAccountId(codeJson.id_token);
		const tokens: CodexTokens = {
			provider: "codex",
			access_token: codeJson.access_token,
			refresh_token: codeJson.refresh_token,
			id_token: codeJson.id_token,
			api_key: apiKey,
			account_id: accountId,
			expires_at: codeJson.expires_in ? obtainedAt + codeJson.expires_in : undefined,
			obtained_at: obtainedAt,
		};
		await saveTokens(tokens);
		console.log("✓ Codex tokens saved." + (apiKey ? " (openai-api-key acquired)" : ""));
	}

	async isAuthenticated(): Promise<boolean> {
		const t = await getTokens("codex");
		return t != undefined;
	}

	async sendRequest({ model = this.defaultModel, primer = this.defaultPrimer, consume = false }: SendRequestOptions): Promise<RawPrimerResponse> {
		const tokens = await getTokens("codex");
		if (!tokens)
			throw new Error("Codex not logged in. Run `code-agent-primer login codex` first.");
		const accountId = tokens.account_id ?? this.decodeChatGptAccountId(tokens.id_token);
		if (!accountId)
			throw new Error("Could not determine ChatGPT account id from stored Codex tokens.");
		const sessionId = randomUUID();
		const res = await fetch(RESPONSES_URL, {
			method: "POST",
			headers: {
				"authorization": `Bearer ${tokens.access_token}`,
				"chatgpt-account-id": accountId,
				"openai-beta": "responses=experimental",
				"session_id": sessionId,
				"originator": "codex_cli_rs",
				"content-type": "application/json",
				"accept": "text/event-stream",
			},
			body: JSON.stringify({
				model,
				instructions: "",
				input: [{ role: "user", content: [{ type: "input_text", text: primer }] }],
				tools: [],
				tool_choice: "auto",
				parallel_tool_calls: false,
				store: false,
				stream: true,
				prompt_cache_key: sessionId,
			}),
		});
		const headers = flattenHeaders(res.headers);
		if (!res.ok) {
			const body = await res.text().catch(() => "(failed to read response body)");
			log.warn(`codex responses ${res.status}: ${body.slice(0, 500)}`);
		}
		else {
			await (consume ? res.text() : res.body?.cancel())
				?.catch(() => { /* ignore */ });
		}
		return { status: res.status, headers };
	}

	/** Decode the chatgpt account id from the JWT id_token, if present. */
	private decodeChatGptAccountId(idToken: string | undefined): string | undefined {
		const claim = this.decodeIdTokenClaims(idToken)?.["https://api.openai.com/auth"];
		const id = claim?.chatgpt_account_id;
		return typeof id === "string" ? id : undefined;
	}

	private decodeIdTokenClaims(idToken: string | undefined): Record<string, any> | undefined {
		if (!idToken) return undefined;
		const parts = idToken.split(".");
		if (parts.length < 2) return undefined;
		try {
			return JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
		}
		catch {
			return undefined;
		}
	}

	selectQuotaHeaders(headers: Record<string, string>): Record<string, string> {
		const out: Record<string, string> = {};
		for (const [k, v] of Object.entries(headers)) {
			if (k.startsWith("x-codex-") || k === "retry-after")
				out[k] = v;
		}
		return out;
	}

	parseQuota(raw: Record<string, string>): QuotaSnapshot {
		const snapshot: QuotaSnapshot = { windows: {}, buckets: {}, raw };
		for (const prefix of PREFIXES) {
			const id = prefix.includes("primary") ? "primary" : "secondary";
			const usedPercent = num(raw[`${prefix}used-percent`]);
			const windowMinutes = num(raw[`${prefix}window-minutes`]);
			const resetAfterSeconds = num(raw[`${prefix}reset-after-seconds`]);
			if (usedPercent !== undefined || windowMinutes !== undefined || resetAfterSeconds !== undefined) {
				snapshot.windows[id] = {
					label: id === "primary" ? "5h window" : "weekly window",
					usedPercent,
					windowMinutes,
					resetAfterSeconds,
				};
			}
		}
		const retry = num(raw["retry-after"]);
		if (retry !== undefined)
			snapshot.retryAfterSeconds = retry;
		return snapshot;
	}

	summarize(snapshot: QuotaSnapshot): string {
		const p = snapshot.windows.primary?.usedPercent;
		const s = snapshot.windows.secondary?.usedPercent;
		const parts: string[] = [];
		if (p !== undefined)
			parts.push(`primary=${p}%`);
		if (s !== undefined)
			parts.push(`secondary=${s}%`);
		return parts.length > 0 ? parts.join(" ") : "(no quota headers)";
	}

	isInterestingHeader(name: string): boolean {
		return name.startsWith("x-codex-") || name.startsWith("x-ratelimit-") || name === "retry-after";
	}
}

export const codexAgent = new CodexAgent();
