import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { postmortem } from "@gajae-code/utils";
import RUNNER_SCRIPT from "./runner.py" with { type: "text" };

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const DIRECTORY_PREFIX = "gjc-python-runner-";

interface RunnerScriptArtifact {
	directory: string;
	scriptPath: string;
}

async function initializeRunnerScript(tempRoot: string): Promise<RunnerScriptArtifact> {
	const directory = await fs.mkdtemp(path.join(tempRoot, DIRECTORY_PREFIX));
	try {
		if (process.platform !== "win32") await fs.chmod(directory, DIRECTORY_MODE);
		const scriptPath = path.join(directory, "runner.py");
		const handle = await fs.open(scriptPath, "wx", FILE_MODE);
		try {
			await handle.writeFile(RUNNER_SCRIPT, { encoding: "utf8" });
			if (process.platform !== "win32") await handle.chmod(FILE_MODE);
		} finally {
			await handle.close();
		}
		return { directory, scriptPath };
	} catch (error) {
		await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
		throw error;
	}
}

export interface RunnerScriptCache {
	ensureRunnerScript(): Promise<string>;
	cleanup(): Promise<void>;
}

export function createRunnerScriptCache(tempRoot: string): RunnerScriptCache {
	let initialization: Promise<RunnerScriptArtifact> | null = null;
	let artifact: RunnerScriptArtifact | null = null;
	let cleanupAttempt: Promise<void> | null = null;

	return {
		async ensureRunnerScript() {
			if (artifact) return artifact.scriptPath;
			if (!initialization) initialization = initializeRunnerScript(tempRoot);
			try {
				artifact = await initialization;
				return artifact.scriptPath;
			} catch (error) {
				if (initialization) initialization = null;
				throw error;
			}
		},
		async cleanup() {
			if (cleanupAttempt) return await cleanupAttempt;
			cleanupAttempt = (async () => {
				const initialized = await initialization?.catch(() => null);
				const directory = artifact?.directory ?? initialized?.directory;
				artifact = null;
				initialization = null;
				if (directory) await fs.rm(directory, { recursive: true, force: true });
			})();
			try {
				await cleanupAttempt;
			} finally {
				cleanupAttempt = null;
			}
		},
	};
}

/** @internal Test-only initializer for isolated artifact assertions. */
export function createRunnerScriptInitializer(tempRoot: string): () => Promise<string> {
	return createRunnerScriptCache(tempRoot).ensureRunnerScript;
}

const processRunnerScriptCache = createRunnerScriptCache(os.tmpdir());

export const ensureRunnerScript = () => processRunnerScriptCache.ensureRunnerScript();

postmortem.register("python-runner-artifact", () => processRunnerScriptCache.cleanup());
