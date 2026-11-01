/**
 * Execute planned migration actions.
 *
 * Consumes the planner's actions unchanged and performs only `create`/`update`
 * operations. It never re-plans. Writes are not transactional: on a write error
 * the offending action flips to `failed_io`, already-written actions remain, and
 * remaining actions still run (no rollback). Dry-run never calls this.
 */
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getTrustedHomeDir } from "@gajae-code/utils";
import { upsertMCPServer } from "../runtime-mcp/config-writer";
import type { MigrateAction } from "./types";

function trustedSkillDestinationBase(destination: string): string {
	const skillDir = path.dirname(path.resolve(destination));
	const skillsRoot = path.dirname(skillDir);
	const scopeRoot = path.dirname(skillsRoot);
	return path.basename(scopeRoot) === ".gjc" ? path.dirname(scopeRoot) : scopeRoot;
}

async function ensureRealDirectoryPathNoFollow(
	directory: string,
	trustedBase: string,
	label = "skill destination",
	createMissing = true,
	mode?: number,
): Promise<void> {
	const resolvedBase = path.resolve(trustedBase);
	const resolvedDirectory = path.resolve(directory);
	const relative = path.relative(resolvedBase, resolvedDirectory);
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error(`${label} escapes trusted base: ${resolvedDirectory}`);
	}

	const baseStat = await fs.stat(resolvedBase);
	if (!baseStat.isDirectory()) {
		throw new Error(`${label} base is not a directory: ${resolvedBase}`);
	}

	let current = resolvedBase;
	for (const part of relative.split(path.sep).filter(part => part && part !== ".")) {
		current = path.join(current, part);
		try {
			const stat = await fs.lstat(current);
			if (!stat.isDirectory() || stat.isSymbolicLink()) {
				throw new Error(`${label} ancestor is not a real directory: ${current}`);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			// A missing project `.gjc` is created by the MCP writer (mode 0o700).
			// Do not mkdir here, or that mode is lost. An existing symlink still fails above.
			if (!createMissing) return;
			await fs.mkdir(current, mode === undefined ? undefined : { mode });
			const stat = await fs.lstat(current);
			if (!stat.isDirectory() || stat.isSymbolicLink()) {
				throw new Error(`${label} ancestor is not a real directory: ${current}`);
			}
		}
	}
}

async function writeSkillFileNoFollow(destination: string, content: string): Promise<void> {
	const skillDir = path.dirname(destination);
	await ensureRealDirectoryPathNoFollow(skillDir, trustedSkillDestinationBase(destination));
	const handle = await fs.open(
		destination,
		fsSync.constants.O_WRONLY | fsSync.constants.O_CREAT | fsSync.constants.O_TRUNC | fsSync.constants.O_NOFOLLOW,
		0o666,
	);
	try {
		await handle.writeFile(content, "utf-8");
	} finally {
		await handle.close();
	}
}

async function ensureInstructionDirectory(
	directory: string,
	project: boolean,
	label = "instruction destination",
): Promise<void> {
	let trustedBase = path.dirname(directory);
	if (!project) {
		const home = path.resolve(getTrustedHomeDir());
		const resolvedDirectory = path.resolve(directory);
		const relative = path.relative(home, resolvedDirectory);
		const isWithinHome =
			relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
		if (isWithinHome) {
			trustedBase = home;
		} else {
			let current = path.dirname(resolvedDirectory);
			while (true) {
				try {
					const stat = await fs.lstat(current);
					if (!stat.isDirectory() || stat.isSymbolicLink()) {
						throw new Error(`user ${label} ancestor is not a real directory: ${current}`);
					}
					trustedBase = current;
					break;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
					const parent = path.dirname(current);
					if (parent === current) throw error;
					current = parent;
				}
			}
		}
	}
	await ensureRealDirectoryPathNoFollow(directory, trustedBase, label, true, 0o700);
}

async function writeInstructionFileNoFollow(destination: string, content: string, project: boolean): Promise<void> {
	await ensureInstructionDirectory(path.dirname(destination), project);
	const handle = await fs.open(
		destination,
		fsSync.constants.O_WRONLY | fsSync.constants.O_CREAT | fsSync.constants.O_TRUNC | fsSync.constants.O_NOFOLLOW,
		0o666,
	);
	try {
		await handle.writeFile(content, "utf-8");
	} finally {
		await handle.close();
	}
}

async function writeAgentFileNoFollow(
	destination: string,
	content: string,
	project: boolean,
	createOnly: boolean,
): Promise<void> {
	const destinationDirectory = path.dirname(destination);
	if (project) {
		const agentsRoot = path.dirname(destinationDirectory);
		const agentRoot = path.dirname(agentsRoot);
		await ensureRealDirectoryPathNoFollow(agentRoot, path.dirname(agentRoot), "agent destination", true, 0o700);
		await ensureRealDirectoryPathNoFollow(agentsRoot, agentRoot, "agent destination", true, 0o700);
		await ensureRealDirectoryPathNoFollow(destinationDirectory, agentsRoot, "agent destination", true, 0o700);
	} else {
		await ensureInstructionDirectory(destinationDirectory, false, "agent destination");
	}
	const handle = await fs.open(
		destination,
		createOnly
			? fsSync.constants.O_WRONLY | fsSync.constants.O_CREAT | fsSync.constants.O_EXCL | fsSync.constants.O_NOFOLLOW
			: fsSync.constants.O_WRONLY |
					fsSync.constants.O_CREAT |
					fsSync.constants.O_TRUNC |
					fsSync.constants.O_NOFOLLOW,
		0o666,
	);
	try {
		await handle.writeFile(content, "utf-8");
	} finally {
		await handle.close();
	}
}

