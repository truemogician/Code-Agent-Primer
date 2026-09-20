import { z } from "zod";
import { CONFIG_PATH } from "../config.js";
import { readJsonFile, writeJsonFileAtomic } from "../utils.js";

const DEFAULT_CRON = "0 */1 * * *";
const DEFAULT_PROBE_LEAD_MINUTES = 5;
export const DEFAULT_SCHEDULE = {
	enabled: true,
	cron: DEFAULT_CRON,
	followUp: false,
	followUpProbeLeadMinutes: DEFAULT_PROBE_LEAD_MINUTES,
} as const;

const AgentScheduleSchema = z.object({
	enabled: z.boolean().default(true),
	cron: z.string().default(DEFAULT_CRON),
	model: z.string().optional(),
	primer: z.string().optional(),
	followUp: z.boolean().default(false),
	followUpProbeLeadMinutes: z.number().positive().default(DEFAULT_PROBE_LEAD_MINUTES),
});

const AccountMapSchema = z.record(z.string(), AgentScheduleSchema);
const ScheduleConfigSchema = z.record(z.string(), AccountMapSchema);

export type AgentSchedule = z.infer<typeof AgentScheduleSchema>;
/** Map from agent id → (account id → schedule). */
export type ScheduleConfig = z.infer<typeof ScheduleConfigSchema>;

const ProxyConfigSchema = z.discriminatedUnion("mode", [
	z.object({ mode: z.literal("system") }),
	z.object({ mode: z.literal("direct") }),
	z.object({ mode: z.literal("custom"), url: z.string().refine(value => {
		try {
			const url = new URL(value);
			return ["http:", "https:"].includes(url.protocol) && !!url.hostname
				&& url.pathname === "/" && !url.search && !url.hash;
		}
		catch {
			return false;
		}
	}, "Proxy must be an HTTP(S) URL with no path, query, or fragment") }),
]);

export type ProxyConfig = z.infer<typeof ProxyConfigSchema>;

const ConfigSchema = z.object({
	schedules: ScheduleConfigSchema.default({}),
	proxy: ProxyConfigSchema.default({ mode: "system" }),
}).strict();

export type Config = z.infer<typeof ConfigSchema>;

/** Iterate over every (agentId, accountId, schedule) triple in `config`. */
export function* iterSchedules(config: ScheduleConfig): Iterable<{ agentId: string; accountId: string; schedule: AgentSchedule; }> {
	for (const [agentId, accounts] of Object.entries(config)) {
		for (const [accountId, schedule] of Object.entries(accounts))
			yield { agentId, accountId, schedule };
	}
}

/** Fill in defaults for agent/account pairs missing from the on-disk config.
 *  `pairs` enumerates the known (agent, account) combinations to ensure exist. */
export function withDefaults(
	config: ScheduleConfig,
	pairs: Iterable<{ agentId: string; accountId: string; }>,
): ScheduleConfig {
	const out: ScheduleConfig = {};
	for (const [agentId, accounts] of Object.entries(config))
		out[agentId] = { ...accounts };
	for (const { agentId, accountId } of pairs) {
		const accounts = out[agentId] ?? (out[agentId] = {});
		if (!accounts[accountId])
			accounts[accountId] = { ...DEFAULT_SCHEDULE };
	}
	return out;
}

export async function loadConfig(): Promise<Config> {
	return readJsonFile(CONFIG_PATH, ConfigSchema, { missing: ConfigSchema.parse({}) });
}

export async function saveConfig(config: Config): Promise<void> {
	await writeJsonFileAtomic(CONFIG_PATH, ConfigSchema.parse(config), { mode: 0o600, chmod: 0o600 });
}

/** Merge a partial update into the on-disk schedule for one agent+account. */
export async function updateAgentConfig(
	agentId: string,
	accountId: string,
	patch: Partial<AgentSchedule>,
): Promise<AgentSchedule> {
	const config = await loadConfig();
	const accounts = config.schedules[agentId] ?? (config.schedules[agentId] = {});
	const current = accounts[accountId] ?? { ...DEFAULT_SCHEDULE };
	const merged: AgentSchedule = { ...current, ...patch };
	accounts[accountId] = merged;
	await saveConfig(config);
	return merged;
}
