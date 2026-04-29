import { join } from "node:path";
import { z } from "zod";
import { PRIMER_HOME } from "../config.js";
import { readJsonFile, writeJsonFileAtomic } from "../utils.js";

const SNAPSHOTS_DIR = join(PRIMER_HOME, "snapshots");

function pathFor(agentId: string): string {
	return join(SNAPSHOTS_DIR, `${agentId}.json`);
}

export interface Snapshot {
	agentId: string;
	updatedAt: number;
	headers: Record<string, string>;
	parsed?: Record<string, unknown>;
}

const SnapshotSchema: z.ZodType<Snapshot> = z.object({
	agentId: z.string(),
	updatedAt: z.number(),
	headers: z.record(z.string(), z.string()),
	parsed: z.record(z.string(), z.unknown()).optional(),
});

export async function readSnapshot(agentId: string): Promise<Snapshot | null> {
	return readJsonFile(pathFor(agentId), SnapshotSchema, { missing: null });
}

export async function writeSnapshot(agentId: string, data: Omit<Snapshot, "agentId" | "updatedAt"> & Partial<Pick<Snapshot, "updatedAt">>): Promise<void> {
	const file = pathFor(agentId);
	const snapshot: Snapshot = {
		agentId,
		updatedAt: data.updatedAt ?? Math.floor(Date.now() / 1000),
		headers: data.headers,
		parsed: data.parsed,
	};
	await writeJsonFileAtomic(file, snapshot, { mode: 0o600 });
}
