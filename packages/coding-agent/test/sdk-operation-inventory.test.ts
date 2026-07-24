import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	pendingReviewErrors,
	scanAcpMethods,
	scanAgentSessionMethods,
	scanSlashCommands,
} from "../scripts/generate-sdk-operation-inventory";
import { ADAPTERS, OPERATIONS } from "../src/sdk/protocol/operation-registry";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const generator = path.join(repoRoot, "packages/coding-agent/scripts/generate-sdk-operation-inventory.ts");
const inventory = path.join(repoRoot, "packages/coding-agent/src/sdk/protocol/operation-inventory.generated.json");
const tempDirs: string[] = [];

function run(args: string[], env?: Record<string, string>) {
	return Bun.spawnSync([process.execPath, generator, ...args], {
		cwd: repoRoot,
		env: { ...process.env, ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
}

function output(result: ReturnType<typeof run>): string {
	return `${result.stdout.toString()}\n${result.stderr.toString()}`;
}

afterEach(async () => {
	for (const directory of tempDirs.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

describe("SDK operation inventory", () => {
	it("has complete typed operation and adapter coverage", () => {
		expect(OPERATIONS.filter(operation => operation.kind === "control")).toHaveLength(52);
		expect(OPERATIONS.filter(operation => operation.kind === "global")).toHaveLength(7);
		expect(OPERATIONS.filter(operation => operation.kind === "query")).toHaveLength(27);
		expect(OPERATIONS.filter(operation => operation.kind === "reverse")).toHaveLength(6);
		for (const operation of OPERATIONS) {
			expect(Object.keys(operation.adapterDispositions).sort()).toEqual([...ADAPTERS].sort());
			expect(operation.testIds.length).toBeGreaterThan(0);
		}
		expect(OPERATIONS.find(operation => operation.id === "G02")?.adapterDispositions).toEqual({
			telegram: "prohibited",
			discord: "prohibited",
			slack: "prohibited",
			mcp: "prohibited",
			acp: "machine_only",
			daemonCli: "machine_only",
		});
		for (const id of ["C39", "C40"])
			expect(OPERATIONS.find(operation => operation.id === id)?.adapterDispositions).toEqual({
				telegram: "prohibited",
				discord: "prohibited",
				slack: "prohibited",
				mcp: "prohibited",
				acp: "provider_only",
				daemonCli: "prohibited",
			});
	});

	it("accepts the committed generated matrix", () => {
		const result = run(["--check"]);
		expect(result.exitCode, output(result)).toBe(0);
	});

	it("locks private AgentSession seams out of the public SDK", async () => {
		const records = (await Bun.file(inventory).json()) as Array<{
			sourceId: string;
			decision: string;
			rationale?: string;
			exclusionMetadata?: { adapterMappings: string; testIds: string };
		}>;

		const expected = new Map([
			[
				"agent_session:runMidRunMaintenanceForTests",
				"test-only maintenance seam, not a user-facing SDK control seam",
			],
			[
				"agent_session:estimateMidRunContextTokensForTests",
				"test-only estimator seam, not a user-facing SDK control seam",
			],
			[
				"agent_session:awaitPendingContextTransformations",
				"internal context-transformation lifecycle barrier, not a user-facing SDK control seam",
			],
		]);
		for (const [sourceId, rationale] of expected) {
			const record = records.find(candidate => candidate.sourceId === sourceId);
			expect(record).toEqual(
				expect.objectContaining({
					sourceId,
					decision: "exclude",
					rationale,
					exclusionMetadata: { adapterMappings: "not_applicable", testIds: "not_applicable" },
				}),
			);
		}
	});

	it("rejects a generated matrix with a dropped row", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-sdk-inventory-"));
		tempDirs.push(directory);
		const copy = path.join(directory, "operation-inventory.generated.json");
		const records: unknown[] = await Bun.file(inventory).json();
		await Bun.write(copy, `${JSON.stringify(records.slice(1), null, "\t")}\n`);
		const result = run(["--check"], { GJC_SDK_OPERATION_INVENTORY: copy });
		expect(result.exitCode, output(result)).toBe(1);
		expect(output(result)).toContain("Unreviewed addition: registry:C01");
	});

	for (const [sourceId, scanner, sourceText] of [
		[
			"slash_command:unreviewed-action",
			scanSlashCommands,
			'const BUILTIN_SLASH_COMMAND_REGISTRY = [\n\t\tname: "unreviewed-action",\n];',
		],
		[
			"agent_session:unreviewedAction",
			scanAgentSessionMethods,
			"export class AgentSession {\n\tunreviewedAction() {}\n}",
		],
		[
			"acp:unreviewed/action",
			scanAcpMethods,
			'switch (method) { case "unreviewed/action": break;\n\t}\n\n\tasync extNotification() {}',
		],
	] as const) {
		it(`discovers and rejects an unclassified ${sourceId} seam`, () => {
			const seams = scanner(sourceText);
			expect(seams).toContain(sourceId);
			expect(pendingReviewErrors(seams.map(sourceId => ({ sourceId })))).toContain(
				`Pending review source seam: ${sourceId}. Add it to SEAM_TO_SDK or LOCKED_EXCLUSIONS.`,
			);
		});
	}

	it("fails closed when the slash-command scanner anchor is absent", () => {
		expect(() => scanSlashCommands('const COMMANDS = [{ name: "goal" }];')).toThrow(
			"SDK operation inventory scanner: required anchor const BUILTIN_SLASH_COMMAND_REGISTRY was not found.",
		);
	});

	it("fails closed when the AgentSession scanner anchor is absent", () => {
		expect(() => scanAgentSessionMethods("class OtherSession {} ")).toThrow(
			"SDK operation inventory scanner: required AgentSession class declaration was not found.",
		);
	});

	it("fails closed when the AgentSession class body is malformed", () => {
		expect(() => scanAgentSessionMethods("class AgentSession extends Base")).toThrow(
			"SDK operation inventory scanner: AgentSession class is missing its opening body delimiter.",
		);
		expect(() => scanAgentSessionMethods("class AgentSession { action() {} ")).toThrow(
			"SDK operation inventory scanner: AgentSession class body is unbalanced.",
		);
	});

	it("classifies explicit AgentSession test seams as non-public authority", async () => {
		const source = await Bun.file(path.join(repoRoot, "packages/coding-agent/src/session/agent-session.ts")).text();
		const sourceIds = scanAgentSessionMethods(source).filter(sourceId => sourceId.endsWith("ForTests"));
		expect(sourceIds).toEqual(
			expect.arrayContaining([
				"agent_session:runMidRunMaintenanceForTests",
				"agent_session:estimateMidRunContextTokensForTests",
				"agent_session:activeMidRunBarrierCountForTests",
				"agent_session:activeMidRunMaintenanceCountForTests",
			]),
		);
		expect(pendingReviewErrors(sourceIds.map(sourceId => ({ sourceId })))).toEqual([]);
	});

	it("discovers AgentSession method declarations independent of modifiers and layout", () => {
		const seams = scanAgentSessionMethods(`
			function decorator(_: unknown, _context: unknown) {}
			class Base { overrideable(): void {} }
			export class AgentSession extends Base {
				constructor() {}
				public publicMethod(): void {}
				protected protectedMethod(): void {}
				private privateMethod(): void {}
				static staticMethod(): void {}
				override overrideable(): void {}
				get accessor(): string { return "value"; }
				set accessor(_value: string) {}
				get accessorForTests(): number { return 1; }
				*generatorMethod(): Generator<string> { yield "value"; }
				@decorator
				decoratedMethod(): void {}
				async
				multilineMethod(
					value: string,
				): Promise<string> { return value; }
			}
		`);
		expect(seams).toEqual([
			"agent_session:constructor",
			"agent_session:publicMethod",
			"agent_session:protectedMethod",
			"agent_session:privateMethod",
			"agent_session:staticMethod",
			"agent_session:overrideable",
			"agent_session:accessorForTests",
			"agent_session:generatorMethod",
			"agent_session:decoratedMethod",
			"agent_session:multilineMethod",
		]);
		expect(seams).not.toContain("agent_session:accessor");
	});

	it("discovers ACP method switch cases independent of formatting", () => {
		const seams = scanAcpMethods(`
			async function extMethod(
				method: string,
			): Promise<void> {
				switch (
					method
				) {
					case
						"formatted/action"
					:
					case \`template/action\`:
						return;
				}
			}
		`);
		expect(seams).toEqual(["acp:formatted/action", "acp:template/action"]);
	});

	it("ignores string, comment, computed-property, and nested-member decoys", () => {
		const seams = scanAgentSessionMethods(`
			class AgentSession {
				@decorator({ label: "})" })
				private async *decoratedPrivate(
					value = "notAMethod() {}",
				): AsyncGenerator<string> {
					yield \`{\${value}}\`;
				}
				["computed"]() {}
				["resetForTests"]() {}
				get ["stateForTests"](): number { return 1; }
				[\`templateMethodForTests\`]() {}
				get [\`templateGetterForTests\`](): number { return 1; }
				set [\`templateSetterForTests\`](_value: number) {}
				[dynamicForTests]() {}
				field = () => ({ text: "notAMethod() {}" });
			}
		`);
		expect(seams).toEqual([
			"agent_session:decoratedPrivate",
			"agent_session:resetForTests",
			"agent_session:stateForTests",
			"agent_session:templateMethodForTests",
			"agent_session:templateGetterForTests",
			"agent_session:templateSetterForTests",
		]);
		expect(pendingReviewErrors(seams.slice(1).map(sourceId => ({ sourceId })))).toEqual([
			"Pending review source seam: agent_session:resetForTests. Add it to SEAM_TO_SDK or LOCKED_EXCLUSIONS.",
			"Pending review source seam: agent_session:stateForTests. Add it to SEAM_TO_SDK or LOCKED_EXCLUSIONS.",
			"Pending review source seam: agent_session:templateMethodForTests. Add it to SEAM_TO_SDK or LOCKED_EXCLUSIONS.",
			"Pending review source seam: agent_session:templateGetterForTests. Add it to SEAM_TO_SDK or LOCKED_EXCLUSIONS.",
			"Pending review source seam: agent_session:templateSetterForTests. Add it to SEAM_TO_SDK or LOCKED_EXCLUSIONS.",
		]);
	});

	it("finds direct and nested ACP method cases without reading strings or interpolated templates", () => {
		const seams = scanAcpMethods(`
			switch (method) {
				case "escaped\\nmethod":
					const decoy = "case \\"ignored\\": {";
					break;
				case \`literal/method\`:
					break;
				case \`dynamic/\${"value"}\`:
					break;
				case "outer": {
					switch (method) { case "nested": break; }
					break;
				}
				// case "comment"
			}
		`);
		expect(seams).toEqual(["acp:escaped\nmethod", "acp:literal/method", "acp:outer", "acp:nested"]);
	});

	it("rejects an unmapped action seam found in a fixture scan root", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-sdk-seam-"));
		tempDirs.push(directory);
		await Bun.write(path.join(directory, "fixture.ts"), 'switch (action) { case "unmapped_action": break; }');
		const result = run(["--check"], { GJC_SDK_SEAM_SCAN_ROOT: directory });
		expect(result.exitCode, output(result)).toBe(1);
		expect(output(result)).toContain("Pending review source seam: controller:fixture.ts:unmapped_action");
	});

	it("contains reviewed non-registry scanner seams", async () => {
		const records: Array<{ sourceKind: string }> = await Bun.file(inventory).json();
		expect(records.filter(record => record.sourceKind === "slash_command").length).toBeGreaterThan(0);
		expect(records.filter(record => record.sourceKind === "agent_session").length).toBeGreaterThan(0);
	});
});
