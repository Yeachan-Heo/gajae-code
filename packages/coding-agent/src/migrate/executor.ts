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
import { upsertMCPServer } from "../runtime-mcp/config-writer";
import type { MigrateAction } from "./types";

async function ensureRealDirectoryPathNoFollow(directory: string): Promise<void> {
	const resolved = path.resolve(directory);
	const parsed = path.parse(resolved);
	let current = parsed.root;
	for (const part of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
		current = path.join(current, part);
		try {
			const stat = await fs.lstat(current);
			if (!stat.isDirectory() || stat.isSymbolicLink()) {
				throw new Error(`skill destination ancestor is not a real directory: ${current}`);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			await fs.mkdir(current);
			const stat = await fs.lstat(current);
			if (!stat.isDirectory() || stat.isSymbolicLink()) {
				throw new Error(`skill destination ancestor is not a real directory: ${current}`);
			}
		}
	}
}

async function writeSkillFileNoFollow(destination: string, content: string): Promise<void> {
	const skillDir = path.dirname(destination);
	await ensureRealDirectoryPathNoFollow(skillDir);
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

export async function executeActions(actions: MigrateAction[]): Promise<MigrateAction[]> {
	const out: MigrateAction[] = [];
	for (const action of actions) {
		if (action.operation !== "create" && action.operation !== "update") {
			out.push(action);
			continue;
		}
		try {
			if (action.type === "mcp" && action.mcp && action.name && action.destination) {
				await upsertMCPServer(action.destination, action.name, action.mcp.config, {
					force: action.operation === "update",
				});
				out.push(action);
			} else if (action.type === "skill" && action.skill && action.destination) {
				await writeSkillFileNoFollow(action.destination, action.skill.content);
				out.push(action);
			} else {
				out.push(action);
			}
		} catch (error) {
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
