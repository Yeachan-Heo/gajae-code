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
import { isEnoent, parseFrontmatter } from "@gajae-code/utils";
import { readMCPConfigFile, validateServerName } from "../runtime-mcp/config-writer";
import { mapMcpEntry } from "./mcp-mapper";
import { slugify } from "./skill-normalizer";
import type { AdapterResult, MigrateAction, MigrateDestinations, MigrateWarning } from "./types";

export interface PlanInput {
	results: AdapterResult[];
	destinations: MigrateDestinations;
	force: boolean;
}

export interface PlanOutput {
	actions: MigrateAction[];
	warnings: MigrateWarning[];
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

export async function planMigration(input: PlanInput): Promise<PlanOutput> {
	const actions: MigrateAction[] = [];
	const warnings: MigrateWarning[] = [];

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

	return { actions, warnings };
}
