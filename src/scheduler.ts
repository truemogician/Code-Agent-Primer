import { Cron } from "croner";
import { AgentRegistry } from "./agents/registry.js";
import type { CodeAgent, QuotaSnapshot, QuotaWindow } from "./agents/agent.js";
import { sendPrimer } from "./primer/sender.js";
import { loadScheduleConfig, withDefaults } from "./storage/scheduleConfig.js";
import type { ScheduleConfig } from "./storage/scheduleConfig.js";
import { log } from "./utils.js";

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
 *  A controller arms one probe near the end of the current window; if usage was
 *  detected, it then arms a follow-up anchor primer just after the window resets,
 *  feeding a fresh snapshot back into {@link arm} to continue the chain. */
class FollowUpController {
	private readonly timers = new Set<NodeJS.Timeout>();

	constructor(
		private readonly agent: CodeAgent,
		private readonly probeLeadMs: number,
	) { }

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
		log.info(`${this.agent.id} follow-up: probe in ${Math.round(probeDelay / 1000)}s (baseline=${baseline.toFixed(1)}%).`);
		this.schedule(probeDelay, () => this.runProbe(baseline));
	}

	cancel(): void {
		for (const t of this.timers)
			clearTimeout(t);
		this.timers.clear();
	}

	private async runProbe(baseline: number): Promise<void> {
		try {
			const result = await sendPrimer(this.agent.id, { consume: false });
			const id = this.agent.followUpWindowId!;
			const w = result.snapshot.windows[id];
			const used = w?.usedPercent ?? baseline;
			if (used - baseline < NO_USAGE_THRESHOLD_PERCENT) {
				log.info(`${this.agent.id} follow-up: no usage detected (baseline=${baseline.toFixed(1)}%, current=${used.toFixed(1)}%); chain stopped.`);
				return;
			}
			const remaining = w ? getResetMs(w) : 0;
			const delay = Math.max(0, remaining ?? 0) + FOLLOW_UP_BUFFER_MS;
			log.info(`${this.agent.id} follow-up: usage detected (Δ=${(used - baseline).toFixed(1)}%); next anchor in ${Math.round(delay / 1000)}s.`);
			this.schedule(delay, () => this.runAnchor());
		}
		catch (err) {
			log.error(`${this.agent.id} follow-up probe failed: ${err instanceof Error ? err.message : String(err)}`);
		}
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
		log.info(`${new Date().toISOString()} ${agent.id} → ${result.status} (${ms}ms) ${summary}`);
		if (controller) {
			controller.cancel();
			controller.arm(result.snapshot);
		}
	}
	catch (err) {
		const ms = Date.now() - start;
		const message = err instanceof Error ? err.message : String(err);
		log.error(`${new Date().toISOString()} ${agent.id} → ERROR (${ms}ms): ${message}`);
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
		jobs.push(job);
		const next = job.nextRun();
		log.info(`scheduled ${agent.id} cron="${schedule.cron}" follow-up=${!!controller} next=${next ? next.toISOString() : "n/a"}`);
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
