import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { experimentalValidators } from "../../protocol-source/schema-validators.generated";
// The pinned catalog labels process requests stable, but the vendored stable validator profile omits process/*; use the complete experimental profile for conformance checks.
import type { HandlerContext } from "../../suites/handlers";
import {
	disposeProcesses,
	getProcessRegistrySize,
	processHandlers,
	processKillHandler,
	processResizePtyHandler,
	processSpawnHandler,
	processWriteStdinHandler,
} from "../../suites/process-handlers";

type Notification = { method: string; params: Record<string, unknown> };

const tempDir = mkdtempSync(join(tmpdir(), "gjc-process-suite-"));

function contextFor(notifications: Notification[]): HandlerContext {
	const context = {
		connectionId: `process-test-${crypto.randomUUID()}`,
		emitTo: (_connectionId: string, method: string, params: unknown) => {
			if (typeof params === "object" && params !== null && !Array.isArray(params))
				notifications.push({ method, params: params as Record<string, unknown> });
		},
	} as HandlerContext;
	return context;
}

async function waitForExit(notifications: Notification[], processHandle: string): Promise<Record<string, unknown>> {
	for (let attempt = 0; attempt < 500; attempt++) {
		const exited = notifications.find(
			notification =>
				notification.method === "process/exited" && notification.params.processHandle === processHandle,
		);
		if (exited) return exited.params;
		await Bun.sleep(10);
	}
	throw new Error(`Timed out waiting for process/exited for ${processHandle}`);
}

function outputBytes(notifications: Notification[], processHandle: string, stream: "stdout" | "stderr"): Uint8Array {
	const chunks = notifications
		.filter(
			notification =>
				notification.method === "process/outputDelta" &&
				notification.params.processHandle === processHandle &&
				notification.params.stream === stream,
		)
		.map(notification => Buffer.from(notification.params.deltaBase64 as string, "base64"));
	return new Uint8Array(Buffer.concat(chunks));
}

beforeEach(() => {
	expect(getProcessRegistrySize()).toBe(0);
});

afterAll(async () => {
	await disposeProcesses();
	expect(getProcessRegistrySize()).toBe(0);
	rmSync(tempDir, { recursive: true, force: true });
});

test("process/spawn streams real stdout and stderr bytes and emits one true exit", async () => {
	const notifications: Notification[] = [];
	const context = contextFor(notifications);
	const params = {
		command: [
			process.execPath,
			"-e",
			'process.stdout.write("stdout-bytes"); process.stderr.write("stderr-bytes"); process.exit(7)',
		],
		processHandle: "output-and-exit",
		cwd: tempDir,
		streamStdoutStderr: true,
	};
	expect(experimentalValidators.clientRequestParams["process/spawn"]!(params)).toBe(true);
	const result = await processSpawnHandler(params, context);
	expect(result).toEqual({ ok: true, result: {} });
	expect(experimentalValidators.clientRequestResults["process/spawn"]!(result.ok ? result.result : undefined)).toBe(
		true,
	);

	const exited = await waitForExit(notifications, "output-and-exit");
	expect(Buffer.from(outputBytes(notifications, "output-and-exit", "stdout")).toString()).toBe("stdout-bytes");
	expect(Buffer.from(outputBytes(notifications, "output-and-exit", "stderr")).toString()).toBe("stderr-bytes");
	expect(exited).toMatchObject({
		processHandle: "output-and-exit",
		exitCode: 7,
		stdout: "",
		stderr: "",
		stdoutCapReached: false,
		stderrCapReached: false,
	});
	expect(notifications.filter(notification => notification.method === "process/exited")).toHaveLength(1);
	expect(experimentalValidators.serverNotificationParams["process/outputDelta"]!(notifications[0]?.params)).toBe(true);
	expect(experimentalValidators.serverNotificationParams["process/exited"]!(exited)).toBe(true);
});

