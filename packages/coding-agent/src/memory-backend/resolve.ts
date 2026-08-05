import type { Settings } from "../config/settings";
import type { MemoryBackend, MemoryBackendId } from "./types";

/**
 * Resident no-op backend used for the default `memory.backend=off` path.
 * Keeping this value here lets the identity resolver stay free of concrete
 * backend imports while preserving the legacy resolver API below.
 */
export const offBackend: MemoryBackend = {
	id: "off",
	async start() {},
	async buildDeveloperInstructions() {
		return undefined;
	},
	async clear() {},
	async enqueue() {},
};

/**
 * Resolve the configured backend identity without importing any backend
 * implementation. This is safe for synchronous capability checks and keeps
 * the default `off` graph resident-free.
 */
export function resolveMemoryBackendId(settings: Settings): MemoryBackendId {
	const id = settings.get("memory.backend");
	if (id === "hindsight" || id === "local") return id;
	return "off";
}

/**
 * Compatibility handles for callers that still resolve a backend object
 * synchronously. Their implementation methods delegate to the same literal
 * dynamic imports used by the runtime service; no backend graph is eager.
 */
export const localBackend: MemoryBackend = {
	id: "local",
	async start(options) {
		return (await import("./local-backend")).localBackend.start(options);
	},
	async buildDeveloperInstructions(agentDir, settings, session) {
		return (await import("./local-backend")).localBackend.buildDeveloperInstructions(agentDir, settings, session);
	},
	async clear(agentDir, cwd, session) {
		return (await import("./local-backend")).localBackend.clear(agentDir, cwd, session);
	},
	async enqueue(agentDir, cwd, session) {
		return (await import("./local-backend")).localBackend.enqueue(agentDir, cwd, session);
	},
};

const hindsightBackend: MemoryBackend = {
	id: "hindsight",
	async start(options) {
		return (await import("../hindsight")).hindsightBackend.start(options);
	},
	async buildDeveloperInstructions(agentDir, settings, session) {
		return (await import("../hindsight")).hindsightBackend.buildDeveloperInstructions(agentDir, settings, session);
	},
	async clear(agentDir, cwd, session) {
		return (await import("../hindsight")).hindsightBackend.clear(agentDir, cwd, session);
	},
	async enqueue(agentDir, cwd, session) {
		return (await import("../hindsight")).hindsightBackend.enqueue(agentDir, cwd, session);
	},
	async beforeAgentStartPrompt(session, promptText) {
		return (await import("../hindsight")).hindsightBackend.beforeAgentStartPrompt?.(session, promptText);
	},
	async preCompactionContext(messages, settings, session) {
		return (await import("../hindsight")).hindsightBackend.preCompactionContext?.(messages, settings, session);
	},
};

/** Legacy synchronous resolver. New behavior callers should use the lazy service. */
export function resolveMemoryBackend(settings: Settings): MemoryBackend {
	switch (resolveMemoryBackendId(settings)) {
		case "local":
			return localBackend;
		case "hindsight":
			return hindsightBackend;
		case "off":
			return offBackend;
	}
}
