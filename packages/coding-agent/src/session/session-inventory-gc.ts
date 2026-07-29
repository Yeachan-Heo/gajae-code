import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, getSessionsDir, isEnoent } from "@gajae-code/utils";
import { isSettingsInitialized, Settings } from "../config/settings";
import { getDefault } from "../config/settings-schema";
import type { GcCollectResult, GcContext, GcRecord, GcStoreAdapter } from "../gjc-runtime/gc-runtime";

const STORE = "sessions" as const;
const MAX_ENTRIES = 20_000;
const DAY_MS = 24 * 60 * 60 * 1000;

type InventorySettings = {
	enabled: boolean;
	maxAgeDays: number;
	maxTotalSizeMb: number;
};

function agentDir(env: NodeJS.ProcessEnv): string {
	return env.GJC_CODING_AGENT_DIR?.trim() || env.PI_CODING_AGENT_DIR?.trim() || getAgentDir();
}

function sessionsRoot(env: NodeJS.ProcessEnv): string {
	return getSessionsDir(agentDir(env));
}

async function readSettings(ctx: GcContext): Promise<InventorySettings> {
	const defaults: InventorySettings = {
		enabled: getDefault("sessions.inventory.enabled"),
		maxAgeDays: getDefault("sessions.inventory.maxAgeDays"),
		maxTotalSizeMb: getDefault("sessions.inventory.maxTotalSizeMb"),
	};
	// `gjc gc` does not initialize the singleton. Load a separate instance in
	// that case, then deliberately read only its global layer.
	const settings = isSettingsInitialized()
		? Settings.instance
		: await Settings.loadForScope({ cwd: ctx.cwd, agentDir: agentDir(ctx.env) });
	return {
		enabled: settings.getGlobal("sessions.inventory.enabled") ?? defaults.enabled,
		maxAgeDays: settings.getGlobal("sessions.inventory.maxAgeDays") ?? defaults.maxAgeDays,
		maxTotalSizeMb: settings.getGlobal("sessions.inventory.maxTotalSizeMb") ?? defaults.maxTotalSizeMb,
	};
}

const HEADER_READ_LIMIT = 64 * 1024;

async function treeSize(
	root: string,
): Promise<{ size: number; maxMtimeMs: number; ambiguous: boolean; surplus: boolean }> {
	let size = 0;
	let maxMtimeMs = Number.NEGATIVE_INFINITY;
	let entries = 0;
	const walk = async (entryPath: string): Promise<boolean> => {
		if (++entries > MAX_ENTRIES) return false;
		const stat = await fs.lstat(entryPath);
		maxMtimeMs = Math.max(maxMtimeMs, stat.mtimeMs);
		if (stat.isSymbolicLink()) return false;
		if (stat.isFile()) {
			size += stat.size;
			return true;
		}
		if (!stat.isDirectory()) return false;
		for (const name of await fs.readdir(entryPath)) {
			if (!(await walk(path.join(entryPath, name)))) return false;
		}
		return true;
	};
	try {
		const complete = await walk(root);
		return { size, maxMtimeMs, ambiguous: !complete, surplus: entries > MAX_ENTRIES };
	} catch {
		return { size, maxMtimeMs, ambiguous: true, surplus: false };
	}
}

async function classifyTranscript(input: {
	transcript: string;
	now: number;
	settings: InventorySettings;
	retentionDisabled: boolean;
}): Promise<{ record: GcRecord; surplus: boolean; size?: number; lastActivityMs?: number }> {
	const { transcript, now, settings, retentionDisabled } = input;
	const id = path.basename(transcript, ".jsonl");
	let transcriptStat: Awaited<ReturnType<typeof fs.lstat>>;
	try {
		transcriptStat = await fs.lstat(transcript);
	} catch (error) {
		return {
			record: {
				store: STORE,
				id,
				path: transcript,
				status: "ambiguous",
				stale: false,
				removable: false,
				action: "none",
				reason: (error as Error).message,
			},
			surplus: false,
		};
	}
	if (!transcript.endsWith(".jsonl") || transcriptStat.isSymbolicLink() || !transcriptStat.isFile()) {
		return {
			record: {
				store: STORE,
				id,
				path: transcript,
				status: "ambiguous",
				stale: false,
				removable: false,
				action: "none",
				reason: "Transcript is not a regular .jsonl file",
			},
			surplus: false,
		};
	}

	let headerTimestamp: number;
	try {
		const handle = await fs.open(transcript, "r");
		try {
			const buffer = Buffer.allocUnsafe(HEADER_READ_LIMIT);
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
			const newline = buffer.subarray(0, bytesRead).indexOf(0x0a);
			if (newline === -1) throw new Error(`Session header is missing or exceeds ${HEADER_READ_LIMIT} bytes`);
			const firstLine = buffer.subarray(0, newline).toString("utf8").replace(/\r$/, "");
			const timestamp = JSON.parse(firstLine).timestamp;
			headerTimestamp = typeof timestamp === "string" ? Date.parse(timestamp) : Number.NaN;
			if (!Number.isFinite(headerTimestamp)) throw new Error("Session header timestamp is invalid");
		} finally {
			await handle.close();
		}
	} catch (error) {
		return {
			record: {
				store: STORE,
				id,
				path: transcript,
				status: retentionDisabled ? "retention_disabled" : "unreadable",
				stale: false,
				removable: false,
				action: "none",
				reason: retentionDisabled ? "Session inventory retention is disabled" : (error as Error).message,
			},
			surplus: false,
		};
	}

	const artifactPath = transcript.slice(0, -".jsonl".length);
	let artifactSize = 0;
	let artifactMaxMtimeMs = Number.NEGATIVE_INFINITY;
	let ambiguous = false;
	let surplus = false;
	try {
		const artifactStat = await fs.lstat(artifactPath);
		if (!artifactStat.isDirectory() || artifactStat.isSymbolicLink()) ambiguous = true;
		else {
			const result = await treeSize(artifactPath);
			artifactSize = result.size;
			artifactMaxMtimeMs = result.maxMtimeMs;
			ambiguous = result.ambiguous;
			surplus = result.surplus;
		}
	} catch (error) {
		if (!isEnoent(error)) ambiguous = true;
	}

	const size = transcriptStat.size + artifactSize;
	const age = now - Math.max(headerTimestamp, transcriptStat.mtimeMs, artifactMaxMtimeMs);
	let status: "retention_disabled" | "within_thresholds" | "over_threshold" | "ambiguous" = "within_thresholds";
	let reason = "Within configured inventory thresholds";
	if (retentionDisabled) {
		status = "retention_disabled";
		reason = "Session inventory retention is disabled";
	} else if (ambiguous) {
		status = "ambiguous";
		reason = "Artifact tree is not a fully readable directory tree";
	} else if (age > settings.maxAgeDays * DAY_MS) {
		status = "over_threshold";
		reason = "Exceeds configured inventory threshold";
	}
	return {
		record: {
			store: STORE,
			id,
			path: transcript,
			status,
			stale: status === "over_threshold",
			removable: false,
			action: "none",
			reason,
			detail: `age_ms=${age} size_bytes=${size}`,
		},
		surplus,
		size: ambiguous ? undefined : size,
		lastActivityMs: ambiguous ? undefined : now - age,
	};
}

