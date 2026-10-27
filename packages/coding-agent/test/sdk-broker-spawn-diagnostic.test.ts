import { expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Broker } from "../src/sdk/broker/broker";
import {
	reapOrphanedChildStderrLogs,
	setLifecycleCommandResolverForTest,
	terminalUncertainStartupMessage,
} from "../src/sdk/broker/lifecycle";
import { lifecycleKnownSecrets, sanitizeSdkStartupMessage } from "../src/sdk/startup-capability";

async function tempRoot(label: string): Promise<string> {
	return await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", `gjc-${label}-`));
}

test("readiness timeout reports stage, awaited signal, child liveness, and bounded stderr", async () => {
	const root = await tempRoot("spawn-diagnostic");
	const agentDir = path.join(root, "agent");
	const fixture = path.join(root, "stall.ts");
	const sessionIndexModule = JSON.stringify(path.resolve(import.meta.dir, "../src/sdk/broker/session-index.ts"));
	const lifecycleModule = JSON.stringify(path.resolve(import.meta.dir, "../src/sdk/broker/lifecycle.ts"));
	const broker = new Broker({ agentDir });
	try {
		await fs.writeFile(
			fixture,
			`import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SessionIndex } from ${sessionIndexModule};
import { writeSessionLifecycleFailure } from ${lifecycleModule};
const request = JSON.parse(process.env.GJC_SDK_LIFECYCLE_REQUEST!);
const sdk = path.join(request.stateRoot, "sdk");
await fs.mkdir(sdk, { recursive: true });
const endpoint = path.join(sdk, request.sessionId + ".json");
await fs.writeFile(endpoint, JSON.stringify({ sessionId: request.sessionId, pid: process.pid, url: "ws://127.0.0.1:1", token: "fixture" }));
const endpointMtimeMs = (await fs.stat(endpoint)).mtimeMs;
const index = await new SessionIndex(process.env.GJC_AGENT_DIR!).open();
const registration = await index.append({ type: "host_registered", sessionId: request.sessionId, locator: { cwd: request.cwd, worktreeRoot: null, stateRoot: request.stateRoot }, endpointGeneration: 1, pid: process.pid, endpointMtimeMs, lifecycleRequestId: request.effectMarker });
process.stderr.write("child startup diagnostic\\n");
let stopping = false;
process.on("SIGTERM", () => {
  if (stopping) return;
  stopping = true;
  void (async () => {
    await index.append({ type: "host_unregistered", sessionId: registration.sessionId, locator: registration.locator, endpointGeneration: registration.endpointGeneration, pid: process.pid, processIncarnation: registration.processIncarnation, hostIncarnation: registration.hostIncarnation, endpointMtimeMs: registration.endpointMtimeMs, lifecycleRequestId: request.effectMarker });
    await fs.rm(endpoint, { force: true });
    await writeSessionLifecycleFailure(request.stateRoot, request.sessionId, request.effectMarker, { phase: "startup", reason: "failed", message: "fixture stopped after readiness timeout" }, { endpointGeneration: 1, fenced: true, runtimeRemoved: true, hostStopped: true, brokerRegistrationReleased: true });
    process.exit(0);
  })();
});
setInterval(() => {}, 1000);`,
		);
		setLifecycleCommandResolverForTest(broker, () => ({ file: process.execPath, args: ["run", fixture] }));
		await broker.start();

		const response = await broker.handleRequest(
			"session.create",
			{ cwd: root, readinessTimeoutMs: 10_000 },
			"spawn-diagnostic",
		);
		expect(response).toMatchObject({
			ok: false,
			error: { code: expect.stringMatching(/readiness_timeout|terminal_uncertain/) },
		});
		if (response.ok) throw new Error("Expected readiness timeout.");
		expect(response.error.message).toContain("stage=readiness");
		expect(response.error.message).toContain("waiting_for=session_ready");
		expect(response.error.message).toContain("child=alive");
		expect(response.error.message).toContain("exit=not_observed");
		expect(response.error.message).toContain("child startup diagnostic");
	} finally {
		setLifecycleCommandResolverForTest(broker, undefined);
		await broker.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
}, 15_000);

test("session.create does not wait for its best-effort heartbeat checkpoint", async () => {
	const root = await tempRoot("spawn-heartbeat-deferred");
	const agentDir = path.join(root, "agent");
	const broker = new Broker({ agentDir });
	const checkpoint = Promise.withResolvers<number>();
	try {
		await broker.start();
		const heartbeat = vi.spyOn(broker, "heartbeatSessions").mockReturnValue(checkpoint.promise);
		setLifecycleCommandResolverForTest(broker, () => {
			throw new Error("synthetic spawn stop");
		});
		const response = await broker.handleRequest(
			"session.create",
			{ cwd: root, readinessTimeoutMs: 4_000 },
			"spawn-heartbeat-deferred",
		);
		expect(response).toEqual({
			ok: false,
			error: { code: "spawn_failed", message: "Unable to spawn session: synthetic spawn stop" },
		});
		expect(heartbeat).toHaveBeenCalled();
		checkpoint.resolve(0);
		heartbeat.mockRestore();
	} finally {
		checkpoint.resolve(0);
		setLifecycleCommandResolverForTest(broker, undefined);
		await broker.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
}, 15_000);

test("startup failure diagnostic reports an exited child status and stderr", async () => {
	const root = await tempRoot("spawn-exit-diagnostic");
	const agentDir = path.join(root, "agent");
	const fixture = path.join(root, "exit.ts");
	const lifecycleModule = JSON.stringify(path.resolve(import.meta.dir, "../src/sdk/broker/lifecycle.ts"));
	const broker = new Broker({ agentDir });
	try {
		await fs.writeFile(
			fixture,
			`import { writeSessionLifecycleFailure } from ${lifecycleModule};
const request = JSON.parse(process.env.GJC_SDK_LIFECYCLE_REQUEST!);
process.stderr.write("child exit diagnostic\\n");
await writeSessionLifecycleFailure(request.stateRoot, request.sessionId, request.effectMarker, { phase: "startup", reason: "failed", message: "fixture startup failure" }, { endpointGeneration: null, fenced: false, runtimeRemoved: true, hostStopped: false, brokerRegistrationReleased: true });
process.exit(7);`,
		);
		setLifecycleCommandResolverForTest(broker, () => ({ file: process.execPath, args: ["run", fixture] }));
		await broker.start();

		const response = await broker.handleRequest(
			"session.create",
			{ cwd: root, readinessTimeoutMs: 6_000 },
			"spawn-exit-diagnostic",
		);
		expect(response).toMatchObject({
			ok: false,
			error: { code: expect.stringMatching(/spawn_failed|terminal_uncertain/) },
		});
		if (response.ok) throw new Error("Expected startup failure.");
		expect(response.error.message).toContain("stage=startup");
		expect(response.error.message).toContain("waiting_for=startup completion");
		expect(response.error.message).toContain("child=exited");
		expect(response.error.message).toContain("exit=7");
		expect(response.error.message).toContain("child exit diagnostic");
	} finally {
		setLifecycleCommandResolverForTest(broker, undefined);
		await broker.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
}, 15_000);

test("startup diagnostics redact launch credentials without mangling ordinary environment values", async () => {
	const root = await tempRoot("spawn-diagnostic-secrets");
	const agentDir = path.join(root, "agent");
	const fixture = path.join(root, "exit.ts");
	const lifecycleModule = JSON.stringify(path.resolve(import.meta.dir, "../src/sdk/broker/lifecycle.ts"));
	const launchSecret = "launch-only-secret-5739";
	const remoteHeaderSecret = "remote-header-secret-5739";
	const plainEnvName = "GJC_DIAGNOSTIC_PLAINTEXT_5739";
	const secretEnvName = "GJC_DIAGNOSTIC_API_KEY_5739";
	const previousPlain = process.env[plainEnvName];
	const previousSecret = process.env[secretEnvName];
	process.env[plainEnvName] = "ordinary-value-5739";
	process.env[secretEnvName] = "process-secret-5739";
	const broker = new Broker({ agentDir });
	try {
		await fs.writeFile(
			fixture,
			`import { writeSessionLifecycleFailure } from ${lifecycleModule};
const request = JSON.parse(process.env.GJC_SDK_LIFECYCLE_REQUEST!);
process.stderr.write(\`line 12 path=/app/host.ts key=${launchSecret} remote=${remoteHeaderSecret} ordinary=ordinary-value-5739\`);
// The child-side normalizer does not know launch-scoped secrets, so a startup
// failure message can carry them verbatim into the receipt.
await writeSessionLifecycleFailure(request.stateRoot, request.sessionId, request.effectMarker, { phase: "startup", reason: "failed", message: "fixture startup failure sidecar=${launchSecret} header=${remoteHeaderSecret}" }, { endpointGeneration: null, fenced: false, runtimeRemoved: true, hostStopped: false, brokerRegistrationReleased: true });
process.exit(7);`,
		);
		setLifecycleCommandResolverForTest(broker, () => ({ file: process.execPath, args: ["run", fixture] }));
		await broker.start();

		const response = await broker.handleRequest(
			"session.create",
			{
				cwd: root,
				readinessTimeoutMs: 6_000,
				mcpServers: [
					{
						type: "http",
						name: "remote",
						url: "https://mcp.example.test",
						// Ordinary headers are not secrets; `a` and `1` must not be redacted
						// out of the stage diagnostic.
						headers: {
							Authorization: `Bearer ${remoteHeaderSecret}`,
							"X-Tenant": "a",
							"X-Protocol-Version": "1",
						},
					},
				],
				coordinatorStateDir: path.join(root, "coordinator"),
				coordinatorSidecarSigningKey: launchSecret,
				coordinatorSidecarKeyId: "a".repeat(64),
			},
			"spawn-diagnostic-secrets",
		);
		if (response.ok) throw new Error("Expected startup failure.");
		expect(response.error.message).toContain("[lifecycle-diagnostic-v1]");
		expect(response.error.message).toContain("line 12");
		expect(response.error.message).toContain("/app/host.ts");
		expect(response.error.message).not.toContain(launchSecret);
		expect(response.error.message).not.toContain(remoteHeaderSecret);
		expect(response.error.message).toContain("[redacted-secret]");
		expect(response.error.message).toContain("ordinary-value-5739");
		expect(response.error.message).toContain("path=/app/host.ts");
		expect(response.error.message).toContain("fixture startup failure sidecar=[redacted-secret]");
		expect(response.error.message.split(launchSecret)).toHaveLength(1);
		expect(response.error.message.split(remoteHeaderSecret)).toHaveLength(1);

		expect(lifecycleKnownSecrets()).toContain("process-secret-5739");
		expect(lifecycleKnownSecrets()).not.toContain("ordinary-value-5739");
		expect(sanitizeSdkStartupMessage("ordinary-value-5739", lifecycleKnownSecrets())).toBe("ordinary-value-5739");
	} finally {
		setLifecycleCommandResolverForTest(broker, undefined);
		await broker.stop();
		await fs.rm(root, { recursive: true, force: true });
		if (previousPlain === undefined) delete process.env[plainEnvName];
		else process.env[plainEnvName] = previousPlain;
		if (previousSecret === undefined) delete process.env[secretEnvName];
		else process.env[secretEnvName] = previousSecret;
	}
}, 15_000);

test("detached stderr capture stays bounded and stale artifacts are reapable", async () => {
	const root = await tempRoot("spawn-diagnostic-bounded");
	const agentDir = path.join(root, "agent");
	const fixture = path.join(root, "noisy-exit.ts");
	const lifecycleModule = JSON.stringify(path.resolve(import.meta.dir, "../src/sdk/broker/lifecycle.ts"));
	// 40-byte secret placed so the 512-byte tail cutoff lands inside it: only
	// its last 21 bytes survive truncation, and they must still be redacted.
	const straddlingSecret = "straddle-secret-5739-abcdefghijklmnopqrs";
	const straddlingSuffix = straddlingSecret.slice(-21);
	const broker = new Broker({ agentDir });
	try {
		await fs.writeFile(
			fixture,
			`import { writeSessionLifecycleFailure } from ${lifecycleModule};
const request = JSON.parse(process.env.GJC_SDK_LIFECYCLE_REQUEST!);
await new Promise<void>(resolve => process.stderr.write("x".repeat(8192) + ${JSON.stringify(straddlingSecret)} + "tail-marker" + "z".repeat(480), resolve));
await writeSessionLifecycleFailure(request.stateRoot, request.sessionId, request.effectMarker, { phase: "startup", reason: "failed", message: "fixture startup failure" }, { endpointGeneration: null, fenced: false, runtimeRemoved: true, hostStopped: false, brokerRegistrationReleased: true });
process.exit(7);`,
		);
		setLifecycleCommandResolverForTest(broker, () => ({ file: process.execPath, args: ["run", fixture] }));
		await broker.start();

		const response = await broker.handleRequest(
			"session.create",
			{
				cwd: root,
				readinessTimeoutMs: 6_000,
				coordinatorStateDir: path.join(root, "coordinator"),
				coordinatorSidecarSigningKey: straddlingSecret,
				coordinatorSidecarKeyId: "b".repeat(64),
			},
			"spawn-diagnostic-bounded",
		);
		if (response.ok) throw new Error("Expected startup failure.");
		expect(response.error.message).toContain("tail-marker");
		expect(response.error.message).not.toContain(straddlingSuffix);
		expect(response.error.message).toContain("[redacted-secret]tail-marker");
		// The ordinary bytes after the cut credential are preserved (the sanitizer
		// later bounds the whole message, so only assert a readable run survives).
		expect(response.error.message).toContain(`[redacted-secret]tail-marker${"z".repeat(64)}`);

		const sdkDirectory = path.join(agentDir, "sdk");
		for (const name of await fs.readdir(sdkDirectory)) {
			if (!name.startsWith("lifecycle-spawn.") || !name.endsWith(".log")) continue;
			expect((await fs.stat(path.join(sdkDirectory, name))).size).toBeLessThanOrEqual(512);
		}

		const staleLog = path.join(sdkDirectory, "lifecycle-spawn.stale.log");
		await fs.writeFile(staleLog, "stale");
		const expiredAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
		await fs.utimes(staleLog, expiredAt, expiredAt);
		expect(await reapOrphanedChildStderrLogs(agentDir)).toBe(1);
		await expect(fs.stat(staleLog)).rejects.toThrow();
	} finally {
		setLifecycleCommandResolverForTest(broker, undefined);
		await broker.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
}, 15_000);

test("uncertain cleanup preserves only explicitly marked lifecycle diagnostics", () => {
	const ordinary = terminalUncertainStartupMessage({
		ok: false,
		error: { code: "spawn_failed", message: "tool stage=/tmp/private-host.ts" },
	});
	const marked = terminalUncertainStartupMessage({
		ok: false,
		error: { code: "spawn_failed", message: "[lifecycle-diagnostic-v1] stage=readiness waiting_for=session_ready" },
	});
	expect(ordinary).toContain("SDK internal process could not be started.");
	expect(ordinary).not.toContain("/tmp/private-host.ts");
	expect(marked).toContain("Original launch failure: [lifecycle-diagnostic-v1]");
});
