import { describe, expect, test } from "bun:test";
import {
	activeTurnId,
	deriveStatus,
	deriveTurnActivity,
	escapeHtml,
	findSessionView,
	formatRelativeTime,
	isTerminalStatus,
	isWithinRetention,
	projectSessionRows,
	projectSessionSummaries,
	RETENTION_DEFAULT_MS,
	renderSessionsList,
	renderSessionsListHtml,
	renderSessionView,
	renderSessionViewHtml,
	shortSessionId,
} from "../src/projection";
import type { CoordinationStatus, RawRecord, SessionStatus } from "../src/types";

function status(parts: Partial<CoordinationStatus>): CoordinationStatus {
	return { ok: true, sessions: [], sessionStates: [], turns: [], ...parts };
}

describe("deriveStatus taxonomy mapping (locked fixtures)", () => {
	// [name, sessionState, activeTurn, latestTurn, expected]
	const cases: Array<[string, RawRecord | null, RawRecord | null, RawRecord | null, SessionStatus]> = [
		["running state -> working", { state: "running", live: true }, null, null, "working"],
		[
			"active turn -> working",
			{ state: "running", live: true },
			{ status: "active" },
			{ status: "active" },
			"working",
		],
		["delivering turn -> working", { state: "running", live: true }, { status: "delivering" }, null, "working"],
		[
			"completing turn -> working",
			{ state: "running", live: true },
			{ status: "completing" },
			{ status: "completing" },
			"working",
		],
		["queued turn -> working", { state: "running", live: true }, null, { status: "queued" }, "working"],
		["queued turn (no state) -> working", null, null, { status: "queued" }, "working"],
		["ready_for_input state -> working", { state: "ready_for_input", live: true }, null, null, "working"],
		[
			"waiting_for_answer turn -> waiting_for_input",
			{ state: "running", live: true },
			{ status: "waiting_for_answer" },
			{ status: "waiting_for_answer" },
			"waiting_for_input",
		],
		[
			"needs_user_input state -> waiting_for_input",
			{ state: "needs_user_input", live: true },
			null,
			null,
			"waiting_for_input",
		],
		[
			"explicit blocked state -> blocked",
			{ state: "blocked", live: true, reason: "waiting on dep" },
			null,
			null,
			"blocked",
		],
		["blocked flag -> blocked", { state: "running", live: true, blocked: true }, null, null, "blocked"],
		["completed state -> done", { state: "completed", live: true }, null, { status: "completed" }, "done"],
		["superseded latest turn -> done", null, null, { status: "superseded" }, "done"],
		["completed latest turn (no state) -> done", null, null, { status: "completed" }, "done"],
		["errored state -> failed", { state: "errored", live: true }, null, null, "failed"],
		["failed latest turn -> failed", null, null, { status: "failed" }, "failed"],
		["cancelled latest turn -> cancelled", null, null, { status: "cancelled" }, "cancelled"],
		["live:false -> dead", { state: "running", live: false }, null, null, "dead"],
		["stale state -> dead", { state: "stale", live: true }, null, null, "dead"],
		["unavailable state -> dead", { state: "unavailable", live: true }, null, null, "dead"],
		["dead retained state -> dead", { state: "dead", live: true }, null, null, "dead"],
		["no state / no turns -> working (present but unknown)", null, null, null, "working"],
		["unknown coordinator state -> working", { state: "unknown_future_state", live: true }, null, null, "working"],
	];
	for (const [label, sessionState, activeTurn, latestTurn, expected] of cases) {
		test(label, () => {
			expect(deriveStatus(sessionState, activeTurn, latestTurn)).toBe(expected);
		});
	}
});

describe("deriveStatus blocked-vs-waiting-vs-failed edges", () => {
	test("waiting_for_answer turn does not collapse into failed even if state is errored", () => {
		expect(
			deriveStatus({ state: "errored", live: true }, { status: "waiting_for_answer" }, { status: "failed" }),
		).toBe("waiting_for_input");
	});
	test("errored state does not become waiting_for_input without a waiting signal", () => {
		expect(deriveStatus({ state: "errored", live: true }, null, null)).toBe("failed");
	});
	test("an explicit blocker reason maps to blocked, not generic working/done", () => {
		expect(deriveStatus({ state: "blocked", live: true, reason: "blocked on review" }, null, null)).toBe("blocked");
	});
});

