/**
 * Custom command loader - loads TypeScript command modules using native Bun import.
 *
 * Dependencies (the zod-backed typebox shim and gajae-code) are injected via the
 * CustomCommandAPI to avoid import resolution issues with custom commands loaded from user directories.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
	getAgentDir,
	getAgentProfileAuthority,
	getProjectDir,
	isEnoent,
	logger,
	normalizePathForComparison,
} from "@gajae-code/utils";
import * as zod from "zod/v4";
import { getConfigDirs } from "../../config";
import { execCommand } from "../../exec/exec";
import * as typebox from "../typebox";
import { GreenCommand } from "./bundled/ci-green";
import type {
	CustomCommand,
	CustomCommandAPI,
	CustomCommandFactory,
	CustomCommandSource,
	CustomCommandsLoadResult,
	LoadedCustomCommand,
} from "./types";

/**
 * Load a single command module using native Bun import.
 */
async function loadCommandModule(
	commandPath: string,
	_cwd: string,
	sharedApi: CustomCommandAPI,
): Promise<{ commands: CustomCommand[] | null; error: string | null }> {
	try {
		const module = await import(commandPath);
		const factory = (module.default ?? module) as CustomCommandFactory;

		if (typeof factory !== "function") {
			return { commands: null, error: "Command must export a default function" };
		}

		const result = await factory(sharedApi);
		const commands = Array.isArray(result) ? result : [result];

		// Validate commands
		for (const cmd of commands) {
			if (!cmd.name || typeof cmd.name !== "string") {
				return { commands: null, error: "Command must have a name" };
			}
			if (!cmd.description || typeof cmd.description !== "string") {
				return { commands: null, error: `Command "${cmd.name}" must have a description` };
			}
			if (typeof cmd.execute !== "function") {
				return { commands: null, error: `Command "${cmd.name}" must have an execute function` };
			}
		}

		return { commands, error: null };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { commands: null, error: `Failed to load command: ${message}` };
	}
}

export interface DiscoverCustomCommandsOptions {
	/** Current working directory. Default: getProjectDir() */
	cwd?: string;
	/** Agent config directory. Default: from getAgentDir() */
	agentDir?: string;
	/** Resolver-owned profile classification. */
	profileAuthority?: "default" | "custom";
}

export interface DiscoverCustomCommandsResult {
	/** Paths to command modules */
	paths: Array<{ path: string; source: CustomCommandSource }>;
}

/**
 * Discover custom command modules (TypeScript slash commands).
 * Markdown slash commands are handled by core/slash-commands.ts.
 */
export async function discoverCustomCommands(
	options: DiscoverCustomCommandsOptions = {},
): Promise<DiscoverCustomCommandsResult> {
	const cwd = options.cwd ?? getProjectDir();
	const agentDir = options.agentDir ?? getAgentDir();
	const resolverAuthority = getAgentProfileAuthority();
	const profileAuthority =
		options.profileAuthority ??
		(resolverAuthority === "custom" ||
		(options.agentDir !== undefined &&
			normalizePathForComparison(options.agentDir) !== normalizePathForComparison(getAgentDir()))
			? "custom"
			: resolverAuthority);
	// Custom profiles replace only the user scope. The default profile retains
	// supported legacy roots such as ~/.gemini/commands.
	const scopedUserAgentDir = profileAuthority === "custom" ? agentDir : undefined;
	const paths: Array<{ path: string; source: CustomCommandSource }> = [];
	const seen = new Set<string>();

	const addPath = (commandPath: string, source: CustomCommandSource): void => {
		const resolved = path.resolve(commandPath);
		if (seen.has(resolved)) return;
		seen.add(resolved);
		paths.push({ path: resolved, source });
	};

	const commandDirs: Array<{ path: string; source: CustomCommandSource }> = [];
	if (scopedUserAgentDir) {
		const userCommandsDir = path.join(scopedUserAgentDir, "commands");
		if (fs.existsSync(userCommandsDir)) {
			commandDirs.push({ path: userCommandsDir, source: "user" });
		}
	}

	for (const entry of getConfigDirs("commands", { cwd, existingOnly: true, userAgentDir: scopedUserAgentDir })) {
		const source = entry.level === "user" ? "user" : "project";
		if (!commandDirs.some(d => d.path === entry.path)) {
			commandDirs.push({ path: entry.path, source });
		}
	}

	const indexCandidates = ["index.ts", "index.js", "index.mjs", "index.cjs"];
	for (const { path: commandsDir, source } of commandDirs) {
		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(commandsDir, { withFileTypes: true });
		} catch (error) {
			if (!isEnoent(error)) {
				logger.warn("Failed to read custom commands directory", { path: commandsDir, error: String(error) });
			}
			continue;
		}
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
			const commandDir = path.join(commandsDir, entry.name);

			for (const filename of indexCandidates) {
				const candidate = path.join(commandDir, filename);
				if (fs.existsSync(candidate)) {
					addPath(candidate, source);
					break;
				}
			}
		}
	}

	return { paths };
}

