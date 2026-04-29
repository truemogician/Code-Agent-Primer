import { CLAUDE } from "../config.js";
import { saveTokens, getTokens, type ClaudeTokens } from "../storage/tokens.js";
import { CodeAgent } from "./agent.js";
import { flattenHeaders, num } from "../utils.js";
import type { ExchangeArgs, OAuthConfig, QuotaSnapshot, RawPrimerResponse, SendRequestOptions } from "./agent.js";

const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const VERSION = "2023-06-01";
const PREFIX = "anthropic-ratelimit-";

interface ClaudeTokenResponse {
	access_token: string;
	refresh_token?: string;
	expires_in?: number;
	scope?: string;
	token_type?: string;
}

class ClaudeAgent extends CodeAgent {
	readonly id = "claude";
	readonly displayName = "Claude Code (Anthropic)";
	readonly defaultModel = "claude-haiku-4-5";
	readonly defaultPrimer = "ping";

	protected readonly oauth: OAuthConfig = {
		clientId: CLAUDE.clientId,
		authorizeUrl: CLAUDE.authorizeUrl,
		tokenUrl: CLAUDE.tokenUrl,
		redirectUri: CLAUDE.redirectUri,
		loopbackPort: 0,
		loopbackPath: "",
		scope: CLAUDE.scope,
		extraAuthorizeParams: { code: "true" },
		manualPaste: true,
	};

	protected async exchangeAndPersist({ clientId, code, verifier, state }: ExchangeArgs): Promise<void> {
		const tokenRes = await fetch(this.oauth.tokenUrl, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				grant_type: "authorization_code",
				client_id: clientId,
				code,
				redirect_uri: this.oauth.redirectUri,
				code_verifier: verifier,
				state,
			}),
		});
		if (!tokenRes.ok) {
			const body = await tokenRes.text().catch(() => "(failed to read body)");
			const headerDump: Record<string, string> = {};
			tokenRes.headers.forEach((v, k) => { headerDump[k.toLowerCase()] = v; });
			console.error("Claude token exchange failed:");
			console.error(`  status:  ${tokenRes.status}`);
			console.error(`  headers: ${JSON.stringify(headerDump, null, 2)}`);
			console.error(`  body:    ${body}`);
			throw new Error(`Claude token exchange failed (${tokenRes.status})`);
		}
		const tokenJson = (await tokenRes.json()) as ClaudeTokenResponse;

		const obtainedAt = Math.floor(Date.now() / 1000);
		const tokens: ClaudeTokens = {
			provider: "claude",
			access_token: tokenJson.access_token,
			refresh_token: tokenJson.refresh_token,
			expires_at: tokenJson.expires_in ? obtainedAt + tokenJson.expires_in : undefined,
			scopes: tokenJson.scope ? tokenJson.scope.split(/\s+/) : this.oauth.scope.split(/\s+/),
			obtained_at: obtainedAt,
		};
		await saveTokens(tokens);
		console.log("✓ Claude tokens saved.");
	}

	async isAuthenticated(): Promise<boolean> {
		const t = await getTokens("claude");
		return !!t;
	}

	async sendRequest({ model = this.defaultModel, primer = this.defaultPrimer }: SendRequestOptions): Promise<RawPrimerResponse> {
		const tokens = await getTokens("claude");
		if (!tokens)
			throw new Error("Claude not logged in. Run `code-agent-primer login claude` first.");
		const res = await fetch(MESSAGES_URL, {
			method: "POST",
			headers: {
				"authorization": `Bearer ${tokens.access_token}`,
				"anthropic-version": VERSION,
				"anthropic-beta": CLAUDE.betaHeader,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				model,
				max_tokens: 1,
				system: "You are Claude Code, Anthropic's official CLI for Claude.",
				messages: [{ role: "user", content: primer }],
			}),
		});
		const headers = flattenHeaders(res.headers);
		const bodyText = await res.text().catch(() => "");
		if (!res.ok)
			console.error(`[claude] ${res.status} body: ${bodyText.slice(0, 500)}`);
		return { status: res.status, headers };
	}

	selectQuotaHeaders(headers: Record<string, string>): Record<string, string> {
		const out: Record<string, string> = {};
		for (const [k, v] of Object.entries(headers)) {
			if (k.startsWith("anthropic-") || k === "retry-after")
				out[k] = v;
		}
		return out;
	}

	parseQuota(raw: Record<string, string>): QuotaSnapshot {
		const snapshot: QuotaSnapshot = { windows: {}, buckets: {}, raw };
		const unifiedWindows: Array<[string, string]> = [
			["5h", "session-5h"],
			["7d", "session-7d"],
			["overage", "overage"],
		];
		for (const [tag, id] of unifiedWindows) {
			const utilization = num(raw[`${PREFIX}unified-${tag}-utilization`]);
			const reset = raw[`${PREFIX}unified-${tag}-reset`];
			const status = raw[`${PREFIX}unified-${tag}-status`];
			if (utilization === undefined && reset === undefined && status === undefined)
				continue;
			snapshot.windows[id] = {
				label: status ? `${tag} (${status})` : tag,
				usedPercent: utilization !== undefined ? utilization * 100 : undefined,
				resetAt: reset ? new Date(Number(reset) * 1000).toISOString() : undefined,
			};
		}
		const reqLimit = num(raw[`${PREFIX}requests-limit`]);
		const reqRemaining = num(raw[`${PREFIX}requests-remaining`]);
		const reqReset = raw[`${PREFIX}requests-reset`];
		if (reqLimit !== undefined || reqRemaining !== undefined || reqReset !== undefined) {
			snapshot.buckets.requests = {
				label: "requests",
				limit: reqLimit,
				remaining: reqRemaining,
				resetAt: reqReset,
			};
		}
		const tokLimit = num(raw[`${PREFIX}tokens-limit`]);
		const tokRemaining = num(raw[`${PREFIX}tokens-remaining`]);
		const tokReset = raw[`${PREFIX}tokens-reset`];
		if (tokLimit !== undefined || tokRemaining !== undefined || tokReset !== undefined) {
			snapshot.buckets.tokens = {
				label: "tokens",
				limit: tokLimit,
				remaining: tokRemaining,
				resetAt: tokReset,
			};
		}
		const retry = num(raw["retry-after"]);
		if (retry !== undefined)
			snapshot.retryAfterSeconds = retry;
		return snapshot;
	}

	summarize(snapshot: QuotaSnapshot): string {
		const parts: string[] = [];
		const w5h = snapshot.windows["session-5h"];
		const w7d = snapshot.windows["session-7d"];
		if (w5h?.usedPercent !== undefined)
			parts.push(`5h=${w5h.usedPercent.toFixed(1)}%`);
		if (w7d?.usedPercent !== undefined)
			parts.push(`7d=${w7d.usedPercent.toFixed(1)}%`);
		const r = snapshot.buckets.requests;
		const t = snapshot.buckets.tokens;
		if (r?.remaining !== undefined && r.limit !== undefined)
			parts.push(`req=${r.remaining}/${r.limit}`);
		if (t?.remaining !== undefined && t.limit !== undefined)
			parts.push(`tok=${t.remaining}/${t.limit}`);
		return parts.length > 0 ? parts.join(" ") : "(no quota headers)";
	}

	isInterestingHeader(name: string): boolean {
		return name.startsWith("anthropic-") || name === "retry-after";
	}
}

export const claudeAgent = new ClaudeAgent();