/** Generated hook modules live beside the agent's own hooks, so they use the same no-follow rules. */
async function writeHookModuleNoFollow(destination: string, content: string, createOnly: boolean): Promise<void> {
	await ensureInstructionDirectory(path.dirname(destination), false, "hook destination");
	const handle = await fs.open(
		destination,
		createOnly
			? fsSync.constants.O_WRONLY | fsSync.constants.O_CREAT | fsSync.constants.O_EXCL | fsSync.constants.O_NOFOLLOW
			: fsSync.constants.O_WRONLY |
					fsSync.constants.O_CREAT |
					fsSync.constants.O_TRUNC |
					fsSync.constants.O_NOFOLLOW,
		0o666,
	);
	try {
		await handle.writeFile(content, "utf-8");
	} finally {
		await handle.close();
	}
}

async function writeCommandFileNoFollow(
	destination: string,
	content: string,
	name: string,
	project: boolean,
	createOnly: boolean,
): Promise<void> {
	const destinationDirectory = path.dirname(destination);
	if (project) {
		const nameParts = name.split(":");
		let commandsRoot = destinationDirectory;
		for (let index = 1; index < nameParts.length; index++) commandsRoot = path.dirname(commandsRoot);
		const agentRoot = path.dirname(commandsRoot);
		await ensureRealDirectoryPathNoFollow(
			agentRoot,
			path.dirname(agentRoot),
			"slash command destination",
			true,
			0o700,
		);
		await ensureRealDirectoryPathNoFollow(commandsRoot, agentRoot, "slash command destination", true, 0o700);
		await ensureRealDirectoryPathNoFollow(
			destinationDirectory,
			commandsRoot,
			"slash command destination",
			true,
			0o700,
		);
	} else {
		await ensureInstructionDirectory(destinationDirectory, false, "slash command destination");
	}

	const handle = await fs.open(
		destination,
		fsSync.constants.O_WRONLY |
			fsSync.constants.O_CREAT |
			fsSync.constants.O_TRUNC |
			fsSync.constants.O_NOFOLLOW |
			(createOnly ? fsSync.constants.O_EXCL : 0),
		0o666,
	);
	try {
		await handle.writeFile(content, "utf-8");
	} finally {
		await handle.close();
	}
}

export async function executeActions(
	actions: MigrateAction[],
	options?: { project?: boolean },
): Promise<MigrateAction[]> {
	const out: MigrateAction[] = [];
	for (const action of actions) {
		if (action.operation !== "create" && action.operation !== "update") {
			out.push(action);
			continue;
		}
		try {
			if (action.type === "mcp" && action.mcp && action.name && action.destination) {
				// `project` is the migrate scope, not a guess from the directory name.
				// A user agent dir may itself be named `.gjc`.
				if (options?.project) {
					const directory = path.dirname(action.destination);
					await ensureRealDirectoryPathNoFollow(
						directory,
						path.dirname(path.resolve(directory)),
						"mcp destination",
						false,
					);
				}
				await upsertMCPServer(action.destination, action.name, action.mcp.config, {
					force: action.operation === "update",
				});
				out.push(action);
			} else if (action.type === "skill" && action.skill && action.destination) {
				await writeSkillFileNoFollow(action.destination, action.skill.content);
				out.push(action);
			} else if (action.type === "instruction" && action.instruction && action.destination) {
				await writeInstructionFileNoFollow(
					action.destination,
					action.instruction.content,
					options?.project ?? false,
				);
				out.push(action);
			} else if (action.type === "hook" && action.hook && action.destination) {
				await writeHookModuleNoFollow(action.destination, action.hook.content, action.operation === "create");
				out.push(action);
			} else if (action.type === "agent" && action.agent && action.destination) {
				await writeAgentFileNoFollow(
					action.destination,
					action.agent.content,
					options?.project ?? false,
					action.operation === "create",
				);
				out.push(action);
			} else if (action.type === "command" && action.command && action.destination && action.name) {
				await writeCommandFileNoFollow(
					action.destination,
					action.command.content,
					action.name,
					options?.project ?? false,
					action.operation === "create",
				);
				out.push(action);
			} else {
				out.push(action);
			}
		} catch (error) {
			if (
				(action.type === "command" || action.type === "agent") &&
				action.operation === "create" &&
				(error as NodeJS.ErrnoException).code === "EEXIST"
			) {
				out.push({
					...action,
					operation: "skip",
					status: "skipped_exists",
					reason: "destination appeared after planning; refusing to overwrite it",
				});
				continue;
			}
			out.push({
				...action,
				operation: "fail",
				status: "failed_io",
				reason: `write failed: ${(error as Error).message}`,
			});
		}
	}
	return out;
}
