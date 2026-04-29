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

const FileSchema = z.object({
	codex: CodexTokensSchema.optional(),
	claude: ClaudeTokensSchema.optional(),
});

export type TokensFile = z.infer<typeof FileSchema>;

export async function loadTokens(): Promise<TokensFile> {
	return readJsonFile(TOKENS_PATH, FileSchema, { missing: {} });
}

export async function saveTokens(tokens: ProviderTokens): Promise<void> {
	const current = await loadTokens();
	const next: TokensFile = { ...current, [tokens.provider]: tokens } as TokensFile;
	await writeJsonFileAtomic(TOKENS_PATH, next, { mode: 0o600, chmod: 0o600 });
}

export async function getTokens<P extends ProviderId>(
	provider: P,
): Promise<(P extends "codex" ? CodexTokens : ClaudeTokens) | undefined> {
	const file = await loadTokens();
	return file[provider] as never;
}

export async function ensureHomeDir(): Promise<void> {
	await mkdir(PRIMER_HOME, { recursive: true });
}
