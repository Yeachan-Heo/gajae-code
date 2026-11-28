import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SessionManager } from "../src/session/session-manager";

const roots: string[] = [];
const managers: SessionManager[] = [];
const user = (content: string) => ({ role: "user" as const, content, timestamp: 1 });

afterEach(async () => {
	vi.restoreAllMocks();
	for (const manager of managers.splice(0)) await manager.closeStrict().catch(() => undefined);
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fresh() {
	const root = await fs.mkdtemp(path.join(import.meta.dirname, ".tmp-shared-eligibility-"));
	roots.push(root);
	const cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
	const destination = SessionManager.managedDestination(cwd, agentDir);
	const a = SessionManager.create(cwd, destination);
	managers.push(a);
	return { a, destination, file: a.getSessionFile()! };
}

describe("persistent shared mutation eligibility", () => {
	it("keeps ordinary non-shared managed append behavior", async () => {
		const { a, file } = await fresh();
		const id = a.appendCustomEntry("ordinary", { value: 1 });
		a.appendMessage(user("ordinary"));
		await a.ensureOnDisk();
		expect(await fs.readFile(file, "utf8")).toContain(id);
		const next = a.appendThinkingLevelChange("high");
		await a.flush();
		expect(await fs.readFile(file, "utf8")).toContain(next);
		await a.closeStrict();
	});
});
