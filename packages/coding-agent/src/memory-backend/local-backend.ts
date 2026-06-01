import {
	buildMemoryToolDeveloperInstructions,
	clearMemoryData,
	enqueueMemoryConsolidation,
	startMemoryStartupTask,
} from "../memories";
import type { MemoryBackend } from "./types";

/**
 * Wraps the existing `memories/` module as a `MemoryBackend`.
 *
 * The local pipeline owns rollout summarisation, SQLite retention, and
 * `memory_summary.md`. Prompt reads use the live session cwd when available so
 * manual enqueue/rebuild and startup hydration address the same memory root.
 */
export const localBackend: MemoryBackend = {
	id: "local",
	start(options) {
		startMemoryStartupTask(options);
	},
	async buildDeveloperInstructions(agentDir, settings, session) {
		return buildMemoryToolDeveloperInstructions(agentDir, settings, session);
	},
	async clear(agentDir, cwd) {
		await clearMemoryData(agentDir, cwd);
	},
	async enqueue(agentDir, cwd, session) {
		enqueueMemoryConsolidation(agentDir, cwd);
		if (!session) return;
		startMemoryStartupTask({
			session,
			settings: session.settings,
			modelRegistry: session.modelRegistry,
			agentDir,
			taskDepth: session.taskDepth,
		});
	},
};
