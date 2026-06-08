import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { RpcClient } from "@gajae-code/coding-agent/modes/rpc/rpc-client";
import type {
	RpcExtensionUIRequest,
	RpcUnattendedDeclaration,
	RpcWorkflowGate,
} from "@gajae-code/coding-agent/modes/rpc/rpc-types";
import { createHarnessCliEnv, type HarnessCliEnv } from "./harness-control-plane/cli-workspace-env";
import { e2eApiKey } from "./utilities";

/**
 * #314/#323 FINAL gap closer: a real model, running unattended over the real
 * spawned `gjc --mode rpc-ui` server, actually calls the ask tool which emits a
 * workflow_gate over RPC; a scripted external "memory" agent answers via
 * workflow_gate_response with zero human input; the turn resumes and completes.
 *
 * Prior coverage proves in-process components (#355) and the spawned stdio
 * transport seam without a model (#391). This is the only test that proves the
 * headline acceptance with a REAL model.
 *
 * CI-safe: the whole describe skips without ANTHROPIC_API_KEY. With a key, ONE
 * overall deadline bounds the entire flow (no stacking sub-waits, no CI hang),
 * and the spawned process is always killed in finally.
 */

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const cliEntry = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");

const OVERALL_DEADLINE_MS = 90_000;
const BUN_TIMEOUT_MS = 120_000;
const SELECTED = "Remember Beta";
const MARKER = "UNATTENDED_GATE_ADVANCED";

const declaration: RpcUnattendedDeclaration = {
	actor: "memory-agent/live-e2e",
	budget: { max_tokens: 12_000, max_tool_calls: 8, max_wall_time_ms: OVERALL_DEADLINE_MS, max_cost_usd: 2 },
	scopes: ["prompt", "control", "message:read"],
	action_allowlist: ["command.prompt", "command.control", "command.message_read"],
};

const ASK_PROMPT = [
	"This is a live unattended lifecycle test. You MUST use the `ask` tool exactly once before any final answer.",
	'Ask ONE single-select multiple-choice clarifying question with id "memory_choice" and EXACTLY these options:',
	'- "Remember Alpha"',
	'- "Remember Beta"',
	'Set the recommended option to "Remember Beta".',
	`After the ask tool returns, reply in ONE concise sentence that includes the exact selected option label and the marker ${MARKER}.`,
	"Do not call any other tool. Do not ask in plain text. Do not finish until the ask tool has returned.",
].join("\n");

const RETRY_PROMPT = `You did not call the ask tool. You MUST call the \`ask\` tool now with one single-select question id "memory_choice" and options "Remember Alpha" / "Remember Beta", then reply with the selected label and ${MARKER}.`;

const HUMAN_UI_METHODS = new Set(["select", "input", "editor", "confirm"]);

