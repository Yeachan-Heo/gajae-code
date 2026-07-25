import { afterEach, describe, expect, it, mock } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { coordinatorStatePaths, initializeCoordinatorNamespace } from "../src/coordinator-mcp/question-state";
import { createCoordinatorMcpServer } from "../src/coordinator-mcp/server";

// Plain snapshot BEFORE any module mock: Bun patches the live namespace, so
// restoring with the namespace object itself would restore the mock.
const realDirectorySync = { ...(await import("../src/utils/directory-sync")) };

function installBarrierMock(impl: (directory: string) => Promise<void>): string[] {
	const calls: string[] = [];
	mock.module("../src/utils/directory-sync", () => ({
		...realDirectorySync,
		syncDirectoryBestEffort: (directory: string) => {
			calls.push(directory);
			return impl(directory);
		},
	}));
	return calls;
}

function errnoError(code: string): NodeJS.ErrnoException {
	const error = new Error(`${code}: injected`) as NodeJS.ErrnoException;
	error.code = code;
	return error;
}

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
	const dir = mkdtempSync(path.join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	mock.module("../src/utils/directory-sync", () => realDirectorySync);
	mock.restore();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("coordinator question-state directory barrier", () => {
	it("initializes the namespace registry through the shared directory barrier", async () => {
		const calls = installBarrierMock(async () => {});
		const stateRoot = tempDir("gjc-question-state-sync-");
		const paths = coordinatorStatePaths(stateRoot, "ns-test");
		await initializeCoordinatorNamespace(paths);
		expect(existsSync(paths.registry)).toBe(true);
		expect(calls).toContain(path.dirname(paths.registry));
	});

	it("fails namespace initialization when the directory barrier reports an unclassified failure", async () => {
		installBarrierMock(async () => {
			throw errnoError("EACCES");
		});
		const stateRoot = tempDir("gjc-question-state-sync-fail-");
		await expect(initializeCoordinatorNamespace(coordinatorStatePaths(stateRoot, "ns-test"))).rejects.toMatchObject({
			code: "EACCES",
		});
	});
});

describe("coordinator idempotency-record directory barrier", () => {
	function server(root: string, stateRoot: string) {
		return createCoordinatorMcpServer({
			env: {
				GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
				GJC_COORDINATOR_MCP_STATE_ROOT: stateRoot,
				GJC_COORDINATOR_MCP_MUTATIONS: "reports",
			},
		});
	}

	it("persists mutation idempotency records through the shared directory barrier", async () => {
		const calls = installBarrierMock(async () => {});
		const root = tempDir("gjc-coordinator-report-sync-");
		const stateRoot = tempDir("gjc-coordinator-report-state-");
		const response = await server(root, stateRoot).callTool("gjc_coordinator_report_status", {
			status: "blocked",
			summary: "Awaiting directory-barrier regression evidence.",
			idempotency_key: "report-sync-1",
			allow_mutation: true,
		});
		expect(response).toMatchObject({ ok: true, report: { status: "blocked" } });
		expect(calls.some(directory => directory.endsWith("idempotency"))).toBe(true);
	});

	it("fails the mutation when the idempotency directory barrier reports an unclassified failure", async () => {
		installBarrierMock(async directory => {
			if (directory.endsWith("idempotency")) throw errnoError("EACCES");
		});
		const root = tempDir("gjc-coordinator-report-sync-fail-");
		const stateRoot = tempDir("gjc-coordinator-report-state-fail-");
		const response = await server(root, stateRoot).callTool("gjc_coordinator_report_status", {
			status: "blocked",
			summary: "Must fail closed.",
			idempotency_key: "report-sync-2",
			allow_mutation: true,
		});
		expect(response).toMatchObject({ ok: false });
	});
});
