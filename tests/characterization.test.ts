import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { home } from "./setup.js";
import { codexAgent } from "../src/agents/codex.js";
import { claudeAgent } from "../src/agents/claude.js";
import { AgentRegistry } from "../src/agents/registry.js";
import { formatQuotaSnapshot } from "../src/utils.js";
import * as schedule from "../src/storage/scheduleConfig.js";
import * as snapshot from "../src/storage/snapshot.js";
import * as tokens from "../src/storage/tokens.js";

test("Codex filters and parses quota headers", () => {
	const selected = codexAgent.selectQuotaHeaders({
		"x-codex-primary-used-percent": "12.5",
		"x-codex-primary-window-minutes": "300",
		"x-codex-secondary-used-percent": "88",
		"x-codex-secondary-reset-after-seconds": "60",
		"retry-after": "10",
		"content-type": "text/event-stream",
	});

	expect(selected).toEqual({
		"x-codex-primary-used-percent": "12.5",
		"x-codex-primary-window-minutes": "300",
		"x-codex-secondary-used-percent": "88",
		"x-codex-secondary-reset-after-seconds": "60",
		"retry-after": "10",
	});

	const parsed = codexAgent.parseQuota(selected);
	expect(parsed.windows.primary?.label).toBe("5h window");
	expect(parsed.windows.primary?.usedPercent).toBe(12.5);
	expect(parsed.windows.primary?.windowMinutes).toBe(300);
	expect(parsed.windows.secondary?.label).toBe("weekly window");
	expect(parsed.windows.secondary?.usedPercent).toBe(88);
	expect(parsed.windows.secondary?.resetAfterSeconds).toBe(60);
	expect(parsed.retryAfterSeconds).toBe(10);
	expect(codexAgent.summarize(parsed)).toBe("primary=12.5% secondary=88%");
});

test("Claude filters and parses quota headers", () => {
	const selected = claudeAgent.selectQuotaHeaders({
		"anthropic-ratelimit-unified-5h-utilization": "0.25",
		"anthropic-ratelimit-unified-5h-status": "allowed",
		"anthropic-ratelimit-unified-7d-utilization": "0.5",
		"anthropic-ratelimit-requests-limit": "100",
		"anthropic-ratelimit-requests-remaining": "75",
		"anthropic-ratelimit-tokens-limit": "1000",
		"anthropic-ratelimit-tokens-remaining": "900",
		"retry-after": "5",
		"content-type": "application/json",
	});

	expect(selected).toEqual({
		"anthropic-ratelimit-unified-5h-utilization": "0.25",
		"anthropic-ratelimit-unified-5h-status": "allowed",
		"anthropic-ratelimit-unified-7d-utilization": "0.5",
		"anthropic-ratelimit-requests-limit": "100",
		"anthropic-ratelimit-requests-remaining": "75",
		"anthropic-ratelimit-tokens-limit": "1000",
		"anthropic-ratelimit-tokens-remaining": "900",
		"retry-after": "5",
	});

	const parsed = claudeAgent.parseQuota(selected);
	expect(parsed.windows["session-5h"]?.label).toBe("5h (allowed)");
	expect(parsed.windows["session-5h"]?.usedPercent).toBe(25);
	expect(parsed.windows["session-7d"]?.usedPercent).toBe(50);
	expect(parsed.buckets.requests?.remaining).toBe(75);
	expect(parsed.buckets.requests?.limit).toBe(100);
	expect(parsed.buckets.tokens?.remaining).toBe(900);
	expect(parsed.buckets.tokens?.limit).toBe(1000);
	expect(parsed.retryAfterSeconds).toBe(5);
	expect(claudeAgent.summarize(parsed)).toBe("5h=25.0% 7d=50.0% req=75/100 tok=900/1000");
});

test("formatQuotaSnapshot renders windows, buckets, and retry hints", () => {
	const formatted = formatQuotaSnapshot({
		windows: {
			primary: { label: "5h window", usedPercent: 50, resetAfterSeconds: 90 },
		},
		buckets: {
			requests: { label: "requests", limit: 100, remaining: 25 },
		},
		retryAfterSeconds: 30,
		raw: {},
	});

	expect(formatted).toMatch(/5h window\s+50\.0% used/);
	expect(formatted).toMatch(/requests\s+25\/100 remaining/);
	expect(formatted).toMatch(/retry-after: 30s/);
});

test("schedule config fills defaults and merges updates", async () => {
	expect(schedule.withDefaults({}, ["codex"])).toEqual({
		codex: { enabled: true, cron: "0 */1 * * *", followUp: false, followUpProbeLeadMinutes: 5 },
	});

	const updated = await schedule.updateAgentConfig("codex", { enabled: false, model: "custom-model" });
	expect(updated).toEqual({
		enabled: false,
		cron: "0 */1 * * *",
		model: "custom-model",
		followUp: false,
		followUpProbeLeadMinutes: 5,
	});
});

test("storage returns empty values for missing files", async () => {
	expect(await tokens.loadTokens()).toEqual({});
	expect(await snapshot.readSnapshot("missing")).toBeNull();
});

test("snapshot round-trips existing JSON shape", async () => {
	await snapshot.writeSnapshot("codex", {
		updatedAt: 123,
		headers: { "x-codex-primary-used-percent": "1" },
		parsed: { windows: {}, buckets: {}, raw: {} },
	});

	expect(await snapshot.readSnapshot("codex")).toEqual({
		agentId: "codex",
		updatedAt: 123,
		headers: { "x-codex-primary-used-percent": "1" },
		parsed: { windows: {}, buckets: {}, raw: {} },
	});
});

test("snapshot rejects malformed JSON with path context", async () => {
	const dir = join(home, "snapshots");
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "broken.json"), "{", "utf8");

	expect(snapshot.readSnapshot("broken")).rejects.toThrow(/Failed to read JSON file .*broken\.json/);
});

test("snapshot rejects invalid JSON shape", async () => {
	const dir = join(home, "snapshots");
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "invalid.json"), JSON.stringify({ agentId: "invalid" }), "utf8");

	expect(snapshot.readSnapshot("invalid")).rejects.toThrow(/Failed to read JSON file .*invalid\.json/);
});

test("registry exposes known agents and rejects unknown agents", () => {
	expect(AgentRegistry.listIds()).toEqual(["codex", "claude"]);
	expect(AgentRegistry.get("codex").id).toBe("codex");
	expect(() => AgentRegistry.get("missing")).toThrow(/Unknown agent: missing\. Known: codex, claude/);
});