test("process/writeStdin delivers real bytes to a child process", async () => {
	const notifications: Notification[] = [];
	const context = contextFor(notifications);
	const params = {
		command: [
			process.execPath,
			"-e",
			'process.stdin.on("data", chunk => { process.stdout.write(chunk); process.exit(0); })',
		],
		processHandle: "stdin",
		cwd: tempDir,
		streamStdin: true,
		streamStdoutStderr: true,
	};
	expect(experimentalValidators.clientRequestParams["process/spawn"]!(params)).toBe(true);
	expect(await processSpawnHandler(params, context)).toEqual({ ok: true, result: {} });
	const input = Buffer.from("observed-stdin");
	const writeResult = await processWriteStdinHandler(
		{ processHandle: "stdin", deltaBase64: input.toString("base64") },
		context,
	);
	expect(writeResult).toEqual({ ok: true, result: {} });
	expect(
		experimentalValidators.clientRequestResults["process/writeStdin"]!(
			writeResult.ok ? writeResult.result : undefined,
		),
	).toBe(true);
	const exited = await waitForExit(notifications, "stdin");
	expect(Buffer.from(outputBytes(notifications, "stdin", "stdout")).toString()).toBe("observed-stdin");
	expect(exited.exitCode).toBe(0);
});

test("process/kill terminates a sleeper and emits exactly one exit", async () => {
	const notifications: Notification[] = [];
	const context = contextFor(notifications);
	const params = {
		command: [process.execPath, "-e", "setInterval(() => {}, 60_000)"],
		processHandle: "kill-me",
		cwd: tempDir,
	};
	expect(await processSpawnHandler(params, context)).toEqual({ ok: true, result: {} });
	expect(await processKillHandler({ processHandle: "kill-me" }, context)).toEqual({ ok: true, result: {} });
	const exited = await waitForExit(notifications, "kill-me");
	expect(exited.processHandle).toBe("kill-me");
	expect(typeof exited.exitCode).toBe("number");
	expect(notifications.filter(notification => notification.method === "process/exited")).toHaveLength(1);
});

test("process/resizePty rejects a non-PTY process with the pinned notSupported error", async () => {
	const notifications: Notification[] = [];
	const context = contextFor(notifications);
	expect(
		await processSpawnHandler(
			{ command: [process.execPath, "-e", "setTimeout(() => {}, 60_000)"], processHandle: "not-pty", cwd: tempDir },
			context,
		),
	).toEqual({ ok: true, result: {} });
	expect(await processResizePtyHandler({ processHandle: "not-pty", size: { rows: 24, cols: 80 } }, context)).toEqual({
		ok: false,
		errorKey: "notSupported",
	});
	expect(await processKillHandler({ processHandle: "not-pty" }, context)).toEqual({ ok: true, result: {} });
	await waitForExit(notifications, "not-pty");
});

test("process handlers return pinned errors for unknown ids and malformed params", async () => {
	const context = contextFor([]);
	expect(await processKillHandler({ processHandle: "missing" }, context)).toEqual({ ok: false, errorKey: "notFound" });
	expect(await processWriteStdinHandler({ processHandle: "missing", deltaBase64: "" }, context)).toEqual({
		ok: false,
		errorKey: "notFound",
	});
	expect(await processResizePtyHandler({ processHandle: "missing", size: { rows: 24, cols: 80 } }, context)).toEqual({
		ok: false,
		errorKey: "notFound",
	});
	expect(await processSpawnHandler({ command: [], processHandle: "bad", cwd: tempDir }, context)).toEqual({
		ok: false,
		errorKey: "invalidParams",
	});
	expect(
		await processSpawnHandler({ command: [process.execPath], processHandle: "bad-cwd", cwd: "relative" }, context),
	).toEqual({
		ok: false,
		errorKey: "invalidParams",
	});
	expect(await processWriteStdinHandler({}, context)).toEqual({ ok: false, errorKey: "invalidParams" });
	expect(await processResizePtyHandler({ processHandle: "x", size: { rows: 0 } }, context)).toEqual({
		ok: false,
		errorKey: "invalidParams",
	});
});

test("processHandlers exposes every client process request handler", () => {
	expect(Object.keys(processHandlers).sort()).toEqual([
		"process/kill",
		"process/resizePty",
		"process/spawn",
		"process/writeStdin",
	]);
});
