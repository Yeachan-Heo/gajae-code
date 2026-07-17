#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import path from "node:path";

const SUPPORTED_VERSION = 1;

type Omission = { path: string; field: string; reason: string };
type PretrainBinaryAudit = {
	baseRef: string;
	commit: string;
	artifactPath: string;
	artifactSha256: string;
	artifactSha256Scope: string;
};
type TransformReport = {
	schemaVersion: 1;
	sourceVersion: number;
	targetVersion: number;
	omissions: Omission[];
	copied: string[];
	pretrainBinary?: PretrainBinaryAudit;
};

function usage(): never {
	throw new Error("Usage: bun scripts/transform-sdk-state-for-rollback.ts --from <state-root> --out <fresh-rollback-dir> --to <version>");
}

function parseArgs(args: string[]): { from: string; out: string; to: number } {
	const values = new Map<string, string>();
	for (let index = 0; index < args.length; index += 2) {
		const flag = args[index];
		const value = args[index + 1];
		if (!flag || !value || !["--from", "--out", "--to"].includes(flag) || values.has(flag)) usage();
		values.set(flag, value);
	}
	const from = values.get("--from");
	const out = values.get("--out");
	const to = Number(values.get("--to"));
	if (!from || !out || !Number.isSafeInteger(to)) usage();
	return { from: path.resolve(from), out: path.resolve(out), to };
}

async function exists(file: string): Promise<boolean> {
	try { await fs.access(file); return true; } catch { return false; }
}

async function validateJson(file: string): Promise<void> {
	const value: unknown = JSON.parse(await fs.readFile(file, "utf8"));
	if (!value || typeof value !== "object") throw new Error(`Invalid SDK state record: ${file}`);
	const version = (value as { version?: unknown; stateVersion?: unknown }).version ?? (value as { stateVersion?: unknown }).stateVersion ?? SUPPORTED_VERSION;
	if (typeof version !== "number" || version !== SUPPORTED_VERSION) throw new Error(`Unsupported source state version in ${file}: ${JSON.stringify(version)}`);
}

async function validateTree(source: string): Promise<void> {
	if (!(await exists(source))) return;
	for await (const entry of new Bun.Glob("**/*").scan({ cwd: source, onlyFiles: true })) {
		const file = path.join(source, entry);
		if (entry.endsWith(".json")) await validateJson(file);
		if (entry.endsWith(".jsonl")) for (const line of (await fs.readFile(file, "utf8")).split("\n")) if (line) await validateJsonText(file, line);
	}
}

async function validateJsonText(file: string, text: string): Promise<void> {
	const value: unknown = JSON.parse(text);
	if (!value || typeof value !== "object") throw new Error(`Invalid SDK state record: ${file}`);
	const version = (value as { version?: unknown; stateVersion?: unknown }).version ?? (value as { stateVersion?: unknown }).stateVersion ?? SUPPORTED_VERSION;
	if (typeof version !== "number" || version !== SUPPORTED_VERSION) throw new Error(`Unsupported source state version in ${file}: ${JSON.stringify(version)}`);
}


type LegacyEndpoint = {
	version: 1;
	sessionId: string;
	pid: number;
	host: string;
	port: number;
	url: string;
	token: string;
	startedAt: number;
	updatedAt: number;
	stale: boolean;
};

