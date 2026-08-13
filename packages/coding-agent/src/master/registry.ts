/**
 * Durable master-session identity registry.
 *
 * `gjc master` records every master session it creates, keyed by project cwd,
 * so `gjc master --continue` / `--resume <id>` can only ever select a session
 * that was actually created as a master. Ordinary sessions are never promoted
 * into master mode by continuation: a requested id that is not a recorded
 * master, or a bare continue with no recorded master, fails closed.
 */
import * as path from "node:path";

export const MASTER_REGISTRY_VERSION = 1;
const MASTER_KNOWN_IDS_LIMIT = 32;

interface MasterProjectRecord {
	current: string;
	known: string[];
}

interface MasterRegistryDocument {
	version: number;
	projects: Record<string, MasterProjectRecord>;
}

export type MasterResumeResolution =
	| { ok: true; sessionId: string }
	| { ok: false; reason: "no_master_session" | "not_a_master_session"; message: string };

export function masterRegistryPath(agentDir: string): string {
	return path.join(agentDir, "master", "sessions.json");
}

async function readRegistry(registryPath: string): Promise<MasterRegistryDocument> {
	const file = Bun.file(registryPath);
	if (!(await file.exists())) return { version: MASTER_REGISTRY_VERSION, projects: {} };
	let value: unknown;
	try {
		value = await file.json();
	} catch {
		// A corrupt registry must fail closed: no record is ever fabricated.
		return { version: MASTER_REGISTRY_VERSION, projects: {} };
	}
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return { version: MASTER_REGISTRY_VERSION, projects: {} };
	const projects = (value as Record<string, unknown>).projects;
	if (typeof projects !== "object" || projects === null || Array.isArray(projects))
		return { version: MASTER_REGISTRY_VERSION, projects: {} };
	const clean: Record<string, MasterProjectRecord> = {};
	for (const [cwd, record] of Object.entries(projects as Record<string, unknown>)) {
		if (typeof record !== "object" || record === null) continue;
		const current = (record as Record<string, unknown>).current;
		const known = (record as Record<string, unknown>).known;
		if (typeof current !== "string" || !current) continue;
		if (!Array.isArray(known) || known.some(id => typeof id !== "string" || !id)) continue;
		clean[cwd] = { current, known: [...new Set(known as string[])] };
	}
	return { version: MASTER_REGISTRY_VERSION, projects: clean };
}

/** Record a session as a master for the given project cwd. Never throws. */
export async function recordMasterSession(agentDir: string, cwd: string, sessionId: string): Promise<void> {
	if (!sessionId) return;
	const registryPath = masterRegistryPath(agentDir);
	const document = await readRegistry(registryPath);
	const existing = document.projects[cwd];
	const known = [sessionId, ...(existing?.known ?? []).filter(id => id !== sessionId)].slice(
		0,
		MASTER_KNOWN_IDS_LIMIT,
	);
	document.projects[cwd] = { current: sessionId, known };
	await Bun.write(registryPath, `${JSON.stringify(document, null, 2)}\n`);
}

/**
 * Resolve a master continuation. With no requested id, selects the recorded
 * current master for the project. With a requested id, accepts only recorded
 * master ids. Every other shape fails closed with an operator-facing message.
 */
export async function resolveMasterResume(
	agentDir: string,
	cwd: string,
	requestedId?: string,
): Promise<MasterResumeResolution> {
	const document = await readRegistry(masterRegistryPath(agentDir));
	const record = document.projects[cwd];
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
