import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { stableValidators } from "../protocol-source/schema-validators.generated";

type JsonObject = Record<string, unknown>;
type Reader = {
	readonly reader: {
		read(): Promise<{ done: boolean; value?: Uint8Array }>;
	};
	readonly decoder: TextDecoder;
	buffer: string;
};

const repoRoot = path.resolve(import.meta.dir, "../../../../..");
const frameTimeoutMs = 30_000;

function isRecord(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readFrame(state: Reader): Promise<JsonObject> {
	const deadline = Date.now() + frameTimeoutMs;
	while (true) {
		const newline = state.buffer.indexOf("\n");
		if (newline >= 0) {
			const line = state.buffer.slice(0, newline).trim();
			state.buffer = state.buffer.slice(newline + 1);
			if (line.length === 0) continue;
			const parsed: unknown = JSON.parse(line);
			if (!isRecord(parsed)) throw new Error(`Expected a JSON object frame, received ${line}`);
			return parsed;
		}
		const remaining = deadline - Date.now();
		if (remaining <= 0) throw new Error("Timed out waiting for an app-server frame.");
		const read = state.reader.read();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error("Timed out waiting for an app-server frame.")), remaining);
		});
		try {
			const chunk = await Promise.race([read, timeout]);
			if (chunk.done) throw new Error("App-server stdout closed before the expected frame.");
			state.buffer += state.decoder.decode(chunk.value, { stream: true });
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	}
}

async function sendFrame(child: Bun.Subprocess<"pipe", "pipe", "pipe">, frame: JsonObject): Promise<void> {
	child.stdin.write(`${JSON.stringify(frame)}\n`);
	await child.stdin.flush();
}

async function sendRequest(
	child: Bun.Subprocess<"pipe", "pipe", "pipe">,
	state: Reader,
	id: number,
	method: string,
	params: JsonObject,
	onFrame: (frame: JsonObject) => Promise<void>,
): Promise<JsonObject> {
	await sendFrame(child, { jsonrpc: "2.0", id, method, params });
	while (true) {
		const frame = await readFrame(state);
		if (frame.id === id) return frame;
		await onFrame(frame);
	}
}

