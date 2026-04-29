import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { QuotaSnapshot, QuotaWindow, RateBucket } from "./agents/agent.js";

const PREFIX = "[primer]";

// #region Logging

export const log = {
	info(...args: unknown[]): void {
		console.log(PREFIX, ...args);
	},
	warn(...args: unknown[]): void {
		console.warn(PREFIX, ...args);
	},
	error(...args: unknown[]): void {
		console.error(PREFIX, ...args);
	},
};

// #endregion

// #region JSON helpers

export async function readJsonFile<T>(file: string, schema: z.ZodType<T>): Promise<T>;
export async function readJsonFile<T, M>(file: string, schema: z.ZodType<T>, opts: { missing: M; }): Promise<T | M>;
export async function readJsonFile<T, M>(
	file: string,
	schema: z.ZodType<T>,
	opts?: { missing: M; },
): Promise<T | M> {
	try {
		const raw = await readFile(file, "utf8");
		return schema.parse(JSON.parse(raw));
	}
	catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT" && opts)
			return opts.missing;
		throw withPath(file, "read", err);
	}
}

export async function writeJsonFileAtomic(
	file: string,
	data: unknown,
	opts: { mode?: number; chmod?: number; } = {},
): Promise<void> {
	await mkdir(dirname(file), { recursive: true });
	const tmp = `${file}.tmp`;
	await writeFile(tmp, JSON.stringify(data, null, 2), { encoding: "utf8", mode: opts.mode });
	await rename(tmp, file);
	if (opts.chmod !== undefined && process.platform !== "win32") {
		try {
			await chmod(file, opts.chmod);
		}
		catch {
			/* ignore */
		}
	}
}

function withPath(file: string, action: "read", err: unknown): Error {
	if (err instanceof z.ZodError)
		return new Error(`Failed to ${action} JSON file ${file}: ${err.message}`, { cause: err });
	if (err instanceof SyntaxError)
		return new Error(`Failed to ${action} JSON file ${file}: ${err.message}`, { cause: err });
	return err instanceof Error
		? new Error(`Failed to ${action} JSON file ${file}: ${err.message}`, { cause: err })
		: new Error(`Failed to ${action} JSON file ${file}: ${String(err)}`);
}

// #endregion

// #region Header helpers

/** Minimal structural shape shared by `globalThis.Headers` and `undici`'s `Headers`. */
export interface HeadersLike {
	forEach(cb: (value: string, name: string) => void): void;
}

/** Convert a fetch `Headers` (or already-flat record) into a lowercased plain record. */
export function flattenHeaders(headers: HeadersLike | Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {};
	if (typeof (headers as HeadersLike).forEach === "function")
		(headers as HeadersLike).forEach((v, k) => { out[k.toLowerCase()] = v; });
	else
		for (const [k, v] of Object.entries(headers as Record<string, string>)) out[k.toLowerCase()] = v;
	return out;
}

/** Parse a numeric header value, tolerating undefined / non-numeric. */
export function num(s: string | undefined): number | undefined {
	if (s === undefined)
		return undefined;
	const n = Number(s);
	return Number.isFinite(n) ? n : undefined;
}

// #endregion

// #region Quota formatting

function formatDuration(seconds: number): string {
	if (seconds < 0)
		seconds = 0;
	const d = Math.floor(seconds / 86400);
	const h = Math.floor((seconds % 86400) / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = Math.floor(seconds % 60);
	if (d > 0)
		return `${d}d ${h}h`;
	if (h > 0)
		return `${h}h ${m}m`;
	if (m > 0)
		return `${m}m ${s}s`;
	return `${s}s`;
}

function formatReset(window: QuotaWindow | RateBucket): string | undefined {
	const w = window as QuotaWindow;
	if (w.resetAfterSeconds !== undefined)
		return `resets in ${formatDuration(w.resetAfterSeconds)}`;
	if (window.resetAt) {
		const target = new Date(window.resetAt);
		if (!Number.isNaN(target.getTime())) {
			const deltaSec = Math.floor((target.getTime() - Date.now()) / 1000);
			const iso = target.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
			return deltaSec > 0
				? `resets at ${iso} (in ${formatDuration(deltaSec)})`
				: `resets at ${iso}`;
		}
	}
	return undefined;
}

function bar(percent: number, width = 20): string {
	const clamped = Math.max(0, Math.min(100, percent));
	const filled = Math.round((clamped / 100) * width);
	return `[${"█".repeat(filled)}${"·".repeat(width - filled)}]`;
}

/** Render a `QuotaSnapshot` as human-readable lines. Returns the formatted block
 *  (no trailing newline). Empty snapshots produce a single "(no quota data)" line. */
export function formatQuotaSnapshot(snapshot: QuotaSnapshot): string {
	const lines: string[] = [];
	const windowEntries = Object.entries(snapshot.windows);
	const bucketEntries = Object.entries(snapshot.buckets);
	if (windowEntries.length === 0 && bucketEntries.length === 0 && snapshot.retryAfterSeconds === undefined)
		return "(no quota data)";
	const maxKeyLen = Math.max(
		...windowEntries.map(([k, w]) => (w.label ?? k).length),
		...bucketEntries.map(([k, b]) => (b.label ?? k).length),
		0,
	);
	for (const [key, w] of windowEntries) {
		const name = (w.label ?? key).padEnd(maxKeyLen);
		const pct = w.usedPercent !== undefined ? `${w.usedPercent.toFixed(1).padStart(5)}% used` : "       ?% used";
		const visual = w.usedPercent !== undefined ? ` ${bar(w.usedPercent)}` : "";
		const reset = formatReset(w);
		lines.push(`  ${name}  ${pct}${visual}${reset ? `  •  ${reset}` : ""}`);
	}
	for (const [key, b] of bucketEntries) {
		const name = (b.label ?? key).padEnd(maxKeyLen);
		const usage = b.limit !== undefined && b.remaining !== undefined
			? `${b.remaining}/${b.limit} remaining`
			: b.remaining !== undefined
				? `${b.remaining} remaining`
				: "(no usage data)";
		const reset = formatReset(b);
		lines.push(`  ${name}  ${usage}${reset ? `  •  ${reset}` : ""}`);
	}
	if (snapshot.retryAfterSeconds !== undefined)
		lines.push(`  retry-after: ${formatDuration(snapshot.retryAfterSeconds)}`);
	return lines.join("\n");
}

// #endregion
