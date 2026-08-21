import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { acpMcpLaunchFailure } from "../src/sdk/acp";
import { Broker } from "../src/sdk/broker/broker";
import {
	probePublishedReadyAuthorityForTest,
	readyThenExitToleranceEnabledForTest,
	removeOwnedLifecycleArtifactsForTest,
	setLifecycleCommandResolverForTest,
	setLifecycleHostPlatformForTest,
} from "../src/sdk/broker/lifecycle";
import { SdkClientError } from "../src/sdk/client";
import { SessionLifecycleService } from "../src/sdk/lifecycle/service";

async function tempRoot(label: string): Promise<{ root: string; cwd: string; agentDir: string }> {
	// `os.tmpdir()` is the platform-native root: a POSIX-only `/tmp` fallback
	// ENOENTs on Windows runners before any lifecycle behavior runs (#4712 review).
	const root = await fs.mkdtemp(path.join(os.tmpdir(), `gjc-sdk-${label}-`));
	const cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true });
	return { root, cwd, agentDir };
}
function bunEval(source: string): { file: string; args: string[] } {
	return { file: process.execPath, args: ["-e", source] };
}

const readyThenExitChild = `
const fs = require("node:fs");
const path = require("node:path");
const request = JSON.parse(process.env.GJC_SDK_LIFECYCLE_REQUEST);
const markerPath = path.join(request.stateRoot, "sdk", request.sessionId + ".lifecycle.json");
const readyPath = path.join(request.stateRoot, "sdk", request.sessionId + ".lifecycle.ready.json");
const endpointPath = path.join(request.stateRoot, "sdk", request.sessionId + ".json");
const deadline = Date.now() + 4000;
let marker;
while (Date.now() < deadline) {
	try {
		const candidate = JSON.parse(fs.readFileSync(markerPath, "utf8"));
		if (candidate.pid === process.pid && candidate.effectMarker === request.effectMarker) {
			marker = candidate;
			break;
		}
	} catch {}
}
if (!marker) process.exit(11);
fs.mkdirSync(path.dirname(readyPath), { recursive: true });
fs.writeFileSync(readyPath, JSON.stringify(marker));
fs.writeFileSync(endpointPath, JSON.stringify({
	sessionId: request.sessionId,
	url: "ws://127.0.0.1:1",
	token: "ready-then-exit",
	pid: process.pid,
	stale: false,
}));
process.stderr.write("Authorization: Bearer ready-then-exit-secret\\n");
process.exit(9);
`;

// Same owned-marker + ready-marker contract, but the endpoint file is corrupt
// JSON: the probe must classify its own condition instead of routing the
// teardown decision through the secondary index authority, and the launch must
// surface the honest terminal reason (#4712 review).
const corruptEndpointChild = `
const fs = require("node:fs");
const path = require("node:path");
const request = JSON.parse(process.env.GJC_SDK_LIFECYCLE_REQUEST);
const markerPath = path.join(request.stateRoot, "sdk", request.sessionId + ".lifecycle.json");
const readyPath = path.join(request.stateRoot, "sdk", request.sessionId + ".lifecycle.ready.json");
const endpointPath = path.join(request.stateRoot, "sdk", request.sessionId + ".json");
const deadline = Date.now() + 4000;
let marker;
while (Date.now() < deadline) {
	try {
		const candidate = JSON.parse(fs.readFileSync(markerPath, "utf8"));
		if (candidate.pid === process.pid && candidate.effectMarker === request.effectMarker) {
			marker = candidate;
			break;
		}
	} catch {}
}
if (!marker) process.exit(11);
fs.mkdirSync(path.dirname(readyPath), { recursive: true });
fs.writeFileSync(readyPath, JSON.stringify(marker));
fs.writeFileSync(endpointPath, "{not-json");
process.exit(9);
`;

/** Writes the owned-marker/ready-marker chain and endpoint payload by hand. */
async function writeReadyThenExitArtifacts(
	root: string,
	id: string,
	marker: { pid: number; effectMarker: string; incarnation: string },
	endpointPayload: string,
): Promise<void> {
	const sdkDir = path.join(root, "sdk");
	await fs.mkdir(sdkDir, { recursive: true });
	await fs.writeFile(path.join(sdkDir, `${id}.lifecycle.json`), JSON.stringify(marker));
	await fs.writeFile(path.join(sdkDir, `${id}.lifecycle.ready.json`), JSON.stringify(marker));
	await fs.writeFile(path.join(sdkDir, `${id}.json`), endpointPayload);
}

