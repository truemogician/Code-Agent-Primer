import chalk from "chalk";
import { Cron } from "croner";
import { AgentRegistry } from "./agents/registry.js";
import type { CodeAgent, QuotaSnapshot, QuotaWindow } from "./agents/agent.js";
import { sendPrimer } from "./primer/sender.js";
import { loadConfig, withDefaults, iterSchedules } from "./storage/config.js";
import type { ScheduleConfig } from "./storage/config.js";
import { listAccounts } from "./storage/tokens.js";
import type { ProviderId } from "./config.js";
import { log, formatLocalTime } from "./utils.js";

export interface SchedulerHandle {
	jobs: Cron[];
	stop(): void;
}

const NO_USAGE_THRESHOLD_PERCENT = 0.5;
const FOLLOW_UP_BUFFER_MS = 5_000;

function getResetMs(window: QuotaWindow): number | undefined {
	if (window.resetAfterSeconds !== undefined)
		return window.resetAfterSeconds * 1000;
	if (window.resetAt) {
		const t = new Date(window.resetAt).getTime();
		if (Number.isFinite(t))
			return t - Date.now();
	}
	return undefined;
}

// #region Follow-up chain

/** Drives the optional "chain follow-up primers across window boundaries" feature.
 *  See {@link FollowUpController.runProbe} for the skip rule. */
class FollowUpController {
	private readonly timers = new Set<NodeJS.Timeout>();
	private nextCronAfter: (after: Date) => Date | null = () => null;

	constructor(
		private readonly agent: CodeAgent,
		private readonly accountId: string,
		private readonly probeLeadMs: number,
	) { }

	setNextCronAfter(fn: (after: Date) => Date | null): void {
		this.nextCronAfter = fn;
	}

	private get tag(): string { return `${this.agent.id}:${this.accountId}`; }

	arm(snapshot: QuotaSnapshot): void {
		const id = this.agent.followUpWindowId;
		if (!id)
			return;
		const w = snapshot.windows[id];
		if (!w) {
			log.warn(`${this.tag} follow-up: window "${id}" missing from snapshot; skipping.`);
			return;
		}
		const resetMs = getResetMs(w);
		if (resetMs === undefined || resetMs <= 0) {
			log.warn(`${this.tag} follow-up: cannot determine window reset; skipping.`);
			return;
		}
		const probeDelay = resetMs - this.probeLeadMs;
		if (probeDelay <= 0) {
			log.warn(`${this.tag} follow-up: window resets in <${this.probeLeadMs / 1000}s; skipping probe.`);
			return;
		}
		const baseline = w.usedPercent ?? 0;
		const windowMinutes = w.windowMinutes;
		log.info(`${this.tag} follow-up: probe in ${Math.round(probeDelay / 1000)}s (baseline=${baseline.toFixed(1)}%).`);
		this.schedule(probeDelay, () => this.runProbe(baseline, windowMinutes));
	}

	cancel(): void {
		for (const t of this.timers)
			clearTimeout(t);
		this.timers.clear();
	}

