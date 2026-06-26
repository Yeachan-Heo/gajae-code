import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createHarnessCliEnv, type HarnessCliEnv } from "./harness-control-plane/cli-workspace-env";

/**
 * Process-level (stdio transport) coverage for the unattended control plane.
 *
 * Every other unattended test calls `dispatchRpcCommand` in-process with a
 * hand-built context. This spawns the REAL `gjc --mode rpc` server so it
 * exercises `runRpcMode`'s own wiring that nothing else covers:
 *   - UnattendedSessionControlPlane construction + session attach (rpc-mode.ts ~211-227)
 *   - emitFrame -> stdout JSON serialization
 *   - the stdin JSONL parse loop routing negotiate_unattended / workflow_gate_response
 *     through the shared dispatcher.
 * The spawned CLI still performs normal non-interactive startup, so the test
 * provides an isolated keyless fixture model config instead of depending on
 * developer or CI provider secrets.
 */

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const cliEntry = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");

let workspace: string;
let cliEnv: HarnessCliEnv;
const fixtureModelsYaml = `providers:
  rpc-test:
    auth: none
    api: openai-responses
    baseUrl: http://127.0.0.1:9/v1
    models:
      - id: rpc-test-model
        contextWindow: 100000
        maxTokens: 4096
        cost:
          input: 0
          output: 0
          cacheRead: 0
          cacheWrite: 0
`;

beforeEach(async () => {
	workspace = await mkdtemp(path.join(tmpdir(), "rpc-stdio-ws-"));
	cliEnv = createHarnessCliEnv(repoRoot);
	const agentDir = path.join(workspace, ".gjc", "agent");
	await mkdir(agentDir, { recursive: true });
	await writeFile(path.join(agentDir, "models.yml"), fixtureModelsYaml);
	cliEnv.env.GJC_CODING_AGENT_DIR = agentDir;
});

afterEach(async () => {
	try {
		cliEnv.cleanup();
	} catch {
		// Best-effort temp cleanup; tolerate env-specific node_modules layout
		// (e.g. symlinked node_modules in git worktrees). Irrelevant to CI.
	}
	await rm(workspace, { recursive: true, force: true });
});

interface Frame {
	type?: string;
	command?: string;
	success?: boolean;
	data?: Record<string, unknown>;
	error?: unknown;
	id?: string;
}

/** Spawn the real RPC server, feed command lines on stdin, collect stdout frames. */
async function driveRpcServer(commands: object[]): Promise<{ frames: Frame[]; raw: string; stderr: string }> {
	const proc = Bun.spawn(["bun", cliEntry, "--mode", "rpc"], {
		cwd: workspace,
		env: { ...cliEnv.env, GJC_HARNESS_STATE_ROOT: workspace },
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	const payload = `${commands.map(c => JSON.stringify(c)).join("\n")}\n`;
	proc.stdin.write(payload);
	await proc.stdin.end(); // EOF -> runRpcMode drains buffered commands then exits cleanly
	const [raw, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	await proc.exited;
	const frames = raw
		.trim()
		.split("\n")
		.filter(Boolean)
		.flatMap(line => {
			try {
				return [JSON.parse(line) as Frame];
			} catch {
				return [];
			}
		});
	return { frames, raw, stderr };
}

const validDeclaration = {
	actor: "openclaw/hermes",
	budget: { max_tokens: 100000, max_tool_calls: 50, max_wall_time_ms: 600000, max_cost_usd: 10 },
	scopes: ["prompt", "control", "bash"],
	action_allowlist: ["command.prompt", "command.control", "bash.readonly"],
};

describe("gjc --mode rpc unattended control plane (stdio transport)", () => {
	it("negotiates unattended and routes workflow_gate_response through the real server loop", async () => {
		const { frames, raw, stderr } = await driveRpcServer([
			{ id: "n1", type: "negotiate_unattended", declaration: validDeclaration },
			// Unknown gate id: proves the command reaches the real control plane's
			// resolveGate (broker unknown_gate) rather than the unknown-command path.
			{ id: "w1", type: "workflow_gate_response", gate_id: "wg_x_ralplan_000999", answer: { decision: "approve" } },
			// Fail-closed: incomplete budget must be refused.
			{
				id: "n2",
				type: "negotiate_unattended",
				declaration: { actor: "x", budget: { max_tokens: 1 }, scopes: [], action_allowlist: [] },
			},
		]);

		expect(
			frames.some(f => f.type === "ready"),
			`no ready frame. stderr:\n${stderr}\nraw:\n${raw}`,
		).toBe(true);

		const neg = frames.find(f => f.command === "negotiate_unattended" && f.id === "n1");
		expect(neg, `no negotiate response. raw:\n${raw}`).toBeDefined();
		expect(neg?.success).toBe(true);
		expect((neg?.data as { actor?: string })?.actor).toBe("openclaw/hermes");

		const ans = frames.find(f => f.command === "workflow_gate_response" && f.id === "w1");
		expect(ans, "no workflow_gate_response frame").toBeDefined();
		expect(ans?.success).toBe(false); // unknown gate -> routed to control plane, errored
		expect(JSON.stringify(ans?.error ?? ans?.data)).toMatch(/gate|unknown|resolv/i);

		const badNeg = frames.find(f => f.command === "negotiate_unattended" && f.id === "n2");
		expect(badNeg?.success).toBe(false); // fail-closed incomplete budget
	}, 60_000);

	it("rejects workflow_gate_response before unattended mode is negotiated (fail-closed)", async () => {
		const { frames, raw } = await driveRpcServer([
			{ id: "w0", type: "workflow_gate_response", gate_id: "wg_x_ralplan_000001", answer: { decision: "approve" } },
		]);
		expect(frames.some(f => f.type === "ready")).toBe(true);
		const ans = frames.find(f => f.command === "workflow_gate_response" && f.id === "w0");
		expect(ans, `no response. raw:\n${raw}`).toBeDefined();
		expect(ans?.success).toBe(false);
	}, 60_000);
});
