/** Validate an account id. Account ids cannot contain `:` (the separator),
 *  whitespace, or path separators, and cannot be empty. */
export function assertValidAccountId(accountId: string): void {
	if (!accountId)
		throw new Error("Account id cannot be empty");
	if (/[:\s/\\]/.test(accountId))
		throw new Error(`Account id "${accountId}" contains invalid characters (no \`:\`, whitespace, or path separators)`);
}

/** Parse a CLI agent ref of the form `<agentId>[:<accountId>]`. The `accountId`
 *  half is undefined when the colon is absent. */
export function parseAgentRef(ref: string): { agentId: string; accountId?: string; } {
	const idx = ref.indexOf(":");
	if (idx < 0)
		return { agentId: ref };
	const agentId = ref.slice(0, idx);
	const accountId = ref.slice(idx + 1);
	if (!agentId)
		throw new Error(`Invalid agent ref "${ref}" (missing agent id)`);
	if (accountId)
		assertValidAccountId(accountId);
	return { agentId, accountId: accountId || undefined };
}