	private async runProbe(baseline: number, windowMinutes: number | undefined): Promise<void> {
		try {
			const result = await sendPrimer(this.agent.id, this.accountId, { consume: false });
			const id = this.agent.followUpWindowId!;
			const w = result.snapshot.windows[id];
			const used = w?.usedPercent ?? baseline;
			const isActive = used - baseline >= NO_USAGE_THRESHOLD_PERCENT;

			const remaining = w ? getResetMs(w) : 0;
			const anchorDelayMs = Math.max(0, remaining ?? 0) + FOLLOW_UP_BUFFER_MS;
			const anchorAt = new Date(Date.now() + anchorDelayMs);
			const effectiveWindowMinutes = w?.windowMinutes ?? windowMinutes;

			if (this.wouldShiftPastNextCron(anchorAt, effectiveWindowMinutes) && !isActive) {
				log.info(`${this.tag} follow-up: idle and would shift next anchor past upcoming cron; chain stopped.`);
				return;
			}
			const reason = isActive
				? `usage detected (Δ=${(used - baseline).toFixed(1)}%)`
				: "idle but no schedule shift";
			log.info(`${this.tag} follow-up: ${reason}; next anchor in ${Math.round(anchorDelayMs / 1000)}s.`);
			this.schedule(anchorDelayMs, () => this.runAnchor());
		}
		catch (err) {
			log.error(`${this.tag} follow-up probe failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private wouldShiftPastNextCron(anchorAt: Date, windowMinutes: number | undefined): boolean {
		if (windowMinutes === undefined)
			return false;
		const nextCron = this.nextCronAfter(anchorAt);
		if (!nextCron)
			return false;
		const anchorWindowEnd = anchorAt.getTime() + windowMinutes * 60_000;
		return anchorWindowEnd > nextCron.getTime();
	}

	private async runAnchor(): Promise<void> {
		await runOnce(this.agent, this.accountId, this);
	}

	private schedule(ms: number, fn: () => void | Promise<void>): void {
		const timer = setTimeout(() => {
			this.timers.delete(timer);
			void fn();
		}, ms);
		this.timers.add(timer);
	}
}

// #endregion

async function runOnce(agent: CodeAgent, accountId: string, controller?: FollowUpController): Promise<void> {
	const start = Date.now();
	const tag = `${agent.id}:${accountId}`;
	try {
		const result = await sendPrimer(agent.id, accountId, { consume: true });
		const ms = Date.now() - start;
		const summary = agent.summarize(result.snapshot);
		const statusColor = result.status >= 400 ? chalk.red : result.status >= 300 ? chalk.yellow : chalk.green;
		log.info(`${formatLocalTime(new Date())} ${chalk.cyan(tag)} → ${statusColor(result.status)} (${ms}ms) ${summary}`);
		if (controller) {
			controller.cancel();
			controller.arm(result.snapshot);
		}
	}
	catch (err) {
		const ms = Date.now() - start;
		const message = err instanceof Error ? err.message : String(err);
		log.error(`${formatLocalTime(new Date())} ${chalk.cyan(tag)} → ${chalk.red("ERROR")} (${ms}ms): ${message}`);
	}
}

/** Enumerate every (agentId, accountId) pair that has stored credentials. */
async function listKnownPairs(): Promise<Array<{ agentId: string; accountId: string; }>> {
	const out: Array<{ agentId: string; accountId: string; }> = [];
	for (const agent of AgentRegistry.list()) {
		const accounts = await listAccounts(agent.id as ProviderId);
		for (const accountId of accounts)
			out.push({ agentId: agent.id, accountId });
	}
	return out;
}

export async function startScheduler(config: ScheduleConfig, opts: { fireOnStart?: boolean; } = {}): Promise<SchedulerHandle> {
	const jobs: Cron[] = [];
	const controllers: FollowUpController[] = [];
	const effective = withDefaults(config, await listKnownPairs());
	for (const { agentId, accountId, schedule } of iterSchedules(effective)) {
		const agent = AgentRegistry.get(agentId);
		const tag = `${agent.id}:${accountId}`;
		if (!schedule.enabled) {
			log.info(`${tag} disabled in config; skipping.`);
			continue;
		}
		let controller: FollowUpController | undefined;
		if (schedule.followUp) {
			if (!agent.followUpWindowId)
				log.warn(`${tag} follow-up requested but agent declares no followUpWindowId; ignoring.`);
			else {
				controller = new FollowUpController(agent, accountId, schedule.followUpProbeLeadMinutes * 60_000);
				controllers.push(controller);
			}
		}
		const job = new Cron(schedule.cron, { name: `primer-${tag}` }, () => { void runOnce(agent, accountId, controller); });
		controller?.setNextCronAfter(after => job.nextRun(after));
		jobs.push(job);
		const next = job.nextRun();
		log.info(`scheduled ${chalk.cyan(tag)} cron="${schedule.cron}" follow-up=${!!controller} next=${next ? formatLocalTime(next) : "n/a"}`);
		if (opts.fireOnStart)
			void runOnce(agent, accountId, controller);
	}
	return {
		jobs,
		stop: () => {
			for (const j of jobs)
				j.stop();
			for (const c of controllers)
				c.cancel();
		},
	};
}

export async function startSchedulerFromConfig(opts: { fireOnStart?: boolean; } = {}): Promise<SchedulerHandle> {
	const config = await loadConfig();
	return startScheduler(config.schedules, opts);
}
