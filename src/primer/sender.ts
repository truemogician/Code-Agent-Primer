import { AgentRegistry } from "../agents/registry.js";
import type { CodeAgent, QuotaSnapshot, SendRequestOptions } from "../agents/agent.js";
import { readSnapshot, writeSnapshot } from "../storage/snapshot.js";
import { loadScheduleConfig } from "../storage/scheduleConfig.js";
import { log } from "../utils.js";

export interface PrimerResult {
	agentId: string;
	accountId: string;
	status: number;
	snapshot: QuotaSnapshot;
	headers: Record<string, string>;
	firstRun: boolean;
}

/** Print every quota-related header on the first-ever primer call for an agent+account. */
function logFirstRunHeaders(agent: CodeAgent, accountId: string, headers: Record<string, string>): void {
	const interesting = Object.entries(headers).filter(([k]) => agent.isInterestingHeader(k));
	if (interesting.length === 0) {
		log.info(`first ${agent.id}:${accountId} run — no quota-related headers were returned.`);
		return;
	}
	log.info(`first ${agent.id}:${accountId} run — recording quota-related response headers:`);
	for (const [k, v] of interesting.sort(([a], [b]) => a.localeCompare(b)))
		console.log(`  ${k}: ${v}`);
}

/** Resolve user-configured model/primer overrides for an agent+account, falling
 *  back to the agent's defaults. */
async function resolveOverrides(agentId: string, accountId: string, explicit?: SendRequestOptions): Promise<SendRequestOptions> {
	const config = await loadScheduleConfig();
	const stored = config[agentId]?.[accountId];
	return {
		model: explicit?.model ?? stored?.model,
		primer: explicit?.primer ?? stored?.primer,
	};
}

export async function sendPrimer(agentId: string, accountId: string, opts?: SendRequestOptions): Promise<PrimerResult> {
	const agent = AgentRegistry.get(agentId);
	const previous = await readSnapshot(agent.id, accountId);
	const firstRun = previous === null;
	const overrides = await resolveOverrides(agent.id, accountId, opts);
	const { status, headers } = await agent.sendRequest(accountId, { ...overrides, consume: opts?.consume });
	const selected = agent.selectQuotaHeaders(headers);
	const snapshot = agent.parseQuota(selected);
	await writeSnapshot(agent.id, accountId, { headers: selected, parsed: snapshot as unknown as Record<string, unknown> });
	if (firstRun)
		logFirstRunHeaders(agent, accountId, headers);
	return { agentId: agent.id, accountId, status, snapshot, headers: selected, firstRun };
}
