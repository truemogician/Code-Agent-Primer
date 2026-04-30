import chalk from "chalk";
import { Cron } from "croner";
import { AgentRegistry } from "./agents/registry.js";
import type { CodeAgent, QuotaSnapshot, QuotaWindow } from "./agents/agent.js";
import { sendPrimer } from "./primer/sender.js";
import { loadScheduleConfig, withDefaults } from "./storage/scheduleConfig.js";
import type { ScheduleConfig } from "./storage/scheduleConfig.js";
import { log, formatLocalTime } from "./utils.js";

export interface SchedulerHandle {
	jobs: Cron[];
	stop(): void;
}

/** Below this delta the scheduler treats the user as inactive. The probe primer
 *  itself adds a tiny amount of usage; this margin prevents that from re-arming the chain. */
const NO_USAGE_THRESHOLD_PERCENT = 0.5;
/** Buffer past the window's nominal reset before firing the next anchor primer. */
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
 *
 *  Near the end of each window the controller fires a `--no-consume` probe to
 *  detect whether the user has been active. The follow-up anchor is skipped only
 *  when both:
 *  1. **Idle** — `usedPercent` did not change beyond the noise threshold since
 *     the last anchor.
 *  2. **Shift risk** — firing the next anchor would push the resulting window's
 *     reset past the upcoming cron tick, so the cron tick would land inside our
 *     anchored window and fail to anchor a fresh one (drifting the schedule).
 *
 *  In every other case the chain continues, so a returning user gets coverage
 *  again the moment they resume activity. */
class FollowUpController {
	private readonly timers = new Set<NodeJS.Timeout>();
	private nextCronAfter: (after: Date) => Date | null = () => null;

	constructor(
		private readonly agent: CodeAgent,
		private readonly probeLeadMs: number,
	) { }

	setNextCronAfter(fn: (after: Date) => Date | null): void {
		this.nextCronAfter = fn;
	}

	arm(snapshot: QuotaSnapshot): void {
		const id = this.agent.followUpWindowId;
		if (!id)
			return;
		const w = snapshot.windows[id];
		if (!w) {
			log.warn(`${this.agent.id} follow-up: window "${id}" missing from snapshot; skipping.`);
			return;
		}
		const resetMs = getResetMs(w);
		if (resetMs === undefined || resetMs <= 0) {
			log.warn(`${this.agent.id} follow-up: cannot determine window reset; skipping.`);
			return;
		}
		const probeDelay = resetMs - this.probeLeadMs;
		if (probeDelay <= 0) {
			log.warn(`${this.agent.id} follow-up: window resets in <${this.probeLeadMs / 1000}s; skipping probe.`);
			return;
		}
		const baseline = w.usedPercent ?? 0;
		const windowMinutes = w.windowMinutes;
		log.info(`${this.agent.id} follow-up: probe in ${Math.round(probeDelay / 1000)}s (baseline=${baseline.toFixed(1)}%).`);
		this.schedule(probeDelay, () => this.runProbe(baseline, windowMinutes));
	}

	cancel(): void {
		for (const t of this.timers)
			clearTimeout(t);
		this.timers.clear();
	}

	private async runProbe(baseline: number, windowMinutes: number | undefined): Promise<void> {
		try {
			const result = await sendPrimer(this.agent.id, { consume: false });
			const id = this.agent.followUpWindowId!;
			const w = result.snapshot.windows[id];
			const used = w?.usedPercent ?? baseline;
			const isActive = used - baseline >= NO_USAGE_THRESHOLD_PERCENT;

			const remaining = w ? getResetMs(w) : 0;
			const anchorDelayMs = Math.max(0, remaining ?? 0) + FOLLOW_UP_BUFFER_MS;
			const anchorAt = new Date(Date.now() + anchorDelayMs);
			const effectiveWindowMinutes = w?.windowMinutes ?? windowMinutes;

			if (this.wouldShiftPastNextCron(anchorAt, effectiveWindowMinutes) && !isActive) {
				log.info(`${this.agent.id} follow-up: idle and would shift next anchor past upcoming cron; chain stopped.`);
				return;
			}
			const reason = isActive
				? `usage detected (Δ=${(used - baseline).toFixed(1)}%)`
				: "idle but no schedule shift";
			log.info(`${this.agent.id} follow-up: ${reason}; next anchor in ${Math.round(anchorDelayMs / 1000)}s.`);
			this.schedule(anchorDelayMs, () => this.runAnchor());
		}
		catch (err) {
			log.error(`${this.agent.id} follow-up probe failed: ${err instanceof Error ? err.message : String(err)}`);
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
		await runOnce(this.agent, this);
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

async function runOnce(agent: CodeAgent, controller?: FollowUpController): Promise<void> {
	const start = Date.now();
	try {
		const result = await sendPrimer(agent.id, { consume: true });
		const ms = Date.now() - start;
		const summary = agent.summarize(result.snapshot);
		const statusColor = result.status >= 400 ? chalk.red : result.status >= 300 ? chalk.yellow : chalk.green;
		log.info(`${formatLocalTime(new Date())} ${chalk.cyan(agent.id)} → ${statusColor(result.status)} (${ms}ms) ${summary}`);
		if (controller) {
			controller.cancel();
			controller.arm(result.snapshot);
		}
	}
	catch (err) {
		const ms = Date.now() - start;
		const message = err instanceof Error ? err.message : String(err);
		log.error(`${formatLocalTime(new Date())} ${chalk.cyan(agent.id)} → ${chalk.red("ERROR")} (${ms}ms): ${message}`);
	}
}

export function startScheduler(config: ScheduleConfig, opts: { fireOnStart?: boolean; } = {}): SchedulerHandle {
	const jobs: Cron[] = [];
	const controllers: FollowUpController[] = [];
	const effective = withDefaults(config, AgentRegistry.list().map(a => a.id));
	for (const [agentId, schedule] of Object.entries(effective)) {
		const agent = AgentRegistry.get(agentId);
		if (!schedule.enabled) {
			log.info(`${agent.id} disabled in config; skipping.`);
			continue;
		}
		let controller: FollowUpController | undefined;
		if (schedule.followUp) {
			if (!agent.followUpWindowId)
				log.warn(`${agent.id} follow-up requested but agent declares no followUpWindowId; ignoring.`);
			else {
				controller = new FollowUpController(agent, schedule.followUpProbeLeadMinutes * 60_000);
				controllers.push(controller);
			}
		}
		const job = new Cron(schedule.cron, { name: `primer-${agent.id}` }, () => { void runOnce(agent, controller); });
		controller?.setNextCronAfter(after => job.nextRun(after));
		jobs.push(job);
		const next = job.nextRun();
		log.info(`scheduled ${chalk.cyan(agent.id)} cron="${schedule.cron}" follow-up=${!!controller} next=${next ? formatLocalTime(next) : "n/a"}`);
		if (opts.fireOnStart)
			void runOnce(agent, controller);
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
	const config = await loadScheduleConfig();
	return startScheduler(config, opts);
}