export const sessionInventoryGcAdapter: GcStoreAdapter = {
	store: STORE,
	async collect(ctx: GcContext): Promise<GcCollectResult> {
		const records: GcRecord[] = [];
		const errors: GcCollectResult["errors"] = [];
		const sizeCandidates: Array<{ record: GcRecord; size: number; lastActivityMs: number }> = [];
		const root = sessionsRoot(ctx.env);
		let settings: InventorySettings;
		let settingsFailed = false;
		try {
			settings = await readSettings(ctx);
		} catch (error) {
			settings = {
				enabled: false,
				maxAgeDays: getDefault("sessions.inventory.maxAgeDays"),
				maxTotalSizeMb: getDefault("sessions.inventory.maxTotalSizeMb"),
			};
			settingsFailed = true;
			errors.push({ store: STORE, scope: STORE, message: (error as Error).message });
		}
		let scopes: string[];
		try {
			scopes = await fs.readdir(root);
		} catch (error) {
			if (isEnoent(error)) return { records, errors };
			errors.push({ store: STORE, scope: root, message: (error as Error).message });
			return { records, errors };
		}
		let seen = 0;
		for (const scope of scopes) {
			if (++seen > MAX_ENTRIES) {
				errors.push({ store: STORE, scope: root, message: `Scan bound exceeded at ${MAX_ENTRIES} entries` });
				break;
			}
			const scopePath = path.join(root, scope);
			try {
				const scopeStat = await fs.lstat(scopePath);
				if (!scopeStat.isDirectory() || scopeStat.isSymbolicLink()) continue;
				for (const name of await fs.readdir(scopePath)) {
					if (++seen > MAX_ENTRIES) {
						errors.push({ store: STORE, scope: root, message: `Scan bound exceeded at ${MAX_ENTRIES} entries` });
						break;
					}
					if (!name.endsWith(".jsonl")) continue;
					const result = await classifyTranscript({
						transcript: path.join(scopePath, name),
						now: Date.now(),
						settings,
						retentionDisabled: settingsFailed || !settings.enabled,
					});
					records.push(result.record);
					if (result.size !== undefined && result.lastActivityMs !== undefined)
						sizeCandidates.push({
							record: result.record,
							size: result.size,
							lastActivityMs: result.lastActivityMs,
						});
					if (result.surplus)
						errors.push({
							store: STORE,
							scope: result.record.path!,
							message: `Scan bound exceeded at ${MAX_ENTRIES} entries`,
						});
				}
			} catch (error) {
				errors.push({ store: STORE, scope: scopePath, message: (error as Error).message });
			}
		}
		if (!settingsFailed && settings.enabled) {
			const ceiling = settings.maxTotalSizeMb * 1024 * 1024;
			const total = sizeCandidates.reduce((sum, candidate) => sum + candidate.size, 0);
			if (total > ceiling) {
				let reclaimed = 0;
				for (const candidate of sizeCandidates.sort((a, b) => a.lastActivityMs - b.lastActivityMs)) {
					candidate.record.status = "over_threshold";
					candidate.record.stale = true;
					candidate.record.reason = "Exceeds configured inventory threshold";
					reclaimed += candidate.size;
					if (reclaimed >= total - ceiling) break;
				}
			}
		}
		return { records, errors };
	},
	async prune() {
		return { removed: false, skipped: "report_only" };
	},
};