describe.skipIf(!e2eApiKey("ANTHROPIC_API_KEY"))("RPC live unattended lifecycle (real model)", () => {
	let workspace: string;
	let cliEnv: HarnessCliEnv;

	beforeEach(async () => {
		workspace = await mkdtemp(path.join(tmpdir(), "rpc-live-e2e-"));
		cliEnv = createHarnessCliEnv(repoRoot);
	});

	afterEach(async () => {
		try {
			cliEnv.cleanup();
		} catch {
			// best-effort temp cleanup (tolerate worktree symlinked node_modules)
		}
		await rm(workspace, { recursive: true, force: true });
	});

	it(
		"a real model emits a workflow_gate over RPC, an external agent answers it, and the turn advances with zero human UI",
		async () => {
			const key = e2eApiKey("ANTHROPIC_API_KEY");
			const client = new RpcClient({
				cliPath: cliEntry,
				cwd: workspace,
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				// Last --mode wins in arg parsing; rpc-ui sets hasUI=true so the ask tool exists.
				args: ["--mode", "rpc-ui"],
				env: { ...cliEnv.env, ANTHROPIC_API_KEY: key as string, GJC_HARNESS_STATE_ROOT: workspace },
			});

			// ONE overall deadline bounds the whole flow; every sub-wait derives from it.
			const deadlineAt = Date.now() + OVERALL_DEADLINE_MS;
			const remainingMs = () => Math.max(0, deadlineAt - Date.now());
			const withDeadline = async <T>(p: Promise<T>, label: string): Promise<T> => {
				let timer: ReturnType<typeof setTimeout> | undefined;
				const guard = new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error(`overall deadline exceeded at: ${label}`)), remainingMs());
				});
				try {
					return await Promise.race([p, guard]);
				} finally {
					if (timer) clearTimeout(timer);
				}
			};

			const gates: RpcWorkflowGate[] = [];
			const uiRequests: RpcExtensionUIRequest[] = [];
			let answered = 0;

			client.onExtensionUiRequest(req => uiRequests.push(req));
			// External "memory" agent: answer every received gate over RPC, zero human input.
			client.onWorkflowGate(gate => {
				gates.push(gate);
				void client
					.respondGate(gate.gate_id, { selected: [SELECTED] }, `ans-${gate.gate_id}`)
					.then(() => {
						answered += 1;
					})
					.catch(() => {
						/* surfaced via diagnostics below */
					});
			});

			const diagnostics = () =>
				[
					`gates=${JSON.stringify(gates.map(g => ({ id: g.gate_id, stage: g.stage, kind: g.kind })))}`,
					`answered=${answered}`,
					`uiRequests=${JSON.stringify(uiRequests.map(r => r.method))}`,
					`stderr=${client.getStderr().slice(-2000)}`,
				].join("\n");

			try {
				await withDeadline(client.start(), "client.start");

				const accepted = await withDeadline(client.negotiateUnattended(declaration), "negotiate_unattended");
				expect(accepted.actor).toBe(declaration.actor);
				expect(accepted.budget).toEqual(declaration.budget);
				expect(accepted.scopes).toEqual(declaration.scopes);
				expect(accepted.action_allowlist).toEqual(declaration.action_allowlist);

				// Turn 1: prompt the model to call ask (emitting a gate).
				await withDeadline(client.promptAndWait(ASK_PROMPT, undefined, remainingMs()), "prompt#1");

				// No-silent-pass: one stricter retry if the model finished without a gate.
				if (gates.length === 0) {
					await withDeadline(client.promptAndWait(RETRY_PROMPT, undefined, remainingMs()), "prompt#retry");
				}
				if (gates.length === 0) {
					throw new Error(`model never emitted a workflow_gate after a retry.\n${diagnostics()}`);
				}

				// (1) a deep-interview question gate was emitted over RPC
				const gate = gates[0];
				expect(gate.stage).toBe("deep-interview");
				expect(gate.kind).toBe("question");
				expect(gate.required).toBe(true);
				expect(gate.options?.map(o => o.value)).toContain(SELECTED);
				expect(answered, `gate not answered.\n${diagnostics()}`).toBeGreaterThanOrEqual(1);

				// (2) ZERO interactive human UI (gate path, not a human prompt)
				const humanUi = uiRequests.filter(r => HUMAN_UI_METHODS.has(r.method));
				expect(humanUi, `unexpected human UI requests.\n${diagnostics()}`).toHaveLength(0);

				// (3) the turn advanced/completed after the answer. Use the model's actual
				// last assistant text (NOT raw events) so the markers prove the model's
				// reply, not the echoed prompt.
				const finalText = (await withDeadline(client.getLastAssistantText(), "get_last_assistant_text")) ?? "";
				expect(finalText, `final assistant text missing markers.\n${diagnostics()}`).toContain(SELECTED);
				expect(finalText).toContain(MARKER);
			} finally {
				// Always kill the spawned process — no orphan, no hang, even on deadline expiry.
				try {
					client.stop();
				} catch {
					/* ignore */
				}
			}
		},
		BUN_TIMEOUT_MS,
	);
});