describe("deriveTurnActivity", () => {
	test("classifies the active turn", () => {
		expect(deriveTurnActivity([{ status: "active" }], { status: "active" })).toBe("active");
		expect(deriveTurnActivity([{ status: "waiting_for_answer" }], { status: "waiting_for_answer" })).toBe(
			"waiting_for_answer",
		);
	});
	test("falls back to queued, terminal, then none", () => {
		expect(deriveTurnActivity([{ status: "queued" }], null)).toBe("queued");
		expect(deriveTurnActivity([{ status: "completed" }], null)).toBe("terminal");
		expect(deriveTurnActivity([], null)).toBe("none");
	});
});

describe("isTerminalStatus", () => {
	test("terminal statuses are done/failed/cancelled/dead", () => {
		for (const s of ["done", "failed", "cancelled", "dead"] as SessionStatus[]) {
			expect(isTerminalStatus(s)).toBe(true);
		}
		for (const s of ["working", "waiting_for_input", "blocked"] as SessionStatus[]) {
			expect(isTerminalStatus(s)).toBe(false);
		}
	});
});

describe("shortSessionId display id", () => {
	test("ids <= 12 chars stay as-is", () => {
		expect(shortSessionId("sess-1")).toBe("sess-1");
		expect(shortSessionId("123456789012")).toBe("123456789012");
	});
	test("long ids collapse to first8…last4 and never expose the full raw id", () => {
		const raw = `sess:${"y".repeat(80)}`;
		const short = shortSessionId(raw);
		expect(short).toBe(`sess:yyy…yyyy`);
		expect(short.length).toBeLessThanOrEqual(13);
		expect(raw).not.toBe(short);
	});
});

describe("formatRelativeTime", () => {
	const now = Date.parse("2026-06-15T12:00:00.000Z");
	test("renders coarse minutes/hours/days and just now", () => {
		expect(formatRelativeTime("2026-06-15T11:59:30.000Z", now)).toBe("just now");
		expect(formatRelativeTime("2026-06-15T11:55:00.000Z", now)).toBe("5m ago");
		expect(formatRelativeTime("2026-06-15T10:00:00.000Z", now)).toBe("2h ago");
		expect(formatRelativeTime("2026-06-12T12:00:00.000Z", now)).toBe("3d ago");
	});
	test("invalid/missing/future timestamps fall back to withheld or just now", () => {
		expect(formatRelativeTime(null, now)).toBe("(withheld on PC)");
		expect(formatRelativeTime("INJECTED_NOT_A_TIMESTAMP", now)).toBe("(withheld on PC)");
		// Future instant clamps to just now (never a negative duration).
		expect(formatRelativeTime("2026-06-15T13:00:00.000Z", now)).toBe("just now");
	});
});

describe("isWithinRetention (terminal/dead 24h eligibility)", () => {
	const now = Date.parse("2026-06-15T12:00:00.000Z");
	test("live (non-terminal) statuses are always eligible", () => {
		expect(isWithinRetention("working", null, now)).toBe(true);
		expect(isWithinRetention("waiting_for_input", null, now)).toBe(true);
	});
	test("terminal sessions retained until last activity older than the window", () => {
		expect(isWithinRetention("done", "2026-06-15T11:00:00.000Z", now)).toBe(true);
		expect(isWithinRetention("dead", "2026-06-14T11:00:00.000Z", now, RETENTION_DEFAULT_MS)).toBe(false);
		expect(isWithinRetention("failed", null, now)).toBe(false);
		expect(isWithinRetention("cancelled", "INJECTED_NOT_A_TIMESTAMP", now)).toBe(false);
	});
});

