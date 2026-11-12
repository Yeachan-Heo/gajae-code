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
import {
	ADAPTERS,
	adapterDispositionError,
	findOperation,
	OPERATIONS,
	TURN_RESULT_PROMPT_ALIAS,
	TURN_RESULT_SKILL_ALIAS,
} from "../src/sdk/protocol/operation-registry";

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

function output(result: Bun.SyncSubprocess<"pipe", "pipe">): string {
	return `${result.stdout.toString()}\n${result.stderr.toString()}`;
}

afterEach(async () => {
	for (const directory of tempDirs.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

describe("SDK operation inventory", () => {
	it("has complete typed operation and adapter coverage", () => {
		expect(OPERATIONS.filter(operation => operation.kind === "control")).toHaveLength(83);
		expect(OPERATIONS.filter(operation => operation.kind === "global")).toHaveLength(11);
		expect(OPERATIONS.filter(operation => operation.kind === "query")).toHaveLength(48);
		expect(OPERATIONS.filter(operation => operation.kind === "reverse")).toHaveLength(6);
		expect(findOperation("query", "ask.requests.list")).toMatchObject({
			id: "Q34",
			sdkId: "ask.requests.list",
		});
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
		expect(
			OPERATIONS.find(operation => operation.kind === "global" && operation.sdkId === "session.spawn"),
		).toMatchObject({
			id: "G09",
			description: "Spawn a task-seeded background child session (local interactive master only).",
			adapterDispositions: {
				telegram: "prohibited",
				discord: "prohibited",
				slack: "prohibited",
				mcp: "prohibited",
				acp: "prohibited",
				daemonCli: "prohibited",
			},
		});
		expect(findOperation("global", "session.spawn")).toMatchObject({ id: "G09", sdkId: "session.spawn" });
		expect(findOperation("global", "session.lookup")).toMatchObject({
			id: "G10",
			sdkId: "session.lookup",
			adapterDispositions: {
				telegram: "prohibited",
				discord: "prohibited",
				slack: "prohibited",
				mcp: "prohibited",
				acp: "prohibited",
				daemonCli: "generic_safe",
			},
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

	it("preserves every stable operation identity across sparse registry rows", () => {
		const identities = Object.fromEntries(
			OPERATIONS.map(operation => [operation.id, `${operation.kind}:${operation.sdkId}`]),
		);
		expect(identities).toEqual({
			C01: "control:turn.prompt",
			C02: "control:turn.steer",
			C03: "control:turn.follow_up",
			C04: "control:turn.abort",
			C05: "control:turn.abort_and_prompt",
			C06: "control:ask.answer",
			C07: "control:workflow.gate_answer",
			C08: "control:workflow.plan_approve",
			C09: "control:skill.invoke",
			C10: "control:mode.plan.set",
			C11: "control:mode.goal.operate",
			C12: "control:todo.replace",
			C13: "control:model.set",
			C14: "control:model.cycle",
			C15: "control:thinking.set",
			C16: "control:thinking.cycle",
			C17: "control:permission_mode.set",
			C18: "control:queue.steering_mode.set",
			C19: "control:queue.follow_up_mode.set",
			C20: "control:queue.tool_interrupt_policy.set",
			C21: "control:compaction.run",
			C22: "control:compaction.auto.set",
			C23: "control:retry.auto.set",
			C24: "control:retry.abort",
			C25: "control:bash.execute",
			C26: "control:bash.abort",
			C27: "control:session.new",
			C28: "control:session.fork",
			C29: "control:session.resume",
			C30: "control:session.close",
			C31: "control:session.switch",
			C32: "control:session.branch",
			C33: "control:session.rename",
			C34: "control:session.handoff",
			C35: "control:session.export_html",
			C36: "control:config.patch",
			C37: "control:runtime.reload",
			C38: "control:auth.login",
			C39: "control:host_tools.register",
			C40: "control:host_uri.register",
			C41: "control:service_tier.set",
			C42: "control:tools.active.set",
			C43: "control:queue.message.remove",
			C44: "control:queue.message.move",
			C45: "control:queue.message.update",
			C46: "control:extension.set_enabled",
			C47: "control:context.clear",
			C48: "control:session.delete",
			C49: "control:session.cwd.move",
			C50: "control:retry.last",
			C51: "control:retry.now",
			C52: "control:bash.background",
			C53: "control:model.profile.set",
			C54: "control:turn.image.begin",
			C55: "control:turn.image.append",
			C56: "control:turn.image.finish",
			C57: "control:turn.image.discard",
			C58: "control:permission.channel.set",
			C59: "control:permission.respond",
			C60: "control:btw.ask",
			C61: "control:model.role.set",
			C62: "control:model.select",
			C63: "control:model.profile.select",
			C64: "control:config.write",
			C65: "control:auth.start",
			C66: "control:auth.answer",
			C67: "control:auth.cancel",
			C68: "control:auth.apiKey.store",
			C69: "control:operator.execute",
			C70: "control:operator.cancel",
			C72: "control:activity.cancel",
			C73: "control:activity.pause",
			C74: "control:activity.resume",
			C75: "control:activity.delete",
			C76: "control:activity.acknowledge",
			C77: "control:mcp.suspend",
			C78: "control:mcp.resume",
			C79: "control:mcp.reconnect",
			C80: "control:btw.open",
			C81: "control:btw.submit",
			C82: "control:btw.cancel",
			C83: "control:btw.close",
			C84: "control:session.revise",
			G01: "global:session.list",
			G02: "global:session.get_endpoint",
			G03: "global:session.create",
			G04: "global:session.fork",
			G05: "global:session.resume",
			G06: "global:session.close",
			G07: "global:session.delete",
			G08: "global:session.reconcile_uncertain",
			G09: "global:session.spawn",
			G10: "global:session.lookup",
			G11: "global:session.revise",
			Q01: "query:transcript.list",
			Q02: "query:transcript.body",
			Q03: "query:context.get",
			Q04: "query:goal.list/get",
			Q05: "query:todo.list",
			Q06: "query:diff.list_files",
			Q07: "query:diff.list_hunks",
			Q08: "query:diff.read_hunk",
			Q09: "query:usage.get",
			Q10: "query:models.list/current",
			Q11: "query:skill.list/state",
			Q12: "query:workflow.gates.list",
			Q13: "query:config.list/get",
			Q14: "query:session.metadata",
			Q15: "query:session.stats",
			Q16: "query:session.branch_candidates",
			Q17: "query:session.last_assistant",
			Q18: "query:runtime.capabilities",
			Q19: "query:auth.providers",
			Q20: "query:tools.list",
			Q21: "query:queue.messages.list",
			Q22: "query:extensions.list",
			Q23: "query:resource.body",
			Q24: "query:artifact.read",
			Q25: "query:runtime.jobs.list",
			Q26: "query:turn.result",
			Q27: "query:models.profiles.list",
			Q29: "query:providers.list/active",
			Q30: "query:session.checkpoint",
			Q31: "query:turn.steer_status",
			Q32: "query:session.progress",
			Q33: "query:permission.requests.list",
			Q34: "query:ask.requests.list",
			Q35: "query:model.roles.get",
			Q36: "query:auth.providers.status",
			Q37: "query:auth.status",
			Q38: "query:auth.read",
			Q39: "query:operator.read",
			Q40: "query:activity.snapshot",
			Q41: "query:activity.detail",
			Q42: "query:mcp.snapshot",
			Q43: "query:composer.catalog",
			Q44: "query:composer.complete",
			Q45: "query:session.info",
			Q46: "query:btw.read",
			Q47: "query:diff.scopes",
			Q48: "query:diff.summary",
			Q49: "query:diff.file",
			R01: "reverse:terminal.create/output/release/wait",
			R02: "reverse:filesystem.read/write",
			R03: "reverse:permission.request",
			R04: "reverse:ui.select/confirm/input/editor/open_url",
			R05: "reverse:host_tool.invoke/cancel/update/result",
			R06: "reverse:host_uri.read/write/cancel/result",
		});
		expect(new Set(OPERATIONS.map(operation => operation.id)).size).toBe(OPERATIONS.length);
	});

	it("removes speculative operator background without moving policies or managed bash background", () => {
		expect(findOperation("control", "operator.background")).toBeUndefined();
		expect(OPERATIONS.some(operation => operation.id === "C71")).toBe(false);
		expect(adapterDispositionError("daemonCli", "control", "operator.background")).toMatchObject({
			code: "unknown_operation",
		});
		expect(findOperation("control", "bash.background")).toMatchObject({
			id: "C52",
			idempotency: "fast_lane",
			errorCodes: ["not_foldable", "already_backgrounded", "no_active_bash"],
		});
		for (const id of [
			"C69",
			"C70",
			"C72",
			"C73",
			"C74",
			"C75",
			"C76",
			"C77",
			"C78",
			"C79",
			"C80",
			"C81",
			"C82",
			"C83",
		])
			expect(OPERATIONS.find(operation => operation.id === id)?.adapterDispositions).toEqual({
				telegram: "prohibited",
				discord: "prohibited",
				slack: "prohibited",
				mcp: "prohibited",
				acp: "prohibited",
				daemonCli: "machine_only",
			});
		expect(findOperation("control", "activity.cancel")?.errorCodes).toContain("invalid_owner");
		for (const [id, sdkId] of [
			["C80", "btw.open"],
			["C81", "btw.submit"],
		] as const) {
			const operation = findOperation("control", sdkId);
			expect(operation?.id).toBe(id);
			expect(operation?.errorCodes).toEqual([
				"invalid_input", "resource_gone", "busy", "unknown_effect", "redaction_failed",
			]);
		}
		for (const [id, sdkId] of [
			["C82", "btw.cancel"],
			["C83", "btw.close"],
		] as const) {
			const operation = findOperation("control", sdkId);
			expect(operation?.id).toBe(id);
			expect(operation?.errorCodes).toEqual(["invalid_input", "resource_gone", "busy"]);
		}
		expect(findOperation("control", "session.revise")?.adapterDispositions).toEqual({
			telegram: "prohibited",
			discord: "prohibited",
			slack: "prohibited",
			mcp: "prohibited",
			acp: "prohibited",
			daemonCli: "prohibited",
		});
	});

	it("accepts the committed generated matrix", () => {
		const result = run(["--check"]);
		expect(result.exitCode, output(result)).toBe(0);
	});

	it("keeps the generated Q26 inventory canonical while retaining validated prompt and skill aliases", async () => {
		const records = (await Bun.file(inventory).json()) as Array<{ sourceId: string; sdkId?: string }>;
		expect(records.find(record => record.sourceId === "registry:Q26")).toMatchObject({ sdkId: "turn.result" });
		expect(records.some(record => record.sourceId === "registry:Q28")).toBe(false);
		for (const alias of [TURN_RESULT_PROMPT_ALIAS, TURN_RESULT_SKILL_ALIAS])
			expect(records.some(record => record.sdkId === alias)).toBe(false);
		expect(OPERATIONS.find(operation => operation.id === "Q26")).toMatchObject({
			aliases: [TURN_RESULT_PROMPT_ALIAS, TURN_RESULT_SKILL_ALIAS],
			errorCodes: ["invalid_request", "resource_gone"],
		});
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
				"agent_session:setCredentialPin",
				"interactive session-scoped OAuth account selector mutation behind the locked /credential and OAuth selector surfaces; the public SDK has no credential-selection operation and must not gain credential authority implicitly",
			],
			[
				"agent_session:setCredentialAuto",
				"interactive session-scoped OAuth AUTO-ranking mutation behind the locked /credential and OAuth selector surfaces; the public SDK has no credential-selection operation and must not gain credential authority implicitly",
			],
			[
				"agent_session:runMidRunMaintenanceForTests",
				"test-only maintenance seam, not a user-facing SDK control seam",
			],
			[
				"agent_session:estimateMidRunContextTokensForTests",
				"test-only estimator seam, not a user-facing SDK control seam",
			],
			[
				"agent_session:getActivatedModelProfile",
				"internal model-profile activation provenance used to gate role-only materialization, not a user-facing SDK control seam",
			],
			[
				"agent_session:refreshEffectiveActiveWorkflowSkillState",
				"internal durable workflow identity refresh before session safety checks, not an independent public SDK operation",
			],
			[
				"agent_session:awaitPendingContextTransformations",
				"internal context-transformation lifecycle barrier, not a user-facing SDK control seam",
			],
			[
				"agent_session:awaitSessionSettlement",
				"internal agent-event settlement barrier, not a user-facing SDK control seam",
			],
			[
				"agent_session:waitForAgentEndHandlingForTests",
				"test-only SDK terminal-event handler completion barrier, not a user-facing SDK control seam",
			],
			[
				"agent_session:abortPromptAndWait",
				"internal SDK prompt-terminalization resource fence over a host-captured run handle, not an independent public SDK control seam",
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

	it("locks the interactive extensions dashboard out of the SDK inventory exactly once", async () => {
		const records = (await Bun.file(inventory).json()) as Array<{
			sourceId: string;
			sdkId?: string;
			sourceFile: string;
			sourceKind: string;
			decision: string;
			rationale?: string;
			exclusionMetadata?: { adapterMappings: string; testIds: string };
		}>;
		const extensions = records.filter(record => record.sourceId === "slash_command:extensions");
		expect(extensions).toEqual([
			expect.objectContaining({
				sourceId: "slash_command:extensions",
				sourceFile: "packages/coding-agent/src/slash-commands/builtin-registry.ts",
				sourceKind: "slash_command",
				decision: "exclude",
				rationale:
					"interactive local customization dashboard mutates trusted local skill, hook, and MCP configuration (including filesystem import/removal); ACP and local headless cannot dispatch it, while SDK extension list/enable operations do not expose this dashboard authority",
				exclusionMetadata: { adapterMappings: "not_applicable", testIds: "not_applicable" },
			}),
		]);
		for (const [sourceId, sdkId] of [
			["registry:Q22", "extensions.list"],
			["registry:C46", "extension.set_enabled"],
		]) {
			expect(records).toContainEqual(expect.objectContaining({ sourceId, sdkId, decision: "include" }));
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
				"agent_session:trackCoordinatorRuntimeStatePersistenceFailuresForTests",
				"agent_session:setCoordinatorRuntimeStateFileForTests",
				"agent_session:getCoordinatorRuntimeStateFileForTests",
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
