import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";

// Phase 0 hard-gate: prove the upstream Claude Code parity oracle is present
// and well-formed. The Monitor / Cron* implementations must mirror the schemas
// declared in these fixtures verbatim. Failures here are a stop-and-return-to-
// planning signal: no implementation may ship against a missing or shallow
// fixture.

const fixturesDir = path.resolve(import.meta.dir, "fixtures", "claude-code-tools");

const requiredFixtures = [
	"monitor.schema.json",
	"cron-create.schema.json",
	"cron-delete.schema.json",
	"cron-list.schema.json",
] as const;

const expectedToolNames: Record<(typeof requiredFixtures)[number], string> = {
	"monitor.schema.json": "Monitor",
	"cron-create.schema.json": "CronCreate",
	"cron-delete.schema.json": "CronDelete",
	"cron-list.schema.json": "CronList",
};

interface ParityFixture {
	captured_at: string;
	claude_version: string;
	capture_command: string;
	tool_name: string;
	description: string;
	input_schema: { type: string; properties: Record<string, unknown> };
	observed_returns: string[];
	notes?: string[];
}

async function loadFixture(name: string): Promise<ParityFixture> {
	const raw = await fs.readFile(path.join(fixturesDir, name), "utf8");
	return JSON.parse(raw) as ParityFixture;
}

describe("claude-code-tools parity fixtures (Phase 0 hard gate)", () => {
	it("has a README documenting provenance", async () => {
		const readme = await fs.readFile(path.join(fixturesDir, "README.md"), "utf8");
		expect(readme).toContain("Required fields");
		expect(readme).toContain("Re-capture procedure");
	});

	for (const fixtureName of requiredFixtures) {
		const expectedToolName = expectedToolNames[fixtureName];

		describe(fixtureName, () => {
			it("exists and is valid JSON", async () => {
				const fixture = await loadFixture(fixtureName);
				expect(fixture).toBeDefined();
			});

			it("has every required metadata field", async () => {
				const fixture = await loadFixture(fixtureName);
				expect(typeof fixture.captured_at).toBe("string");
				expect(fixture.captured_at.length).toBeGreaterThan(0);
				expect(typeof fixture.claude_version).toBe("string");
				expect(fixture.claude_version.length).toBeGreaterThan(0);
				expect(typeof fixture.capture_command).toBe("string");
				expect(fixture.capture_command.length).toBeGreaterThan(0);
				expect(typeof fixture.description).toBe("string");
				expect(fixture.description.length).toBeGreaterThan(0);
				expect(Array.isArray(fixture.observed_returns)).toBe(true);
				expect(fixture.observed_returns.length).toBeGreaterThan(0);
			});

			it(`names the exact upstream tool "${expectedToolName}"`, async () => {
				const fixture = await loadFixture(fixtureName);
				expect(fixture.tool_name).toBe(expectedToolName);
			});

			it("has a non-empty input_schema with an object type", async () => {
				const fixture = await loadFixture(fixtureName);
				expect(fixture.input_schema).toBeDefined();
				expect(fixture.input_schema.type).toBe("object");
				expect(fixture.input_schema.properties).toBeDefined();
				expect(typeof fixture.input_schema.properties).toBe("object");
			});

			it("captured against a recognizable Claude Code version", async () => {
				const fixture = await loadFixture(fixtureName);
				// Format from `claude --version`: e.g. "2.1.152 (Claude Code)"
				expect(fixture.claude_version).toMatch(/\d+\.\d+\.\d+/);
			});

			it("captured at a parseable ISO-8601 timestamp", async () => {
				const fixture = await loadFixture(fixtureName);
				const ms = Date.parse(fixture.captured_at);
				expect(Number.isFinite(ms)).toBe(true);
			});
		});
	}

	describe("Monitor", () => {
		it("requires command, kind, and description as inputs", async () => {
			const fixture = await loadFixture("monitor.schema.json");
			const required = (fixture.input_schema as { required?: string[] }).required ?? [];
			expect(required).toContain("command");
			expect(required).toContain("kind");
			expect(required).toContain("description");
		});

		it("documents that kill reuses the existing background-task stop tool (no MonitorKill sibling)", async () => {
			const fixture = await loadFixture("monitor.schema.json");
			const observed = fixture.observed_returns.join("\n");
			expect(observed).toMatch(/no separate Monitor-side kill tool/i);
		});
	});

	describe("CronCreate", () => {
		it("requires cron_expression, prompt, and recurring", async () => {
			const fixture = await loadFixture("cron-create.schema.json");
			const required = (fixture.input_schema as { required?: string[] }).required ?? [];
			expect(required).toContain("cron_expression");
			expect(required).toContain("prompt");
			expect(required).toContain("recurring");
		});
	});

	describe("CronDelete", () => {
		it("requires id", async () => {
			const fixture = await loadFixture("cron-delete.schema.json");
			const required = (fixture.input_schema as { required?: string[] }).required ?? [];
			expect(required).toContain("id");
		});
	});

	describe("CronList", () => {
		it("takes no input parameters", async () => {
			const fixture = await loadFixture("cron-list.schema.json");
			expect(Object.keys(fixture.input_schema.properties ?? {})).toEqual([]);
		});
	});
});