function validateLegacyEndpoint(file: string, value: unknown): asserts value is LegacyEndpoint {
	if (!value || typeof value !== "object") throw new Error(`Invalid rollback endpoint schema: ${file}`);
	const endpoint = value as Partial<LegacyEndpoint>;
	if (
		endpoint.version !== 1 ||
		typeof endpoint.sessionId !== "string" ||
		endpoint.sessionId.length === 0 ||
		typeof endpoint.pid !== "number" ||
		!Number.isSafeInteger(endpoint.pid) ||
		endpoint.pid <= 0 ||
		typeof endpoint.host !== "string" ||
		typeof endpoint.port !== "number" ||
		!Number.isSafeInteger(endpoint.port) ||
		endpoint.port < 1 ||
		endpoint.port > 65_535 ||
		typeof endpoint.url !== "string" ||
		typeof endpoint.token !== "string" ||
		endpoint.token.length === 0 ||
		typeof endpoint.startedAt !== "number" ||
		!Number.isFinite(endpoint.startedAt) ||
		typeof endpoint.updatedAt !== "number" ||
		!Number.isFinite(endpoint.updatedAt) ||
		typeof endpoint.stale !== "boolean"
	) {
		throw new Error(`Invalid rollback endpoint schema: ${file}`);
	}
	let url: URL;
	try {
		url = new URL(endpoint.url);
	} catch {
		throw new Error(`Invalid rollback endpoint schema: ${file}`);
	}
	if (url.protocol !== "ws:" || url.hostname !== endpoint.host || Number(url.port) !== endpoint.port) {
		throw new Error(`Invalid rollback endpoint schema: ${file}`);
	}
}

async function copyLegacyEndpoints(source: string, destination: string, copied: string[]): Promise<void> {
	if (!(await exists(source))) throw new Error(`Missing rollback endpoint directory: ${source}`);
	const endpointFiles: string[] = [];
	for await (const entry of new Bun.Glob("*.json").scan({ cwd: source, onlyFiles: true })) endpointFiles.push(entry);
	if (endpointFiles.length === 0) throw new Error(`Missing rollback endpoint records: ${source}`);
	await fs.mkdir(destination, { recursive: true, mode: 0o700 });
	for (const entry of endpointFiles.sort()) {
		const input = path.join(source, entry);
		const endpoint: unknown = JSON.parse(await fs.readFile(input, "utf8"));
		validateLegacyEndpoint(input, endpoint);
		if (path.basename(entry, ".json") !== endpoint.sessionId) {
			throw new Error(`Invalid rollback endpoint path: ${input}`);
		}
		await fs.copyFile(input, path.join(destination, entry));
		copied.push(path.join("state/notifications", entry));
	}
}

async function copyTree(source: string, destination: string, copied: string[], relativeRoot: string): Promise<void> {
	if (!(await exists(source))) return;
	await fs.mkdir(destination, { recursive: true, mode: 0o700 });
	for await (const entry of new Bun.Glob("**/*").scan({ cwd: source, onlyFiles: true })) {
		const input = path.join(source, entry);
		const output = path.join(destination, entry);
		await fs.mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
		await fs.copyFile(input, output);
		copied.push(path.join(relativeRoot, entry));
	}
}

export async function transformSdkStateForRollback({ from, out, to, pretrainBinary }: { from: string; out: string; to: number; pretrainBinary?: PretrainBinaryAudit }): Promise<TransformReport> {
	if (to !== SUPPORTED_VERSION) throw new Error(`Unsupported rollback target version: ${to}`);
	if (await exists(out)) throw new Error(`Rollback output directory must be fresh: ${out}`);
	await validateTree(path.join(from, "sdk"));
	const endpointSource = path.join(from, "state", "sdk");
	const report: TransformReport = { schemaVersion: 1, sourceVersion: SUPPORTED_VERSION, targetVersion: to, omissions: [], copied: [], ...(pretrainBinary ? { pretrainBinary } : {}) };
	await fs.mkdir(out, { recursive: true, mode: 0o700 });
	await copyTree(path.join(from, "sdk"), path.join(out, "sdk"), report.copied, "sdk");
	// Pre-Phase-B readers discover only strict v1 session endpoint records here.
	await copyLegacyEndpoints(endpointSource, path.join(out, "state", "notifications"), report.copied);
	await fs.writeFile(path.join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
	return report;
}

if (import.meta.main) {
	const args = parseArgs(process.argv.slice(2));
	const report = await transformSdkStateForRollback(args);
	process.stdout.write(`${JSON.stringify(report)}\n`);
}
