import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { normalizeLegacyState } from "../../src/gjc-runtime/state-migrations";
import { runNativeStateCommand } from "../../src/gjc-runtime/state-runtime";

async function withTempCwd(fn: (cwd: string) => Promise<void>): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-state-migration-"));
	const priorSessionId = process.env.GJC_SESSION_ID;
	delete process.env.GJC_SESSION_ID;
	try {
		await fn(dir);
	} finally {
		if (priorSessionId !== undefined) process.env.GJC_SESSION_ID = priorSessionId;
		await fs.rm(dir, { recursive: true, force: true });
	}
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, JSON.stringify(value, null, 2));
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
	return JSON.parse(await fs.readFile(filePath, "utf-8")) as Record<string, unknown>;
}

async function readAuditEntries(cwd: string): Promise<Array<Record<string, unknown>>> {
	const raw = await fs.readFile(path.join(cwd, ".gjc/state/audit.jsonl"), "utf-8");
	return raw
		.trim()
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line) as Record<string, unknown>);
}

describe("G7 gjc state migration gate", () => {
	it("normalizes legacy state purely and persists migration only through the state command", async () => {
		await withTempCwd(async cwd => {
			const statePath = path.join(cwd, ".gjc/state/ralplan-state.json");
			const legacy = {
				current_phase: "planning",
				extension_field: { nested: true },
				custom_list: ["keep", "me"],
			};
			await writeJson(statePath, legacy);

			const normalized = normalizeLegacyState(legacy, "ralplan");
			expect(normalized.changed).toBe(true);
			expect(normalized.state.current_phase).toBe("planner");
			expect(normalized.state.extension_field).toEqual({ nested: true });
			expect(normalized.state.custom_list).toEqual(["keep", "me"]);
			expect(await readJson(statePath)).toEqual(legacy);

			const result = await runNativeStateCommand(["ralplan", "migrate", "--json"], cwd);
			expect(result.status).toBe(0);

			const persisted = await readJson(statePath);
			expect(persisted.current_phase).toBe("planner");
			expect(persisted.extension_field).toEqual({ nested: true });
			expect(persisted.custom_list).toEqual(["keep", "me"]);
			expect(persisted.receipt).toMatchObject({
				version: 1,
				skill: "ralplan",
				owner: "gjc-state-cli",
				status: "fresh",
			});

			const auditEntry = (await readAuditEntries(cwd)).at(-1);
			expect(auditEntry).toMatchObject({
				skill: "ralplan",
				category: "state",
				verb: "migrate",
				owner: "gjc-state-cli",
			});
		});
	});
});
