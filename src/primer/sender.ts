import { AgentRegistry } from "../agents/registry.js";
import type { CodeAgent, QuotaSnapshot, SendRequestOptions } from "../agents/agent.js";
import { readSnapshot, writeSnapshot } from "../storage/snapshot.js";
import { loadScheduleConfig } from "../storage/scheduleConfig.js";
import { log } from "../utils.js";

export interface PrimerResult {
	agentId: string;
	status: number;
	snapshot: QuotaSnapshot;
	headers: Record<string, string>;
	firstRun: boolean;
}

/** Print every quota-related header on the first-ever primer call for an agent.
 *  Phase 3: this is how we discover unknown headers (e.g. an Anthropic 5h
 *  session-window header that surfaces only on real traffic). */
function logFirstRunHeaders(agent: CodeAgent, headers: Record<string, string>): void {
	const interesting = Object.entries(headers).filter(([k]) => agent.isInterestingHeader(k));
	if (interesting.length === 0) {
		log.info(`first ${agent.id} run — no quota-related headers were returned.`);
		return;
	}
	log.info(`first ${agent.id} run — recording quota-related response headers:`);
	for (const [k, v] of interesting.sort(([a], [b]) => a.localeCompare(b)))
		console.log(`  ${k}: ${v}`);
}

/** Resolve user-configured model/primer overrides for an agent, falling back to its defaults. */
async function resolveOverrides(agentId: string, explicit?: SendRequestOptions): Promise<SendRequestOptions> {
	const config = await loadScheduleConfig();
	const stored = config[agentId];
	return {
		model: explicit?.model ?? stored?.model,
		primer: explicit?.primer ?? stored?.primer,
	};
}

export async function sendPrimer(agentId: string, opts?: SendRequestOptions): Promise<PrimerResult> {
	const agent = AgentRegistry.get(agentId);
	const previous = await readSnapshot(agent.id);
	const firstRun = previous === null;
	const overrides = await resolveOverrides(agent.id, opts);
	const { status, headers } = await agent.sendRequest({ ...overrides, consume: opts?.consume });
	const selected = agent.selectQuotaHeaders(headers);
	const snapshot = agent.parseQuota(selected);
	await writeSnapshot(agent.id, { headers: selected, parsed: snapshot as unknown as Record<string, unknown> });
	if (firstRun)
		logFirstRunHeaders(agent, headers);
	return { agentId: agent.id, status, snapshot, headers: selected, firstRun };
}
