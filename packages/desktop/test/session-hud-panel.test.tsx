import { describe, expect, test } from "bun:test";
import type { DesktopSessionInfo, DesktopSessionInfoUsage } from "@gajae-code/desktop-host/session-info-protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionHudPanel, type SessionHudPanelProps } from "../src/SessionHudPanel";

type AvailableInfo = Extract<DesktopSessionInfo, { available: true }>;

function usage(cost: number | null): DesktopSessionInfoUsage {
	return {
		available: true,
		source: "transcript_aggregate",
		note: "Whole transcript",
		tokens: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, total: 30 },
		premiumRequests: null,
		cost: { amount: cost, source: "sdk_recorded_cost", reason: "SDK record" },
	};
}

function info(): AvailableInfo {
	return {
		available: true,
		metadata: {
			catalogSessionId: "catalog-1",
			name: "Fix the release flow",
			sessionFileDisplay: "[redacted]/session.jsonl",
			cwd: "/work/gajae-code",
			createdAt: null,
			persisted: true,
		},
		model: { provider: "anthropic", id: "claude-opus-4-5", name: "Opus 4.5" },
		thinkingLevel: "high",
		run: {
			state: "idle",
			streaming: false,
			bashRunning: false,
			pythonRunning: false,
			compacting: false,
			retrying: false,
			postPromptWork: false,
			queuedMessages: 0,
		},
		tools: { available: 4, pending: 0, calls: 1, results: 1 },
		recordedTotals: usage(1.234),
		activeTotals: { ...usage(1), source: "active_messages" },
		liveProgress: { ...usage(0), source: "stream_partial", cost: { amount: 0, source: "live_partial_cost", reason: "Live" } },
		context: { tokens: 48_000, contextWindow: 128_000, percent: 37.5, source: "provider_anchor", note: "Anchor" },
		accountQuota: { available: false, reason: "No quota" },
		actualBilledCost: { available: false, reason: "No bill" },
		hud: { branch: "feat/hud", jobs: 2, tokensPerSecond: 42.46, version: "1.2.3" },
	};
}

function render(props: Partial<SessionHudPanelProps> = {}): string {
	return renderToStaticMarkup(
		<SessionHudPanel
			info={info()}
			pullRequest={{ number: 7323, url: "https://github.com/acme/app/pull/7323" }}
			onRefresh={() => {
				throw new Error("SSR must not refresh");
			}}
			onOpenPullRequest={() => {
				throw new Error("SSR must not open a link");
			}}
			{...props}
		/>,
	);
}

/** The `<dd>` that follows the tile whose label is `label`. */
function tile(html: string, label: string): string {
	const start = html.indexOf(`${label}</dt><dd>`);
	if (start < 0) throw new Error(`Missing tile: ${label}`);
	const from = start + label.length + "</dt><dd>".length;
	return html.slice(from, html.indexOf("</dd>", from));
}

const UNKNOWN = '<span aria-hidden="true">—</span><span class="sr-only">Unknown</span>';

