import { describe, expect, it } from "bun:test";
import * as os from "node:os";

import {
	formatLifecycleOutcome,
	isLifecycleCommandText,
	lifecycleUsage,
	normalizeLifecyclePath,
	parseLifecycleCommand,
	validateLifecycleTarget,
} from "@gajae-code/coding-agent/sdk/bus/lifecycle-commands";

describe("lifecycle command parser (G009)", () => {
	it("detects lifecycle command text", () => {
		expect(isLifecycleCommandText("/session_create path /repo")).toBe(true);
		expect(isLifecycleCommandText("/session_recent")).toBe(true);
		expect(isLifecycleCommandText("hello")).toBe(false);
		expect(isLifecycleCommandText("/sessionate")).toBe(false);
		expect(isLifecycleCommandText(undefined)).toBe(false);
	});

	it("parses all three create target kinds", () => {
		expect(parseLifecycleCommand("/session_create path /repo")).toEqual({
			kind: "create",
			target: { kind: "existing_path", path: "/repo" },
		});
		expect(parseLifecycleCommand("/session_create worktree /repo feat/x")).toEqual({
			kind: "create",
			target: { kind: "worktree", repo: "/repo", branch: "feat/x" },
		});
		expect(parseLifecycleCommand("/session_create dir /new/dir")).toEqual({
			kind: "create",
			target: { kind: "plain_dir", path: "/new/dir" },
		});
	});

	it("expands own-home tilde paths for create targets", () => {
		const home = os.homedir();

		expect(parseLifecycleCommand("/session_create path ~/projects/work")).toEqual({
			kind: "create",
			target: { kind: "existing_path", path: `${home}/projects/work` },
		});
		expect(parseLifecycleCommand("/session_create dir ~/scratch/new")).toEqual({
			kind: "create",
			target: { kind: "plain_dir", path: `${home}/scratch/new` },
		});
		expect(parseLifecycleCommand("/session_create worktree ~/projects/repo feat/x")).toEqual({
			kind: "create",
			target: { kind: "worktree", repo: `${home}/projects/repo`, branch: "feat/x" },
		});
		expect(normalizeLifecyclePath("~")).toBe(home);
	});

	it("parses close, resume, and recent", () => {
		expect(parseLifecycleCommand("/session_close sess-1")).toEqual({
			kind: "close",
			target: { sessionId: "sess-1" },
		});
		expect(parseLifecycleCommand("/session_resume abc")).toEqual({
			kind: "resume",
			target: { sessionIdOrPrefix: "abc" },
		});
		expect(parseLifecycleCommand("/session_recent")).toEqual({ kind: "recent", which: "all" });
		expect(parseLifecycleCommand("/session_recent create")).toEqual({ kind: "recent", which: "create" });
	});
	it("accepts only this bot's Telegram username suffix in non-private chats", () => {
		const groupCtx = { chatType: "supergroup", botUsername: "GajaeCodeBot" };
		expect(isLifecycleCommandText("/session_recent@GajaeCodeBot", groupCtx)).toBe(true);
		expect(parseLifecycleCommand("/session_recent@GajaeCodeBot", groupCtx)).toEqual({
			kind: "recent",
			which: "all",
		});
		expect(parseLifecycleCommand("/session_create@GajaeCodeBot path /repo", groupCtx)).toEqual({
			kind: "create",
			target: { kind: "existing_path", path: "/repo" },
		});
		expect(parseLifecycleCommand("/session_create@GajaeCodeBot worktree /repo feat/x", groupCtx)).toEqual({
			kind: "create",
			target: { kind: "worktree", repo: "/repo", branch: "feat/x" },
		});
		expect(parseLifecycleCommand("/session_create@GajaeCodeBot dir /new/dir", groupCtx)).toEqual({
			kind: "create",
			target: { kind: "plain_dir", path: "/new/dir" },
		});
		expect(parseLifecycleCommand("/session_close@GajaeCodeBot sess-1", groupCtx)).toEqual({
			kind: "close",
			target: { sessionId: "sess-1" },
		});
		expect(parseLifecycleCommand("/session_resume@GajaeCodeBot abc", groupCtx)).toEqual({
			kind: "resume",
			target: { sessionIdOrPrefix: "abc" },
		});
		expect(
			parseLifecycleCommand("/session_recent@GajaeCodeBot", { chatType: "group", botUsername: "gajaecodebot" }),
		).toEqual({
			kind: "recent",
			which: "all",
		});
		expect(parseLifecycleCommand("/session_recent", groupCtx)).toEqual({ kind: "none" });
		expect(parseLifecycleCommand("/session_recent@OtherBot", groupCtx)).toEqual({ kind: "none" });
		expect(parseLifecycleCommand("/session_recent@GajaeCodeBot", { chatType: "supergroup" })).toEqual({
			kind: "none",
		});
	});

	it("rejects an initial prompt (MVP) with usage and no frame", () => {
		const out = parseLifecycleCommand("/session_create path /repo -- do the thing");
		expect(out.kind).toBe("reject");
		if (out.kind === "reject") {
			expect(out.reason).toBe("prompt_unsupported");
			// The raw prompt text must NOT be echoed back.
			expect(out.message).not.toContain("do the thing");
		}
	});

	it("returns usage for missing args, not a side effect", () => {
		expect(parseLifecycleCommand("/session_create").kind).toBe("usage");
		expect(parseLifecycleCommand("/session_create path").kind).toBe("usage");
		expect(parseLifecycleCommand("/session_close").kind).toBe("usage");
		expect(parseLifecycleCommand("/session_create worktree /repo").kind).toBe("usage");
		expect(lifecycleUsage()).toContain("/session_create");
	});

	it("rejects injection-shaped paths / branches / ids", () => {
		expect(parseLifecycleCommand("/session_create path /repo;rm").kind).toBe("reject");
		expect(parseLifecycleCommand("/session_create worktree /repo ../evil").kind).toBe("reject");
		expect(parseLifecycleCommand("/session_close bad id with spaces").kind).toBe("usage");
		expect(parseLifecycleCommand("/session_close a$(whoami)").kind).toBe("reject");
	});

	it("rejects unsupported named-user tilde paths", () => {
		expect(parseLifecycleCommand("/session_create path ~other/repo").kind).toBe("reject");
		expect(validateLifecycleTarget("session_create", { kind: "existing_path", path: "~other/repo" }).ok).toBe(false);
	});

	it("requires exact arity for create (rejects trailing tokens)", () => {
		// Trailing benign text -> usage (no create intent leaks through).
		expect(parseLifecycleCommand("/session_create path /repo extra").kind).toBe("usage");
		expect(parseLifecycleCommand("/session_create dir /new junk here").kind).toBe("usage");
		expect(parseLifecycleCommand("/session_create worktree /repo feat/x extra").kind).toBe("usage");
		// Trailing metacharacter token must NOT produce a create.
		expect(parseLifecycleCommand("/session_create path /repo ; rm -rf").kind).toBe("usage");
		// Exact arity still works.
		expect(parseLifecycleCommand("/session_create path /repo").kind).toBe("create");
		expect(parseLifecycleCommand("/session_create worktree /repo feat/x").kind).toBe("create");
	});

	it("returns none for non-lifecycle text", () => {
		expect(parseLifecycleCommand("just a message").kind).toBe("none");
	});

	it("shared validator agrees with the parser", () => {
		expect(validateLifecycleTarget("session_create", { kind: "existing_path", path: "/repo" }).ok).toBe(true);
		expect(validateLifecycleTarget("session_create", { kind: "worktree", repo: "/r", branch: "../x" }).ok).toBe(
			false,
		);
		expect(validateLifecycleTarget("session_close", { sessionId: "ok-1" }).ok).toBe(true);
		expect(validateLifecycleTarget("session_close", { sessionId: "bad id" }).ok).toBe(false);
		expect(validateLifecycleTarget("session_resume", { sessionIdOrPrefix: "p" }).ok).toBe(true);
	});

	it("formats lifecycle outcomes for every status (G010) with no token/prompt leakage", () => {
		const create = formatLifecycleOutcome({
			type: "session_create_response",
			requestId: "r",
			status: "ok",
			lifecycleRequestId: "r",
			sessionId: "sess-1",
			matchedBy: "spawn_marker",
			endpoint: { url: "ws://x", token: "session-token" },
			topic: { chatId: "42", threadId: "9" },
			target: { kind: "existing_path", path: "/repo" },
		});
		expect(create).toContain("sess-1");
		// Honest MVP copy: we confirm the tmux launch was requested, not that the
		// agent is ready or a Telegram topic was surfaced.
		expect(create).toContain("Launching");
		expect(create).not.toContain("session-token");

		expect(
			formatLifecycleOutcome({
				type: "session_resume_response",
				requestId: "r",
				status: "ok",
				sessionId: "s",
				mode: "cold_restarted",
				endpoint: { url: "", token: "" },
				topic: { chatId: "42", threadId: "9" },
			}),
		).toContain("Cold-restarting");

		const reasons = [
			"unauthorized",
			"rate_limited",
			"duplicate_conflict",
			"invalid_target",
			"spawn_failed",
			"discovery_timeout",
			"readiness_timeout",
			"close_refused",
			"not_found",
			"terminal_uncertain",
			"unsupported_platform",
		] as const;
		for (const reason of reasons) {
			const out = formatLifecycleOutcome({
				type: "session_lifecycle_error",
				requestId: "r",
				status: "error",
				reason,
				message: "detail",
			});
			expect(out.length).toBeGreaterThan(0);
		}

		// "in progress" terminal_uncertain is surfaced distinctly (pending).
		expect(
			formatLifecycleOutcome({
				type: "session_lifecycle_error",
				requestId: "r",
				status: "error",
				reason: "terminal_uncertain",
				message: "request already in progress",
			}),
		).toMatch(/in progress/i);

		const uncertain = {
			type: "session_lifecycle_error",
			requestId: "r",
			status: "error",
			reason: "terminal_uncertain",
			message: "outcome unknown",
		} as const;
		const createUncertain = formatLifecycleOutcome(uncertain, "session_create");
		expect(createUncertain).toContain("already be starting");
		expect(createUncertain).toContain("starting it twice");

		const closeUncertain = formatLifecycleOutcome(uncertain, "session_close");
		expect(closeUncertain).toContain("already be closed");
		expect(closeUncertain).not.toContain("starting it twice");

		const resumeUncertain = formatLifecycleOutcome(uncertain, "session_resume");
		expect(resumeUncertain).toContain("reattached or restarting");
		expect(resumeUncertain).not.toContain("starting it twice");

		const genericUncertain = formatLifecycleOutcome(uncertain);
		expect(genericUncertain).not.toContain("starting it twice");

		// ambiguous_target lists candidates.
		const amb = formatLifecycleOutcome({
			type: "session_lifecycle_error",
			requestId: "r",
			status: "error",
			reason: "ambiguous_target",
			message: "multiple",
			candidates: [{ sessionId: "a" }, { sessionId: "b", path: "/r" }],
		});
		expect(amb).toContain("a");
		expect(amb).toContain("b");
	});
	it("formats unsupported platform with the exact safe lifecycle copy", () => {
		const output = formatLifecycleOutcome({
			type: "session_lifecycle_error",
			requestId: "request-1",
			status: "error",
			reason: "unsupported_platform",
			message: "ignored",
		});
		expect(output).toBe(
			"Remote session lifecycle is unavailable on this psmux host because GJC cannot prove immutable session identity. No lifecycle action was performed. Use a local GJC terminal with a supported tmux provider.",
		);
		expect(output).not.toContain("request-1");
		expect(output).not.toContain("chat");
		expect(output).not.toContain("token");
		expect(output).not.toContain("/");
	});

	it("preserves legacy ambiguous candidate path output", () => {
		const output = formatLifecycleOutcome({
			type: "session_lifecycle_error",
			requestId: "r",
			status: "error",
			reason: "ambiguous_target",
			message: "multiple",
			candidates: [{ sessionId: "a", path: "/legacy/path" }],
		});
		expect(output).toBe("❓ Multiple sessions match — reply with the exact id:\n• a (/legacy/path)");
	});

	it("parses --mpreset for all create target kinds (space-separated)", () => {
		expect(parseLifecycleCommand("/session_create path /repo --mpreset codex-eco")).toEqual({
			kind: "create",
			target: { kind: "existing_path", path: "/repo" },
			modelPreset: "codex-eco",
		});
		expect(parseLifecycleCommand("/session_create dir /new/dir --mpreset claude-opus")).toEqual({
			kind: "create",
			target: { kind: "plain_dir", path: "/new/dir" },
			modelPreset: "claude-opus",
		});
		expect(parseLifecycleCommand("/session_create worktree /repo feat/x --mpreset opencodego")).toEqual({
			kind: "create",
			target: { kind: "worktree", repo: "/repo", branch: "feat/x" },
			modelPreset: "opencodego",
		});
	});

	it("parses --mpreset=<name> (equals-separated) form", () => {
		expect(parseLifecycleCommand("/session_create path /repo --mpreset=codex-medium")).toEqual({
			kind: "create",
			target: { kind: "existing_path", path: "/repo" },
			modelPreset: "codex-medium",
		});
	});

	it("omits modelPreset when --mpreset is not given", () => {
		const out = parseLifecycleCommand("/session_create path /repo");
		expect(out.kind).toBe("create");
		if (out.kind === "create") {
			expect(out.modelPreset).toBeUndefined();
		}
	});

	it("preserves quoted and punctuation-bearing exact --mpreset IDs without shell interpretation", () => {
		expect(parseLifecycleCommand(`/session_create path /repo --mpreset "custom profile/한글 !"`)).toEqual({
			kind: "create",
			target: { kind: "existing_path", path: "/repo" },
			modelPreset: "custom profile/한글 !",
		});
		expect(parseLifecycleCommand("/session_create path /repo --mpreset 'bad;rm'")).toMatchObject({
			kind: "create",
			modelPreset: "bad;rm",
		});
		expect(parseLifecycleCommand(`/session_create path /repo --mpreset "unterminated`).kind).toBe("usage");
	});

	it("usage text includes --mpreset", () => {
		expect(lifecycleUsage()).toContain("--mpreset");
	});
});
