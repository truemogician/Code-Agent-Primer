import { z } from "zod";
import { CONFIG_PATH } from "../config.js";
import { readJsonFile, writeJsonFileAtomic } from "../utils.js";

const DEFAULT_CRON = "0 */1 * * *";
export const DEFAULT_SCHEDULE = { enabled: true, cron: DEFAULT_CRON } as const;

const AgentScheduleSchema = z.object({
	enabled: z.boolean().default(true),
	cron: z.string().default(DEFAULT_CRON),
	model: z.string().optional(),
	primer: z.string().optional(),
});

const ScheduleConfigSchema = z.record(z.string(), AgentScheduleSchema);

export type AgentSchedule = z.infer<typeof AgentScheduleSchema>;
/** Map from agent id (e.g. `"codex"`, `"claude"`) to its schedule. */
export type ScheduleConfig = z.infer<typeof ScheduleConfigSchema>;

/** Fill in defaults for any agent ids missing from the on-disk config. */
export function withDefaults(config: ScheduleConfig, agentIds: string[]): ScheduleConfig {
	const out: ScheduleConfig = { ...config };
	for (const id of agentIds) {
		if (!out[id])
			out[id] = { ...DEFAULT_SCHEDULE };
	}
	return out;
}

export async function loadScheduleConfig(): Promise<ScheduleConfig> {
	return readJsonFile(CONFIG_PATH, ScheduleConfigSchema, { missing: {} });
}

export async function saveScheduleConfig(config: ScheduleConfig): Promise<void> {
	await writeJsonFileAtomic(CONFIG_PATH, config);
}

/** Merge a partial update into the on-disk schedule for one agent. Persists the result. */
export async function updateAgentConfig(agentId: string, patch: Partial<AgentSchedule>): Promise<AgentSchedule> {
	const config = await loadScheduleConfig();
	const current = config[agentId] ?? { ...DEFAULT_SCHEDULE };
	const merged: AgentSchedule = { ...current, ...patch };
	config[agentId] = merged;
	await saveScheduleConfig(config);
	return merged;
}
