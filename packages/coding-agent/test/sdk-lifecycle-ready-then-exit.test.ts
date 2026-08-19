import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { acpMcpLaunchFailure } from "../src/sdk/acp";
import { Broker } from "../src/sdk/broker/broker";
import {
	readSessionHostSpawnLogTailForTest,
	readyThenExitToleranceEnabledForTest,
	sanitizeSessionHostSpawnLogForTest,
	setLifecycleCommandResolverForTest,
	setLifecycleHostPlatformForTest,
} from "../src/sdk/broker/lifecycle";
import { SdkClientError } from "../src/sdk/client";
import { SessionLifecycleService } from "../src/sdk/lifecycle/service";

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

test("session-host spawn-log sanitation redacts secrets and URLs", () => {
	const dirty =
		"failed Authorization: Bearer supersecret-token https://example.invalid/hook?token=abc password=hunter2 leftover";
	const clean = sanitizeSessionHostSpawnLogForTest(dirty);
	expect(clean).not.toContain("supersecret-token");
	expect(clean).not.toContain("hunter2");
	expect(clean).not.toContain("https://example.invalid");
	expect(clean).toMatch(/redacted/i);
});

test("spawn-log tail sanitizes a secret that spans the 1024-byte bound", async () => {
	const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-sdk-spawn-log-"));
	const logPath = path.join(dir, "spawn.log");
	const secret = "token=supersecret-boundary-value";
	await Bun.write(logPath, `${"x".repeat(1010)}${secret}`);
	try {
		const tail = await readSessionHostSpawnLogTailForTest(logPath);
		expect(tail).not.toContain("supersecret-boundary-value");
		expect(tail).toMatch(/redacted/i);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
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

test("ACP preserves ready_then_exited with and without MCP servers", () => {
	const mcpServers = [
		{ name: "docs", command: "docs-mcp", args: [] },
		{ name: "search", command: "search-mcp", args: [] },
	];
	const typed = new SdkClientError("ready_then_exited", "Session s became ready then exited before live admission.");
	expect(acpMcpLaunchFailure(typed, mcpServers)).toBe(typed);
	expect(acpMcpLaunchFailure(typed, [])).toBe(typed);
	const masked = acpMcpLaunchFailure(new SdkClientError("spawn_failed", "child exited"), mcpServers) as {
		code: string;
	};
	expect(masked.code).toBe("unavailable");
});

test("lifecycle service certainty for ready_then_exited is terminal, not retryable", async () => {
	const service = new SessionLifecycleService({
		global: async () => ({
			ok: false,
			error: {
				code: "ready_then_exited",
				message: "Session s became ready then exited before live admission. exit=9",
			},
		}),
	});
	const outcome = await service.create({
		actor: { id: "tester", namespace: "local" },
		capability: "session.create",
		requestKey: "certainty-rte",
		target: { cwd: "/tmp" },
	});
	expect(outcome.ok).toBe(false);
	if (outcome.ok) throw new Error("expected failure");
	expect(outcome.certainty).toBe("terminal");
	expect(outcome.error.code).toBe("ready_then_exited");
});
