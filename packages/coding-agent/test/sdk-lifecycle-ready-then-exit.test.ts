import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Broker } from "../src/sdk/broker/broker";
import { sanitizeSessionHostSpawnLogForTest, setLifecycleCommandResolverForTest } from "../src/sdk/broker/lifecycle";

async function tempRoot(label: string): Promise<{ root: string; cwd: string; agentDir: string }> {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", `gjc-sdk-${label}-`));
	const cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true });
	return { root, cwd, agentDir };
}

function bunEval(source: string): { file: string; args: string[] } {
	return { file: process.execPath, args: ["-e", source] };
}

test("session-host spawn-log sanitation redacts secrets and URLs", () => {
	const dirty =
		"failed Authorization: Bearer supersecret-token https://example.invalid/hook?token=abc password=hunter2 leftover";
	const clean = sanitizeSessionHostSpawnLogForTest(dirty);
	expect(clean).not.toContain("supersecret-token");
	expect(clean).not.toContain("hunter2");
	expect(clean).not.toContain("https://example.invalid");
	expect(clean).toMatch(/redacted/i);
});

test("child exit before ready is spawn_failed with sanitized stderr, not terminal_uncertain", async () => {
	const { root, cwd, agentDir } = await tempRoot("exit-before-ready");
	const broker = new Broker({ agentDir });
	setLifecycleCommandResolverForTest(broker, () =>
		bunEval("process.stderr.write('token=leakme-before-ready\\n'); process.exit(3);"),
	);
	try {
		await broker.start();
		const input = { cwd, readinessTimeoutMs: 4_000 };
		const response = await broker.handleRequest("session.create", input, "exit-before-ready");
		expect(response.ok).toBe(false);
		if (response.ok) throw new Error("expected failure");
		expect(response.error.code).toBe("spawn_failed");
		expect(response.error.code).not.toBe("terminal_uncertain");
		expect(response.error.message).toMatch(/exited before registering readiness/i);
		expect(response.error.message).not.toContain("leakme-before-ready");
		expect(await broker.handleRequest("session.create", input, "exit-before-ready")).toEqual(response);
	} finally {
		setLifecycleCommandResolverForTest(broker, undefined);
		await broker.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
}, 20_000);

test("ready then exit before live admission is spawn_failed and retryable, not terminal_uncertain", async () => {
	const { root, cwd, agentDir } = await tempRoot("ready-then-exit");
	const broker = new Broker({ agentDir });
	setLifecycleCommandResolverForTest(broker, () =>
		bunEval(`
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
`),
	);
	try {
		await broker.start();
		const input = { cwd, readinessTimeoutMs: 6_000 };
		const response = await broker.handleRequest("session.create", input, "ready-then-exit");
		expect(response.ok).toBe(false);
		if (response.ok) throw new Error("expected failure");
		expect(response.error.code).toBe("spawn_failed");
		expect(response.error.code).not.toBe("terminal_uncertain");
		expect(response.error.message).toMatch(/became ready then exited before live admission/i);
		expect(response.error.message).not.toContain("ready-then-exit-secret");
		expect(await broker.handleRequest("session.create", input, "ready-then-exit")).toEqual(response);
		const sdkDir = path.join(cwd, ".gjc", "state", "sdk");
		const entries = await fs.readdir(sdkDir).catch(() => [] as string[]);
		const canonical = entries.filter(entry => !entry.startsWith(".gjc-delete-"));
		expect(canonical.some(entry => entry.endsWith(".lifecycle.json"))).toBe(false);
		expect(canonical.some(entry => entry.endsWith(".lifecycle.ready.json"))).toBe(false);
	} finally {
		setLifecycleCommandResolverForTest(broker, undefined);
		await broker.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
}, 25_000);

test("production host exit after ready is spawn_failed, not terminal_uncertain", async () => {
	const { root, cwd, agentDir } = await tempRoot("host-exit-after-ready");
	const broker = new Broker({ agentDir });
	const previous = process.env.GJC_SDK_TEST_EXIT_AFTER_READY;
	process.env.GJC_SDK_TEST_EXIT_AFTER_READY = cwd;
	try {
		await broker.start();
		const input = { cwd, readinessTimeoutMs: 12_000 };
		const response = await broker.handleRequest("session.create", input, "host-exit-after-ready");
		expect(response.ok).toBe(false);
		if (response.ok) throw new Error("expected failure");
		expect(response.error.code).toBe("spawn_failed");
		expect(response.error.code).not.toBe("terminal_uncertain");
		expect(response.error.message).toMatch(/became ready then exited before live admission/i);
		expect(await broker.handleRequest("session.create", input, "host-exit-after-ready")).toEqual(response);
	} finally {
		if (previous === undefined) delete process.env.GJC_SDK_TEST_EXIT_AFTER_READY;
		else process.env.GJC_SDK_TEST_EXIT_AFTER_READY = previous;
		await broker.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
}, 30_000);
