import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { runNativeStateCommand } from "@gajae-code/coding-agent/gjc-runtime/state-runtime";

const tempRoots: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(process.cwd(), ".tmp-state-retention-gc-"));
	tempRoots.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

let priorSessionId: string | undefined;
beforeAll(() => {
	priorSessionId = process.env.GJC_SESSION_ID;
	delete process.env.GJC_SESSION_ID;
});
afterAll(() => {
	if (priorSessionId !== undefined) process.env.GJC_SESSION_ID = priorSessionId;
});

async function writeFileWithAge(
	root: string,
	relativePath: string,
	ageDays: number,
	content = "{}\n",
): Promise<string> {
	const filePath = path.join(root, ".gjc", "state", relativePath);
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, content, "utf-8");
	const when = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
	await fs.utimes(filePath, when, when);
	return filePath;
}

async function exists(filePath: string): Promise<boolean> {
	try {
		await fs.stat(filePath);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ENOENT";
	}
}

describe("native gjc state retention gc", () => {
	it("dry-runs and prunes only manifest-retention eligible state files", async () => {
		const root = await tempDir();
		const oldLog = await writeFileWithAge(root, "logs/old.jsonl", 45, '{"old":true}\n');
		const freshLog = await writeFileWithAge(root, "logs/fresh.jsonl", 1, '{"fresh":true}\n');
		const oldReport = await writeFileWithAge(root, "reports/old.json", 45);
		const currentState = await writeFileWithAge(
			root,
			"team-state.json",
			45,
			JSON.stringify({ skill: "team", active: true }),
		);
		const currentSnapshot = await writeFileWithAge(
			root,
			"skill-active-state.json",
			45,
			JSON.stringify({ active: true }),
		);
		const audit = await writeFileWithAge(root, "audit.jsonl", 120, '{"category":"state"}\n');

		const dryRun = await runNativeStateCommand(["gc", "--skill", "team", "--dry-run"], root);
		expect(dryRun.status).toBe(0);
		const dryRunJson = JSON.parse(dryRun.stdout ?? "{}") as {
			dry_run: boolean;
			eligible: string[];
			pruned: string[];
		};
		expect(dryRunJson.dry_run).toBe(true);
		expect(dryRunJson.eligible).toEqual(["logs/old.jsonl", "reports/old.json"]);
		expect(dryRunJson.pruned).toEqual([]);
		expect(await exists(oldLog)).toBe(true);
		expect(await exists(oldReport)).toBe(true);

		const gc = await runNativeStateCommand(["gc", "--skill", "team"], root);
		expect(gc.status).toBe(0);
		const gcJson = JSON.parse(gc.stdout ?? "{}") as { pruned: string[] };
		expect(gcJson.pruned).toEqual(["logs/old.jsonl", "reports/old.json"]);
		expect(await exists(oldLog)).toBe(false);
		expect(await exists(oldReport)).toBe(false);
		expect(await exists(freshLog)).toBe(true);
		expect(await exists(currentState)).toBe(true);
		expect(await exists(currentSnapshot)).toBe(true);
		expect(await exists(audit)).toBe(true);

		const auditLines = (await fs.readFile(path.join(root, ".gjc", "state", "audit.jsonl"), "utf-8"))
			.trim()
			.split(/\r?\n/)
			.map(line => JSON.parse(line) as Record<string, unknown>);
		expect(auditLines.some(entry => entry.category === "prune" && entry.verb === "gc")).toBe(true);
	});
});