test("endpoint probe classifies malformed, unreadable, foreign, and absent endpoints distinctly", async () => {
	const { root } = await tempRoot("probe-boundary");
	const id = "0123456789abcdef0123456789abcdef";
	const marker = { pid: 424_242, effectMarker: "probe-marker-1", incarnation: "linux:1724000000.123" };
	try {
		// Matching markers + endpoint naming the same pid/session: matched.
		await writeReadyThenExitArtifacts(
			root,
			id,
			marker,
			JSON.stringify({ sessionId: id, pid: marker.pid, url: "ws://127.0.0.1:1", token: "t" }),
		);
		expect(await probePublishedReadyAuthorityForTest(root, id, marker)).toEqual({ kind: "matched" });

		// Corrupt endpoint JSON is its own malformed outcome, never absence.
		await writeReadyThenExitArtifacts(root, id, marker, "{not-json");
		expect(await probePublishedReadyAuthorityForTest(root, id, marker)).toEqual({ kind: "malformed" });

		// An endpoint naming a different child is not_published.
		await writeReadyThenExitArtifacts(
			root,
			id,
			marker,
			JSON.stringify({ sessionId: id, pid: marker.pid + 1, url: "ws://127.0.0.1:1", token: "t" }),
		);
		expect(await probePublishedReadyAuthorityForTest(root, id, marker)).toEqual({ kind: "not_published" });

		// A missing endpoint without an index authority is absent_unindexed
		// (the index fallback itself is exercised by the graceful-teardown e2e).
		await fs.rm(path.join(root, "sdk", `${id}.json`));
		expect(await probePublishedReadyAuthorityForTest(root, id, marker)).toEqual({ kind: "absent_unindexed" });
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test.skipIf(process.platform === "win32")("endpoint probe keeps EACCES fail-closed as io_error", async () => {
	const { root } = await tempRoot("probe-eacces");
	const id = "0123456789abcdef0123456789abcdef";
	const marker = { pid: 424_243, effectMarker: "probe-marker-2", incarnation: "linux:1724000000.456" };
	const endpointPath = path.join(root, "sdk", `${id}.json`);
	try {
		await writeReadyThenExitArtifacts(
			root,
			id,
			marker,
			JSON.stringify({ sessionId: id, pid: marker.pid, url: "ws://127.0.0.1:1", token: "t" }),
		);
		await fs.chmod(endpointPath, 0o000);
		const probe = await probePublishedReadyAuthorityForTest(root, id, marker);
		expect(probe.kind).toBe("io_error");
		if (probe.kind === "io_error") expect(probe.code).toBe("EACCES");
	} finally {
		await fs.chmod(endpointPath, 0o700).catch(() => {});
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("owned-artifact cleanup never unlinks a successor endpoint after marker takeover (PID reuse)", async () => {
	const { root } = await tempRoot("pid-reuse");
	const id = "0123456789abcdef0123456789abcdef";
	const deadChild = { pid: 424_244, effectMarker: "dead-marker", incarnation: "linux:1724000000.789" };
	// A successor launch for the same session rewrites the broker-owned marker
	// through the broker before its child publishes anything: same reused pid,
	// new effectMarker + incarnation.
	const successor = { pid: deadChild.pid, effectMarker: "successor-marker", incarnation: "linux:1724000009.999" };
	const endpointPath = path.join(root, "sdk", `${id}.json`);
	try {
		await writeReadyThenExitArtifacts(
			root,
			id,
			deadChild,
			JSON.stringify({ sessionId: id, pid: deadChild.pid, url: "ws://127.0.0.1:1", token: "t" }),
		);
		// Positive control: with the dead child still owning the marker chain,
		// cleanup removes the endpoint (the process is provably not alive, so
		// observeProcess cannot report "alive" for a fabricated incarnation).
		expect(await removeOwnedLifecycleArtifactsForTest(root, id, deadChild)).toBe(true);
		await expect(fs.access(endpointPath)).rejects.toMatchObject({ code: "ENOENT" });

		// PID-reuse: the endpoint file is back and numerically matches the pid,
		// but the marker chain now names the successor incarnation.
		await writeReadyThenExitArtifacts(
			root,
			id,
			successor,
			JSON.stringify({ sessionId: id, pid: deadChild.pid, url: "ws://127.0.0.1:1", token: "t" }),
		);
		await fs.writeFile(path.join(root, "sdk", `${id}.lifecycle.json`), JSON.stringify(successor));
		expect(await removeOwnedLifecycleArtifactsForTest(root, id, deadChild)).toBe(false);
		await fs.access(endpointPath);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("ready-then-exit tolerance is win32-only through the host-platform seam", () => {
	const original = readyThenExitToleranceEnabledForTest();
	try {
		setLifecycleHostPlatformForTest("linux");
		expect(readyThenExitToleranceEnabledForTest()).toBe(false);
		setLifecycleHostPlatformForTest("darwin");
		expect(readyThenExitToleranceEnabledForTest()).toBe(false);
		setLifecycleHostPlatformForTest("win32");
		expect(readyThenExitToleranceEnabledForTest()).toBe(true);
	} finally {
		setLifecycleHostPlatformForTest(undefined);
		expect(readyThenExitToleranceEnabledForTest()).toBe(original);
	}
});

test("non-Windows ready-then-exit stays fail-closed as terminal_uncertain", async () => {
	const { root, cwd, agentDir } = await tempRoot("ready-then-exit-linux");
	const broker = new Broker({ agentDir });
	setLifecycleHostPlatformForTest("linux");
	setLifecycleCommandResolverForTest(broker, () => bunEval(readyThenExitChild));
	try {
		await broker.start();
		const response = await broker.handleRequest("session.create", { cwd, readinessTimeoutMs: 6_000 }, "linux-rte");
		expect(response.ok).toBe(false);
		if (response.ok) throw new Error("expected failure");
		expect(response.error.code).toBe("terminal_uncertain");
		expect(response.error.code).not.toBe("ready_then_exited");
	} finally {
		setLifecycleCommandResolverForTest(broker, undefined);
		setLifecycleHostPlatformForTest(undefined);
		await broker.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
}, 25_000);

test("win32 ready-then-exit is typed ready_then_exited with exit evidence and same-key replay", async () => {
	const { root, cwd, agentDir } = await tempRoot("ready-then-exit-win32");
	const broker = new Broker({ agentDir });
	setLifecycleHostPlatformForTest("win32");
	setLifecycleCommandResolverForTest(broker, () => bunEval(readyThenExitChild));
	try {
		await broker.start();
		const input = { cwd, readinessTimeoutMs: 6_000 };
		const response = await broker.handleRequest("session.create", input, "win32-rte");
		expect(response.ok).toBe(false);
		if (response.ok) throw new Error("expected failure");
		expect(response.error.code).toBe("ready_then_exited");
		expect(response.error.code).not.toBe("spawn_failed");
		expect(response.error.code).not.toBe("terminal_uncertain");
		expect(response.error.message).toMatch(/became ready then exited before live admission/i);
		expect(response.error.message).toMatch(/exit=9/);
		expect(response.error.message).not.toContain("ready-then-exit-secret");
		expect(await broker.handleRequest("session.create", input, "win32-rte")).toEqual(response);
		const sdkDir = path.join(cwd, ".gjc", "state", "sdk");
		const entries = await fs.readdir(sdkDir).catch(() => [] as string[]);
		const canonical = entries.filter(entry => !entry.startsWith(".gjc-delete-"));
		expect(canonical.some(entry => entry.endsWith(".lifecycle.json"))).toBe(false);
		expect(canonical.some(entry => entry.endsWith(".lifecycle.ready.json"))).toBe(false);
	} finally {
		setLifecycleCommandResolverForTest(broker, undefined);
		setLifecycleHostPlatformForTest(undefined);
		await broker.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
}, 25_000);

test("win32 production host exit after ready is ready_then_exited, not spawn_failed", async () => {
	const { root, cwd, agentDir } = await tempRoot("host-exit-after-ready");
	const broker = new Broker({ agentDir });
	const previous = process.env.GJC_SDK_TEST_EXIT_AFTER_READY;
	process.env.GJC_SDK_TEST_EXIT_AFTER_READY = cwd;
	setLifecycleHostPlatformForTest("win32");
	try {
		await broker.start();
		const input = { cwd, readinessTimeoutMs: 12_000 };
		const response = await broker.handleRequest("session.create", input, "host-exit-after-ready");
		expect(response.ok).toBe(false);
		if (response.ok) throw new Error("expected failure");
		expect(response.error.code).toBe("ready_then_exited");
		expect(response.error.message).toMatch(/became ready then exited before live admission/i);
		expect(await broker.handleRequest("session.create", input, "host-exit-after-ready")).toEqual(response);
	} finally {
		if (previous === undefined) delete process.env.GJC_SDK_TEST_EXIT_AFTER_READY;
		else process.env.GJC_SDK_TEST_EXIT_AFTER_READY = previous;
		setLifecycleHostPlatformForTest(undefined);
		await broker.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
}, 30_000);
test("win32 host that rejects after ready is ready_then_exited, never spawn_failed via a post-ready receipt", async () => {
	const { root, cwd, agentDir } = await tempRoot("host-reject-after-ready");
	const broker = new Broker({ agentDir });
	const previous = process.env.GJC_SDK_TEST_REJECT_AFTER_READY;
	process.env.GJC_SDK_TEST_REJECT_AFTER_READY = cwd;
	setLifecycleHostPlatformForTest("win32");
	try {
		await broker.start();
		const input = { cwd, readinessTimeoutMs: 12_000 };
		const response = await broker.handleRequest("session.create", input, "host-reject-after-ready");
		expect(response.ok).toBe(false);
		if (response.ok) throw new Error("expected failure");
		expect(response.error.code).toBe("ready_then_exited");
		expect(response.error.code).not.toBe("spawn_failed");
		expect(response.error.message).toMatch(/became ready then exited before live admission/i);
		// The user-visible message must never carry host stderr (#4712 review).
		expect(response.error.message).not.toContain("Host stderr");
		expect(await broker.handleRequest("session.create", input, "host-reject-after-ready")).toEqual(response);
	} finally {
		if (previous === undefined) delete process.env.GJC_SDK_TEST_REJECT_AFTER_READY;
		else process.env.GJC_SDK_TEST_REJECT_AFTER_READY = previous;
		setLifecycleHostPlatformForTest(undefined);
		await broker.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
}, 30_000);

test("win32 corrupt endpoint after ready is endpoint_unreadable, never ready_then_exited or spawn_failed", async () => {
	const { root, cwd, agentDir } = await tempRoot("corrupt-endpoint");
	const broker = new Broker({ agentDir });
	setLifecycleHostPlatformForTest("win32");
	setLifecycleCommandResolverForTest(broker, () => bunEval(corruptEndpointChild));
	try {
		await broker.start();
		const input = { cwd, readinessTimeoutMs: 6_000 };
		const response = await broker.handleRequest("session.create", input, "corrupt-endpoint");
		expect(response.ok).toBe(false);
		if (response.ok) throw new Error("expected failure");
		// Fail-closed boundary: a corrupt endpoint must not classify through the
		// secondary index authority as ready-then-exited, and must not claim the
		// child "exited before registering readiness" — the honest reason names
		// the unreadable endpoint (#4712 review).
		expect(response.error.code).toBe("endpoint_unreadable");
		expect(response.error.code).not.toBe("ready_then_exited");
		expect(response.error.code).not.toBe("spawn_failed");
		expect(response.error.message).toMatch(/endpoint file is malformed/);
		expect(response.error.message).not.toMatch(/exited before registering readiness/);
	} finally {
		setLifecycleCommandResolverForTest(broker, undefined);
		setLifecycleHostPlatformForTest(undefined);
		await broker.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
}, 25_000);

test("ACP preserves ready_then_exited and endpoint_unreadable with and without MCP servers", () => {
	const mcpServers = [
		{ name: "docs", command: "docs-mcp", args: [] },
		{ name: "search", command: "search-mcp", args: [] },
	];
	const typed = new SdkClientError("ready_then_exited", "Session s became ready then exited before live admission.");
	expect(acpMcpLaunchFailure(typed, mcpServers)).toBe(typed);
	expect(acpMcpLaunchFailure(typed, [])).toBe(typed);
	const unreadable = new SdkClientError("endpoint_unreadable", "Session s exited; endpoint file is malformed.");
	expect(acpMcpLaunchFailure(unreadable, mcpServers)).toBe(unreadable);
	const masked = acpMcpLaunchFailure(new SdkClientError("spawn_failed", "child exited"), mcpServers) as {
		code: string;
	};
	expect(masked.code).toBe("unavailable");
});

test("lifecycle service certainty for ready_then_exited and endpoint_unreadable is terminal, not retryable", async () => {
	const service = new SessionLifecycleService({
		global: async (_operation: string, _input: Record<string, unknown>, options: { idempotencyKey?: string }) => ({
			ok: false,
			error:
				options.idempotencyKey === "certainty-unreadable"
					? {
							code: "endpoint_unreadable",
							message:
								"Session s exited, and its readiness could not be determined: endpoint file is malformed.",
						}
					: {
							code: "ready_then_exited",
							message: "Session s became ready then exited before live admission. exit=9",
						},
		}),
	});
	for (const requestKey of ["certainty-rte", "certainty-unreadable"]) {
		const outcome = await service.create({
			actor: { id: "tester", namespace: "local" },
			capability: "session.create",
			requestKey,
			target: { cwd: os.tmpdir() },
		});
		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("expected failure");
		expect(outcome.certainty).toBe("terminal");
	}
});
