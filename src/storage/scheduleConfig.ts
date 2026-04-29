import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { CONFIG_PATH } from "../config.js";

const AgentScheduleSchema = z.object({
	enabled: z.boolean().default(true),
	cron: z.string().default("0 */1 * * *"),
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
			out[id] = { enabled: true, cron: "0 */1 * * *" };
	}
	return out;
}

export async function loadScheduleConfig(): Promise<ScheduleConfig> {
	try {
		const raw = await readFile(CONFIG_PATH, "utf8");
		return ScheduleConfigSchema.parse(JSON.parse(raw));
	}
	catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT")
			return {};
		throw err;
	}
}

export async function saveScheduleConfig(config: ScheduleConfig): Promise<void> {
	await mkdir(dirname(CONFIG_PATH), { recursive: true });
	const tmp = `${CONFIG_PATH}.tmp`;
	await writeFile(tmp, JSON.stringify(config, null, 2), "utf8");
	await rename(tmp, CONFIG_PATH);
}

/** Merge a partial update into the on-disk schedule for one agent. Persists the result. */
export async function updateAgentConfig(agentId: string, patch: Partial<AgentSchedule>): Promise<AgentSchedule> {
	const config = await loadScheduleConfig();
	const current = config[agentId] ?? { enabled: true, cron: "0 */1 * * *" };
	const merged: AgentSchedule = { ...current, ...patch };
	config[agentId] = merged;
	await saveScheduleConfig(config);
	return merged;
}
