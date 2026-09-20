import chalk from "chalk";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { spawn } from "node:child_process";
import packageJson from "../package.json" with { type: "json" };
import type { CodeAgent } from "./agents/agent.js";
import { AgentRegistry } from "./agents/registry.js";
import { PRIMER_HOME, type ProviderId } from "./config.js";
import { sendPrimer } from "./primer/sender.js";
import { startSchedulerFromConfig } from "./scheduler.js";
import { parseAgentRef } from "./storage/account.js";
import type { AgentSchedule } from "./storage/config.js";
import { iterSchedules, loadConfig, saveConfig, updateAgentConfig, withDefaults } from "./storage/config.js";
import { deleteAccount, ensureHomeDir, listAccounts, loadTokens, nextAutoAccountId } from "./storage/tokens.js";
import { formatLocalTime, formatQuotaSnapshot, log } from "./utils.js";

function openInBrowser(url: string): void {
	const platform = process.platform;
	try {
		if (platform === "win32") {
			spawn("cmd", ["/s", "/c", `start "" "${url.replace(/"/g, "")}"`], {
				detached: true,
				stdio: "ignore",
				windowsVerbatimArguments: true,
			}).unref();
		}
		else if (platform === "darwin")
			spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
		else
			spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
	}
	catch {
		/* user can copy/paste */
	}
}

/** Resolve a CLI `<agent>` arg into a validated agent + optional account. */
function resolveAgentRef(ref: string): { agent: CodeAgent; accountId?: string; } {
	const { agentId, accountId } = parseAgentRef(ref);
	if (!AgentRegistry.listIds().includes(agentId))
		throw new Error(`Unknown agent "${agentId}". Known: ${AgentRegistry.listIds().join(", ")}`);
	return { agent: AgentRegistry.get(agentId), accountId };
}

function formatAgentConfig(agent: CodeAgent, accountId: string, stored: AgentSchedule | undefined): string {
	const followUpDetail = agent.followUpWindowId
		? `${stored?.followUp ? "on" : "off"} (probe ${stored?.followUpProbeLeadMinutes}min before window "${agent.followUpWindowId}" resets)`
		: "(unsupported by agent)";
	return [
		`[${agent.id}:${accountId}] ${agent.displayName}`,
		`  enabled:   ${stored?.enabled}`,
		`  cron:      ${stored?.cron}`,
		`  model:     ${stored?.model ?? `(default: ${agent.defaultModel})`}`,
		`  primer:    ${stored?.primer ?? `(default: ${JSON.stringify(agent.defaultPrimer)})`}`,
		`  follow-up: ${followUpDetail}`,
	].join("\n");
}

async function showStatus(): Promise<void> {
	const tokens = await loadTokens();
	const now = Math.floor(Date.now() / 1000);
	console.log(`Primer home: ${chalk.gray(PRIMER_HOME)}`);
	for (const agent of AgentRegistry.list()) {
		const bucket = (tokens as Record<string, Record<string, { obtained_at: number; expires_at?: number; }> | undefined>)[agent.id];
		if (!bucket || Object.keys(bucket).length === 0) {
			console.log(`${chalk.cyan(agent.id)}: ${chalk.gray("(no accounts)")}`);
			continue;
		}
		console.log(`${chalk.cyan(agent.id)}:`);
		for (const accountId of Object.keys(bucket).sort()) {
			const t = bucket[accountId];
			const exp = t.expires_at
				? (t.expires_at - now > 0 ? chalk.green(`expires in ${t.expires_at - now}s`) : chalk.red(`expired ${now - t.expires_at}s ago`))
				: chalk.gray("no expiry recorded");
			console.log(`  ${accountId}: obtained ${formatLocalTime(new Date(t.obtained_at * 1000))} (${exp})`);
		}
	}
}

/** Print the friendly send-result block for one (agent, account, result). */
function printSendResult(agent: CodeAgent, accountId: string, status: number, snapshotRaw: Record<string, string>, snapshot: Parameters<typeof formatQuotaSnapshot>[0], firstRun: boolean, consumed: boolean, raw: boolean): void {
	const statusColor = status >= 400 ? chalk.red : status >= 300 ? chalk.yellow : chalk.green;
	log.info(`${chalk.cyan(`${agent.id}:${accountId}`)} → ${statusColor(status)} (firstRun=${firstRun}, consumed=${consumed})`);
	if (raw)
		console.log(JSON.stringify(snapshotRaw, null, 2));
	else
		console.log(formatQuotaSnapshot(snapshot));
}

