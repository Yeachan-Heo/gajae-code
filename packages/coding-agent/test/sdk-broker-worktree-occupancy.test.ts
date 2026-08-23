import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { lifecycleTargetForTest } from "../src/sdk/broker/broker";
import { worktreeOccupantForTest } from "../src/sdk/broker/lifecycle";
import type { IndexedSession } from "../src/sdk/broker/session-index";

const WORKTREE = "/repos/app.gajae-code-worktrees/main-0d6e4079";
const OTHER_WORKTREE = "/repos/app.gajae-code-worktrees/task-b-1a2b3c4d";

function session(overrides: Partial<IndexedSession> & { sessionId: string; repo: string }): IndexedSession {
	const { repo, ...rest } = overrides;
	return {
		locator: { repo, stateRoot: `${repo}/.gjc/state` },
		endpointGeneration: 1,
		pid: 4242,
		live: true,
		indexSeq: 1,
		identityProvenance: "composite",
		ambiguous: false,
		terminal: false,
		...rest,
	};
}

const alive = () => "alive" as const;
const exited = () => "exited" as const;
const uncertain = () => "uncertain" as const;

describe("worktree occupancy", () => {
	it("serializes same-worktree lifecycle launches together", () => {
		const source = "/repos/app";
		expect(lifecycleTargetForTest("session.create", { cwd: source, worktree: { name: "same-worktree" } })).toEqual(
			lifecycleTargetForTest("session.create", { cwd: source, worktree: { name: "same-worktree" } }),
		);
		expect(
			lifecycleTargetForTest("session.create", { cwd: source, worktree: { name: "same-worktree" } }),
		).not.toEqual(lifecycleTargetForTest("session.create", { cwd: source, worktree: { name: "other-worktree" } }));
	});

	it("reports the live session holding the worktree", () => {
		const sessions = [session({ sessionId: "holder", repo: WORKTREE })];

		expect(worktreeOccupantForTest(sessions, WORKTREE, alive)).toBe("holder");
	});

	it("ignores sessions in a different worktree", () => {
		const sessions = [session({ sessionId: "elsewhere", repo: OTHER_WORKTREE })];

		expect(worktreeOccupantForTest(sessions, WORKTREE, alive)).toBeNull();
	});

	it("matches worktrees that differ only by path spelling", () => {
		const sessions = [session({ sessionId: "holder", repo: `${WORKTREE}/../${path.basename(WORKTREE)}` })];

		expect(worktreeOccupantForTest(sessions, WORKTREE, alive)).toBe("holder");
	});

	it("matches an existing worktree through a symlink alias", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-worktree-occupancy-"));
		const worktree = path.join(root, "worktree");
		const alias = path.join(root, "worktree-alias");
		try {
			await fs.mkdir(worktree);
			await fs.symlink(worktree, alias);
			expect(worktreeOccupantForTest([session({ sessionId: "holder", repo: alias })], worktree, alive)).toBe(
				"holder",
			);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("uses the host incarnation when probing a composite holder", () => {
		const holder = session({
			sessionId: "holder",
			repo: WORKTREE,
			processIncarnation: "process-incarnation",
			hostIncarnation: "host-incarnation",
		});
		const observed: string[] = [];

		expect(
			worktreeOccupantForTest([holder], WORKTREE, (_pid, incarnation) => {
				if (incarnation) observed.push(incarnation);
				return "alive";
			}),
		).toBe("holder");
		expect(observed).toEqual(["host-incarnation"]);
	});

	it("releases the worktree once the owning process has exited", () => {
		// This is the common case: a crashed or killed session must not park the
		// worktree forever, which is why liveness is observed and not assumed.
		const sessions = [session({ sessionId: "crashed", repo: WORKTREE })];

		expect(worktreeOccupantForTest(sessions, WORKTREE, exited)).toBeNull();
	});

	it("treats an unverifiable process as still holding the worktree", () => {
		// Refusing a launch is recoverable by choosing another worktree name;
		// two live sessions sharing one checkout corrupts work already done.
		const sessions = [session({ sessionId: "unverifiable", repo: WORKTREE })];

		expect(worktreeOccupantForTest(sessions, WORKTREE, uncertain)).toBe("unverifiable");
	});

	it("ignores rows the index already settled as not live or terminal", () => {
		const sessions = [
			session({ sessionId: "not-live", repo: WORKTREE, live: false }),
			session({ sessionId: "terminal", repo: WORKTREE, terminal: true }),
		];

		// A settled row must not be probed back to life by the process observer.
		expect(worktreeOccupantForTest(sessions, WORKTREE, alive)).toBeNull();
	});

	it("finds the live holder among settled rows for the same worktree", () => {
		const sessions = [
			session({ sessionId: "stale-1", repo: WORKTREE, live: false }),
			session({ sessionId: "stale-2", repo: WORKTREE, terminal: true }),
			session({ sessionId: "holder", repo: WORKTREE }),
		];

		expect(worktreeOccupantForTest(sessions, WORKTREE, alive)).toBe("holder");
	});
});
