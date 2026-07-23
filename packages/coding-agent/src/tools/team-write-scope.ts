import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@gajae-code/utils";
import { isCanonicalPersistedGjcTeamTaskClaim, readCanonicalGjcTeamTasksFromDir } from "../gjc-runtime/team-store";
import type { ToolSession } from ".";
import { ToolError } from "./tool-errors";

async function resolvePotentialRealPath(candidate: string): Promise<string> {
	let cursor = path.resolve(candidate);
	const suffix: string[] = [];
	while (true) {
		try {
			return path.join(await fs.realpath(cursor), ...suffix);
		} catch (error) {
			if (!isEnoent(error)) throw error;
			const parent = path.dirname(cursor);
			if (parent === cursor) throw error;
			suffix.unshift(path.basename(cursor));
			cursor = parent;
		}
	}
}

function pathKey(candidate: string): string {
	const normalized = candidate.split(path.sep).join("/");
	return process.platform === "darwin" || process.platform === "win32"
		? normalized.toLocaleLowerCase("en-US")
		: normalized;
}

export async function enforceTeamWriteScope(
	session: Pick<ToolSession, "cwd">,
	absolutePath: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	const stateRoot = env.GJC_TEAM_STATE_ROOT?.trim();
	const teamName = env.GJC_TEAM_NAME?.trim();
	const workerId = env.GJC_TEAM_WORKER_ID?.trim();
	if (!stateRoot || !teamName || !workerId) return;

	const teamDir = path.join(stateRoot, teamName);
	const tasks = await readCanonicalGjcTeamTasksFromDir(teamDir);
	const activeTasks = [];
	for (const task of tasks) {
		if (
			task.status !== "in_progress" ||
			(task.owner !== workerId && task.assignee !== workerId) ||
			!/^[A-Za-z0-9._-]+$/u.test(task.id)
		) {
			continue;
		}
		const claimFile = Bun.file(path.join(teamDir, "claims", `${task.id}.json`));
		if (!(await claimFile.exists())) continue;
		const claim: unknown = await claimFile.json();
		if (
			!isCanonicalPersistedGjcTeamTaskClaim(claim) ||
			!task.claim ||
			!isCanonicalPersistedGjcTeamTaskClaim(task.claim) ||
			claim.owner !== workerId ||
			task.claim.owner !== claim.owner ||
			task.claim.token !== claim.token ||
			task.claim.leased_until !== claim.leased_until ||
			Date.parse(claim.leased_until) <= Date.now()
		) {
			continue;
		}
		activeTasks.push(task);
	}
	if (activeTasks.length === 0) throw new ToolError(`Team worker ${workerId} must claim a task before writing files.`);
	const scopedTasks = activeTasks.filter(task => task.write_paths !== undefined);
	if (scopedTasks.length === 0) {
		throw new ToolError(`Team worker ${workerId} must declare write_paths before writing files.`);
	}

	const canonicalRoot = await fs.realpath(session.cwd);
	const canonicalTarget = await resolvePotentialRealPath(absolutePath);
	const relativeTarget = path.relative(canonicalRoot, canonicalTarget);
	if (relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget)) {
		throw new ToolError(`Team write scope forbids paths outside the worker workspace: ${absolutePath}`);
	}

	const allowed = new Set<string>();
	for (const task of scopedTasks) {
		for (const writePath of task.write_paths ?? []) {
			allowed.add(
				pathKey(path.relative(canonicalRoot, await resolvePotentialRealPath(path.join(canonicalRoot, writePath)))),
			);
		}
	}
	const targetKey = pathKey(relativeTarget);
	if (!allowed.has(targetKey)) {
		throw new ToolError(`Team write scope forbids ${targetKey}; claimed paths: ${[...allowed].sort().join(", ")}`);
	}
}
