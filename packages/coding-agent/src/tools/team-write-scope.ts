import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isEnoent } from "@gajae-code/utils";
import { type EditPathMutationOptions, withEditPathMutation } from "../edit/path-mutation-lock";
import {
	gjcTeamTaskAuthorityDigest,
	isCanonicalPersistedGjcTeamTaskClaim,
	readCanonicalGjcTeamTasksFromDir,
} from "../gjc-runtime/team-store";
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

interface ValidatedWriteTarget {
	canonicalPath: string;
	identityKey: string;
	identityLockPath?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function resolveValidatedWriteTarget(absolutePath: string): Promise<ValidatedWriteTarget> {
	const canonicalPath = await resolvePotentialRealPath(absolutePath);
	try {
		const stat = await fs.stat(canonicalPath);
		if (stat.isFile()) {
			const identityKey = `inode:${stat.dev}:${stat.ino}`;
			return {
				canonicalPath,
				identityKey,
				identityLockPath: path.join(os.tmpdir(), "gjc-edit-identities", identityKey),
			};
		}
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	return { canonicalPath, identityKey: `path:${pathKey(canonicalPath)}` };
}

async function validateTeamWriteScope(
	session: Pick<ToolSession, "cwd">,
	absolutePath: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<ValidatedWriteTarget> {
	const target = await resolveValidatedWriteTarget(absolutePath);
	const stateRoot = env.GJC_TEAM_STATE_ROOT?.trim();
	const teamName = env.GJC_TEAM_NAME?.trim();
	const workerId = env.GJC_TEAM_WORKER_ID?.trim();
	if (!stateRoot || !teamName || !workerId) return target;

	const teamDir = path.join(stateRoot, teamName);
	const configFile = Bun.file(path.join(teamDir, "config.json"));
	let config: unknown;
	try {
		config = await configFile.json();
	} catch {
		throw new ToolError(`Team worker ${workerId} has no canonical team configuration.`);
	}
	if (
		!isRecord(config) ||
		config.team_name !== teamName ||
		!Array.isArray(config.task_ids) ||
		!config.task_ids.every(taskId => typeof taskId === "string" && /^[A-Za-z0-9._-]+$/u.test(taskId)) ||
		!isRecord(config.task_authorities) ||
		!Object.values(config.task_authorities).every(
			digest => typeof digest === "string" && /^[a-f0-9]{64}$/u.test(digest),
		)
	) {
		throw new ToolError(`Team worker ${workerId} has no canonical task membership.`);
	}
	const authorizedTaskIds = new Set(config.task_ids);
	const tasks = await readCanonicalGjcTeamTasksFromDir(teamDir);
	const activeTasks = [];
	for (const task of tasks) {
		if (
			!authorizedTaskIds.has(task.id) ||
			config.task_authorities[task.id] !== gjcTeamTaskAuthorityDigest(task) ||
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
	const relativeTarget = path.relative(canonicalRoot, target.canonicalPath);
	if (relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget)) {
		throw new ToolError(`Team write scope forbids paths outside the worker workspace: ${absolutePath}`);
	}

	const allowed = new Map<string, string>();
	for (const task of scopedTasks) {
		for (const writePath of task.write_paths ?? []) {
			allowed.set((await resolveValidatedWriteTarget(path.join(canonicalRoot, writePath))).identityKey, writePath);
		}
	}
	if (!allowed.has(target.identityKey)) {
		throw new ToolError(
			`Team write scope forbids ${pathKey(relativeTarget)}; claimed paths: ${[...allowed.values()].sort().join(", ")}`,
		);
	}
	return target;
}

export async function enforceTeamWriteScope(
	session: Pick<ToolSession, "cwd">,
	absolutePath: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	await validateTeamWriteScope(session, absolutePath, env);
}

export async function withTeamWriteScopeMutation<T>(
	session: Pick<ToolSession, "cwd">,
	absolutePaths: readonly string[],
	mutate: (canonicalPaths: readonly string[]) => Promise<T>,
	options: EditPathMutationOptions = {},
	env: NodeJS.ProcessEnv = process.env,
): Promise<T> {
	const initialCanonicalPaths = await Promise.all(
		absolutePaths.map(absolutePath => validateTeamWriteScope(session, absolutePath, env)),
	);
	return withEditPathMutation(
		[
			...absolutePaths,
			...initialCanonicalPaths.map(target => target.canonicalPath),
			...initialCanonicalPaths.flatMap(target => (target.identityLockPath ? [target.identityLockPath] : [])),
		],
		async () => {
			const lockedCanonicalPaths = await Promise.all(
				absolutePaths.map(absolutePath => validateTeamWriteScope(session, absolutePath, env)),
			);
			if (
				lockedCanonicalPaths.some(
					(target, index) =>
						pathKey(target.canonicalPath) !== pathKey(initialCanonicalPaths[index]!.canonicalPath) ||
						target.identityKey !== initialCanonicalPaths[index]!.identityKey,
				)
			) {
				throw new ToolError(
					"Team write target changed while waiting for the mutation lock; retry after re-reading.",
				);
			}
			return mutate(lockedCanonicalPaths.map(target => target.canonicalPath));
		},
		options,
	);
}
