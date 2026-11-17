import { describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import fc from "fast-check";
import { createDiscordAdapter, createSlackAdapter } from "../src/sdk/bus/chat-adapters";
import { NotificationPresentationEngine, type NotificationReplyRoute } from "../src/sdk/bus/engine";

const URL_SPAN_SEED = 20261024;

function renderedBodies(payloads: Array<{ body: unknown }>): string[] {
	return payloads.map(payload => {
		const body = payload.body as { content?: unknown; text?: unknown };
		return `${typeof body.content === "string" ? body.content : ""}${typeof body.text === "string" ? body.text : ""}`;
	});
}

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

	test("scrubs a legacy replayed frame body and ask text stays literal", async () => {
		const { scrubReplayedProviderText } = await import("../src/sdk/bus/engine");
		const raw = "alert xoxb-secret-token at /home/alice/private/repo";
		const once = scrubReplayedProviderText("notification:session:1", raw);
		expect(once).not.toContain("xoxb-secret-token");
		expect(once).not.toContain("/home/alice/private/repo");
		expect(scrubReplayedProviderText("notification:session:1", once)).toBe(once);
		const ask = "Choose /srv/prod or /srv/staging";
		expect(scrubReplayedProviderText("action:session:ask:1", ask)).toBe(ask);
		expect(scrubReplayedProviderText("action-publication:thread:ask:1", ask)).toBe(ask);
		expect(scrubReplayedProviderText("root:session:1", ask, true)).toBe(ask);
		expect(scrubReplayedProviderText("root:session:1", ask)).not.toContain("/srv/prod");
		expect(scrubReplayedProviderText("notification:session:1", "see notes/todo.txt")).toBe("see notes/todo.txt");
		expect(scrubReplayedProviderText("notification:session:1", "gap / between")).toBe("gap / between");
	});

	test("replay scrub stays idempotent and does not rewrite ask text", async () => {
		const { scrubReplayedProviderText } = await import("../src/sdk/bus/engine");
		fc.assert(
			fc.property(fc.string({ maxLength: 120 }), value => {
				const once = scrubReplayedProviderText("notification:thread:frame", value);
				expect(scrubReplayedProviderText("notification:thread:frame", once)).toBe(once);
				expect(scrubReplayedProviderText("action:session:ask:1", value)).toBe(value);
				expect(scrubReplayedProviderText("action-publication:thread:ask:1", value)).toBe(value);
				expect(scrubReplayedProviderText("root:session:1", value, true)).toBe(value);
			}),
			{ seed: 20261025, numRuns: 64 },
		);
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

	test("drops inherited and assigned prototype frame text", () => {
		const engine = new NotificationPresentationEngine([createDiscordAdapter(), createSlackAdapter()], {
			redact: true,
		});
		const inherited = Object.create({
			type: "context_update",
			text: "INHERITED_SECRET",
			title: "INHERITED_TITLE",
		}) as Record<string, unknown>;
		inherited.repo = "own-repo";
		const assigned: Record<string, unknown> = { type: "context_update", title: "own-title" };
		Object.setPrototypeOf(assigned, { text: "ASSIGN_SECRET" });
		for (const frame of [inherited, assigned]) {
			for (const text of renderedBodies(engine.fanout({ type: "frame", sessionId: "session-abcdef", frame }))) {
				expect(text).not.toContain("INHERITED_SECRET");
				expect(text).not.toContain("INHERITED_TITLE");
				expect(text).not.toContain("ASSIGN_SECRET");
			}
		}
		expect(renderedBodies(engine.fanout({ type: "frame", sessionId: "session-abcdef", frame: inherited }))).toEqual(
			[],
		);
	});

	test("keeps a json proto key out of the notification body", () => {
		const engine = new NotificationPresentationEngine([createDiscordAdapter(), createSlackAdapter()], {
			redact: true,
		});
		const frame = JSON.parse(
			'{"type":"context_update","text":"own body","__proto__":{"title":"JSON_OBJ_SECRET","text":"JSON_PROTO_TEXT"}}',
		) as Record<string, unknown>;
		for (const text of renderedBodies(engine.fanout({ type: "frame", sessionId: "session-abcdef", frame }))) {
			expect(text).toContain("own body");
			expect(text).not.toContain("JSON_OBJ_SECRET");
			expect(text).not.toContain("JSON_PROTO_TEXT");
		}
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
		const slash = engine.fanout({
			type: "frame",
			sessionId: "session-abcdef",
			frame: { type: "context_update", text: "root / stays" },
		});
		for (const text of renderedBodies(slash)) {
			expect(text).toContain("root / stays");
			expect(text).not.toContain("<path>");
		}
	});

	test("still allows surrounding whitespace and a relative backslash path", () => {
		const engine = new NotificationPresentationEngine([createDiscordAdapter(), createSlackAdapter()], {
			redact: true,
		});
		const textValue = "  finished src\\main.ts  ";
		const frame = engine.fanout({
			type: "frame",
			sessionId: "session-abcdef",
			frame: { type: "Context_Update", title: "Build", text: textValue },
		});
		for (const text of renderedBodies(frame)) {
			expect(text).toContain("Context Update");
			expect(text).toContain(textValue);
			expect(text).toContain("Build");
		}
	});

	test("still allows an uppercase https url beside a relative path", () => {
		const url = "HTTPS://Example.COM/Docs/Readme";
		const engine = new NotificationPresentationEngine([createDiscordAdapter(), createSlackAdapter()], {
			redact: true,
		});
		const frame = engine.fanout({
			type: "frame",
			sessionId: "session-abcdef",
			frame: { type: "context_update", text: `see ${url} and src/main.ts` },
		});
		for (const text of renderedBodies(frame)) {
			expect(text).toContain(url);
			expect(text).toContain("src/main.ts");
			expect(text).not.toContain("<path>");
		}
	});

	test("keeps an opted-out frame body unchanged", () => {
		const homeFile = path.join(os.homedir(), ".gjc", "agent", "settings.json");
		const engine = new NotificationPresentationEngine([createDiscordAdapter(), createSlackAdapter()], {
			redact: false,
		});
		const token = `xoxb-${"d".repeat(10)}`;
		const frame = engine.fanout({
			type: "frame",
			sessionId: "session-abcdef",
			frame: { type: "context_update", text: `token ${token} at ${homeFile}` },
		});
		for (const text of renderedBodies(frame)) {
			expect(text).toContain(token);
			expect(text).toContain(homeFile);
		}
	});

	test("masks credentials and absolute paths in frame text", () => {
		const homeFile = path.join(os.homedir(), ".gjc", "agent", "settings.json");
		const filePath = "/home/victimuser/.gjc/agent/settings.json";
		const windowsHome = "C:\\Users\\alice\\.gjc\\settings.json";
		const token = `xoxb-${"d".repeat(10)}`;
		const plain = "https://example.com/docs";
		const ipv6 = "https://[::1]:8080/a/b";
		const engine = new NotificationPresentationEngine([createDiscordAdapter(), createSlackAdapter()], {
			redact: true,
		});
		const ask = engine.fanout({
			type: "action_needed",
			id: "ask-secret",
			kind: "ask",
			sessionId: "session-abcdef",
			question: `Approve ${plain}?`,
			options: ["/srv/prod", "/srv/staging"],
		});
		for (const text of renderedBodies(ask)) {
			expect(text).toContain("/srv/prod");
			expect(text).toContain("/srv/staging");
			expect(text).toContain(plain);
			expect(text).not.toContain("<path>");
		}
		const frame = engine.fanout({
			type: "frame",
			sessionId: "session-abcdef",
			frame: {
				type: "context_update",
				title: "status",
				text: `alert ${token} at ${filePath} ${windowsHome} https://user:pass@example.com/docs ${ipv6}`,
				lastMessage: homeFile,
			},
		});
		for (const text of renderedBodies(frame)) {
			expect(text).toContain("status");
			expect(text).toContain(ipv6);
			expect(text).toContain("example.com/docs");
			expect(text).not.toContain("user:pass");
			expect(text).not.toContain(token);
			expect(text).not.toContain(filePath);
			expect(text).not.toContain(windowsHome);
			expect(text).not.toContain(homeFile);
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
				fc.constantFrom("", "\uE000\uE001"),
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
