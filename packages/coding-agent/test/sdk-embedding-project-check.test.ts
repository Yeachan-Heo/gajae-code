import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createEmbeddedAgentSession, isEmbeddedSameDirectory } from "../src/sdk/embedding";
import { SessionManager } from "../src/session/session-manager";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	while (cleanups.length) await cleanups.pop()?.();
});

/** A project reached through a symlink, and a transcript a terminal wrote from that spelling. */
async function workspace() {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-embedding-project-")));
	cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
	const agentDir = path.join(root, "agent");
	const project = path.join(root, "project");
	const linked = path.join(root, "linked-project");
	const other = path.join(root, "other-project");
	await Promise.all([agentDir, project, other].map(directory => fs.mkdir(directory, { recursive: true })));
	await fs.symlink(project, linked);
	const manager = SessionManager.create(linked, SessionManager.managedDestination(linked, agentDir));
	manager.appendMessage({ role: "user", content: [{ type: "text", text: "from the terminal" }], timestamp: 1 });
	await manager.ensureOnDisk();
	await manager.flush();
	const file = manager.getSessionFile();
	if (!file) throw new Error("Missing transcript");
	await manager.close();
	return { agentDir, project, linked, other, file };
}

/** Construction is stubbed: reaching it means the project check admitted the transcript. */
const reached = new Error("reached session construction");
const createSession = async (): Promise<never> => {
	throw reached;
};

test("a transcript recorded under a symlinked spelling of the project opens for the project's real path", async () => {
	const { agentDir, project, linked, file } = await workspace();
	// The terminal recorded the spelling it was started from.
	const header = JSON.parse((await Bun.file(file).text()).split("\n")[0]!) as { cwd: string };
	expect(header.cwd).toBe(linked);
	await expect(
		createEmbeddedAgentSession({ cwd: project, agentDir, storage: { managed: true, file }, createSession }),
	).rejects.toBe(reached);
	// And the other way round: the real path recorded, the symlink asked for.
	await expect(
		createEmbeddedAgentSession({ cwd: linked, agentDir, storage: { managed: true, file }, createSession }),
	).rejects.toBe(reached);
});

test("a transcript of a different directory is still refused, as is one whose recorded directory is gone", async () => {
	const { agentDir, project, other, linked, file } = await workspace();
	await expect(
		createEmbeddedAgentSession({ cwd: other, agentDir, storage: { managed: true, file }, createSession }),
	).rejects.toThrow("Session project does not match catalog");
	// A recorded spelling that no longer resolves never matches the project (the store refuses it
	// even before the project check), so nothing is constructed for it.
	await fs.rm(linked);
	const refused = await createEmbeddedAgentSession({
		cwd: project,
		agentDir,
		storage: { managed: true, file },
		createSession,
	}).then(
		() => undefined,
		(error: unknown) => error,
	);
	expect(refused).toBeInstanceOf(Error);
	expect(refused).not.toBe(reached);
});

test.skipIf(process.platform !== "darwin")(
	"a transcript a terminal recorded as /var/... or /tmp/... opens for the /private/... project",
	async () => {
		for (const base of [os.tmpdir(), "/tmp"]) {
			const root = await fs.realpath(await fs.mkdtemp(path.join(base, "gjc-embedding-private-")));
			cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
			expect(root.startsWith("/private/")).toBe(true);
			const agentDir = path.join(root, "agent");
			const project = path.join(root, "project");
			await Promise.all([agentDir, project].map(directory => fs.mkdir(directory, { recursive: true })));
			// The spelling the terminal records: `getProjectDir()` strips `/private` on macOS.
			const terminalSpelling = project.slice("/private".length);
			const manager = SessionManager.create(
				terminalSpelling,
				SessionManager.managedDestination(terminalSpelling, agentDir),
			);
			manager.appendMessage({ role: "user", content: [{ type: "text", text: "terminal" }], timestamp: 1 });
			await manager.ensureOnDisk();
			await manager.flush();
			const file = manager.getSessionFile();
			if (!file) throw new Error("Missing transcript");
			await manager.close();
			const header = JSON.parse((await Bun.file(file).text()).split("\n")[0]!) as { cwd: string };
			expect(header.cwd).toBe(terminalSpelling);
			await expect(
				createEmbeddedAgentSession({ cwd: project, agentDir, storage: { managed: true, file }, createSession }),
			).rejects.toBe(reached);
		}
	},
);

test("the shared directory test accepts spellings of one directory and nothing else", async () => {
	const { project, linked, other } = await workspace();
	expect(await isEmbeddedSameDirectory(linked, project)).toBe(true);
	expect(await isEmbeddedSameDirectory(`${project}/`, project)).toBe(true);
	expect(await isEmbeddedSameDirectory(other, project)).toBe(false);
	expect(await isEmbeddedSameDirectory(path.join(project, "missing"), path.join(project, "missing"))).toBe(true);
	expect(await isEmbeddedSameDirectory(path.join(project, "missing"), project)).toBe(false);
});
