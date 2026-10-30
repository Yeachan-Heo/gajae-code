import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $which, isEnoent, logger } from "@gajae-code/utils";
import type { DetectedRunner, RunnerTask, TaskRunner } from "../runner";

interface JustDumpRecipeRaw {
	name?: string;
	doc?: string | null;
	private?: boolean;
	parameters?: Array<{ name?: string }>;
}

interface JustDump {
	recipes?: Record<string, JustDumpRecipeRaw>;
}

const JUSTFILE_NAMES = ["justfile", "Justfile", ".justfile"] as const;

async function hasJustfile(cwd: string): Promise<boolean> {
	for (const name of JUSTFILE_NAMES) {
		try {
			const stat = await fs.stat(path.join(cwd, name));
			if (stat.isFile()) return true;
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}
	}
	return false;
}

async function dumpJustTasks(cwd: string): Promise<RunnerTask[] | null> {
	try {
		const proc = Bun.spawn(["just", "--dump", "--dump-format=json"], {
			cwd,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, exit] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		if (exit !== 0) return null;
		const dump = JSON.parse(stdout) as JustDump;
		const tasks: RunnerTask[] = [];
		for (const recipe of Object.values(dump.recipes ?? {})) {
			if (!recipe.name || recipe.private) continue;
			const parameters = (recipe.parameters ?? [])
				.map(parameter => parameter.name)
				.filter((name): name is string => typeof name === "string" && name.length > 0);
			const doc = typeof recipe.doc === "string" && recipe.doc.length > 0 ? recipe.doc : undefined;
			tasks.push({ name: recipe.name, doc, parameters });
		}
		return tasks;
	} catch (err) {
		logger.debug("just task detection failed", { error: err instanceof Error ? err.message : String(err) });
		return null;
	}
}

export const justRunner: TaskRunner = {
	id: "just",
	label: "Just",
	async detect(cwd: string): Promise<DetectedRunner | null> {
		try {
			if (!$which("just")) return null;
			if (!(await hasJustfile(cwd))) return null;
			const tasks = await dumpJustTasks(cwd);
			if (!tasks || tasks.length === 0) return null;
			return { id: "just", label: "Just", commandPrefix: "just", tasks };
		} catch (err) {
			logger.debug("just runner probe failed", { error: err instanceof Error ? err.message : String(err) });
			return null;
		}
	},
};