async function runScenario(
	decision: JsonObject | undefined,
	approvalPolicy?: "never" | "on-request",
	mode:
		| "bash"
		| "patchRename"
		| "patchDelete"
		| "editUpdate"
		| "write"
		| "sequenceMixed"
		| "mixedEdit"
		| "astEdit" = "bash",
): Promise<{
	approvalMethod: string | undefined;
	approvalRequestCount: number;
	approvalParams: JsonObject | undefined;
	markerContent: string | undefined;
	patchSourceContent: string | undefined;
	patchDestinationContent: string | undefined;
}> {
	const tempRoot = mkdtempSync(path.join(tmpdir(), "gjc-permission-bridge-e2e-"));
	const agentDir = path.join(tempRoot, "agent");
	const cwd = repoRoot;
	const marker = path.join(tempRoot, "tool-ran.txt");
	const patchSource = path.join(tempRoot, "patch-target.txt");
	const patchDestination = path.join(tempRoot, "patch-target-renamed.txt");
	const provider = path.join(
		repoRoot,
		"packages/coding-agent/src/app-server/__tests__/fixtures/stub-model-provider.ts",
	);
	const command = `printf approved > ${marker}`;
	const toolName = mode === "bash" ? "bash" : mode === "write" ? "write" : mode === "astEdit" ? "ast_edit" : "edit";
	const toolArguments: JsonObject =
		mode === "patchRename"
			? {
					path: patchSource,
					edits: [{ op: "update", rename: patchDestination, diff: "@@ -1 +1 @@\n-before\n+after\n" }],
				}
			: mode === "patchDelete"
				? { path: patchSource, edits: [{ op: "delete" }] }
				: mode === "mixedEdit"
					? {
							path: patchSource,
							edits: [
								{ op: "update", diff: "@@ -1 +1 @@\n-before\n+one\n" },
								{ op: "update", diff: "@@ -1 +1 @@\n-one\n+two\n" },
							],
						}
					: mode === "astEdit"
						? { paths: [patchSource], ops: [{ pat: "before", out: "after" }] }
						: mode === "editUpdate"
							? { path: patchSource, edits: [{ old_text: "before", new_text: "after" }] }
							: mode === "write"
								? { path: patchSource, content: "after\n" }
								: { command };
	const toolSequence =
		mode === "sequenceMixed"
			? [
					{
						name: "edit",
						arguments: { path: patchSource, edits: [{ op: "update", diff: "@@ -1 +1 @@\n-before\n+one\n" }] },
					},
					{
						name: "edit",
						arguments: {
							path: patchSource,
							edits: [
								{ op: "update", diff: "@@ -1 +1 @@\n-one\n+two\n" },
								{ op: "update", diff: "@@ -1 +1 @@\n-two\n+three\n" },
							],
						},
					},
				]
			: undefined;
	if (mode !== "bash") await Bun.write(patchSource, "before\n");
	mkdirSync(agentDir);
	const child = Bun.spawn([process.execPath, "packages/coding-agent/src/cli.ts", "app-server", "--stdio"], {
		cwd: repoRoot,
		env: {
			...process.env,
			GJC_AGENT_DIR: agentDir,
			GJC_CODING_AGENT_DIR: agentDir,
			PI_CODING_AGENT_DIR: agentDir,
			GJC_TEST_MODEL_PROVIDER: provider,
			GJC_TEST_MODEL_PROVIDER_AUTHORITY: "1",
			GJC_TEST_MODEL_TOOL_NAME: toolName,
			GJC_TEST_MODEL_TOOL_ARGS: JSON.stringify(toolArguments),
			GJC_TEST_MODEL_TOOL_COMMAND: command,
			...(toolSequence ? { GJC_TEST_MODEL_TOOL_SEQUENCE: JSON.stringify(toolSequence) } : {}),
			...(mode === "patchRename" || mode === "patchDelete" || mode === "sequenceMixed" || mode === "mixedEdit"
				? { GJC_EDIT_VARIANT: "patch" }
				: mode === "editUpdate"
					? { GJC_EDIT_VARIANT: "replace" }
					: {}),
		},
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	const stderr = new Response(child.stderr).text();
	const state: Reader = {
		reader: child.stdout.getReader() as unknown as Reader["reader"],
		decoder: new TextDecoder(),
		buffer: "",
	};
	let approvalMethod: string | undefined;
	let approvalRequestCount = 0;
	let approvalParams: JsonObject | undefined;
	const onFrame = async (frame: JsonObject): Promise<void> => {
		if (frame.method !== "execCommandApproval" && frame.method !== "applyPatchApproval") return;
		approvalRequestCount++;
		if (approvalRequestCount > 1) throw new Error(`approval request was emitted more than once: ${frame.method}`);
		if (!decision) throw new Error(`approval request was unexpected under approvalPolicy=never: ${frame.method}`);
		approvalMethod = frame.method;
		if (frame.method === "applyPatchApproval") {
			expect(stableValidators.serverRequestParams.applyPatchApproval(frame.params)).toBe(true);
		}
		if (!isRecord(frame.params)) throw new Error(`approval request omitted params: ${frame.method}`);
		approvalParams = frame.params;
		await sendFrame(child, { jsonrpc: "2.0", id: frame.id as string, result: decision });
	};
	try {
		await sendRequest(
			child,
			state,
			1,
			"initialize",
			{
				clientInfo: { name: "permission-bridge-e2e", version: "1.0.0" },
			},
			onFrame,
		);
		await sendFrame(child, { jsonrpc: "2.0", method: "initialized" });
		const threadStart = await sendRequest(
			child,
			state,
			2,
			"thread/start",
			{
				cwd,
				model: "gjc-app-server-stub/gjc-app-server-stub-model",
				allowProviderModelFallback: false,
				experimentalRawEvents: false,
			},
			onFrame,
		);
		if (!isRecord(threadStart.result)) {
			child.kill();
			throw new Error(`thread/start failed: ${JSON.stringify(threadStart)}\nstderr: ${await stderr}`);
		}
		const thread = (threadStart.result as JsonObject).thread;
		expect(isRecord(thread)).toBe(true);
		const threadId = (thread as JsonObject).id;
		expect(typeof threadId).toBe("string");
		const turnStart = await sendRequest(
			child,
			state,
			3,
			"turn/start",
			{
				threadId,
				input: [{ type: "text", text: "run the guarded command", text_elements: [] }],
				...(approvalPolicy === undefined ? {} : { approvalPolicy }),
			},
			onFrame,
		);
		if (!isRecord(turnStart.result)) throw new Error(`turn/start failed: ${JSON.stringify(turnStart)}`);
		let completed = false;
		while (!completed) {
			const frame = await readFrame(state);
			await onFrame(frame);
			if (frame.method === "turn/completed") completed = true;
		}
		await child.stdin.end();
		await child.exited;
		const errorOutput = await stderr;
		if (child.exitCode !== 0) throw new Error(`app-server exited ${child.exitCode}: ${errorOutput}`);
		expect(approvalMethod).toBe(
			decision ? (mode === "bash" ? "execCommandApproval" : "applyPatchApproval") : undefined,
		);
		expect(approvalRequestCount).toBe(decision ? 1 : 0);
		return {
			approvalMethod,
			approvalRequestCount,
			approvalParams,
			markerContent: existsSync(marker) ? readFileSync(marker, "utf8") : undefined,
			patchSourceContent: existsSync(patchSource) ? readFileSync(patchSource, "utf8") : undefined,
			patchDestinationContent: existsSync(patchDestination) ? readFileSync(patchDestination, "utf8") : undefined,
		};
	} finally {
		if (child.exitCode === null) child.kill();
		rmSync(tempRoot, { recursive: true, force: true });
	}
}

test("real guarded child tool routes approval to the subscribed app-server client", async () => {
	const approved = await runScenario({ decision: "approved" });
	expect(approved.markerContent).toBe("approved");

	const denied = await runScenario({ decision: { denied: { rejection: "not allowed" } } });
	expect(denied.markerContent).toBeUndefined();

	const never = await runScenario(undefined, "never");
	expect(never.markerContent).toBe("approved");
}, 120_000);

test("real patch-mode edit routes a schema-shaped applyPatchApproval exactly once", async () => {
	const approved = await runScenario({ decision: "approved" }, undefined, "patchRename");
	expect(approved.approvalMethod).toBe("applyPatchApproval");
	expect(approved.approvalRequestCount).toBe(1);
	expect(approved.patchSourceContent).toBeUndefined();
	expect(approved.patchDestinationContent).toBe("after\n");
	const approvedFileChanges = approved.approvalParams?.fileChanges;
	expect(isRecord(approvedFileChanges)).toBe(true);
	if (!isRecord(approvedFileChanges)) return;
	const approvedChange = Object.values(approvedFileChanges)[0];
	expect(isRecord(approvedChange)).toBe(true);
	if (!isRecord(approvedChange)) return;
	expect(approvedChange.type).toBe("update");
	expect(approvedChange.unified_diff).toEqual(expect.stringContaining("+1|after"));
	expect(approvedChange.move_path).toEqual(expect.stringContaining("patch-target-renamed.txt"));

	const denied = await runScenario({ decision: { denied: { rejection: "not allowed" } } }, undefined, "patchRename");
	expect(denied.approvalMethod).toBe("applyPatchApproval");
	expect(denied.approvalRequestCount).toBe(1);
	expect(denied.patchSourceContent).toBe("before\n");
	expect(denied.patchDestinationContent).toBeUndefined();
}, 120_000);

test("real patch-mode delete routes a schema-shaped applyPatchApproval with the preimage", async () => {
	for (const approvalPolicy of [undefined, "on-request"] as const) {
		const label = `${approvalPolicy ?? "default"}:patchDelete`;
		const approved = await runScenario({ decision: "approved" }, approvalPolicy, "patchDelete");
		expect(approved.approvalMethod, label).toBe("applyPatchApproval");
		expect(approved.approvalRequestCount, label).toBe(1);
		expect(approved.patchSourceContent, label).toBeUndefined();
		const approvedFileChanges = approved.approvalParams?.fileChanges;
		expect(isRecord(approvedFileChanges), label).toBe(true);
		if (!isRecord(approvedFileChanges)) continue;
		const approvedChange = Object.values(approvedFileChanges)[0];
		expect(isRecord(approvedChange), label).toBe(true);
		if (!isRecord(approvedChange)) continue;
		expect(approvedChange.type, label).toBe("delete");
		expect(approvedChange.content, label).toBe("before\n");

		const denied = await runScenario(
			{ decision: { denied: { rejection: "not allowed" } } },
			approvalPolicy,
			"patchDelete",
		);
		expect(denied.approvalMethod, label).toBe("applyPatchApproval");
		expect(denied.approvalRequestCount, label).toBe(1);
		expect(denied.patchSourceContent, label).toBe("before\n");
	}
}, 180_000);

test("real ordinary edit and write mutations require applyPatchApproval and honor approve or deny", async () => {
	for (const approvalPolicy of [undefined, "on-request"] as const) {
		for (const mode of ["editUpdate", "write"] as const) {
			const label = `${approvalPolicy ?? "default"}:${mode}`;
			const approved = await runScenario({ decision: "approved" }, approvalPolicy, mode);
			expect(approved.approvalMethod, label).toBe("applyPatchApproval");
			expect(approved.approvalRequestCount, label).toBe(1);
			expect(approved.patchSourceContent, label).toBe("after\n");
			expect(approved.patchDestinationContent, label).toBeUndefined();
			const approvedFileChanges = approved.approvalParams?.fileChanges;
			expect(isRecord(approvedFileChanges), label).toBe(true);
			if (!isRecord(approvedFileChanges)) continue;
			const approvedChange = Object.values(approvedFileChanges)[0];
			expect(isRecord(approvedChange), label).toBe(true);
			if (!isRecord(approvedChange)) continue;
			expect(approvedChange.type, label).toBe("update");
			expect(approvedChange.unified_diff, label).toEqual(expect.stringContaining("+1|after"));
			expect(approvedChange.move_path, label).toBeNull();

			const denied = await runScenario({ decision: { denied: { rejection: "not allowed" } } }, approvalPolicy, mode);
			expect(denied.approvalMethod, label).toBe("applyPatchApproval");
			expect(denied.approvalRequestCount, label).toBe(1);
			expect(denied.patchSourceContent, label).toBe("before\n");
			expect(denied.patchDestinationContent, label).toBeUndefined();
		}
	}
}, 180_000);

test("valid edit approval cannot authorize a later mixed edit", async () => {
	const result = await runScenario({ decision: "approved_for_session" }, undefined, "sequenceMixed");
	expect(result.approvalMethod).toBe("applyPatchApproval");
	expect(result.approvalRequestCount).toBe(1);
	expect(result.patchSourceContent).toBe("one\n");
	expect(result.patchDestinationContent).toBeUndefined();
}, 180_000);

test("mixed patch edits fail closed before any entry under every approval policy", async () => {
	for (const approvalPolicy of [undefined, "on-request", "never"] as const) {
		const result = await runScenario(undefined, approvalPolicy, "mixedEdit");
		const label = `${approvalPolicy ?? "default"}:mixedEdit`;
		expect(result.approvalMethod, label).toBeUndefined();
		expect(result.approvalRequestCount, label).toBe(0);
		expect(result.patchSourceContent, label).toBe("before\n");
		expect(result.patchDestinationContent, label).toBeUndefined();
	}
}, 180_000);

test("real child mutation policy matrix remains fail-closed and atomic", async () => {
	const modes = ["editUpdate", "write", "patchDelete", "patchRename", "astEdit", "mixedEdit"] as const;
	const policies = [undefined, "on-request", "never"] as const;
	for (const mode of modes) {
		for (const approvalPolicy of policies) {
			const gated = mode !== "astEdit" && mode !== "mixedEdit";
			const decision = gated && approvalPolicy !== "never" ? { decision: "approved" } : undefined;
			const result = await runScenario(decision, approvalPolicy, mode);
			const label = `${approvalPolicy ?? "default"}:${mode}`;
			const expectedSource =
				mode === "mixedEdit" || mode === "astEdit"
					? "before\n"
					: mode === "patchDelete" || mode === "patchRename"
						? undefined
						: "after\n";
			const expectedDestination = mode === "patchRename" ? "after\n" : undefined;
			console.log(
				`MUTATION_MATRIX ${JSON.stringify({
					policy: approvalPolicy ?? "default",
					mode,
					approvalMethod: result.approvalMethod ?? null,
					approvalRequestCount: result.approvalRequestCount,
					source: result.patchSourceContent ?? null,
					destination: result.patchDestinationContent ?? null,
				})}`,
			);
			expect(result.approvalMethod, label).toBe(
				gated && approvalPolicy !== "never" ? "applyPatchApproval" : undefined,
			);
			expect(result.approvalRequestCount, label).toBe(gated && approvalPolicy !== "never" ? 1 : 0);
			expect(result.patchSourceContent, label).toBe(expectedSource);
			expect(result.patchDestinationContent, label).toBe(expectedDestination);
		}
	}
}, 360_000);
