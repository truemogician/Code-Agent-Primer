import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { spawn } from "node:child_process";
import { ensureHomeDir, loadTokens } from "./storage/tokens.js";
import { PRIMER_HOME } from "./config.js";
import { sendPrimer } from "./primer/sender.js";
import { startSchedulerFromConfig } from "./scheduler.js";
import { loadScheduleConfig, updateAgentConfig, withDefaults } from "./storage/scheduleConfig.js";
import { AgentRegistry } from "./agents/registry.js";
import { log, formatQuotaSnapshot } from "./utils.js";
import packageJson from "../package.json" with { type: "json" };

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

async function showStatus(): Promise<void> {
	const tokens = await loadTokens();
	const now = Math.floor(Date.now() / 1000);
	const fmt = (label: string, t?: { obtained_at: number; expires_at?: number; }) => {
		if (!t)
			return `${label}: (not logged in)`;
		const exp = t.expires_at ? `expires in ${t.expires_at - now}s` : "no expiry recorded";
		return `${label}: obtained ${new Date(t.obtained_at * 1000).toISOString()} (${exp})`;
	};
	console.log(`Primer home: ${PRIMER_HOME}`);
	for (const agent of AgentRegistry.list()) {
		const t = (tokens as Record<string, { obtained_at: number; expires_at?: number; } | undefined>)[agent.id];
		console.log(fmt(agent.id, t));
	}
}

const agentChoices = AgentRegistry.listIds();

await yargs(hideBin(process.argv))
	.scriptName("code-agent-primer")
	.usage("$0 <command> [options]")
	.version(packageJson.version)
	.command(
		"login <agent>",
		"Authorize a code agent and store tokens locally",
		y => y
			.positional("agent", {
				describe: "Code agent to authorize",
				type: "string",
				choices: agentChoices,
				demandOption: true,
			})
			.option("open", {
				type: "boolean",
				default: true,
				describe: "Auto-open the browser (use --no-open to disable)",
			}),
		async argv => {
			await ensureHomeDir();
			const agent = AgentRegistry.get(argv.agent as string);
			await agent.login({ open: argv.open ? openInBrowser : undefined });
		}
	)
	.command("status", "Show stored token status", () => { }, showStatus)
	.command(
		"send <agent>",
		"Send a single primer request and write a snapshot",
		y => y
			.positional("agent", {
				describe: "Code agent to send a primer to",
				type: "string",
				choices: agentChoices,
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
			const result = await sendPrimer(argv.agent as string, { consume: argv.consume });
			log.info(`${result.agentId} → ${result.status} (firstRun=${result.firstRun}, consumed=${argv.consume})`);
			if (argv.raw)
				console.log(JSON.stringify(result.snapshot.raw, null, 2));
			else
				console.log(formatQuotaSnapshot(result.snapshot));
		}
	)
	.command(
		"run",
		"Start the primer scheduler (long-running)",
		y => y.option("now", {
			type: "boolean",
			default: false,
			describe: "Fire one primer per agent immediately on startup",
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
		"config [agent]",
		"Show or update the primer schedule. With no agent: print everything. With an agent and flags: update.",
		y => y
			.positional("agent", {
				describe: "Agent to inspect or update",
				type: "string",
				choices: agentChoices,
			})
			.option("cron", { type: "string", describe: "Cron expression for this agent" })
			.option("model", { type: "string", describe: "Override model name (use \"\" to clear)" })
			.option("primer", { type: "string", describe: "Override primer message (use \"\" to clear)" })
			.option("enable", { type: "boolean", describe: "Enable scheduled primers" })
			.option("disable", { type: "boolean", describe: "Disable scheduled primers" })
			.conflicts("enable", "disable"),
		async argv => {
			const config = await loadScheduleConfig();
			if (!argv.agent) {
				const effective = withDefaults(config, AgentRegistry.listIds());
				console.log(`Primer home: ${PRIMER_HOME}`);
				for (const agent of AgentRegistry.list()) {
					const stored = effective[agent.id];
					console.log(`\n[${agent.id}] ${agent.displayName}`);
					console.log(`  enabled: ${stored?.enabled}`);
					console.log(`  cron:    ${stored?.cron}`);
					console.log(`  model:   ${stored?.model ?? `(default: ${agent.defaultModel})`}`);
					console.log(`  primer:  ${stored?.primer ?? `(default: ${JSON.stringify(agent.defaultPrimer)})`}`);
				}
				return;
			}
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
			if (Object.keys(patch).length === 0) {
				const agent = AgentRegistry.get(argv.agent);
				const stored = withDefaults(config, [agent.id])[agent.id];
				console.log(`[${agent.id}] ${agent.displayName}`);
				console.log(`  enabled: ${stored?.enabled}`);
				console.log(`  cron:    ${stored?.cron}`);
				console.log(`  model:   ${stored?.model ?? `(default: ${agent.defaultModel})`}`);
				console.log(`  primer:  ${stored?.primer ?? `(default: ${JSON.stringify(agent.defaultPrimer)})`}`);
				return;
			}
			const updated = await updateAgentConfig(argv.agent, patch);
			console.log(`[${argv.agent}] updated:`);
			console.log(JSON.stringify(updated, null, 2));
		}
	)
	.command(
		"agents",
		"List registered code agents",
		() => { },
		async () => {
			for (const agent of AgentRegistry.list())
				console.log(`${agent.id}\t${agent.displayName}`);
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
