import { afterEach, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { safeRm } from "../../../scripts/safe-cleanup";
import { collectGcDiskReport, resolveGcDiskPolicy } from "../src/gjc-runtime/gc-runtime";
import { SessionManager } from "../src/session/session-manager";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => safeRm(root, { recursive: true, force: true })));
});

it("disk GC retires the exact stable owner without selecting a newer logical session", async () => {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-task-owner-gc-")));
	roots.push(root);
	const cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "profile");
	await fs.mkdir(cwd);
	await fs.mkdir(agentDir);
	const manager = SessionManager.create(cwd, SessionManager.managedDestination(cwd, agentDir));
	const oldId = manager.getSessionId();
	const owner = await manager.ensureArtifactManager();
	if (!owner) throw new Error("Expected managed owner");
	await manager.saveArtifact("owned payload", "probe");
	const transcript = manager.getSessionFile()!;
	const ownerDir = owner.dir;
	await manager.close();
	const old = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
	await fs.utimes(transcript, old, old);
	const successor = SessionManager.create(cwd, SessionManager.managedDestination(cwd, agentDir));
	await successor.ensureOnDisk();
	const newer = successor.getSessionFile()!;
	await successor.close();
	const options = {
		agentDir,
		env: {
			GJC_CODING_AGENT_DIR: agentDir,
			GJC_HARNESS_ROOT_REGISTRY_DIR: path.join(root, "registry"),
			TMPDIR: path.join(root, "tmp"),
		},
		policy: resolveGcDiskPolicy({ sessions_max_age_days: 30 }),
		prune: true,
	};
	let report = await collectGcDiskReport(options);
	for (let attempt = 0; attempt < 3 && (await Bun.file(transcript).exists()); attempt++) {
		report = await collectGcDiskReport(options);
	}
	const retired = report.surfaces.sessions.records.find(record => record.id === oldId);
	expect({
		record: retired,
		surface: report.surfaces.sessions,
		errors: report.errors,
		transcriptExists: await Bun.file(transcript).exists(),
	}).toEqual(expect.objectContaining({ transcriptExists: false }));
	await expect(fs.lstat(ownerDir)).rejects.toMatchObject({ code: "ENOENT" });
	expect(await Bun.file(newer).exists()).toBe(true);
	expect(report.surfaces.sessions.records.find(record => record.path === newer)?.action).toBe("keep");
});