// SSR proves presentation only; the app shell owns reads, polling and opening links.
describe("desktop session status panel", () => {
	test("shows every TUI status-line field compactly", () => {
		const html = render();
		expect(tile(html, "Model")).toBe("Opus 4.5");
		expect(html).toContain('title="anthropic/claude-opus-4-5"');
		expect(tile(html, "Reasoning")).toBe("high");
		expect(tile(html, "Context")).toContain("37.5%<small> / 128K</small>");
		expect(tile(html, "Context")).toContain('aria-valuetext="37.5%"');
		expect(html).toContain('title="48K / 128K"');
		expect(tile(html, "Cost")).toBe("$1.23");
		expect(tile(html, "Branch")).toBe("feat/hud");
		expect(tile(html, "PR")).toContain(">#7323</button>");
		expect(tile(html, "PR")).toContain('title="https://github.com/acme/app/pull/7323"');
		expect(tile(html, "Jobs")).toBe("2");
		expect(tile(html, "Speed")).toBe("42.5/s");
		expect(tile(html, "Title")).toBe("Fix the release flow");
		expect(tile(html, "Directory")).toBe('<span class="session-hud-path">/work/gajae-code</span>');
		expect(tile(html, "gjc")).toBe("v1.2.3");
		expect(html).not.toMatch(/<a\b|\shref=/u);
	});

	test("shows unknown instead of zero for missing, invalid or unsourced values", () => {
		const value = info();
		value.model = null;
		value.thinkingLevel = null;
		value.metadata.name = null;
		value.recordedTotals = usage(null);
		value.context = { tokens: null, contextWindow: null, percent: 50, source: "unknown", note: "No anchor" };
		value.hud = { branch: null, jobs: 1.5, tokensPerSecond: Number.NaN, version: "1.2.3" };
		const html = render({ info: value, pullRequest: null });
		for (const label of ["Model", "Reasoning", "Context", "Cost", "Branch", "PR", "Jobs", "Speed", "Title"]) {
			expect(tile(html, label)).toContain(UNKNOWN);
		}
		expect(html).not.toContain("<meter");
		expect(html.slice(0, html.indexOf("<details"))).not.toMatch(/NaN|\$0\.00|>0</u);
		const unavailable = { ...info(), recordedTotals: { available: false as const, reason: "Unreadable" } };
		expect(tile(render({ info: unavailable }), "Cost")).toContain(UNKNOWN);
		expect(tile(render({ info: { ...info(), hud: { ...info().hud, jobs: 0 } } }), "Jobs")).toBe("0");
	});

	test("separates a pull request lookup in flight from a branch without one", () => {
		const pending = tile(render({ pullRequest: undefined }), "PR");
		expect(pending).toContain('<span class="sr-only">Loading…</span>');
		expect(pending).not.toContain("<button");
		expect(tile(render({ pullRequest: null }), "PR")).toContain(UNKNOWN);
	});

	test("caps the context meter while keeping the reported percentage", () => {
		const value = info();
		value.context.percent = 104.2;
		const context = tile(render({ info: value }), "Context");
		expect(context).toContain("104.2%");
		expect(context).toContain('value="100"');
	});

	test("keeps refresh usable through reads, errors and unavailable sessions", () => {
		const refresh = /<button\b[^>]*aria-label="Refresh session status"[^>]*>/u;
		const pending = render({ pending: true });
		expect(pending).toContain('aria-busy="true"');
		expect(pending.match(refresh)?.[0]).not.toContain("disabled");
		const failed = render({ error: "Read failed <socket>" });
		expect(failed).toContain('role="alert"');
		expect(failed).toContain("Read failed &lt;socket&gt;");
		expect(tile(failed, "Model")).toBe("Opus 4.5");
		const loading = render({ info: null });
		expect(loading).toContain('role="status"');
		expect(loading).toContain("Loading…");
		expect(loading).not.toContain("session-hud-tile");
		const gone = render({ info: { available: false, code: "disposed", reason: "This session has ended." } });
		expect(gone).toContain('role="alert"');
		expect(gone).toContain("This session has ended.");
		expect(gone).not.toContain("session-hud-tile");
		for (const html of [loading, gone]) expect(html.match(refresh)?.[0]).not.toContain("disabled");
	});

	test("folds the full usage report under details without a second refresh control", () => {
		const html = render();
		const details = html.slice(html.indexOf('<details class="session-hud-details">'));
		expect(details).toContain("<summary>Details</summary>");
		expect(details).toContain("Whole transcript usage · All branches");
		expect(details).not.toContain("Refresh session information");
		expect(details).not.toContain("Read-only view");
		expect(html).not.toContain("<details open");
	});

	test("renders host text inert and bounded", () => {
		const value = info();
		const hostile = '<script>alert(1)</script><img src="x">';
		value.hud.branch = hostile;
		value.metadata.name = `${"t".repeat(238)}𠀀tail`;
		value.metadata.cwd = "p".repeat(400);
		const html = render({ info: value });
		expect(tile(html, "Branch")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=&quot;x&quot;&gt;");
		expect(tile(html, "Title")).toBe(`${"t".repeat(238)}…`);
		expect(tile(html, "Directory")).toContain(`${"p".repeat(239)}…`);
		expect(html).not.toMatch(/<script|<img/u);
	});
});
