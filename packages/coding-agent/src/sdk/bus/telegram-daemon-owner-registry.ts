import * as path from "node:path";
import { isProcessIncarnation } from "../broker/process-incarnation";
import { agentDirDigest, telegramDaemonOwnerMarkerPath } from "./daemon-paths";
import type { TelegramDaemonFs } from "./telegram-daemon";

export interface TelegramOwnerMarker {
	version: 1;
	agentDir: string;
	agentDirDigest: string;
	ownerId: string;
	acquisitionId: string;
	pid: number;
	incarnation: string;
	createdAt: number;
	startedAt: number;
}

export function validMarker(value: unknown): value is TelegramOwnerMarker {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const v = value as Record<string, unknown>;
	return (
		v.version === 1 &&
		typeof v.agentDir === "string" &&
		typeof v.agentDirDigest === "string" &&
		typeof v.ownerId === "string" &&
		v.ownerId.length > 0 &&
		typeof v.acquisitionId === "string" &&
		v.acquisitionId.length > 0 &&
		typeof v.pid === "number" &&
		Number.isSafeInteger(v.pid) &&
		v.pid > 0 &&
		typeof v.incarnation === "string" &&
		isProcessIncarnation(v.incarnation) &&
		typeof v.createdAt === "number" &&
		Number.isSafeInteger(v.createdAt) &&
		typeof v.startedAt === "number" &&
		Number.isSafeInteger(v.startedAt)
	);
}

export async function writeTelegramOwnerMarker(
	fsImpl: TelegramDaemonFs,
	agentDir: string,
	marker: TelegramOwnerMarker,
): Promise<void> {
	const file = telegramDaemonOwnerMarkerPath(agentDir, marker.acquisitionId);
	const dir = path.dirname(file);
	await fsImpl.mkdir(dir, { recursive: true, mode: 0o700 });
	await fsImpl.chmod(dir, 0o700).catch(() => undefined);
	const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
	await fsImpl.writeFile(tmp, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
	await fsImpl.chmod(tmp, 0o600).catch(() => undefined);
	await fsImpl.rename(tmp, file);
}

export async function removeTelegramOwnerMarker(
	fsImpl: TelegramDaemonFs,
	agentDir: string,
	acquisitionId: string,
): Promise<void> {
	const file = telegramDaemonOwnerMarkerPath(agentDir, acquisitionId);
	await fsImpl.unlink(file).catch(() => undefined);
	// Best-effort directory cleanup; do not fail if markers remain.
	try {
		const entries = await fsImpl.readdir(path.dirname(file));
		if (entries.length === 0) await fsImpl.unlink(path.dirname(file)).catch(() => undefined);
	} catch {}
}

export async function readTelegramOwnerMarker(
	fsImpl: TelegramDaemonFs,
	agentDir: string,
	acquisitionId: string,
): Promise<TelegramOwnerMarker | undefined> {
	const file = telegramDaemonOwnerMarkerPath(agentDir, acquisitionId);
	try {
		const raw = await fsImpl.readFile(file, "utf8");
		const parsed = JSON.parse(raw) as unknown;
		if (!validMarker(parsed)) return undefined;
		// Digest must match the path's agent dir; otherwise fail closed (foreign).
		if (parsed.agentDirDigest !== agentDirDigest(agentDir)) return undefined;
		if (path.resolve(parsed.agentDir) !== path.resolve(agentDir)) return undefined;
		return parsed;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		return undefined;
	}
}

export interface ListedOwnerMarker {
	acquisitionId: string;
	marker: TelegramOwnerMarker | undefined;
	// undefined marker means malformed/unreadable/foreign-digest-mismatch (fail-closed).
	raw?: string;
}

export async function listTelegramOwnerMarkers(
	fsImpl: TelegramDaemonFs,
	agentDir: string,
): Promise<ListedOwnerMarker[]> {
	const { daemonPaths } = await import("./daemon-paths");
	const dir = daemonPaths(agentDir).ownerRegistry;
	let entries: string[];
	try {
		entries = await fsImpl.readdir(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const out: ListedOwnerMarker[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(".json")) continue;
		const acquisitionId = entry.slice(0, -5);
		const file = path.join(dir, entry);
		try {
			const raw = await fsImpl.readFile(file, "utf8");
			let parsed: unknown;
			try {
				parsed = JSON.parse(raw);
			} catch {
				out.push({ acquisitionId, marker: undefined, raw });
				continue;
			}
			if (!validMarker(parsed)) {
				out.push({ acquisitionId, marker: undefined, raw });
				continue;
			}
			if (parsed.agentDirDigest !== agentDirDigest(agentDir)) {
				out.push({ acquisitionId, marker: undefined, raw });
				continue;
			}
			if (path.resolve(parsed.agentDir) !== path.resolve(agentDir)) {
				out.push({ acquisitionId, marker: undefined, raw });
				continue;
			}
			out.push({ acquisitionId, marker: parsed });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			out.push({ acquisitionId, marker: undefined });
		}
	}
	return out;
}

export async function clearStaleTelegramOwnerMarkers(
	fsImpl: TelegramDaemonFs,
	agentDir: string,
	pidAlive: (pid: number) => boolean,
	pidIncarnation: (pid: number) => string | undefined,
	now: number,
	ttlMs = 86_400_000,
): Promise<number> {
	const markers = await listTelegramOwnerMarkers(fsImpl, agentDir);
	let removed = 0;
	for (const entry of markers) {
		if (!entry.marker) {
			// Malformed markers are not auto-removed here; the reaper counts them as refused.
			// But very old malformed cruft beyond TTL may be removed if its mtime is ancient and pid proves absent.
			// For now fail closed and leave it.
			continue;
		}
		const m = entry.marker;
		const alive = pidAlive(m.pid);
		const currentIncarnation = pidIncarnation(m.pid);
		const pidReused =
			isProcessIncarnation(currentIncarnation) &&
			isProcessIncarnation(m.incarnation) &&
			currentIncarnation !== m.incarnation;
		const isStaleTime = now - m.createdAt > ttlMs;
		if ((!alive || pidReused) && isStaleTime) {
			await removeTelegramOwnerMarker(fsImpl, agentDir, m.acquisitionId);
			removed += 1;
		}
	}
	return removed;
}
