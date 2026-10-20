/**
 * Central migration action planner.
 *
 * Reads destination state ONCE and produces an immutable list of actions that
 * both dry-run and live execution consume unchanged. This is the single place
 * that decides add/update/skip/fail, destinations, and warnings, guaranteeing
 * dry-run/live parity.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { FileType, glob } from "@gajae-code/natives";
import { isEnoent, parseFrontmatter } from "@gajae-code/utils";
import { readMCPConfigFile, validateServerName } from "../runtime-mcp/config-writer";
import { PROTECTED_AGENT_NAMES } from "./adapters";
import { isSupportedHookEvent, renderHookModule } from "./hook-module";
import { mapMcpEntry } from "./mcp-mapper";
import { slugify } from "./skill-normalizer";
import type { AdapterResult, ManualAction, MigrateAction, MigrateDestinations, MigrateWarning } from "./types";

export interface PlanInput {
	results: AdapterResult[];
	destinations: MigrateDestinations;
	force: boolean;
}

export interface PlanOutput {
	actions: MigrateAction[];
	warnings: MigrateWarning[];
	manualActions: ManualAction[];
}

interface DestSkillIndex {
	/** slug -> kind of existing destination entry. */
	slugs: Map<string, "dir-with-skill" | "stale-dir" | "occupied">;
	/** effective loaded name -> owning slug. */
	effectiveNames: Map<string, string>;
	/** The skills root exists but is unsafe to write through. */
	rootUnsafe?: boolean;
}

async function indexDestinationSkills(skillsDir: string): Promise<DestSkillIndex> {
	const index: DestSkillIndex = { slugs: new Map(), effectiveNames: new Map() };
	let rootStat: Awaited<ReturnType<typeof fs.lstat>>;
	try {
		rootStat = await fs.lstat(skillsDir);
	} catch (error) {
		if (isEnoent(error)) return index;
		throw error;
	}
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return { ...index, rootUnsafe: true };
	const entries = await fs.readdir(skillsDir, { withFileTypes: true });
	for (const entry of entries) {
		const name = String(entry.name);
		if (!entry.isDirectory() || entry.isSymbolicLink()) {
			index.slugs.set(name, "occupied");
			continue;
		}
		const slug = name;
		const skillFile = path.join(skillsDir, slug, "SKILL.md");
		let content: string | undefined;
		try {
			const skillFileStat = await fs.lstat(skillFile);
			if (!skillFileStat.isFile() || skillFileStat.isSymbolicLink()) {
				index.slugs.set(slug, "occupied");
				continue;
			}
			content = await fs.readFile(skillFile, "utf-8");
		} catch (error) {
			if (isEnoent(error)) {
				index.slugs.set(slug, "stale-dir");
				continue;
			}
			throw error;
		}
		index.slugs.set(slug, "dir-with-skill");
		const { frontmatter } = parseFrontmatter(content, { level: "off" });
		const effective =
			typeof frontmatter.name === "string" && frontmatter.name.trim() ? slugify(frontmatter.name) : slug;
		index.effectiveNames.set(effective, slug);
	}
	return index;
}

interface CommandDestinationInspection {
	destination: string;
	exists: boolean;
	unsafeReason?: string;
}

interface PlannedCommandDestination {
	name: string;
	destination: string;
	segments: string[];
}

function isStrictPathPrefix(prefix: string[], candidate: string[]): boolean {
	return prefix.length < candidate.length && prefix.every((segment, index) => segment === candidate[index]);
}

function commandNameFromDestination(commandsDir: string, destination: string): string {
	return path.relative(commandsDir, destination).replace(/\.md$/, "").split(path.sep).join(":");
}

interface ExistingCommandDestination {
	name: string;
	destination: string;
}

type ExistingCommandNameIndex = Map<string, ExistingCommandDestination[]>;

/**
 * Imported commands are always namespaced under their source. Built-in,
 * extension, and MCP/custom commands are all resolved before file commands, so
 * a bare imported name can be shadowed by any registration the user later
 * enables. The prefix keeps every imported command addressable.
 */
