import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PRIMER_HOME } from "../config.js";

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

export async function readSnapshot(agentId: string): Promise<Snapshot | null> {
	try {
		const raw = await readFile(pathFor(agentId), "utf8");
		return JSON.parse(raw) as Snapshot;
	}
	catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT")
			return null;
		throw err;
	}
}

export async function writeSnapshot(agentId: string, data: Omit<Snapshot, "agentId" | "updatedAt"> & Partial<Pick<Snapshot, "updatedAt">>): Promise<void> {
	const file = pathFor(agentId);
	await mkdir(dirname(file), { recursive: true });
	const snapshot: Snapshot = {
		agentId,
		updatedAt: data.updatedAt ?? Math.floor(Date.now() / 1000),
		headers: data.headers,
		parsed: data.parsed,
	};
	const tmp = `${file}.tmp`;
	await writeFile(tmp, JSON.stringify(snapshot, null, 2), { encoding: "utf8", mode: 0o600 });
	await rename(tmp, file);
}