describe("display name and timestamp", () => {
	test("repo + branch render repo@branch", () => {
		const [summary] = projectSessionSummaries(
			status({
				sessions: [{ session_id: "sess-1", repo: "proj", branch: "feat/x" }],
				sessionStates: [{ session_id: "sess-1", state: "running", live: true }],
			}),
		);
		expect(summary?.name).toBe("proj@feat/x");
	});
	test("missing repo/branch falls back to first8…last4 and the long raw id is absent from rendered text", () => {
		const raw = `sess:gjc-${"z".repeat(60)}`;
		const coordination = status({
			sessions: [{ session_id: raw }],
			sessionStates: [{ session_id: raw, state: "running", live: true }],
		});
		const [summary] = projectSessionSummaries(coordination);
		expect(summary?.name).toBe(shortSessionId(raw));
		const rendered = renderSessionsList(projectSessionSummaries(coordination));
		expect(rendered).not.toContain(raw);
		expect(rendered).toContain("…");
	});
	test("the session view renders relative time when a clock is injected", () => {
		const now = Date.parse("2026-06-15T12:00:00.000Z");
		const view = findSessionView(
			status({
				sessions: [{ session_id: "sess-1", repo: "proj", branch: "feat/x" }],
				sessionStates: [
					{ session_id: "sess-1", state: "running", live: true, updated_at: "2026-06-15T10:00:00.000Z" },
				],
			}),
			"sess-1",
		);
		expect(view).not.toBeNull();
		const rendered = view ? renderSessionView(view, now) : "";
		expect(rendered).toContain("last: 2h ago");
		expect(rendered).not.toContain("2026-06-15T10:00:00.000Z");
	});
});

describe("transmitted-data allowlist (redaction)", () => {
	// A session record stuffed with everything that must NEVER reach chat.
	const hostileSession: RawRecord = {
		session_id: "sess-1",
		branch: "feat/x",
		repo: "proj",
		cwd: "/secret/abs/path/to/repo",
		model: "claude-opus-secret",
		tail_preview: ["SECRET_TAIL_LINE", "$ export TOKEN=sk-SECRET"],
		last_content: "RAW_SCROLLBACK_LINE",
		final_response: { text: "TRANSCRIPT_BODY_SECRET" },
		prompt: "USER_PROMPT_TEXT_SECRET",
		env: { TOKEN: "sk-SECRET", OPENAI_API_KEY: "sk-leak" },
	};
	const hostileState: RawRecord = {
		session_id: "sess-1",
		state: "running",
		live: true,
		updated_at: "2026-06-15T00:00:00.000Z",
		current_turn_id: "turn-1",
		reason: "INTERNAL_REASON_SECRET",
	};
	const hostileTurn: RawRecord = {
		session_id: "sess-1",
		status: "active",
		turn_id: "turn-1",
		prompt: { text: "PROMPT_BODY_SECRET" },
		final_response: { text: "RESPONSE_BODY_SECRET" },
	};
	const FORBIDDEN = [
		"SECRET_TAIL_LINE",
		"RAW_SCROLLBACK_LINE",
		"TRANSCRIPT_BODY_SECRET",
		"USER_PROMPT_TEXT_SECRET",
		"PROMPT_BODY_SECRET",
		"RESPONSE_BODY_SECRET",
		"sk-SECRET",
		"sk-leak",
		"/secret/abs/path/to/repo",
		"claude-opus-secret",
		"INTERNAL_REASON_SECRET",
	];

	const coordination = status({ sessions: [hostileSession], sessionStates: [hostileState], turns: [hostileTurn] });

	test("projected summary contains only allowlisted fields", () => {
		const [summary] = projectSessionSummaries(coordination);
		expect(summary).toEqual({
			sessionId: "sess-1",
			name: "proj@feat/x",
			status: "working",
			branch: "feat/x",
			lastActivityAt: "2026-06-15T00:00:00.000Z",
		});
		for (const secret of FORBIDDEN) {
			expect(JSON.stringify(summary)).not.toContain(secret);
		}
	});

	test("rendered list and view never leak forbidden content", () => {
		const summaries = projectSessionSummaries(coordination);
		const view = findSessionView(coordination, "sess-1");
		expect(view).not.toBeNull();
		const rendered = `${renderSessionsList(summaries)}\n${view ? renderSessionView(view) : ""}`;
		for (const secret of FORBIDDEN) {
			expect(rendered).not.toContain(secret);
		}
		// Allowlisted fields are present.
		expect(rendered).toContain("sess-1");
		expect(rendered).toContain("feat/x");
		expect(rendered).toContain("working");
	});

	test("a blocked session surfaces only a sanitized, capped reason", () => {
		const blocked = status({
			sessions: [{ session_id: "sess-2", branch: "main" }],
			sessionStates: [{ session_id: "sess-2", state: "blocked", live: true, reason: "x".repeat(400) }],
			turns: [],
		});
		const view = findSessionView(blocked, "sess-2");
		expect(view?.status).toBe("blocked");
		expect((view?.blockerSummary ?? "").length).toBeLessThanOrEqual(120);
	});

	test("a non-ISO timestamp cannot ride the allowlisted lastActivityAt key", () => {
		const hostile = status({
			sessions: [{ session_id: "sess-3", branch: "main", created_at: "2026-06-15T00:00:00.000Z" }],
			sessionStates: [
				{ session_id: "sess-3", state: "running", live: true, updated_at: "INJECTED_NOT_A_TIMESTAMP" },
			],
			turns: [],
		});
		const [summary] = projectSessionSummaries(hostile);
		// The hostile updated_at is rejected; derivation falls back to the valid created_at.
		expect(summary?.lastActivityAt).toBe("2026-06-15T00:00:00.000Z");
		expect(JSON.stringify(summary)).not.toContain("INJECTED_NOT_A_TIMESTAMP");
	});

	test("activeTurnId returns the coordinator turn id for /stop", () => {
		expect(activeTurnId(coordination, "sess-1")).toBe("turn-1");
		expect(activeTurnId(coordination, "missing")).toBeNull();
	});
});

