import { Cron } from "croner";
import { AgentRegistry } from "./agents/registry.js";
import type { CodeAgent } from "./agents/agent.js";
import { sendPrimer } from "./primer/sender.js";
import { loadScheduleConfig, withDefaults } from "./storage/scheduleConfig.js";
import type { ScheduleConfig } from "./storage/scheduleConfig.js";
import { log } from "./utils.js";

export interface SchedulerHandle {
	jobs: Cron[];
	stop(): void;
}

async function runOnce(agent: CodeAgent): Promise<void> {
	const start = Date.now();
	try {
		const result = await sendPrimer(agent.id, { consume: true });
		const ms = Date.now() - start;
		const summary = agent.summarize(result.snapshot);
		log.info(`${new Date().toISOString()} ${agent.id} → ${result.status} (${ms}ms) ${summary}`);
	}
	catch (err) {
		const ms = Date.now() - start;
		const message = err instanceof Error ? err.message : String(err);
		log.error(`${new Date().toISOString()} ${agent.id} → ERROR (${ms}ms): ${message}`);
	}
}

export function startScheduler(config: ScheduleConfig, opts: { fireOnStart?: boolean; } = {}): SchedulerHandle {
	const jobs: Cron[] = [];
	const effective = withDefaults(config, AgentRegistry.list().map(a => a.id));
	for (const [agentId, schedule] of Object.entries(effective)) {
		const agent = AgentRegistry.get(agentId);
		if (!schedule.enabled) {
			log.info(`${agent.id} disabled in config; skipping.`);
			continue;
		}
		const job = new Cron(schedule.cron, { name: `primer-${agent.id}` }, () => { void runOnce(agent); });
		jobs.push(job);
		const next = job.nextRun();
		log.info(`scheduled ${agent.id} cron="${schedule.cron}" next=${next ? next.toISOString() : "n/a"}`);
		if (opts.fireOnStart)
			void runOnce(agent);
	}
	return {
		jobs,
		stop: () => {
			for (const j of jobs)
				j.stop();
		},
	};
}

export async function startSchedulerFromConfig(opts: { fireOnStart?: boolean; } = {}): Promise<SchedulerHandle> {
	const config = await loadScheduleConfig();
	return startScheduler(config, opts);
}
