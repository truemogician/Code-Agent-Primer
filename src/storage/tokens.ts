import { mkdir } from "node:fs/promises";
import { z } from "zod";
import { PRIMER_HOME, TOKENS_PATH, type ProviderId } from "../config.js";
import { readJsonFile, writeJsonFileAtomic } from "../utils.js";

const CodexTokensSchema = z.object({
	provider: z.literal("codex"),
	access_token: z.string(),
	refresh_token: z.string().optional(),
	id_token: z.string().optional(),
	api_key: z.string().optional(),
	account_id: z.string().optional(),
	expires_at: z.number().optional(),
	obtained_at: z.number(),
});

const ClaudeTokensSchema = z.object({
	provider: z.literal("claude"),
	access_token: z.string(),
	refresh_token: z.string().optional(),
	expires_at: z.number().optional(),
	scopes: z.array(z.string()).optional(),
	obtained_at: z.number(),
});

export type CodexTokens = z.infer<typeof CodexTokensSchema>;
export type ClaudeTokens = z.infer<typeof ClaudeTokensSchema>;
export type ProviderTokens = CodexTokens | ClaudeTokens;

/** On-disk shape: provider id → (account id → tokens). Each provider may host
 *  any number of named accounts. */
const FileSchema = z.object({
	codex: z.record(z.string(), CodexTokensSchema).optional(),
	claude: z.record(z.string(), ClaudeTokensSchema).optional(),
});

export type TokensFile = z.infer<typeof FileSchema>;

export async function loadTokens(): Promise<TokensFile> {
	return readJsonFile(TOKENS_PATH, FileSchema, { missing: {} });
}

/** Persist tokens for `accountId` under their provider. */
export async function saveTokens(accountId: string, tokens: ProviderTokens): Promise<void> {
	const current = await loadTokens();
	const next: TokensFile = { ...current };
	const bucket = { ...(next[tokens.provider] ?? {}) } as Record<string, ProviderTokens>;
	bucket[accountId] = tokens;
	(next as Record<string, unknown>)[tokens.provider] = bucket;
	await writeJsonFileAtomic(TOKENS_PATH, next, { mode: 0o600, chmod: 0o600 });
}

/** Read tokens for the given provider+account, or `undefined` if absent. */
export async function getTokens<P extends ProviderId>(
	provider: P,
	accountId: string,
): Promise<(P extends "codex" ? CodexTokens : ClaudeTokens) | undefined> {
	const file = await loadTokens();
	const bucket = file[provider] as Record<string, ProviderTokens> | undefined;
	return bucket?.[accountId] as never;
}

/** List the account ids that have stored tokens for `provider`, sorted. */
export async function listAccounts(provider: ProviderId): Promise<string[]> {
	const file = await loadTokens();
	const bucket = file[provider];
	return bucket ? Object.keys(bucket).sort() : [];
}

/** Delete tokens for `provider`/`accountId`. Returns true if anything was removed. */
export async function deleteAccount(provider: ProviderId, accountId: string): Promise<boolean> {
	const current = await loadTokens();
	const bucket = current[provider];
	if (!bucket || !(accountId in bucket))
		return false;
	const nextBucket = { ...bucket };
	delete (nextBucket as Record<string, unknown>)[accountId];
	const next: TokensFile = { ...current };
	if (Object.keys(nextBucket).length === 0)
		delete (next as Record<string, unknown>)[provider];
	else
		(next as Record<string, unknown>)[provider] = nextBucket;
	await writeJsonFileAtomic(TOKENS_PATH, next, { mode: 0o600, chmod: 0o600 });
	return true;
}

/** Pick the smallest positive-integer account id not already in use under `provider`. */
export async function nextAutoAccountId(provider: ProviderId): Promise<string> {
	const used = new Set(await listAccounts(provider));
	for (let i = 1; ; i++) {
		const candidate = String(i);
		if (!used.has(candidate))
			return candidate;
	}
}

export async function ensureHomeDir(): Promise<void> {
	await mkdir(PRIMER_HOME, { recursive: true });
}