describe("HTML rendering (rich mode) escaping + exact raw id", () => {
	test("escapeHtml neutralizes parse-mode metacharacters", () => {
		expect(escapeHtml(`<b>&"x"`)).toBe(`&lt;b&gt;&amp;"x"`);
	});

	test("rendered HTML escapes hostile projected fields, including a blocked reason, and leaks no raw fields", () => {
		const hostile = status({
			sessions: [
				{
					session_id: "sess-1",
					repo: "<script>",
					branch: "<img src=x>",
					cwd: "/secret/abs",
					prompt: "PROMPT_LEAK",
				},
			],
			sessionStates: [{ session_id: "sess-1", state: "blocked", live: true, reason: "<b>boom</b>" }],
			turns: [{ session_id: "sess-1", status: "active", turn_id: "t" }],
		});
		const summaries = projectSessionSummaries(hostile);
		const view = findSessionView(hostile, "sess-1");
		expect(view?.status).toBe("blocked");
		const rendered = `${renderSessionsListHtml(summaries)}\n${view ? renderSessionViewHtml(view) : ""}`;
		expect(rendered).not.toContain("<script>");
		expect(rendered).not.toContain("<img");
		expect(rendered).not.toContain("<b>boom</b>");
		expect(rendered).toContain("&lt;");
		expect(rendered).not.toContain("PROMPT_LEAK");
		expect(rendered).not.toContain("/secret/abs");
	});

	test("projectSessionRows keeps the exact raw id while the display summary stays short", () => {
		const rawId = `sess:${"y".repeat(80)}`;
		const rows = projectSessionRows(
			status({
				sessions: [{ session_id: rawId, branch: "main" }],
				sessionStates: [{ session_id: rawId, state: "running", live: true }],
			}),
		);
		expect(rows[0]?.rawSessionId).toBe(rawId);
		expect(rows[0]?.summary.sessionId.length).toBeLessThanOrEqual(13);
		expect(rows[0]?.summary.sessionId).not.toBe(rawId);
	});
});
