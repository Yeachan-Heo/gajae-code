import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type {
	DesktopSessionInfo,
	DesktopSessionInfoUsage,
} from "../../desktop-host/src/session-info-protocol";
import { SessionInfoPanel, type SessionInfoPanelProps } from "../src/SessionInfoPanel";

type AvailableInfo = Extract<DesktopSessionInfo, { available: true }>;

function usage(source: DesktopSessionInfoUsage["source"], total: number | null): DesktopSessionInfoUsage {
	return {
		available: true,
		source,
		note: `${source} actual host aggregate description`,
		tokens: { input: null, output: 0, cacheRead: null, cacheWrite: 0, total },
		premiumRequests: null,
		cost: {
			amount: null,
			source: source === "stream_partial" ? "live_partial_cost" : "sdk_recorded_cost",
			reason: "No pricing evidence, so the cost is unknown",
		},
	};
}

function info(): AvailableInfo {
	return {
		available: true,
		metadata: {
			catalogSessionId: "app-catalog-session-17",
			name: "Session information review",
			sessionFileDisplay: "[redacted]/project/session.jsonl",
			cwd: "[redacted]/project",
			createdAt: "2026-10-28T18:00:00Z",
			persisted: true,
		},
		model: { provider: "actual-provider", id: "actual-model-id", name: "Actual model name" },
		thinkingLevel: "medium",
		run: { state: "running", streaming: true, bashRunning: false, pythonRunning: false, compacting: false, retrying: false, postPromptWork: false, queuedMessages: 0 },
		tools: { available: 8, pending: null, calls: 12, results: 11 },
		recordedTotals: usage("transcript_aggregate", 1001),
		activeTotals: usage("active_messages", 204),
		liveProgress: usage("stream_partial", 7),
		context: { tokens: 1234, contextWindow: 16000, percent: 7.7125, source: "provider_anchor", note: "Messages after the provider anchor are estimated" },
		accountQuota: { available: false, reason: "The public SDK has no account quota" },
		actualBilledCost: { available: false, reason: "The actual billed cost is not provided" },
	};
}

function render(value: DesktopSessionInfo | null = info(), props: Partial<SessionInfoPanelProps> = {}): string {
	return renderToStaticMarkup(<SessionInfoPanel info={value} onRefresh={() => { throw new Error("SSR must not request a refresh"); }} {...props} />);
}

function section(html: string, label: string): string {
	const start = html.indexOf(`aria-label="${label}"`);
	if (start < 0) throw new Error(`Missing section: ${label}`);
	return html.slice(start, html.indexOf("</section>", start));
}

function refreshButton(html: string): string {
	const match = html.match(/<button\b[^>]*>Refresh session information<\/button>/u);
	if (!match) throw new Error("Missing refresh button");
	return match[0];
}

