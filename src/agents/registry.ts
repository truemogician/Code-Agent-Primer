import type { CodeAgent } from "./agent.js";
import { codexAgent } from "./codex.js";
import { claudeAgent } from "./claude.js";

export namespace AgentRegistry {
	const registry = new Map<string, CodeAgent>();

	export function register(...agents: CodeAgent[]): void {
		for (const agent of agents) {
			if (registry.has(agent.id))
				throw new Error(`Agent already registered: ${agent.id}`);
			registry.set(agent.id, agent);
		}
	}

	export function get(id: string): CodeAgent {
		const agent = registry.get(id);
		if (!agent)
			throw new Error(`Unknown agent: ${id}. Known: ${listIds().join(", ")}`);
		return agent;
	}

	export function tryGet(id: string): CodeAgent | undefined {
		return registry.get(id);
	}

	export function list(): CodeAgent[] {
		return [...registry.values()];
	}

	export function listIds(): string[] {
		return [...registry.keys()];
	}
}

AgentRegistry.register(codexAgent, claudeAgent);