function importedSlashCommandName(source: string, name: string): string {
	return `${source}:${name}`;
}

async function indexExistingCommandNames(commandsDir: string): Promise<ExistingCommandNameIndex> {
	const index: ExistingCommandNameIndex = new Map();
	const root = path.resolve(commandsDir);
	try {
		const rootStat = await fs.lstat(root);
		if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return index;
	} catch (error) {
		if (isEnoent(error)) return index;
		throw error;
	}

	const result = await glob({
		pattern: "**/*.md",
		path: root,
		fileType: FileType.File,
		hidden: false,
		gitignore: true,
	});
	for (const match of result.matches) {
		const matchSegments = match.path.split("/");
		const destination = path.join(root, ...matchSegments);
		const relative = path.relative(root, destination);
		if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;

		let isRegularFile = false;
		try {
			const stat = await fs.lstat(destination);
			isRegularFile = stat.isFile() && !stat.isSymbolicLink();
		} catch (error) {
			if (isEnoent(error)) continue;
			throw error;
		}
		if (!isRegularFile) continue;

		const name = commandNameFromDestination(root, destination);
		const key = name.toLowerCase();
		const destinations = index.get(key) ?? [];
		destinations.push({ name, destination });
		index.set(key, destinations);
	}
	return index;
}

/** Resolve case-equivalent existing paths so command collisions stay portable. */
async function inspectCommandDestination(
	commandsDir: string,
	nameParts: string[],
): Promise<CommandDestinationInspection> {
	const segments = [...nameParts.slice(0, -1), `${nameParts[nameParts.length - 1]}.md`];
	let directory = commandsDir;

	for (let index = 0; index < segments.length; index++) {
		const segment = segments[index]!;
		const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
			if (!isEnoent(error)) throw error;
			return null;
		});
		if (!entries) {
			return { destination: path.join(directory, ...segments.slice(index)), exists: false };
		}

		const matches = entries.filter(entry => entry.name.toLowerCase() === segment.toLowerCase());
		if (matches.length > 1) {
			return {
				destination: path.join(directory, segment),
				exists: false,
				unsafeReason: `multiple case-equivalent destination entries exist for ${segment} in ${directory}`,
			};
		}
		const entry = matches[0];
		if (!entry) return { destination: path.join(directory, ...segments.slice(index)), exists: false };

		const entryPath = path.join(directory, entry.name);
		if (index < segments.length - 1) {
			if (!entry.isDirectory() || entry.isSymbolicLink()) {
				return {
					destination: entryPath,
					exists: false,
					unsafeReason: `command destination ancestor is not a real directory: ${entryPath}`,
				};
			}
			directory = entryPath;
			continue;
		}

		if (!entry.isFile() || entry.isSymbolicLink()) {
			return {
				destination: entryPath,
				exists: false,
				unsafeReason: "destination is not a regular file; refusing to replace it",
			};
		}
		if (!entry.name.endsWith(".md")) {
			return {
				destination: entryPath,
				exists: false,
				unsafeReason: "destination filename must end in lowercase .md for native slash-command discovery",
			};
		}
		return { destination: entryPath, exists: true };
	}

	throw new Error("slash command name has no destination segment");
}