await yargs(hideBin(process.argv))
	.scriptName("code-agent-primer")
	.usage("$0 <command> [options]")
	.version(packageJson.version)
	.command(
		"login <agent>",
		"Authorize a code agent and store tokens locally. <agent> is `<id>` or `<id>:<accountId>`.",
		y => y
			.positional("agent", {
				describe: "Code agent ref, e.g. `codex` or `codex:work`",
				type: "string",
				demandOption: true,
			})
			.option("open", {
				type: "boolean",
				default: true,
				describe: "Auto-open the browser (use --no-open to disable)",
			}),
		async argv => {
			await ensureHomeDir();
			const { agent, accountId: explicit } = resolveAgentRef(argv.agent as string);
			const accountId = explicit ?? await nextAutoAccountId(agent.id as ProviderId);
			if (!explicit)
				log.info(`No account id provided; assigning auto-generated id "${accountId}".`);
			await agent.login(accountId, { open: argv.open ? openInBrowser : undefined });
		}
	)
	.command(
		"remove <agent>",
		"Remove stored auth tokens and schedule config for an agent/account. Omit the account half (`<id>`) to remove all accounts of that agent.",
		y => y
			.positional("agent", {
				describe: "Code agent ref, e.g. `codex` or `codex:work`",
				type: "string",
				demandOption: true,
			}),
		async argv => {
			await ensureHomeDir();
			const { agent, accountId } = resolveAgentRef(argv.agent as string);
			const config = await loadConfig();
			const accounts = config.schedules[agent.id];
			const targets = accountId ? [accountId] : await listAccounts(agent.id as ProviderId);
			if (targets.length === 0)
				throw new Error(`No accounts logged in for ${agent.id}.`);
			for (const id of targets) {
				const removed = await deleteAccount(agent.id as ProviderId, id);
				if (!removed)
					throw new Error(`No auth entry found for ${agent.id}:${id}.`);
				if (accounts !== undefined && Object.hasOwn(accounts, id)) {
					delete accounts[id];
					if (Object.keys(accounts).length === 0)
						delete config.schedules[agent.id];
					await saveConfig(config);
				}
				console.log(`[${agent.id}:${id}] removed account.`);
			}
		}
	)
	.command(
		"clean",
		"Remove orphaned schedule entries that have no stored auth tokens across all agents.",
		() => { },
		async () => {
			const config = await loadConfig();
			const auth = new Map(Object.entries(await loadTokens()));
			const removed: string[] = [];
			for (const [agentId, accounts] of Object.entries(config.schedules)) {
				const tokens = auth.get(agentId);
				for (const accountId of Object.keys(accounts)) {
					if (tokens && Object.hasOwn(tokens, accountId))
						continue;
					delete accounts[accountId];
					removed.push(`${agentId}:${accountId}`);
				}
				if (Object.keys(accounts).length === 0)
					delete config.schedules[agentId];
			}
			if (removed.length === 0) {
				console.log("No orphaned schedules found.");
				return;
			}
			await saveConfig(config);
			for (const ref of removed)
				console.log(`[${ref}] removed orphaned schedule.`);
		}
	)
	.command("status", "Show stored token status across all agents and accounts", () => { }, showStatus)
	.command(
		"send <agent>",
		"Send a primer request and write a snapshot. Omit the account half (`<id>`) to fan out across every logged-in account for that agent.",
		y => y
			.positional("agent", {
				describe: "Agent ref `<id>[:<accountId>]`",
				type: "string",
				demandOption: true,
			})
			.option("consume", {
				type: "boolean",
				default: true,
				describe: "Consume a token to anchor rolling rate-limit windows (use --no-consume for a cheap quota probe)",
			})
			.option("raw", {
				type: "boolean",
				default: false,
				describe: "Print the raw QuotaSnapshot JSON instead of the friendly summary",
			}),
		async argv => {
			await ensureHomeDir();
			const { agent, accountId } = resolveAgentRef(argv.agent as string);
			const targets = accountId ? [accountId] : await listAccounts(agent.id as ProviderId);
			if (targets.length === 0)
				throw new Error(`No accounts logged in for ${agent.id}. Run \`code-agent-primer login ${agent.id}\` first.`);
			for (const id of targets) {
				const result = await sendPrimer(agent.id, id, { consume: argv.consume });
				printSendResult(agent, id, result.status, result.snapshot.raw, result.snapshot, result.firstRun, argv.consume, argv.raw);
			}
		}
	)
	.command(
		"run",
		"Start the primer scheduler (long-running)",
		y => y.option("now", {
			type: "boolean",
			default: false,
			describe: "Fire one primer per (agent, account) immediately on startup",
		}),
		async argv => {
			await ensureHomeDir();
			const handle = await startSchedulerFromConfig({ fireOnStart: argv.now });
			log.info("scheduler running. Press Ctrl+C to stop.");
			const shutdown = () => {
				log.info("stopping scheduler…");
				handle.stop();
				process.exit(0);
			};
			process.on("SIGINT", shutdown);
			process.on("SIGTERM", shutdown);
			await new Promise<void>(() => { });
		}
	)
	.command(
		"config",
		"Show or update settings.",
		y => y
			.command(
				"proxy [value]",
				"Show or configure the proxy for all provider requests. Defaults to system settings.",
				y => y
					.positional("value", { type: "string", describe: "false for direct connections, system for OS/environment settings, or an HTTP(S) proxy URL" }),
				async argv => {
					const config = await loadConfig();
					if (argv.value !== undefined) {
						config.proxy = argv.value === "false"
							? { mode: "direct" }
							: argv.value === "system"
								? { mode: "system" }
								: { mode: "custom", url: argv.value };
						await saveConfig(config);
					}
					if (config.proxy.mode === "custom") {
						const url = new URL(config.proxy.url);
						if (url.username)
							url.username = "***";
						if (url.password)
							url.password = "***";
						console.log(`Proxy: ${url.href}`);
					}
					else
						console.log(config.proxy.mode === "direct" ? "Proxy: disabled (direct connections)." : "Proxy: system settings.");
				}
			)
			.command(
				"schedule [agent]",
				"Show or update the primer schedule. With no agent: print every (agent, account). With `<id>`: every account under that agent. With `<id>:<accountId>`: that single one. Flags update the matching scope.",
				y => y
					.positional("agent", {
						describe: "Agent ref `<id>[:<accountId>]` to inspect or update",
						type: "string",
					})
					.option("cron", { type: "string", describe: "Cron expression" })
					.option("model", { type: "string", describe: "Override model name (use \"\" to clear)" })
					.option("primer", { type: "string", describe: "Override primer message (use \"\" to clear)" })
					.option("enable", { type: "boolean", describe: "Enable scheduled primers" })
					.option("disable", { type: "boolean", describe: "Disable scheduled primers" })
					.option("follow-up", { type: "boolean", describe: "Chain extra primers across window boundaries" })
					.option("follow-up-probe-lead", { type: "number", describe: "Minutes before window reset to probe for usage (default 5)" })
					.conflicts("enable", "disable"),
				async argv => {
					const config = await loadConfig();
					const patch: Record<string, unknown> = {};
					if (argv.cron !== undefined)
						patch.cron = argv.cron;
					if (argv.model !== undefined)
						patch.model = argv.model === "" ? undefined : argv.model;
					if (argv.primer !== undefined)
						patch.primer = argv.primer === "" ? undefined : argv.primer;
					if (argv.enable)
						patch.enabled = true;
					if (argv.disable)
						patch.enabled = false;
					if (argv["follow-up"] !== undefined)
						patch.followUp = argv["follow-up"];
					if (argv["follow-up-probe-lead"] !== undefined)
						patch.followUpProbeLeadMinutes = argv["follow-up-probe-lead"];

					// Resolve the (agent, account) target list
					let targets: Array<{ agentId: string; accountId: string; }>;
					if (!argv.agent) {
						targets = [];
						for (const agent of AgentRegistry.list()) {
							for (const accountId of await listAccounts(agent.id as ProviderId))
								targets.push({ agentId: agent.id, accountId });
						}
					}
					else {
						const { agent, accountId } = resolveAgentRef(argv.agent);
						if (accountId)
							targets = [{ agentId: agent.id, accountId }];
						else {
							const accounts = await listAccounts(agent.id as ProviderId);
							if (accounts.length === 0)
								throw new Error(`No accounts logged in for ${agent.id}.`);
							targets = accounts.map(a => ({ agentId: agent.id, accountId: a }));
						}
					}

					if (Object.keys(patch).length === 0) {
						const effective = withDefaults(config.schedules, targets);
						console.log(`Primer home: ${PRIMER_HOME}`);
						if (targets.length === 0) {
							console.log(chalk.gray("(no accounts logged in)"));
							return;
						}
						const seen = new Set(targets.map(t => `${t.agentId}:${t.accountId}`));
						for (const { agentId, accountId, schedule } of iterSchedules(effective)) {
							if (!seen.has(`${agentId}:${accountId}`))
								continue;
							const agent = AgentRegistry.get(agentId);
							console.log(`\n${formatAgentConfig(agent, accountId, schedule)}`);
						}
						return;
					}

					for (const { agentId, accountId } of targets) {
						const updated = await updateAgentConfig(agentId, accountId, patch);
						console.log(`[${agentId}:${accountId}] updated:`);
						console.log(JSON.stringify(updated, null, 2));
					}
				}
			)
			.demandCommand(1, "Choose config proxy or config schedule.")
	)
	.command(
		"agents",
		"List registered code agents and their connected accounts",
		() => { },
		async () => {
			for (const agent of AgentRegistry.list()) {
				console.log(`${chalk.cyan(agent.id)}\t${agent.displayName}`);
				const accounts = await listAccounts(agent.id as ProviderId);
				if (accounts.length === 0) {
					console.log(`  ${chalk.gray("(no accounts logged in)")}`);
					continue;
				}
				for (const accountId of accounts)
					console.log(`  - ${accountId}`);
			}
		}
	)
	.demandCommand(1, "A command is required")
	.strict()
	.help()
	.alias("h", "help")
	.alias("v", "version")
	.fail((msg, err) => {
		if (err)
			console.error("Error:", err.message);
		else
			console.error(msg);
		process.exit(1);
	})
	.parseAsync();
