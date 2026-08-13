/** Durable, cross-process-safe master-session identity registry. */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { withFileLock } from "../config/file-lock";
import { isCanonicalSessionId } from "../sdk/broker/lifecycle";

export const MASTER_REGISTRY_VERSION = 1;
const MASTER_KNOWN_IDS_LIMIT = 32;

interface MasterProjectRecord {
	current: string;
	known: string[];
}

interface MasterRegistryDocument {
	version: typeof MASTER_REGISTRY_VERSION;
	projects: Record<string, MasterProjectRecord>;
}

export type MasterResumeResolution =
	| { ok: true; sessionId: string }
	| { ok: false; reason: "no_master_session" | "not_a_master_session"; message: string };

export function masterRegistryPath(agentDir: string): string {
	return path.join(agentDir, "master", "sessions.json");
}

async function canonicalProject(cwd: string): Promise<string> {
	try {
		return await fs.realpath(cwd);
	} catch {
		return path.resolve(cwd);
	}
}

function emptyRegistry(): MasterRegistryDocument {
	return { version: MASTER_REGISTRY_VERSION, projects: {} };
}

function parseRegistry(value: unknown): MasterRegistryDocument | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const root = value as Record<string, unknown>;
	if (root.version !== MASTER_REGISTRY_VERSION) return undefined;
	if (typeof root.projects !== "object" || root.projects === null || Array.isArray(root.projects)) return undefined;
	const projects: Record<string, MasterProjectRecord> = {};
	for (const [cwd, raw] of Object.entries(root.projects as Record<string, unknown>)) {
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
		const record = raw as Record<string, unknown>;
		if (!isCanonicalSessionId(String(record.current ?? "")) || !Array.isArray(record.known)) return undefined;
		const known = record.known.filter((id): id is string => typeof id === "string" && isCanonicalSessionId(id));
		if (known.length !== record.known.length || !known.includes(record.current as string)) return undefined;
		projects[cwd] = {
			current: record.current as string,
			known: [...new Set(known)].slice(0, MASTER_KNOWN_IDS_LIMIT),
		};
	}
	return { version: MASTER_REGISTRY_VERSION, projects };
}

async function readRegistry(file: string): Promise<{ exists: boolean; value?: MasterRegistryDocument }> {
	try {
		const raw = await fs.readFile(file, "utf8");
		return { exists: true, value: parseRegistry(JSON.parse(raw)) };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, value: emptyRegistry() };
		if (error instanceof SyntaxError) return { exists: true };
		throw error;
	}
}

async function writeAtomic(file: string, value: MasterRegistryDocument): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
	const handle = await fs.open(temporary, "wx", 0o600);
	try {
		await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		await fs.rename(temporary, file);
	} catch (error) {
		await fs.rm(temporary, { force: true }).catch(() => {});
		throw error;
	}
	const directory = await fs.open(path.dirname(file), "r");
	try {
		await directory.sync();
	} finally {
		await directory.close();
	}
}

/** Required durable admission. Throws on corruption or publication failure. */
export async function recordMasterSession(agentDir: string, cwd: string, sessionId: string): Promise<void> {
	if (!isCanonicalSessionId(sessionId)) throw new Error("invalid_master_session_id");
	const file = masterRegistryPath(agentDir);
	const project = await canonicalProject(cwd);
	await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	await withFileLock(file, async () => {
		const read = await readRegistry(file);
		if (read.exists && !read.value) throw new Error("master_registry_corrupt");
		const document = read.value ?? emptyRegistry();
		const existing = document.projects[project];
		const known = [sessionId, ...(existing?.known ?? []).filter(id => id !== sessionId)].slice(
			0,
			MASTER_KNOWN_IDS_LIMIT,
		);
		document.projects[project] = { current: sessionId, known };
		await writeAtomic(file, document);
	});
}

export async function resolveMasterResume(
	agentDir: string,
	cwd: string,
	requestedId?: string,
): Promise<MasterResumeResolution> {
	if (requestedId !== undefined && !isCanonicalSessionId(requestedId)) {
		return {
			ok: false,
			reason: "not_a_master_session",
			message: `Session ${requestedId} is not a canonical recorded master session.`,
		};
	}
	const read = await readRegistry(masterRegistryPath(agentDir));
	const document = read.value;
	const project = await canonicalProject(cwd);
	const record = document?.projects[project];
	if (requestedId !== undefined) {
		if (record?.known.includes(requestedId)) return { ok: true, sessionId: requestedId };
		return {
			ok: false,
			reason: "not_a_master_session",
			message: `Session ${requestedId} is not a recorded master session for this project. Master mode refuses to convert an ordinary session; start one with \`gjc master\`.`,
		};
	}
	if (record?.current) return { ok: true, sessionId: record.current };
	return {
		ok: false,
		reason: "no_master_session",
		message: "No master session is recorded for this project. Start one with `gjc master`.",
	};
}