export async function planMigration(input: PlanInput): Promise<PlanOutput> {
	const actions: MigrateAction[] = [];
	const warnings: MigrateWarning[] = [];
	// Settings that cannot be expressed in gjc are reported, never guessed at.
	const manualActions = input.results.flatMap(result => result.manualActions);

	// 1. Source-level diagnostics become `source`-typed actions.
	for (const result of input.results) {
		for (const diag of result.diagnostics) {
			actions.push({
				source: diag.source,
				type: "source",
				operation: diag.status.startsWith("failed") ? "fail" : "skip",
				status: diag.status,
				reason: diag.message,
			});
		}
	}

	// 1b. Hook commands: one generated module per source that has importable events.
	for (const result of input.results) {
		const importable = result.hookCandidates.filter(candidate => isSupportedHookEvent(candidate.event));
		const unsupported = result.hookCandidates.filter(candidate => !isSupportedHookEvent(candidate.event));
		for (const candidate of unsupported) {
			actions.push({
				source: candidate.source,
				type: "hook",
				name: `${candidate.event}`,
				operation: "skip",
				status: "skipped_unmappable",
				reason: `${candidate.event} has no faithful gjc hook event; port this command by hand`,
			});
		}
		const source = importable[0]?.source;
		if (importable.length === 0 || !source) continue;
		const destination = path.join(input.destinations.hooksDir, `migrated-${source}.ts`);
		const content = renderHookModule(source, importable);
		let exists = false;
		let unsafe = false;
		try {
			const stat = await fs.lstat(destination);
			exists = true;
			unsafe = !stat.isFile() || stat.isSymbolicLink();
		} catch (error) {
			if (!isEnoent(error)) {
				actions.push({
					source,
					type: "hook",
					name: path.basename(destination),
					destination,
					operation: "fail",
					status: "failed_io",
					reason: `failed to inspect destination: ${(error as Error).message}`,
				});
				continue;
			}
		}
		if (unsafe) {
			actions.push({
				source,
				type: "hook",
				name: path.basename(destination),
				destination,
				operation: "fail",
				status: "failed_invalid_destination",
				reason: "destination is not a regular file; refusing to replace it",
			});
			continue;
		}
		actions.push({
			source,
			type: "hook",
			name: path.basename(destination),
			destination,
			operation: exists && !input.force ? "skip" : exists ? "update" : "create",
			status: exists && !input.force ? "skipped_exists" : exists ? "updated" : "imported",
			hook: { content },
		});
	}

	// 2. MCP actions — read the destination config once.
	const existingConfig = await readMCPConfigFile(input.destinations.mcpConfigPath).catch(() => null);
	const mcpInvalid = existingConfig === null;
	const existingServers = new Set(Object.keys(existingConfig?.mcpServers ?? {}));
	const disabledServers = new Set(existingConfig?.disabledServers ?? []);

	for (const result of input.results) {
		for (const candidate of result.mcpCandidates) {
			const nameError = validateServerName(candidate.name);
			if (nameError) {
				actions.push({
					source: candidate.source,
					type: "mcp",
					name: candidate.name,
					operation: "fail",
					status: "failed_invalid_source",
					reason: nameError,
				});
				continue;
			}
			const mapped = mapMcpEntry(candidate.source, candidate.name, candidate.raw);
			if (!mapped.ok) {
				actions.push({
					source: candidate.source,
					type: "mcp",
					name: candidate.name,
					operation: mapped.status.startsWith("failed") ? "fail" : "skip",
					status: mapped.status,
					reason: mapped.reason,
				});
				continue;
			}
			for (const w of mapped.warnings)
				warnings.push({ source: candidate.source, type: "mcp", name: candidate.name, message: w });

			if (mcpInvalid) {
				actions.push({
					source: candidate.source,
					type: "mcp",
					name: candidate.name,
					destination: input.destinations.mcpConfigPath,
					operation: "fail",
					status: "failed_invalid_destination",
					reason: "destination mcp.json is malformed",
				});
				continue;
			}

			const exists = existingServers.has(candidate.name);
			if (exists && !input.force) {
				actions.push({
					source: candidate.source,
					type: "mcp",
					name: candidate.name,
					destination: input.destinations.mcpConfigPath,
					operation: "skip",
					status: "skipped_exists",
				});
				continue;
			}
			const actionWarnings = [...mapped.warnings];
			if (exists && disabledServers.has(candidate.name)) {
				const msg = `disabled MCP state preserved for "${candidate.name}"`;
				actionWarnings.push(msg);
				warnings.push({ source: candidate.source, type: "mcp", name: candidate.name, message: msg });
			}
			actions.push({
				source: candidate.source,
				type: "mcp",
				name: candidate.name,
				destination: input.destinations.mcpConfigPath,
				operation: exists ? "update" : "create",
				status: exists ? "updated" : "imported",
				warnings: actionWarnings.length > 0 ? actionWarnings : undefined,
				mcp: { config: mapped.config, force: input.force },
			});
			// Track so an intra-run duplicate of the same name doesn't double-write.
			existingServers.add(candidate.name);
		}
	}

	// 3. Skill actions — index the destination skills tree once.
	const destIndex = await indexDestinationSkills(input.destinations.skillsDir);
	const plannedSlugs = new Map<string, string>(); // slug -> source (intra-run)
	const plannedEffective = new Map<string, string>(); // effective -> slug (intra-run)

	for (const result of input.results) {
		for (const candidate of result.skillCandidates) {
			for (const w of candidate.warnings) {
				warnings.push({ source: candidate.source, type: "skill", name: candidate.slug, message: w });
			}
			const slug = candidate.slug;
			const destination = path.join(input.destinations.skillsDir, slug, "SKILL.md");
			const base = {
				source: candidate.source,
				type: "skill" as const,
				name: slug,
				effectiveName: slug,
				destination,
			};

			// Intra-run duplicate slug / effective name. Since effective name == slug, a
			// duplicate always targets the same destination: skip by default; with --force
			// the later (canonical-order) source overwrites the same destination.
			if (plannedSlugs.has(slug) || plannedEffective.has(slug)) {
				if (input.force) {
					actions.push({
						...base,
						operation: "update",
						status: "updated",
						reason: "duplicate within this run (overwritten under --force)",
						skill: { content: candidate.content },
					});
				} else {
					actions.push({
						...base,
						operation: "skip",
						status: "skipped_exists",
						reason: "duplicate within this run",
					});
				}
				continue;
			}

			const existingKind = destIndex.slugs.get(slug);
			const effectiveOwner = destIndex.effectiveNames.get(slug);

			if (destIndex.rootUnsafe) {
				if (!input.force) {
					actions.push({
						...base,
						operation: "skip",
						status: "skipped_exists",
						reason: "skills destination root is not a real directory",
					});
				} else {
					actions.push({
						...base,
						operation: "fail",
						status: "failed_invalid_destination",
						reason: "skills destination root is not a real directory; refusing to write",
					});
				}
				continue;
			}

			// Effective-name collision with a different existing destination skill.
			if (effectiveOwner && effectiveOwner !== slug) {
				if (!input.force) {
					actions.push({
						...base,
						operation: "skip",
						status: "skipped_exists",
						reason: `effective name collides with "${effectiveOwner}"`,
					});
				} else {
					actions.push({
						...base,
						operation: "fail",
						status: "failed_invalid_destination",
						reason: `effective name collides with "${effectiveOwner}"`,
					});
				}
				continue;
			}

			if (existingKind === "occupied") {
				if (!input.force) {
					actions.push({
						...base,
						operation: "skip",
						status: "skipped_exists",
						reason: "a non-directory or unsafe file occupies the destination path",
					});
				} else {
					actions.push({
						...base,
						operation: "fail",
						status: "failed_invalid_destination",
						reason: "a non-directory or unsafe file occupies the destination path; refusing to delete",
					});
				}
				continue;
			}

			if (existingKind === "dir-with-skill") {
				if (!input.force) {
					actions.push({ ...base, operation: "skip", status: "skipped_exists" });
				} else {
					actions.push({ ...base, operation: "update", status: "updated", skill: { content: candidate.content } });
				}
				plannedSlugs.set(slug, candidate.source);
				plannedEffective.set(slug, slug);
				continue;
			}

			if (existingKind === "stale-dir") {
				if (!input.force) {
					actions.push({ ...base, operation: "skip", status: "skipped_exists", reason: "stale skill directory" });
				} else {
					actions.push({
						...base,
						operation: "update",
						status: "updated",
						reason: "stale skill directory reused",
						skill: { content: candidate.content },
					});
				}
				plannedSlugs.set(slug, candidate.source);
				plannedEffective.set(slug, slug);
				continue;
			}

			// Fresh import.
			actions.push({ ...base, operation: "create", status: "imported", skill: { content: candidate.content } });
			plannedSlugs.set(slug, candidate.source);
			plannedEffective.set(slug, slug);
		}
	}

	// 4. Instructions — all selected sources target the same scoped AGENTS.md.
	const plannedInstructions = new Set<string>();
	for (const result of input.results) {
		for (const candidate of result.instructionCandidates) {
			const destination = input.destinations.instructionsPath;
			const base = { source: candidate.source, type: "instruction" as const, name: candidate.name, destination };
			if (plannedInstructions.has(destination)) {
				actions.push({
					...base,
					operation: "skip",
					status: "skipped_exists",
					reason: "another selected source already targets this file; import one source at a time",
				});
				continue;
			}

			let exists = false;
			try {
				const stat = await fs.lstat(destination);
				exists = true;
				if (!stat.isFile() || stat.isSymbolicLink()) {
					actions.push({
						...base,
						operation: input.force ? "fail" : "skip",
						status: input.force ? "failed_invalid_destination" : "skipped_exists",
						reason: "destination is not a regular file; refusing to replace it",
					});
					plannedInstructions.add(destination);
					continue;
				}
			} catch (error) {
				if (!isEnoent(error)) {
					actions.push({
						...base,
						operation: "fail",
						status: "failed_io",
						reason: `failed to inspect destination: ${(error as Error).message}`,
					});
					plannedInstructions.add(destination);
					continue;
				}
			}

			if (exists && !input.force) {
				actions.push({ ...base, operation: "skip", status: "skipped_exists" });
			} else {
				actions.push({
					...base,
					operation: exists ? "update" : "create",
					status: exists ? "updated" : "imported",
					instruction: { content: candidate.content },
				});
			}
			plannedInstructions.add(destination);
		}
	}

	// 5. Slash commands — command names map to the scoped commands directory.
	let existingCommandNames: ExistingCommandNameIndex = new Map();
	let existingCommandNameIndexError: unknown;
	if (input.results.some(result => result.slashCommandCandidates.length > 0)) {
		try {
			existingCommandNames = await indexExistingCommandNames(input.destinations.commandsDir);
		} catch (error) {
			existingCommandNameIndexError = error;
		}
	}
	const plannedCommands = new Map<string, PlannedCommandDestination>();
	const validCommandNameSegment = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
	for (const result of input.results) {
		for (const candidate of result.slashCommandCandidates) {
			const name = importedSlashCommandName(candidate.source, candidate.name);
			const nameParts = name.split(":");
			if (!nameParts.every(part => validCommandNameSegment.test(part))) {
				actions.push({
					source: candidate.source,
					type: "command",
					name,
					operation: "fail",
					status: "failed_invalid_source",
					reason:
						"slash command name must use letters, numbers, dots, underscores, or hyphens separated by colons",
				});
				continue;
			}

			const requestedDestination = path.join(
				input.destinations.commandsDir,
				...nameParts.slice(0, -1),
				`${nameParts[nameParts.length - 1]}.md`,
			);
			const collisionKey = path.resolve(requestedDestination).toLowerCase();
			const destinationSegments = [...nameParts.slice(0, -1), `${nameParts[nameParts.length - 1]}.md`].map(segment =>
				segment.toLowerCase(),
			);
			const plannedCommand = plannedCommands.get(collisionKey);
			let destination = plannedCommand?.destination ?? requestedDestination;
			let base = { source: candidate.source, type: "command" as const, name, destination };
			if (existingCommandNameIndexError) {
				actions.push({
					...base,
					operation: "fail",
					status: "failed_io",
					reason: `failed to index existing slash commands: ${(existingCommandNameIndexError as Error).message}`,
				});
				continue;
			}
			if (plannedCommand) {
				const sameName = plannedCommand.name === name;
				const collisionReason = sameName
					? "duplicate within this run"
					: `case-insensitive destination collision with "${plannedCommand.name}"`;
				if (input.force) {
					actions.push({
						...base,
						name: plannedCommand.name,
						operation: "update",
						status: "updated",
						reason: `${collisionReason} (overwritten under --force)`,
						command: { content: candidate.content },
					});
				} else {
					actions.push({
						...base,
						operation: "skip",
						status: "skipped_exists",
						reason: collisionReason,
					});
				}
				continue;
			}

			const matchingExistingNames = existingCommandNames.get(name.toLowerCase()) ?? [];
			if (matchingExistingNames.length > 1) {
				const paths = matchingExistingNames.map(existing => existing.destination).join(", ");
				actions.push({
					...base,
					operation: input.force ? "fail" : "skip",
					status: input.force ? "failed_invalid_destination" : "skipped_exists",
					reason: `multiple existing files resolve to /${name}: ${paths}`,
				});
				continue;
			}
			const matchingExistingName = matchingExistingNames[0];
			if (matchingExistingName) {
				const effectiveBase = {
					...base,
					name: matchingExistingName.name,
					destination: matchingExistingName.destination,
				};
				if (input.force) {
					actions.push({
						...effectiveBase,
						operation: "update",
						status: "updated",
						command: { content: candidate.content },
					});
				} else {
					actions.push({
						...effectiveBase,
						operation: "skip",
						status: "skipped_exists",
						reason: `command name already resolves from ${matchingExistingName.destination}`,
					});
				}
				plannedCommands.set(collisionKey, {
					name: matchingExistingName.name,
					destination: matchingExistingName.destination,
					segments: destinationSegments,
				});
				continue;
			}

			const structuralCollision = [...plannedCommands.values()].find(
				planned =>
					isStrictPathPrefix(planned.segments, destinationSegments) ||
					isStrictPathPrefix(destinationSegments, planned.segments),
			);
			if (structuralCollision) {
				actions.push({
					...base,
					operation: input.force ? "fail" : "skip",
					status: input.force ? "failed_invalid_destination" : "skipped_exists",
					reason: `structural destination collision with "${structuralCollision.name}"; a command file cannot also be a directory`,
				});
				plannedCommands.set(collisionKey, { name: candidate.name, destination, segments: destinationSegments });
				continue;
			}

			const destinationDirectories = [path.dirname(input.destinations.commandsDir), input.destinations.commandsDir];
			let commandDirectory = input.destinations.commandsDir;
			for (const segment of nameParts.slice(0, -1)) {
				commandDirectory = path.join(commandDirectory, segment);
				destinationDirectories.push(commandDirectory);
			}
			let unsafeDirectory: string | undefined;
			let directoryReadError: unknown;
			for (const directory of destinationDirectories) {
				try {
					const stat = await fs.lstat(directory);
					if (!stat.isDirectory() || stat.isSymbolicLink()) {
						unsafeDirectory = directory;
						break;
					}
				} catch (error) {
					if (!isEnoent(error)) {
						directoryReadError = error;
						break;
					}
				}
			}
			if (directoryReadError) {
				actions.push({
					...base,
					operation: "fail",
					status: "failed_io",
					reason: `failed to inspect command destination directory: ${(directoryReadError as Error).message}`,
				});
				plannedCommands.set(collisionKey, { name: candidate.name, destination, segments: destinationSegments });
				continue;
			}
			if (unsafeDirectory) {
				actions.push({
					...base,
					operation: input.force ? "fail" : "skip",
					status: input.force ? "failed_invalid_destination" : "skipped_exists",
					reason: `command destination ancestor is not a real directory: ${unsafeDirectory}`,
				});
				plannedCommands.set(collisionKey, { name: candidate.name, destination, segments: destinationSegments });
				continue;
			}

			let inspection: CommandDestinationInspection;
			try {
				inspection = await inspectCommandDestination(input.destinations.commandsDir, nameParts);
			} catch (error) {
				actions.push({
					...base,
					operation: "fail",
					status: "failed_io",
					reason: `failed to inspect command destination: ${(error as Error).message}`,
				});
				plannedCommands.set(collisionKey, { name: candidate.name, destination, segments: destinationSegments });
				continue;
			}
			destination = inspection.destination;
			base = { ...base, destination };
			if (inspection.unsafeReason) {
				actions.push({
					...base,
					operation: input.force ? "fail" : "skip",
					status: input.force ? "failed_invalid_destination" : "skipped_exists",
					reason: inspection.unsafeReason,
				});
				plannedCommands.set(collisionKey, { name: candidate.name, destination, segments: destinationSegments });
				continue;
			}
			const effectiveName = commandNameFromDestination(input.destinations.commandsDir, destination);
			base = { ...base, name: effectiveName };

			if (inspection.exists && !input.force) {
				actions.push({ ...base, operation: "skip", status: "skipped_exists" });
			} else {
				actions.push({
					...base,
					operation: inspection.exists ? "update" : "create",
					status: inspection.exists ? "updated" : "imported",
					command: { content: candidate.content },
				});
			}
			plannedCommands.set(collisionKey, { name: effectiveName, destination, segments: destinationSegments });
		}
	}

	// 6. Subagents — one flat `<name>.md` per agent. An imported agent must never
	// shadow a bundled role, so a colliding name is namespaced under its source.
	const plannedAgents = new Map<string, { name: string; destination: string }>();
	const validAgentName = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
	for (const result of input.results) {
		for (const candidate of result.agentCandidates) {
			const warnings = [...candidate.warnings];
			let name = candidate.name;
			if (PROTECTED_AGENT_NAMES.has(name.toLowerCase())) {
				name = `${candidate.source}-${name}`;
				warnings.push(
					`renamed agent "${candidate.name}" to "${name}" so the bundled ${candidate.name} role stays authoritative`,
				);
			}
			if (!validAgentName.test(name)) {
				actions.push({
					source: candidate.source,
					type: "agent",
					name,
					operation: "fail",
					status: "failed_invalid_source",
					reason: "agent name must use letters, numbers, dots, underscores, or hyphens",
				});
				continue;
			}

			const destination = path.join(input.destinations.agentsDir, `${name}.md`);
			const collisionKey = path.resolve(destination).toLowerCase();
			const base = {
				source: candidate.source,
				type: "agent" as const,
				name,
				destination,
				...(warnings.length > 0 ? { warnings } : {}),
			};
			const planned = plannedAgents.get(collisionKey);
			if (planned) {
				actions.push({
					...base,
					operation: input.force ? "update" : "skip",
					status: input.force ? "updated" : "skipped_exists",
					reason: `duplicate agent destination with "${planned.name}"`,
					...(input.force ? { agent: { content: candidate.content } } : {}),
				});
				continue;
			}

			let exists = false;
			try {
				const stat = await fs.lstat(destination);
				exists = true;
				if (!stat.isFile() || stat.isSymbolicLink()) {
					actions.push({
						...base,
						operation: input.force ? "fail" : "skip",
						status: input.force ? "failed_invalid_destination" : "skipped_exists",
						reason: "destination is not a regular file; refusing to replace it",
					});
					plannedAgents.set(collisionKey, { name, destination });
					continue;
				}
			} catch (error) {
				if (!isEnoent(error)) {
					actions.push({
						...base,
						operation: "fail",
						status: "failed_io",
						reason: `failed to inspect destination: ${(error as Error).message}`,
					});
					plannedAgents.set(collisionKey, { name, destination });
					continue;
				}
			}

			if (exists && !input.force) {
				actions.push({ ...base, operation: "skip", status: "skipped_exists" });
			} else {
				actions.push({
					...base,
					operation: exists ? "update" : "create",
					status: exists ? "updated" : "imported",
					agent: { content: candidate.content },
				});
			}
			plannedAgents.set(collisionKey, { name, destination });
		}
	}

	return { actions, warnings, manualActions };
}
