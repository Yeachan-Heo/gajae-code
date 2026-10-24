import { describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import fc from "fast-check";
import { createDiscordAdapter, createSlackAdapter } from "../src/sdk/bus/chat-adapters";
import {
	type NotificationAdapterPayload,
	NotificationPresentationEngine,
	type NotificationReplyRoute,
} from "../src/sdk/bus/engine";

const URL_SPAN_SEED = 238202610;

const secretCorpus = [
	"raw prompt body",
	"transcript chunk",
	"xoxb-secret-token",
	"https://hooks.slack.com/services/T/B/C",
	"/home/alice/private/repo",
	"bot-token-secret",
];

describe("Discord and Slack notification adapters", () => {
	test("render ask events and map replies without owning daemon lifecycle", () => {
		const discord = createDiscordAdapter({ channelId: "discord-channel" });
		const slack = createSlackAdapter({ channelId: "slack-channel" });
		const engine = new NotificationPresentationEngine([discord, slack], {
			redact: true,
		});
		const replies: NotificationReplyRoute[] = [];
		engine.connectSession("session-abcdef", { sendReply: route => replies.push(route) });

		const payloads = engine.fanout({
			type: "action_needed",
			id: "ask-1",
			kind: "ask",
			sessionId: "session-abcdef",
			question: "Proceed with deploy?",
			options: ["Yes", "No"],
			summary: "prompt context is intentionally not needed for routing",
		});

		expect(payloads.map(payload => payload.adapter)).toEqual(["discord", "slack"]);
		expect(JSON.stringify(payloads[0]!.body)).toContain("Proceed with deploy?");
		expect(JSON.stringify(payloads[1]!.body)).toContain("1. Yes");
		expect(payloads[0]!.route).toEqual({ sessionId: "session-abcdef", actionId: "ask-1" });

		expect(engine.routeInbound("discord", { sessionId: "session-abcdef", actionId: "ask-1", answer: 0 })).toBe(true);
		expect(engine.routeInbound("slack", { sessionId: "session-abcdef", actionId: "ask-1", text: "No" })).toBe(true);
		expect(replies).toEqual([
			{ sessionId: "session-abcdef", actionId: "ask-1", answer: 0 },
			{ sessionId: "session-abcdef", actionId: "ask-1", answer: "No" },
		]);
	});

	test("keeps distinct slack ask path choices readable and routable", () => {
		const prod = "Use /srv/prod";
		const staging = "Use /srv/staging";
		const engine = new NotificationPresentationEngine([createDiscordAdapter(), createSlackAdapter()], {
			redact: true,
		});
		const replies: NotificationReplyRoute[] = [];
		engine.connectSession("session-abcdef", { sendReply: route => replies.push(route) });
		const payloads = engine.fanout({
			type: "action_needed",
			id: "ask-paths",
			kind: "ask",
			sessionId: "session-abcdef",
			question: "Which root?",
			options: [prod, staging],
		});
		const slackBody = payloads.find(payload => payload.adapter === "slack")!.body as { text: string };
		expect(slackBody.text).toContain(`1. ${prod}`);
		expect(slackBody.text).toContain(`2. ${staging}`);
		expect(slackBody.text).not.toContain("<path>");
		expect(engine.routeInbound("slack", { sessionId: "session-abcdef", actionId: "ask-paths", text: prod })).toBe(
			true,
		);
		expect(replies).toEqual([{ sessionId: "session-abcdef", actionId: "ask-paths", answer: prod }]);
	});

	test("redacts public payload boundaries for non-ask events", () => {
		const engine = new NotificationPresentationEngine([createDiscordAdapter(), createSlackAdapter()], {
			redact: true,
		});
		const payloads = engine.fanout({
			type: "action_needed",
			id: "idle-1",
			kind: "idle",
			sessionId: "session-abcdef",
			summary: secretCorpus.join(" "),
		});
		const serialized = JSON.stringify(payloads);
		expect(serialized).toContain("Agent idle");
		for (const secret of secretCorpus) expect(serialized).not.toContain(secret);
		// Discord/Slack deliver inside per-session threads whose first message is
		// the identity header, so the RENDERED idle text stays bare there
		// (#981, #4855). The route keeps the full routing sessionId; it is
		// transport metadata and never user-visible.
		for (const payload of payloads) {
			const body = payload.body as Record<string, unknown>;
			const rendered = `${body.content ?? ""}${body.text ?? ""}`;
			expect(rendered).toBe("Agent idle");
		}
	});

	test("still allows a plain ask and frame with no secret or absolute path", () => {
		const engine = new NotificationPresentationEngine([createDiscordAdapter(), createSlackAdapter()], {
			redact: true,
		});
		const ask = engine.fanout({
			type: "action_needed",
			id: "ask-plain",
			kind: "ask",
			sessionId: "session-abcdef",
			question: "Proceed with deploy of src/main.ts?",
			options: ["Yes", "No"],
		});
		for (const text of renderedBodies(ask)) {
			expect(text).toContain("Proceed with deploy of src/main.ts?");
			expect(text).toContain("Yes");
			expect(text).toContain("No");
		}
		const frame = engine.fanout({
			type: "frame",
			sessionId: "session-abcdef",
			frame: { type: "context_update", title: "build", text: "finished src/main.ts" },
		});
		for (const text of renderedBodies(frame)) {
			expect(text).toContain("build");
			expect(text).toContain("finished src/main.ts");
		}
	});

	test("keeps a presentation opt-out body unchanged", () => {
		const homeFile = path.join(os.homedir(), ".gjc", "agent", "settings.json");
		const engine = new NotificationPresentationEngine([createDiscordAdapter(), createSlackAdapter()], {
			redact: false,
		});
		const payloads = engine.fanout({
			type: "action_needed",
			id: "ask-off",
			kind: "ask",
			sessionId: "session-abcdef",
			question: `Approve using sk-ant-optoutvalue at ${homeFile}?`,
			options: ["Yes"],
		});
		for (const text of renderedBodies(payloads)) {
			expect(text).toContain("sk-ant-optoutvalue");
			expect(text).toContain(homeFile);
		}
	});

	test("still allows a plain https url, a parenthesis path, and an ipv6 host", () => {
		const plain = "https://example.com/docs";
		const paren = "https://example.com/a(b)/c";
		const ipv6 = "https://[::1]:8080/a/b";
		const wrapped = "https://[::1]/docs";
		const engine = new NotificationPresentationEngine([createDiscordAdapter(), createSlackAdapter()], {
			redact: true,
		});
		const ask = engine.fanout({
			type: "action_needed",
			id: "ask-url",
			kind: "ask",
			sessionId: "session-abcdef",
			question: `Open ${plain} and ${paren} and ${ipv6}`,
			options: [paren, "https://example.com/a(b)/d", wrapped],
		});
		for (const text of renderedBodies(ask)) {
			expect(text).toContain(plain);
			expect(text).toContain(paren);
			expect(text).toContain("https://example.com/a(b)/d");
			expect(text).toContain(ipv6);
			expect(text).toContain(wrapped);
			expect(text).not.toContain("<path>");
		}
		const frame = engine.fanout({
			type: "frame",
			sessionId: "session-abcdef",
			frame: { type: "context_update", text: `see "${ipv6}" and ${paren}` },
		});
		for (const text of renderedBodies(frame)) {
			expect(text).toContain(ipv6);
			expect(text).toContain(paren);
			expect(text).not.toContain("<path>");
		}
	});

	test("still allows an angle link and a slack label with no absolute path", () => {
		const angle = "<https://example.com/docs>";
		const slack = "<https://example.com/docs|release notes>";
		const piped = "https://example.com/docs?q=a|b";
		const paren = "https://example.com/a(b)/c";
		const ipv6 = "https://[::1]:8080/a/b";
		const engine = new NotificationPresentationEngine([createDiscordAdapter(), createSlackAdapter()], {
			redact: true,
		});
		const ask = engine.fanout({
			type: "action_needed",
			id: "ask-markup-ok",
			kind: "ask",
			sessionId: "session-abcdef",
			question: `See ${angle} and ${slack} and ${piped}`,
			options: [angle, slack, paren, ipv6],
		});
		for (const text of renderedBodies(ask)) {
			expect(text).toContain(angle);
			expect(text).toContain(slack);
			expect(text).toContain(piped);
			expect(text).toContain(paren);
			expect(text).toContain(ipv6);
			expect(text).not.toContain("<path>");
		}
		const frame = engine.fanout({
			type: "frame",
			sessionId: "session-abcdef",
			frame: { type: "context_update", text: `${angle} ${slack}` },
		});
		for (const text of renderedBodies(frame)) {
			expect(text).toContain(angle);
			expect(text).toContain(slack);
			expect(text).not.toContain("<path>");
		}
	});

	test("still allows an https url glued after a path prefix", () => {
		const url = "https://example.com/docs";
		const glued = `Read /home/alice/log(${url})`;
		const engine = new NotificationPresentationEngine([createDiscordAdapter(), createSlackAdapter()], {
			redact: true,
		});
		const ask = engine.fanout({
			type: "action_needed",
			id: "ask-glued-ok",
			kind: "ask",
			sessionId: "session-abcdef",
			question: glued,
			options: [glued],
		});
		for (const text of renderedBodies(ask)) expect(text).toContain(url);
		const frame = engine.fanout({
			type: "frame",
			sessionId: "session-abcdef",
			frame: { type: "context_update", text: glued },
		});
		for (const text of renderedBodies(frame)) expect(text).toContain(url);
	});

	test("still allows a private-use marker beside an https url", () => {
		const marker = "\uE0000\uE001";
		const n = 20;
		const url = `https://example.com/${"a".repeat(n)}`;
		const question = `${marker.repeat(n)} ${url}`;
		const engine = new NotificationPresentationEngine([createDiscordAdapter(), createSlackAdapter()], {
			redact: true,
		});
		const ask = engine.fanout({
			type: "action_needed",
			id: "ask-marker",
			kind: "ask",
			sessionId: "session-abcdef",
			question,
			options: ["Yes"],
		});
		for (const text of renderedBodies(ask)) {
			expect(text).toContain(marker);
			expect(text).toContain(url);
			expect(text.length).toBeLessThan(question.length * 4);
		}
	});

	test("masks a glued path in frame text and leaves the ask readable", () => {
		const url = "https://example.com/docs";
		const file = "/home/alice/log";
		const glued = `Read ${file}(${url})`;
		const engine = new NotificationPresentationEngine([createDiscordAdapter(), createSlackAdapter()], {
			redact: true,
		});
		const ask = engine.fanout({
			type: "action_needed",
			id: "ask-glued-path",
			kind: "ask",
			sessionId: "session-abcdef",
			question: glued,
			options: [glued],
		});
		for (const text of renderedBodies(ask)) {
			expect(text).toContain(url);
			expect(text).toContain(file);
		}
		const frame = engine.fanout({
			type: "frame",
			sessionId: "session-abcdef",
			frame: { type: "context_update", text: glued },
		});
		for (const text of renderedBodies(frame)) {
			expect(text).toContain(url);
			expect(text).not.toContain(file);
		}
	});

	test("masks a path after chat markup in frame text and leaves the ask readable", () => {
		const url = "https://example.com/docs";
		const file = "/home/alice/private.txt";
		const angle = `<${url}>${file}`;
		const slack = `<${url}|${file}>`;
		const engine = new NotificationPresentationEngine([createDiscordAdapter(), createSlackAdapter()], {
			redact: true,
		});
		const ask = engine.fanout({
			type: "action_needed",
			id: "ask-markup-path",
			kind: "ask",
			sessionId: "session-abcdef",
			question: angle,
			options: [slack, angle],
		});
		for (const text of renderedBodies(ask)) {
			expect(text).toContain(angle);
			expect(text).toContain(slack);
			expect(text).toContain(file);
		}
		const frame = engine.fanout({
			type: "frame",
			sessionId: "session-abcdef",
			frame: { type: "context_update", text: `${angle} ${slack}` },
		});
		for (const text of renderedBodies(frame)) {
			expect(text).toContain(url);
			expect(text).not.toContain(file);
		}
	});

	test("masks credentials in frame text and leaves ask text readable", () => {
		const homeFile = path.join(os.homedir(), ".gjc", "agent", "settings.json");
		const transcript = path.join(os.tmpdir(), "transcript-canary.json");
		const windowsHome = "C:\\Users\\alice\\.gjc\\settings.json";
		const filePath = "/home/victimuser/.gjc/agent/settings.json";
		const secrets = [
			`npm_${"a".repeat(20)}`,
			`AIza${"A".repeat(35)}`,
			`ghp_${"e".repeat(16)}`,
			`github_pat_${"e".repeat(20)}`,
			`xoxb-${"d".repeat(10)}`,
			`sk-ant-${"f".repeat(12)}`,
			`AKIA${"Z".repeat(16)}`,
			`glpat-${"c".repeat(20)}`,
			`hf_${"b".repeat(20)}`,
			"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
			"Bearer abcdefghijklmnop",
			"-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----",
			`sessionid=${"g".repeat(12)}`,
		];
		const plain = "https://example.com/docs";
		const paren = "https://example.com/a(b)/c";
		const ipv6 = "https://[::1]:8080/a/b";
		const engine = new NotificationPresentationEngine([createDiscordAdapter(), createSlackAdapter()], {
			redact: true,
		});
		const ask = engine.fanout({
			type: "action_needed",
			id: "ask-secret",
			kind: "ask",
			sessionId: "session-abcdef",
			question: `Approve deploy? (${paren}) ${secrets.join(" ")} ${homeFile} ${transcript} ${windowsHome} ${filePath} https://user:pass@example.com/docs ${ipv6}`,
			options: ["Ship it", plain, ...secrets],
		});
		for (const text of renderedBodies(ask)) {
			expect(text).toContain("Approve deploy?");
			expect(text).toContain("Ship it");
			expect(text).toContain(plain);
			expect(text).toContain(paren);
			for (const secret of secrets) expect(text).toContain(secret.slice(0, 40));
		}
		const frame = engine.fanout({
			type: "frame",
			sessionId: "session-abcdef",
			frame: {
				type: "context_update",
				title: "status",
				text: `alert ${secrets[5]} at ${filePath} https://user:pass@example.com/docs ${ipv6}`,
				lastMessage: transcript,
			},
		});
		for (const text of renderedBodies(frame)) {
			expect(text).toContain("status");
			expect(text).toContain(ipv6);
			expect(text).toContain("example.com/docs");
			expect(text).not.toContain("user:pass");
			expect(text).not.toContain(secrets[5]);
			expect(text).not.toContain(filePath);
			expect(text).not.toContain(transcript);
		}
	});

	test("property: https spans stay intact while a sibling absolute path is masked", () => {
		const engine = new NotificationPresentationEngine([createDiscordAdapter(), createSlackAdapter()], {
			redact: true,
		});
		fc.assert(
			fc.property(
				fc.constantFrom("example.com", "[::1]", "[::1]:8080"),
				fc.constantFrom("/a", "/a/b", "/a(b)/c", "/docs"),
				fc.stringMatching(/^[a-z][a-z0-9]{0,7}$/),
				fc.constantFrom("space", "angle", "slack", "glued"),
				fc.constantFrom("", "\uE0000\uE001"),
				fc.stringMatching(/^[a-z]{16,32}$/),
				(host, urlPath, leaf, kind, marker, longTail) => {
					const url = `https://${host}${urlPath}/${longTail}`;
					const file = `/var/notify-canary/${leaf}.json`;
					const marked =
						kind === "angle"
							? `<${url}>${file}`
							: kind === "slack"
								? `<${url}|${file}>`
								: kind === "glued"
									? `${file}(${url})`
									: `${url} ${file}`;
					const body = `${marker}Open ${marked}`;
					const frame = engine.fanout({
						type: "frame",
						sessionId: "session-abcdef",
						frame: { type: "context_update", text: body },
					});
					const again = engine.fanout({
						type: "frame",
						sessionId: "session-abcdef",
						frame: { type: "context_update", text: body },
					});
					expect(renderedBodies(frame)).toEqual(renderedBodies(again));
					for (const text of renderedBodies(frame)) {
						expect(text).toContain(url);
						if (marker) expect(text).toContain(marker);
						expect(text).not.toContain(file);
						expect(text).not.toContain(`>${file}`);
						expect(text).not.toContain(`|${file}`);
						expect(text).not.toContain(`<path>${urlPath}`);
						expect(text.length).toBeLessThan(body.length * 8);
					}
				},
			),
			{ seed: URL_SPAN_SEED, numRuns: 64 },
		);
	});

	test("ignore unknown or stale inbound replies", () => {
		const engine = new NotificationPresentationEngine([createDiscordAdapter()], {
			redact: false,
		});
		engine.connectSession("session-abcdef", { sendReply: () => expect.unreachable("stale reply routed") });
		expect(engine.routeInbound("discord", { sessionId: "session-abcdef", actionId: "missing", answer: 0 })).toBe(
			false,
		);
		expect(engine.routeInbound("slack", { sessionId: "session-abcdef", actionId: "missing", answer: 0 })).toBe(false);
	});
});

function renderedBodies(payloads: NotificationAdapterPayload[]): string[] {
	return payloads.map(payload => {
		const body = payload.body as Record<string, unknown>;
		return `${body.content ?? ""}\n${body.text ?? ""}`;
	});
}
