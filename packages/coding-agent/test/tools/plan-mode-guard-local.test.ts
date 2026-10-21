import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, getLocalRootsDir } from "@gajae-code/utils";
import type { PlanModeState } from "../../src/plan-mode/state";
import type { ToolSession } from "../../src/tools";
import { enforcePlanModeWrite, resolvePlanPath } from "../../src/tools/plan-mode-guard";

interface SessionOverrides {
	artifactsDir?: string | null;
	sessionId?: string | null;
	cwd?: string;
	planMode?: PlanModeState;
}

function makeSession(overrides: SessionOverrides): ToolSession {
	return {
		cwd: overrides.cwd ?? "/repo",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: {
			getAgentDir,
			getPlansDirectory: () => "/plans",
		},
		getArtifactsDir: () => overrides.artifactsDir ?? null,
		getSessionId: () => overrides.sessionId ?? null,
		getPlanModeState: () => overrides.planMode,
	} as unknown as ToolSession;
}

describe("resolvePlanPath local:// support", () => {
	it("resolves local:// paths under session artifacts local root", () => {
		const session = makeSession({ artifactsDir: "/tmp/agent-artifacts", sessionId: "abc" });
		expect(resolvePlanPath(session, "local://handoffs/result.json")).toBe(
			path.join("/tmp/agent-artifacts", "local", "handoffs", "result.json"),
		);
	});

	it("uses the persistent managed local root when artifacts dir is unavailable", async () => {
		const sessionId = `session-${crypto.randomUUID()}`;
		const session = makeSession({ artifactsDir: null, sessionId });
		const root = path.join(getLocalRootsDir(), sessionId);
		try {
			expect(resolvePlanPath(session, "local://memo.txt")).toBe(path.join(root, "memo.txt"));
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});

describe("resolvePlanPath plan-mode redirect", () => {
	const planMode: PlanModeState = { enabled: true, planFilePath: "local://PLAN.md" };

	it("redirects bare PLAN.md to the session plan path when plan mode is active", () => {
		const session = makeSession({ artifactsDir: "/tmp/agent-artifacts", planMode });
		expect(resolvePlanPath(session, "PLAN.md")).toBe(path.join("/tmp/agent-artifacts", "local", "PLAN.md"));
	});

	it("redirects ./PLAN.md and absolute cwd-PLAN.md alike", () => {
		const session = makeSession({ artifactsDir: "/tmp/agent-artifacts", cwd: "/repo", planMode });
		const expected = path.join("/tmp/agent-artifacts", "local", "PLAN.md");
		expect(resolvePlanPath(session, "./PLAN.md")).toBe(expected);
		expect(resolvePlanPath(session, "/repo/PLAN.md")).toBe(expected);
	});

	it("does not redirect when plan mode is disabled", () => {
		const session = makeSession({ artifactsDir: "/tmp/agent-artifacts", cwd: "/repo" });
		expect(resolvePlanPath(session, "PLAN.md")).toBe(path.join("/repo", "PLAN.md"));
	});

	it("does not redirect paths whose basename differs from the plan basename", () => {
		const session = makeSession({ artifactsDir: "/tmp/agent-artifacts", cwd: "/repo", planMode });
		expect(resolvePlanPath(session, "src/foo.ts")).toBe(path.join("/repo", "src/foo.ts"));
	});

	it("leaves an explicit local://PLAN.md unchanged", () => {
		const session = makeSession({ artifactsDir: "/tmp/agent-artifacts", planMode });
		expect(resolvePlanPath(session, "local://PLAN.md")).toBe(path.join("/tmp/agent-artifacts", "local", "PLAN.md"));
	});
});

describe("enforcePlanModeWrite plan-mode redirect", () => {
	const planMode: PlanModeState = { enabled: true, planFilePath: "local://PLAN.md" };

	it("accepts bare PLAN.md as a write to the plan file", () => {
		const session = makeSession({ artifactsDir: "/tmp/agent-artifacts", planMode });
		expect(() => enforcePlanModeWrite(session, "PLAN.md", { op: "update" })).not.toThrow();
	});

	it("still rejects non-plan paths in plan mode", () => {
		const session = makeSession({ artifactsDir: "/tmp/agent-artifacts", planMode });
		expect(() => enforcePlanModeWrite(session, "src/foo.ts", { op: "update" })).toThrow(
			/only the plan file may be modified/,
		);
	});

	it("rejects deletes of PLAN.md even when basename matches", () => {
		const session = makeSession({ artifactsDir: "/tmp/agent-artifacts", planMode });
		expect(() => enforcePlanModeWrite(session, "PLAN.md", { op: "delete" })).toThrow(
			/Plan mode: deleting files is not allowed/,
		);
	});
});
