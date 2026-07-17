import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SessionIndex } from "../src/sdk/broker/session-index";
import { listSdkSessionEndpoints, SdkClient } from "../src/sdk/client";
import { listManagedSessionCandidates } from "../src/sdk/session-directory";
import {
	createLifecycleFixture,
	createSharedLifecycleFixture,
	type LifecycleFixture,
	type SharedLifecycleFixture,
} from "./helpers/sdk-lifecycle-fixture";

const cliEntrypoint = path.resolve(import.meta.dir, "../src/cli.ts");
const fixtures: Array<{ cleanup: () => Promise<void> }> = [];

afterEach(async () => {
	await Promise.all(fixtures.splice(0).map(fixture => fixture.cleanup()));
});

async function fixture(): Promise<LifecycleFixture> {
	const value = await createLifecycleFixture();
	fixtures.push(value);
	return value;
}

function result(value: unknown): { ok: boolean; result?: Record<string, unknown>; error?: { code?: string } } {
	if (!value || typeof value !== "object")
		throw new Error(`Expected lifecycle result, received ${JSON.stringify(value)}`);
	return value as { ok: boolean; result?: Record<string, unknown>; error?: { code?: string } };
}

async function mcpGlobal(
	repo: string,
	agentDir: string,
	operation: string,
	input: Record<string, unknown>,
	idempotencyKey: string,
	environment?: NodeJS.ProcessEnv,
) {
	const child = Bun.spawn([process.execPath, "run", cliEntrypoint, "mcp-serve", "sdk"], {
		cwd: repo,
		env: { ...(environment ?? process.env), GJC_CODING_AGENT_DIR: agentDir, GJC_AGENT_DIR: agentDir },
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	child.stdin.write(
		`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "gjc_session_global", arguments: { operation, input, idempotencyKey } } })}\n`,
	);
	await child.stdin.end();
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	expect(exitCode, stderr).toBe(0);
	const response = JSON.parse(stdout.trim()) as { result?: { content?: Array<{ text?: string }> } };
	return result(JSON.parse(response.result?.content?.[0]?.text ?? "null"));
}

async function daemonGlobal(
	repo: string,
	agentDir: string,
	operation: string,
	input: Record<string, unknown>,
	idempotencyKey: string,
	environment?: NodeJS.ProcessEnv,
) {
	const child = Bun.spawn(
		[
			process.execPath,
			"run",
			cliEntrypoint,
			"daemon",
			"session",
			"global",
			"--op",
			operation,
			"--json-input",
			JSON.stringify(input),
			"--idempotency-key",
			idempotencyKey,
		],
		{
			cwd: repo,
			env: { ...(environment ?? process.env), GJC_CODING_AGENT_DIR: agentDir, GJC_AGENT_DIR: agentDir },
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	const output = result(JSON.parse(stdout));
	expect(exitCode, stderr).toBe(output.ok ? 0 : 1);
	expect(stderr).not.toContain("token");
	return output;
}

async function acpGlobal(
	repo: string,
	agentDir: string,
	operation: string,
	input: Record<string, unknown>,
	idempotencyKey: string,
) {
	const child = Bun.spawn([process.execPath, cliEntrypoint, "--mode", "acp"], {
		cwd: repo,
		env: { ...process.env, GJC_CODING_AGENT_DIR: agentDir, GJC_AGENT_DIR: agentDir, PI_NO_TITLE: "1", NO_COLOR: "1" },
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	const stderr = new Response(child.stderr).text();
	const reader = child.stdout.getReader();
	const decoder = new TextDecoder();
	let buffered = "";
	const readFrame = async (): Promise<{
		id?: number;
		result?: unknown;
		error?: { code?: string; message?: string };
	}> => {
		while (true) {
			const newline = buffered.indexOf("\n");
			if (newline >= 0) {
				const line = buffered.slice(0, newline).trim();
				buffered = buffered.slice(newline + 1);
				if (line)
					return JSON.parse(line) as {
						id?: number;
						result?: unknown;
						error?: { code?: string; message?: string };
					};
			}
			const chunk = await reader.read();
			if (chunk.done) throw new Error("ACP stdout closed before response.");
			buffered += decoder.decode(chunk.value, { stream: true });
		}
	};
	child.stdin.write(
		`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } })}\n`,
	);
	child.stdin.flush();
	await readFrame();
	child.stdin.write(
		`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "_gjc/sdk/global", params: { operation, input, idempotencyKey } })}\n`,
	);
	child.stdin.flush();
	const response = await readFrame();
	await child.stdin.end();
	const exitCode = await child.exited;
	const stderrText = await stderr;
	expect(exitCode, stderrText).toBe(0);
	return result(response.result ?? { ok: false, error: response.error ?? { code: "unknown" } });
}

test("shipped ACP rejects raw generic lifecycle ingress in favor of typed session methods", async () => {
	const life = await fixture();
	try {
		await expect(
			acpGlobal(
				life.repo,
				life.agentDir,
				"session.create",
				{ cwd: life.repo, target: { path: life.repo }, stateRoot: life.stateRoot },
				"raw-lifecycle-must-not-reach-broker",
			),
		).resolves.toMatchObject({ ok: false, error: { code: "operation_prohibited" } });
	} finally {
		await life.cleanup();
	}
}, 120_000);

test("shipped mcp-serve sdk stdio drives authenticated G03-G07 lifecycle topology with durable effects", async () => {
	const life = await fixture();
	await life.invokeScenario((operation, input, idempotencyKey) =>
		mcpGlobal(life.repo, life.agentDir, operation, input, idempotencyKey),
	);
}, 120_000);

test("shipped daemon session CLI drives authenticated G03-G07 lifecycle topology with durable effects", async () => {
	const life = await fixture();
	await life.invokeScenario((operation, input, idempotencyKey) =>
		daemonGlobal(life.repo, life.agentDir, operation, input, idempotencyKey),
	);
}, 120_000);

async function sharedFixture(sourceIds?: Record<"A" | "B", string>): Promise<SharedLifecycleFixture> {
	const value = await createSharedLifecycleFixture(sourceIds);
	fixtures.push(value);
	return value;
}

type LifecycleLedgerRow = {
	identity?: string;
	state?: string;
	effectIntent?: { sessionId?: string; stateRoot?: string; childOwnershipEstablished?: boolean };
};

async function readLifecycleLedger(agentDir: string): Promise<LifecycleLedgerRow[]> {
	const source = await fs.readFile(path.join(agentDir, "sdk", "lifecycle-ledger.jsonl"), "utf8").catch(() => "");
	return source
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line) as LifecycleLedgerRow);
}

async function sdkDirectoryEntries(agentDir: string): Promise<string[]> {
	return (await fs.readdir(path.join(agentDir, "sdk")).catch(() => [])).sort();
}

async function managedCandidatePaths(workspace: SharedLifecycleFixture["workspaces"]["A"]): Promise<string[]> {
	const inventory = await listManagedSessionCandidates({ scope: workspace.scope });
	expect(inventory.kind).toBe("complete");
	if (inventory.kind !== "complete") throw new Error(inventory.message);
	return inventory.owned.map(candidate => candidate.path).sort();
}

function assertNoEffectStarted(rows: LifecycleLedgerRow[], before: number): void {
	expect(rows.slice(before).some(row => row.state === "effect_started")).toBe(false);
}

async function assertTranscriptAppended(pathname: string, prefix: Uint8Array): Promise<void> {
	const transcript = await fs.readFile(pathname);
	expect([...transcript.subarray(0, prefix.length)]).toEqual([...prefix]);
	for (const line of transcript.toString("utf8").trimEnd().split("\n")) expect(() => JSON.parse(line)).not.toThrow();
}

async function registeredOwners(agentDir: string, sessionId: string) {
	const index = await new SessionIndex(agentDir).open();
	return index.listSessions().sessions.filter(session => session.sessionId === sessionId);
}

type SessionIndexOwner = { sessionId: string; repo: string; stateRoot: string };

/** Stable complete live owner/locator view; use equality to catch unexpected generated registrations. */
async function sessionIndexOwnerSnapshot(agentDir: string): Promise<SessionIndexOwner[]> {
	const index = await new SessionIndex(agentDir).open();
	return index
		.listSessions()
		.sessions.map(session => ({
			sessionId: session.sessionId,
			repo: session.locator.repo,
			stateRoot: session.locator.stateRoot,
		}))
		.sort((left, right) =>
			`${left.sessionId}\u0000${left.repo}\u0000${left.stateRoot}`.localeCompare(
				`${right.sessionId}\u0000${right.repo}\u0000${right.stateRoot}`,
			),
		);
}

async function assertEndpointAndMarkerAbsent(
	workspace: SharedLifecycleFixture["workspaces"]["A"],
	sessionId: string,
): Promise<void> {
	for (const suffix of [".json", ".lifecycle.json", ".lifecycle.ready.json"]) {
		expect(
			await fs.access(path.join(workspace.stateRoot, "sdk", `${sessionId}${suffix}`)).then(
				() => true,
				() => false,
			),
		).toBe(false);
	}
}
async function assertReadyOwner(
	life: SharedLifecycleFixture,
	workspace: SharedLifecycleFixture["workspaces"]["A"],
	sessionId: string,
): Promise<void> {
	await expect(fs.access(path.join(workspace.stateRoot, "sdk", `${sessionId}.json`))).resolves.toBeNull();
	await expect(fs.access(path.join(workspace.stateRoot, "sdk", `${sessionId}.lifecycle.json`))).resolves.toBeNull();
	await expect(
		fs.access(path.join(workspace.stateRoot, "sdk", `${sessionId}.lifecycle.ready.json`)),
	).resolves.toBeNull();
	const owners = await registeredOwners(life.agentDir, sessionId);
	expect(owners).toHaveLength(1);
	expect(owners[0]!.locator).toMatchObject({ repo: workspace.cwd, stateRoot: workspace.stateRoot });
}

function resumeInput(
	workspace: SharedLifecycleFixture["workspaces"]["A"],
	sessionId = workspace.source.id,
	sessionPath = workspace.source.path,
) {
	return {
		cwd: workspace.cwd,
		target: { path: workspace.cwd },
		stateRoot: workspace.stateRoot,
		sessionId,
		sessionPath,
	};
}

/** Close removes the endpoint and unregisters the host; its lifecycle marker is retained until session.delete removes it. */
async function closeSharedOwner(
	life: SharedLifecycleFixture,
	workspace: SharedLifecycleFixture["workspaces"]["A"],
	sessionId: string,
) {
	const endpointPath = path.join(workspace.stateRoot, "sdk", `${sessionId}.json`);
	const markerPath = path.join(workspace.stateRoot, "sdk", `${sessionId}.lifecycle.json`);
	const discovery = await listSdkSessionEndpoints(workspace.cwd);
	const endpoint = discovery.endpoints.find(candidate => candidate.sessionId === sessionId);
	if (!endpoint) throw new Error(`Persisted lifecycle endpoint is unavailable for ${sessionId}.`);
	const client = await SdkClient.connect(endpoint.url, endpoint.token, { timeoutMs: 2_000, reconnectAttempts: 0 });
	try {
		expect(await client.control("session.close")).toMatchObject({ ok: true });
	} finally {
		await client.close();
	}
	for (let attempt = 0; attempt < 200; attempt += 1) {
		const [endpointExists, markerExists, index] = await Promise.all([
			fs.access(endpointPath).then(
				() => true,
				() => false,
			),
			fs.access(markerPath).then(
				() => true,
				() => false,
			),
			fs.readFile(path.join(life.agentDir, "sdk", "sessions", "index.jsonl"), "utf8").catch(() => ""),
		]);
		const unregistered = index.split("\n").some(line => {
			try {
				const event = JSON.parse(line) as {
					type?: string;
					sessionId?: string;
					locator?: { stateRoot?: string };
				};
				return (
					event.type === "host_unregistered" &&
					event.sessionId === sessionId &&
					event.locator?.stateRoot === workspace.stateRoot
				);
			} catch {
				return false;
			}
		});
		if (!endpointExists && markerExists && unregistered) return;
		await Bun.sleep(50);
	}
	throw new Error(`Timed out waiting for shared lifecycle owner ${sessionId} to close.`);
}

test("shared-agent distinct saved-source IDs remain isolated across inverted MCP and daemon concurrency", async () => {
	const run = async (a: "mcp" | "daemon", b: "mcp" | "daemon", suffix: string) => {
		const life = await sharedFixture();
		const { A, B } = life.workspaces;
		expect(A.source.id).not.toBe(B.source.id);
		const barrier = life.createBarrier();
		const invoke = (
			adapter: "mcp" | "daemon",
			workspace: typeof A,
			operation: "session.resume" | "session.fork",
			key: string,
		) => {
			const input =
				operation === "session.resume"
					? resumeInput(workspace)
					: {
							cwd: workspace.cwd,
							target: { path: workspace.cwd },
							stateRoot: workspace.stateRoot,
							sourceSessionId: workspace.source.id,
							sourceSessionPath: workspace.source.path,
						};
			const call = adapter === "mcp" ? mcpGlobal : daemonGlobal;
			return barrier().then(() => call(workspace.cwd, life.agentDir, operation, input, key, life.environment));
		};
		const [left, right] = await Promise.all([
			invoke(a, A, "session.resume", `shared-${suffix}-a`),
			invoke(b, B, "session.fork", `shared-${suffix}-b`),
		]);
		expect(left).toMatchObject({ ok: true, result: { sessionId: A.source.id } });
		expect(right).toMatchObject({ ok: true });
		if (!right.ok) throw new Error("Fork unexpectedly failed.");
		const forkId = String(right.result?.sessionId);
		expect(forkId).not.toBe(A.source.id);
		expect(forkId).not.toBe(B.source.id);
		await assertTranscriptAppended(A.source.path, A.source.bytes);
		expect([...(await fs.readFile(B.source.path))]).toEqual([...B.source.bytes]);
		await assertReadyOwner(life, A, A.source.id);
		await assertReadyOwner(life, B, forkId);
		for (const [sessionId, owner, sibling] of [
			[A.source.id, A, B],
			[forkId, B, A],
		] as const) {
			await expect(fs.access(path.join(owner.stateRoot, "sdk", `${sessionId}.json`))).resolves.toBeNull();
			await expect(fs.access(path.join(owner.stateRoot, "sdk", `${sessionId}.lifecycle.json`))).resolves.toBeNull();
			await expect(
				fs.access(path.join(owner.stateRoot, "sdk", `${sessionId}.lifecycle.ready.json`)),
			).resolves.toBeNull();
			await assertEndpointAndMarkerAbsent(sibling, sessionId);
		}
		const inventory = await listManagedSessionCandidates({ scope: B.scope });
		expect(inventory.kind).toBe("complete");
		if (inventory.kind !== "complete") throw new Error(inventory.message);
		const fork = inventory.owned.filter(candidate => candidate.sessionId === forkId);
		expect(fork).toHaveLength(1);
		expect(path.dirname(fork[0]!.path)).toBe(B.scope.directoryPath);
		await closeSharedOwner(life, A, String(left.result?.sessionId));
		await closeSharedOwner(life, B, forkId);
		const call = b === "mcp" ? mcpGlobal : daemonGlobal;
		for (const [workspace, sessionId, sessionPath] of [
			[A, A.source.id, A.source.path],
			[B, forkId, fork[0]!.path],
		] as const) {
			expect(
				await call(
					workspace.cwd,
					life.agentDir,
					"session.delete",
					{ cwd: workspace.cwd, stateRoot: workspace.stateRoot, sessionId, sessionPath },
					`delete-${suffix}-${sessionId}`,
					life.environment,
				),
			).toMatchObject({ ok: true });
			expect(
				await fs.access(sessionPath).then(
					() => true,
					() => false,
				),
			).toBe(false);
			expect(
				await fs.access(path.join(workspace.stateRoot, "sdk", `${sessionId}.lifecycle.json`)).then(
					() => true,
					() => false,
				),
			).toBe(false);
			expect(
				await fs.access(path.join(workspace.stateRoot, "sdk", `${sessionId}.lifecycle.ready.json`)).then(
					() => true,
					() => false,
				),
			).toBe(false);
			expect((await managedCandidatePaths(workspace)).includes(sessionPath)).toBe(false);
		}
		expect(await sessionIndexOwnerSnapshot(life.agentDir)).toEqual([]);
	};
	await run("mcp", "daemon", "d1");
	await run("daemon", "mcp", "d2");
}, 120_000);

test("shared-agent shipped ingresses reject crossed saved-session workspace identity without effects", async () => {
	const life = await sharedFixture();
	const { A, B } = life.workspaces;
	const ledgerBefore = (await readLifecycleLedger(life.agentDir)).length;
	const ownersBefore = await sessionIndexOwnerSnapshot(life.agentDir);
	const barrier = life.createBarrier();
	const [mcp, daemon] = await Promise.all([
		barrier().then(() =>
			mcpGlobal(
				A.cwd,
				life.agentDir,
				"session.resume",
				resumeInput(A, A.source.id, B.source.path),
				"crossed-mcp",
				life.environment,
			),
		),
		barrier().then(() =>
			daemonGlobal(
				B.cwd,
				life.agentDir,
				"session.resume",
				resumeInput(B, B.source.id, A.source.path),
				"crossed-daemon",
				life.environment,
			),
		),
	]);
	for (const response of [mcp, daemon])
		expect(response).toMatchObject({ ok: false, error: { code: "invalid_input" } });
	for (const workspace of [A, B]) {
		expect(
			await fs.access(path.join(workspace.stateRoot, "sdk", `${workspace.source.id}.json`)).then(
				() => true,
				() => false,
			),
		).toBe(false);
		expect(
			await fs.access(path.join(workspace.stateRoot, "sdk", `${workspace.source.id}.lifecycle.json`)).then(
				() => true,
				() => false,
			),
		).toBe(false);
		expect([...(await fs.readFile(workspace.source.path))]).toEqual([...workspace.source.bytes]);
	}
	assertNoEffectStarted(await readLifecycleLedger(life.agentDir), ledgerBefore);
	expect(await sessionIndexOwnerSnapshot(life.agentDir)).toEqual(ownersBefore);
}, 120_000);

test("shared-agent shipped MCP and daemon reject foreign saved-session forks without lifecycle effects", async () => {
	const life = await sharedFixture();
	const { A, B } = life.workspaces;
	const run = async (leftAdapter: "mcp" | "daemon", rightAdapter: "mcp" | "daemon", suffix: string) => {
		const sdkBefore = await Promise.all([sdkDirectoryEntries(A.stateRoot), sdkDirectoryEntries(B.stateRoot)]);
		const [aCandidatesBefore, bCandidatesBefore] = await Promise.all([
			managedCandidatePaths(A),
			managedCandidatePaths(B),
		]);
		const ledgerBefore = (await readLifecycleLedger(life.agentDir)).length;
		const ownersBefore = await sessionIndexOwnerSnapshot(life.agentDir);
		const invoke = (adapter: "mcp" | "daemon", target: typeof A, source: typeof B, key: string) =>
			(adapter === "mcp" ? mcpGlobal : daemonGlobal)(
				target.cwd,
				life.agentDir,
				"session.fork",
				{
					cwd: target.cwd,
					target: { path: target.cwd },
					stateRoot: target.stateRoot,
					sourceSessionId: source.source.id,
					sourceSessionPath: source.source.path,
				},
				`foreign-fork-${suffix}-${key}`,
				life.environment,
			);
		const [left, right] = await Promise.all([invoke(leftAdapter, A, B, "a"), invoke(rightAdapter, B, A, "b")]);
		for (const response of [left, right])
			expect(response).toMatchObject({ ok: false, error: { code: "invalid_input" } });
		expect(await Promise.all([sdkDirectoryEntries(A.stateRoot), sdkDirectoryEntries(B.stateRoot)])).toEqual(
			sdkBefore,
		);
		expect(await managedCandidatePaths(A)).toEqual(aCandidatesBefore);
		expect(await managedCandidatePaths(B)).toEqual(bCandidatesBefore);
		assertNoEffectStarted(await readLifecycleLedger(life.agentDir), ledgerBefore);
		expect(await sessionIndexOwnerSnapshot(life.agentDir)).toEqual(ownersBefore);
		for (const workspace of [A, B]) {
			expect(await registeredOwners(life.agentDir, workspace.source.id)).toHaveLength(0);
			expect([...(await fs.readFile(workspace.source.path))]).toEqual([...workspace.source.bytes]);
		}
	};
	await run("mcp", "daemon", "d1");
	await run("daemon", "mcp", "d2");
}, 120_000);

test("shared-agent equal saved IDs select one owner without cross-workspace effects in either adapter direction", async () => {
	const run = async (a: "mcp" | "daemon", b: "mcp" | "daemon", suffix: string) => {
		const life = await sharedFixture({ A: "global-collision-source", B: "global-collision-source" });
		const { A, B } = life.workspaces;
		const ledgerBefore = (await readLifecycleLedger(life.agentDir)).length;
		const barrier = life.createBarrier();
		const call = (adapter: "mcp" | "daemon", workspace: typeof A, key: string) =>
			barrier().then(() =>
				(adapter === "mcp" ? mcpGlobal : daemonGlobal)(
					workspace.cwd,
					life.agentDir,
					"session.resume",
					resumeInput(workspace),
					key,
					life.environment,
				),
			);
		const [left, right] = await Promise.all([
			call(a, A, `collision-${suffix}-a`),
			call(b, B, `collision-${suffix}-b`),
		]);
		const responses = [left, right];
		const successes = responses.filter(response => response.ok);
		expect(successes.length).toBeLessThanOrEqual(1);
		const winnerIndex = responses.findIndex(response => response.ok);
		if (winnerIndex === -1) {
			for (const response of responses) expect(response).toMatchObject({ ok: false });
			expect(await sessionIndexOwnerSnapshot(life.agentDir)).toEqual([]);
			for (const workspace of [A, B]) {
				await assertEndpointAndMarkerAbsent(workspace, A.source.id);
				expect([...(await fs.readFile(workspace.source.path))]).toEqual([...workspace.source.bytes]);
			}
			assertNoEffectStarted(await readLifecycleLedger(life.agentDir), ledgerBefore);
			return;
		}
		const winner = winnerIndex === 0 ? A : B;
		const loser = winner === A ? B : A;
		const winnerResponse = responses[winnerIndex]!;
		const loserResponse = responses[winnerIndex === 0 ? 1 : 0]!;
		expect(winnerResponse).toMatchObject({ ok: true, result: { sessionId: A.source.id } });
		expect(loserResponse).toMatchObject({ ok: false });
		for (const [response, opposite] of [
			[winnerResponse, loser],
			[loserResponse, winner],
		] as const) {
			const serialized = JSON.stringify(response);
			expect(serialized).not.toContain(opposite.cwd);
			expect(serialized).not.toContain(opposite.source.path);
		}
		expect(await sessionIndexOwnerSnapshot(life.agentDir)).toEqual([
			{ sessionId: A.source.id, repo: winner.cwd, stateRoot: winner.stateRoot },
		]);
		await assertReadyOwner(life, winner, A.source.id);
		await assertEndpointAndMarkerAbsent(loser, A.source.id);
		await assertTranscriptAppended(winner.source.path, winner.source.bytes);
		expect([...(await fs.readFile(loser.source.path))]).toEqual([...loser.source.bytes]);
		const effectRecords = (await readLifecycleLedger(life.agentDir))
			.slice(ledgerBefore)
			.filter(row => row.state === "effect_started" && row.effectIntent?.childOwnershipEstablished === true);
		expect(effectRecords).toHaveLength(1);
		expect(effectRecords[0]).toMatchObject({
			effectIntent: { sessionId: A.source.id, stateRoot: winner.stateRoot, childOwnershipEstablished: true },
		});
		expect(effectRecords.some(row => row.effectIntent?.stateRoot === loser.stateRoot)).toBe(false);
		await closeSharedOwner(life, winner, A.source.id);
		await expect(fs.access(path.join(winner.stateRoot, "sdk", `${A.source.id}.lifecycle.json`))).resolves.toBeNull();
		await expect(
			fs.access(path.join(winner.stateRoot, "sdk", `${A.source.id}.lifecycle.ready.json`)),
		).resolves.toBeNull();
		await assertEndpointAndMarkerAbsent(loser, A.source.id);
		const deleteCall = winner === A ? a : b;
		expect(
			await (deleteCall === "mcp" ? mcpGlobal : daemonGlobal)(
				winner.cwd,
				life.agentDir,
				"session.delete",
				{ cwd: winner.cwd, stateRoot: winner.stateRoot, sessionId: A.source.id, sessionPath: winner.source.path },
				`delete-collision-${suffix}`,
				life.environment,
			),
		).toMatchObject({ ok: true, result: { sessionId: A.source.id } });
		for (const workspace of [A, B]) await assertEndpointAndMarkerAbsent(workspace, A.source.id);
		expect((await managedCandidatePaths(winner)).includes(winner.source.path)).toBe(false);
		expect((await managedCandidatePaths(loser)).includes(loser.source.path)).toBe(true);
		expect(await sessionIndexOwnerSnapshot(life.agentDir)).toEqual([]);
	};
	await run("mcp", "daemon", "d1");
	await run("daemon", "mcp", "d2");
}, 120_000);
