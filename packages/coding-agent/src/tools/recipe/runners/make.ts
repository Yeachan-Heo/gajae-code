import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, logger } from "@gajae-code/utils";
import { type SessionLaunchEnvironment, whichWithSessionEnvironment } from "../../../sdk/session-environment";
import type { DetectedRunner, RunnerTask, TaskRunner } from "../runner";

const MAKEFILE_NAMES = ["Makefile", "makefile", "GNUmakefile"] as const;
const TARGET_PATTERN = /^(?<name>[A-Za-z_][A-Za-z0-9_-]*)\s*:(?!=).*?(?:##\s*(?<doc>.+))?$/u;
const PHONY_PATTERN = /^\.PHONY\s*:\s*(?<targets>.*)$/u;

interface MakeTargetInfo {
	name: string;
	doc?: string;
	order: number;
	phony: boolean;
}

async function findMakefile(cwd: string): Promise<string | null> {
	for (const name of MAKEFILE_NAMES) {
		const candidate = path.join(cwd, name);
		try {
			const stat = await fs.stat(candidate);
			if (stat.isFile()) return candidate;
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}
	}
	return null;
}

function isVariableAssignment(line: string, name: string): boolean {
	return new RegExp(`^\\s*${name}\\s*[:?+]?=`, "u").test(line);
}

function parsePhonyTargets(line: string): string[] {
	const match = PHONY_PATTERN.exec(line);
	if (!match?.groups?.targets) return [];
	return match.groups.targets
		.split(/\s+/u)
		.map(target => target.trim())
		.filter(target => /^[A-Za-z_][A-Za-z0-9_-]*$/u.test(target));
}

function parseMakeTargets(text: string): RunnerTask[] {
	const targets = new Map<string, MakeTargetInfo>();
	const phonyTargets: string[] = [];
	let order = 0;

	for (const line of text.split("\n")) {
		for (const target of parsePhonyTargets(line)) {
			if (!phonyTargets.includes(target)) phonyTargets.push(target);
		}

		const match = TARGET_PATTERN.exec(line);
		const name = match?.groups?.name;
		if (!name || name === ".PHONY" || isVariableAssignment(line, name)) continue;
		if (targets.has(name)) continue;
		const rawDoc = match?.groups?.doc?.trim();
		const doc = rawDoc && rawDoc.length > 0 ? rawDoc : undefined;
		targets.set(name, { name, doc, order, phony: false });
		order += 1;
	}

	for (const phony of phonyTargets) {
		const existing = targets.get(phony);
		if (existing) {
			existing.phony = true;
			continue;
		}
		targets.set(phony, { name: phony, order, phony: true });
		order += 1;
	}

	const hasPhonyTargets = phonyTargets.length > 0;
	return [...targets.values()]
		.sort((left, right) => left.order - right.order)
		.flatMap(target => {
			if (!hasPhonyTargets || target.phony) {
				return [{ name: target.name, doc: target.doc, parameters: [] }];
			}
			if (!target.doc) return [];
			return [{ name: target.name, doc: `${target.doc} (file target)`, parameters: [] }];
		});
}

export const makeRunner: TaskRunner = {
	id: "make",
	label: "Make",
	async detect(cwd: string, sessionEnvironment?: SessionLaunchEnvironment): Promise<DetectedRunner | null> {
		try {
			if (!whichWithSessionEnvironment("make", sessionEnvironment)) return null;
			const makefile = await findMakefile(cwd);
			if (!makefile) return null;
			const tasks = parseMakeTargets(await Bun.file(makefile).text());
			if (tasks.length === 0) return null;
			return { id: "make", label: "Make", commandPrefix: "make", tasks };
		} catch (err) {
			logger.debug("make runner probe failed", { error: err instanceof Error ? err.message : String(err) });
			return null;
		}
	},
};
