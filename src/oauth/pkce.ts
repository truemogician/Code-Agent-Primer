import { randomBytes, createHash } from "node:crypto";

export interface PkcePair {
	verifier: string;
	challenge: string;
}

function base64url(buf: Buffer): string {
	return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function createPkcePair(): PkcePair {
	const verifier = base64url(randomBytes(32));
	const challenge = base64url(createHash("sha256").update(verifier).digest());
	return { verifier, challenge };
}

export function randomState(): string {
	return randomBytes(32).toString("hex");
}