export interface LoadCustomCommandsOptions {
	/** Current working directory. Default: getProjectDir() */
	cwd?: string;
	/** Agent config directory. Default: from getAgentDir() */
	agentDir?: string;
	/** Resolver-owned profile classification. */
	profileAuthority?: "default" | "custom";
}

/**
 * Load bundled commands (shipped with gajae-code).
 */
function loadBundledCommands(sharedApi: CustomCommandAPI): LoadedCustomCommand[] {
	const bundled: LoadedCustomCommand[] = [];

	// Add bundled commands here
	bundled.push({
		path: "bundled:green",
		resolvedPath: "bundled:green",
		command: new GreenCommand(sharedApi),
		source: "bundled",
	});

	return bundled;
}

/**
 * Discover and load custom commands from standard locations.
 */
export async function loadCustomCommands(options: LoadCustomCommandsOptions = {}): Promise<CustomCommandsLoadResult> {
	const cwd = options.cwd ?? getProjectDir();
	const agentDir = options.agentDir ?? getAgentDir();

	const { paths } = await discoverCustomCommands({ cwd, agentDir, profileAuthority: options.profileAuthority });

	const commands: LoadedCustomCommand[] = [];
	const errors: Array<{ path: string; error: string }> = [];
	const seenNames = new Set<string>();

	// Shared API object - all commands get the same instance
	const sharedApi: CustomCommandAPI = {
		cwd,
		exec: (command: string, args: string[], execOptions) =>
			execCommand(command, args, execOptions?.cwd ?? cwd, execOptions),
		typebox,
		zod,
		pi: await import("@gajae-code/coding-agent"),
	};

	// 1. Load bundled commands first (lowest priority - can be overridden)
	for (const loaded of loadBundledCommands(sharedApi)) {
		seenNames.add(loaded.command.name);
		commands.push(loaded);
	}

	// 2. Load user/project commands (can override bundled)
	for (const { path: commandPath, source } of paths) {
		const { commands: loadedCommands, error } = await loadCommandModule(commandPath, cwd, sharedApi);

		if (error) {
			errors.push({ path: commandPath, error });
			continue;
		}

		if (loadedCommands) {
			for (const command of loadedCommands) {
				// Allow overriding bundled commands, but not user/project conflicts
				const existingIdx = commands.findIndex(c => c.command.name === command.name);
				if (existingIdx !== -1) {
					const existing = commands[existingIdx];
					if (existing.source === "bundled") {
						// Override bundled command
						commands.splice(existingIdx, 1);
						seenNames.delete(command.name);
					} else {
						// Conflict between user/project commands
						errors.push({
							path: commandPath,
							error: `Command name "${command.name}" conflicts with existing command`,
						});
						continue;
					}
				}

				seenNames.add(command.name);
				commands.push({
					path: commandPath,
					resolvedPath: path.resolve(commandPath),
					command,
					source,
				});
			}
		}
	}

	return { commands, errors };
}