// SSR proves presentation only, not DOM interactions, refresh transport or SDK effects.
describe("desktop session information presentation", () => {
	test("keeps recorded branches, active messages and provisional stream counters separate and non-additive", () => {
		const html = render();
		const recorded = section(html, "Whole transcript usage · All branches");
		const active = section(html, "Active message usage · Partial stream excluded");
		const live = section(html, "Live progress · Provisional, unbilled partial stream");
		expect(recorded).toContain('data-source="transcript_aggregate"');
		expect(recorded).toContain("Whole transcript, including inactive branches");
		expect(recorded).not.toContain("(transcript_aggregate)");
		expect(recorded).toContain("<dt>SDK total tokens</dt><dd>1001</dd>");
		expect(active).toContain('data-source="active_messages"');
		expect(active).toContain("<dt>SDK total tokens</dt><dd>204</dd>");
		expect(live).toContain('data-source="stream_partial"');
		expect(live).toContain("<dt>SDK total tokens</dt><dd>7</dd>");
		expect(live).toContain("Partial live stream, provisional and unbilled");
		expect(live).not.toContain("(stream_partial)");
		expect(html).toContain("Do not add them together.");
		expect(html).toContain("Do not add the token rows to a shown total either.");
		expect(html).toContain("assistant/task usage from inactive branches");
		expect(html).not.toContain(">1212<");
		expect(html).not.toContain(">1205<");
	});

	test("distinguishes unknown counters and costs from genuine zero without deriving totals", () => {
		const value = info();
		value.recordedTotals = usage("transcript_aggregate", null);
		value.activeTotals = { ...usage("active_messages", 0), premiumRequests: 0, cost: { amount: 0, source: "sdk_recorded_cost", reason: "Genuine zero with pricing evidence from the SDK" } };
		const html = render(value);
		const recorded = section(html, "Whole transcript usage · All branches");
		const active = section(html, "Active message usage · Partial stream excluded");
		expect(recorded).toContain("<dt>Input tokens</dt><dd>Unknown</dd>");
		expect(recorded).toContain("<dt>Output tokens</dt><dd>0</dd>");
		expect(recorded).toContain("<dt>SDK total tokens</dt><dd>Unknown</dd>");
		expect(recorded).toContain("<dt>Premium requests</dt><dd>Unknown</dd>");
		expect(recorded).toContain("<dt>SDK recorded cost</dt><dd>Unknown</dd>");
		expect(active).toContain("<dt>SDK total tokens</dt><dd>0</dd>");
		expect(active).toContain("<dt>Premium requests</dt><dd>0</dd>");
		expect(active).toContain("<dt>SDK recorded cost</dt><dd>0</dd>");
		expect(html).toContain("Unknown values are not zero.");
	});

	test("labels SDK costs and unbilled provisional costs without currency, invoice or quota substitution", () => {
		const value = info();
		value.recordedTotals = { ...usage("transcript_aggregate", 1), cost: { amount: 0.123456, source: "sdk_recorded_cost", reason: "SDK record" } };
		value.liveProgress = { ...usage("stream_partial", 2), cost: { amount: 0.000003, source: "live_partial_cost", reason: "Provisional record in progress" } };
		const html = render(value);
		expect(html).toContain("<dt>SDK recorded cost</dt><dd>0.123456</dd>");
		expect(html).toContain("<dt>SDK provisional cost · Unbilled</dt><dd>0.000003</dd>");
		expect(html).toContain("Cost source: SDK recorded value");
		expect(html).toContain("Cost source: Provisional live value");
		expect(html).not.toContain("Cost source: sdk_recorded_cost");
		expect(html).not.toContain("Cost source: live_partial_cost");
		expect(html).toContain("not the actual invoice, account balance or quota.");
		expect(html).toContain("No currency is provided, so none is assumed.");
		const account = section(html, "Account information that is not provided");
		expect(account).toContain("Account quota</dt><dd>Unknown");
		expect(account).toContain("Actual billed cost</dt><dd>Unknown");
		expect(account).toContain("The public SDK has no account quota");
		expect(account).not.toContain("0.123456");
		expect(html).not.toMatch(/\$|USD|KRW|₩|€|£/u);
	});

	test("labels provider anchor plus trailing heuristic, heuristic alone and unknown context honestly", () => {
		const anchored = section(render(), "Context estimate");
		expect(anchored).toContain("Provider anchor plus heuristic estimate");
		expect(anchored).not.toContain("(provider_anchor)");
		expect(anchored).toContain("Messages after the provider anchor are estimated");
		expect(anchored).toContain('aria-label="Estimated context usage"');
		expect(anchored).toContain('aria-valuetext="About 8%"');
		expect(anchored).toContain('min="0" max="100" value="8"');
		expect(anchored).not.toContain("7.7125");
		expect(anchored).toContain("The context estimate is not billed usage.");
		const value = info();
		value.context = { tokens: 0, contextWindow: 16000, percent: 0, source: "heuristic", note: "Local estimate" };
		const zero = section(render(value), "Context estimate");
		expect(zero).toContain("Source: Heuristic estimate");
		expect(zero).not.toContain("(heuristic)");
		expect(zero).toContain('value="0"');
		expect(zero).toContain("Estimated context tokens</dt><dd>0</dd>");
		value.context = { tokens: null, contextWindow: null, percent: null, source: "unknown", note: "No anchor" };
		const unknown = section(render(value), "Context estimate");
		expect(unknown).toContain("Unknown source");
		expect(unknown).not.toContain("(unknown)");
		expect(unknown).toContain("Estimated usage</dt><dd>Unknown</dd>");
		expect(unknown).not.toContain("<meter");
	});

	test("bounds the accessible context meter and withholds it for unavailable or invalid estimates", () => {
		const value = info();
		value.context.percent = 182.7;
		const overflow = section(render(value), "Context estimate");
		expect(overflow).toContain('value="100"');
		expect(overflow).toContain('aria-valuetext="About 100% or more"');
		for (const percent of [null, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
			value.context.percent = percent;
			const html = section(render(value), "Context estimate");
			expect(html).not.toContain("<meter");
			expect(html).toContain("Estimated usage</dt><dd>Unknown</dd>");
		}
		value.context = { ...value.context, source: "unknown", percent: 50 };
		expect(section(render(value), "Context estimate")).not.toContain("<meter");
	});

	test("shows actual execution flags and tool scope while refresh stays enabled in every active state", () => {
		for (const [state, label] of [
			["running", "Working"],
			["compacting", "Compacting context"],
			["retrying", "Retrying"],
			["settling", "Finishing up"],
			["idle", "Not running"],
		] as const) {
			const value = info();
			value.run = { state, streaming: true, bashRunning: true, pythonRunning: true, compacting: true, retrying: true, postPromptWork: true, queuedMessages: 3 };
			const html = render(value);
			expect(html).toContain(`State at read: ${label}`);
			expect(html).not.toContain(`(${state})`);
			expect(refreshButton(html)).not.toContain('disabled=""');
			for (const field of ["Streaming", "Direct shell run", "Direct Python run", "Context compaction", "Retry", "Post-prompt work"]) {
				expect(html).toContain(`<dt>${field}</dt><dd>In progress</dd>`);
			}
			expect(html).toContain("Queued messages</dt><dd>3</dd>");
			expect(html).toContain("Available tools</dt><dd>8</dd>");
			expect(html).toContain("Pending tools</dt><dd>Unknown</dd>");
			expect(html).toContain("Tool calls in active messages</dt><dd>12</dd>");
			expect(html).toContain("Tool results in active messages</dt><dd>11</dd>");
			expect(html).not.toContain("Resource cleanup complete");
		}
		const normal = render();
		expect(normal).toContain("Context compaction</dt><dd>No</dd>");
		expect(normal).toContain("Queued messages</dt><dd>0</dd>");
	});

	test("distinguishes no snapshot, pending, refresh errors and each unavailable session reason", () => {
		const empty = render(null);
		expect(empty).toContain("No session information has been received yet.");
		expect(empty).not.toContain("SDK total tokens");
		expect(refreshButton(empty)).not.toContain('disabled=""');
		const pending = render(info(), { pending: true });
		expect(pending).toContain('aria-busy="true"');
		expect(pending).toContain('role="status"');
		expect(pending).toContain("The information below is the last received.");
		expect(refreshButton(pending)).toContain('disabled=""');
		const failed = render(info(), { error: "Read failed <connection>" });
		expect(failed).toContain('role="alert"');
		expect(failed).toContain("Read failed &lt;connection&gt;");
		expect(failed).toContain("It may differ from the current state.");
		expect(refreshButton(failed)).not.toContain('disabled=""');
		for (const [code, label] of [
			["disposed", "This session has ended."],
			["transitioning", "The session is transitioning. Read it again after the transition."],
			["stale_session", "The target session changed. Read the current session again."],
			["backend_failure", "Session information could not be read."],
			["redaction_failed", "Redaction failed, so the information is not shown."],
			["invalid_catalog_session", "This is not a valid app catalog session."],
		] as const) {
			const html = render({ available: false, code, reason: `Host description: ${code}` });
			expect(html).toContain('role="alert"');
			expect(html).toContain(label);
			expect(html).not.toContain(`(${code})`);
			expect(html).toContain(`Host description: ${code}`);
			expect(html).not.toContain("Actual model name");
			expect(html).not.toContain("SDK total tokens");
			expect(refreshButton(html)).not.toContain('disabled=""');
		}
		expect(render({ available: false, code: "redaction_failed", reason: "Redaction failure" })).toContain("so the information is not shown.");
	});

	test("retains independently unavailable usage buckets and missing metadata without fabricating values", () => {
		const value = info();
		value.recordedTotals = { available: false, reason: "Record read unavailable" };
		value.liveProgress = { available: false, reason: "No stream counters" };
		value.model = null;
		value.thinkingLevel = null;
		value.metadata.name = null;
		value.metadata.sessionFileDisplay = null;
		value.metadata.createdAt = null;
		value.metadata.persisted = false;
		const html = render(value);
		expect(section(html, "Whole transcript usage · All branches")).toContain("Record read unavailable");
		expect(section(html, "Live progress · Provisional, unbilled partial stream")).toContain("No stream counters");
		expect(section(html, "Whole transcript usage · All branches")).not.toContain("SDK total tokens");
		expect(section(html, "Active message usage · Partial stream excluded")).toContain("<dd>204</dd>");
		expect(html).toContain("The actual model is unknown.");
		expect(html).toContain("<dt>Transcript persistence</dt><dd>Off</dd>");
		expect(html).not.toContain("Transcript persistence</dt><dd>On");
	});

	test("renders catalog identity, masked paths and model/source metadata as bounded inert text", () => {
		const value = info();
		const hostile = '<script>alert(1)</script><img src="https://example.invalid/pixel">';
		value.metadata.sessionFileDisplay = hostile;
		value.metadata.cwd = "file:///display-only/path";
		value.model = { provider: hostile, id: "https://example.invalid/model", name: "x".repeat(239) + "𠀀tail" };
		value.recordedTotals = { ...usage("transcript_aggregate", 1), note: "note-start" + "n".repeat(2000) + "hidden-note-end" };
		const html = render(value, { error: "e".repeat(2000) + "hidden-error-end" });
		expect(html).toContain("app-catalog-session-17");
		expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
		expect(html).toContain("file:///display-only/path");
		expect(html).toContain("Redacted, display only");
		expect(html).toContain("Showing a path does not grant permission to open the file.");
		expect(html).toContain("Does not guarantee the disk write completed");
		expect(html).toContain("x".repeat(239) + '<small class="truncation-notice">');
		expect(html).toContain("content truncated");
		expect(html).not.toContain("𠀀");
		expect(html).not.toContain("hidden-note-end");
		expect(html).not.toContain("hidden-error-end");
		expect(html).not.toMatch(/<script|<img|<a\b|\shref="|\ssrc="/u);
	});

	test("does not show invalid or unsafe counters and costs as real zero", () => {
		const value = info();
		value.activeTotals = { ...usage("active_messages", Number.MAX_SAFE_INTEGER + 1), tokens: { input: -1, output: Number.NaN, cacheRead: Number.POSITIVE_INFINITY, cacheWrite: 1.5, total: Number.MAX_SAFE_INTEGER + 1 }, cost: { amount: Number.NaN, source: "sdk_recorded_cost", reason: "Invalid record" } };
		const html = section(render(value), "Active message usage · Partial stream excluded");
		expect(html).toContain("SDK total tokens</dt><dd>Unknown</dd>");
		expect(html).toContain("SDK recorded cost</dt><dd>Unknown</dd>");
		expect(html).not.toContain("<dd>0</dd>");
		expect(html).not.toMatch(/NaN|Infinity|9007199254740992/u);
	});
});
