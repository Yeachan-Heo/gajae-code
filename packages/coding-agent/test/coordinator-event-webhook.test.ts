import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	DEFAULT_EVENT_WEBHOOK_MAX_ATTEMPTS,
	DEFAULT_EVENT_WEBHOOK_TIMEOUT_MS,
	deliverEventWebhook,
	type EventWebhookConfig,
	MAX_EVENT_WEBHOOK_MAX_ATTEMPTS,
	MAX_EVENT_WEBHOOK_TIMEOUT_MS,
	parseEventWebhookConfig,
	type WebhookDelivery,
} from "../src/coordinator-mcp/event-webhook";

const tempDirs: string[] = [];

/** Child-process probe: prints `overlay:<parseEventWebhookConfig() result>`. */
const script = `
	import { parseEventWebhookConfig } from ${JSON.stringify(new URL("../src/coordinator-mcp/event-webhook.ts", import.meta.url).href)};
	console.log("overlay:" + (parseEventWebhookConfig()?.url ?? "null"));
`;

async function tempRoot(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-event-webhook-"));
	const canonical = await fs.realpath(dir);
	tempDirs.push(canonical);
	return canonical;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

interface RecordedAttempt {
	body: string;
	url: string;
	token: string | null;
	timeoutMs: number;
}

function recordingDelivery(outcomes: Array<{ ok: boolean; error?: string } | Error>): {
	delivery: WebhookDelivery;
	attempts: RecordedAttempt[];
	sleeps: number[];
} {
	const attempts: RecordedAttempt[] = [];
	const sleeps: number[] = [];
	let call = 0;
	return {
		attempts,
		sleeps,
		delivery: {
			async post(body, options) {
				attempts.push({
					body,
					url: options.url,
					token: options.token,
					timeoutMs: options.timeoutMs,
				});
				const outcome = outcomes[Math.min(call, outcomes.length - 1)];
				call += 1;
				if (outcome instanceof Error) throw outcome;
				return {
					ok: outcome.ok,
					status: outcome.ok ? 200 : 503,
					error: outcome.ok ? null : (outcome.error ?? "http_503"),
				};
			},
			sleep: async ms => {
				sleeps.push(ms);
			},
			now: () => Date.now(),
		},
	};
}

function minimalConfig(overrides: Partial<EventWebhookConfig> = {}): EventWebhookConfig {
	return {
		url: "https://sink.example.test/hook",
		tokenFile: null,
		sessionIds: null,
		timeoutMs: DEFAULT_EVENT_WEBHOOK_TIMEOUT_MS,
		maxAttempts: DEFAULT_EVENT_WEBHOOK_MAX_ATTEMPTS,
		...overrides,
	};
}

function journalRow(overrides: Record<string, unknown> = {}): { id: string; session_id?: string } {
	return {
		schema_version: 1,
		seq: 7,
		id: "event-000000000007",
		timestamp: "2026-08-19T00:00:00.000Z",
		kind: "turn.failed",
		session_id: "session-a",
		turn_id: "turn-1",
		summary: "turn failed",
		...overrides,
	} as { id: string; session_id?: string };
}

function outboxPath(namespaceDir: string, eventId: string): string {
	return path.join(namespaceDir, "webhook-outbox", `${createHash("sha256").update(eventId).digest("hex")}.json`);
}

describe("parseEventWebhookConfig", () => {
	it("is disabled by default when no URL is configured", () => {
		expect(parseEventWebhookConfig({})).toBeNull();
		expect(parseEventWebhookConfig({ GJC_COORDINATOR_MCP_EVENT_WEBHOOK_URL: "  " })).toBeNull();
	});

	it("accepts https destinations and http loopback, rejects other destinations", () => {
		expect(parseEventWebhookConfig({ GJC_COORDINATOR_MCP_EVENT_WEBHOOK_URL: "https://sink.example.test" })?.url).toBe(
			"https://sink.example.test",
		);
		for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
			expect(parseEventWebhookConfig({ GJC_COORDINATOR_MCP_EVENT_WEBHOOK_URL: `http://${host}:9/hook` })?.url).toBe(
				`http://${host}:9/hook`,
			);
		}
		expect(() =>
			parseEventWebhookConfig({ GJC_COORDINATOR_MCP_EVENT_WEBHOOK_URL: "http://sink.example.test" }),
		).toThrow("coordinator_event_webhook_url_not_allowed");
		expect(() =>
			parseEventWebhookConfig({ GJC_COORDINATOR_MCP_EVENT_WEBHOOK_URL: "ftp://sink.example.test" }),
		).toThrow("coordinator_event_webhook_url_not_allowed");
		expect(() => parseEventWebhookConfig({ GJC_COORDINATOR_MCP_EVENT_WEBHOOK_URL: "not a url" })).toThrow(
			"coordinator_event_webhook_url_invalid",
		);
	});

	it("parses session scope, bounds timeout and attempts, and requires an absolute token file", async () => {
		const scoped = parseEventWebhookConfig({
			GJC_COORDINATOR_MCP_EVENT_WEBHOOK_URL: "https://sink.example.test",
			GJC_COORDINATOR_MCP_EVENT_WEBHOOK_SESSION_IDS: "session-a, session-b,,invalid value!",
		});
		expect(scoped?.sessionIds).toEqual(new Set(["session-a", "session-b"]));

		const bounded = parseEventWebhookConfig({
			GJC_COORDINATOR_MCP_EVENT_WEBHOOK_URL: "https://sink.example.test",
			GJC_COORDINATOR_MCP_EVENT_WEBHOOK_TIMEOUT_MS: "999999",
			GJC_COORDINATOR_MCP_EVENT_WEBHOOK_MAX_ATTEMPTS: "99",
		});
		expect(bounded?.timeoutMs).toBe(MAX_EVENT_WEBHOOK_TIMEOUT_MS);
		expect(bounded?.maxAttempts).toBe(MAX_EVENT_WEBHOOK_MAX_ATTEMPTS);

		const tokenDir = await tempRoot();
		const withToken = parseEventWebhookConfig({
			GJC_COORDINATOR_MCP_EVENT_WEBHOOK_URL: "https://sink.example.test",
			GJC_COORDINATOR_MCP_EVENT_WEBHOOK_TOKEN_FILE: path.join(tokenDir, "token"),
		});
		expect(withToken?.tokenFile).toBe(path.join(tokenDir, "token"));
		expect(() =>
			parseEventWebhookConfig({
				GJC_COORDINATOR_MCP_EVENT_WEBHOOK_URL: "https://sink.example.test",
				GJC_COORDINATOR_MCP_EVENT_WEBHOOK_TOKEN_FILE: "relative/token",
			}),
		).toThrow("coordinator_event_webhook_token_file_invalid");
	});

	it("falls back to the defaults for timeout and attempts values that are not plain digits", () => {
		for (const raw of ["1.5", "1e4", "10s", "+3", "-2", "0", "0x10"]) {
			const config = parseEventWebhookConfig({
				GJC_COORDINATOR_MCP_EVENT_WEBHOOK_URL: "https://sink.example.test",
				GJC_COORDINATOR_MCP_EVENT_WEBHOOK_TIMEOUT_MS: raw,
				GJC_COORDINATOR_MCP_EVENT_WEBHOOK_MAX_ATTEMPTS: raw,
			});
			expect({ raw, timeoutMs: config?.timeoutMs, maxAttempts: config?.maxAttempts }).toEqual({
				raw,
				timeoutMs: DEFAULT_EVENT_WEBHOOK_TIMEOUT_MS,
				maxAttempts: DEFAULT_EVENT_WEBHOOK_MAX_ATTEMPTS,
			});
		}

		const padded = parseEventWebhookConfig({
			GJC_COORDINATOR_MCP_EVENT_WEBHOOK_URL: "https://sink.example.test",
			GJC_COORDINATOR_MCP_EVENT_WEBHOOK_TIMEOUT_MS: " 2500 ",
			GJC_COORDINATOR_MCP_EVENT_WEBHOOK_MAX_ATTEMPTS: "99999999999999999999",
		});
		expect(padded?.timeoutMs).toBe(2500);
		expect(padded?.maxAttempts).toBe(MAX_EVENT_WEBHOOK_MAX_ATTEMPTS);
	});
});
describe("webhook egress provenance", () => {
	it("never selects the egress destination from a checkout .env overlay", async () => {
		// Bun loads cwd/.env into the process environment, so the production
		// entry points must not read the merged view for these variables. Run
		// a real child process in a directory whose .env names a sink and
		// assert the no-argument parse (the production call shape) stays off.
		const projectRoot = await tempRoot();
		await fs.writeFile(
			path.join(projectRoot, ".env"),
			"GJC_COORDINATOR_MCP_EVENT_WEBHOOK_URL=https://project-env-sink.example.test/steal\n",
			"utf8",
		);
		const probe = Bun.spawnSync({
			cmd: [process.execPath, "--eval", script],
			cwd: projectRoot,
			env: { ...process.env, GJC_COORDINATOR_MCP_EVENT_WEBHOOK_URL: undefined },
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(probe.exitCode).toBe(0);
		expect(probe.stdout.toString().trim()).toBe("overlay:null");
	});

	it("an inherited (trusted) environment still enables delivery", async () => {
		const projectRoot = await tempRoot();
		const probe = Bun.spawnSync({
			cmd: [process.execPath, "--eval", script],
			cwd: projectRoot,
			env: { ...process.env, GJC_COORDINATOR_MCP_EVENT_WEBHOOK_URL: "https://trusted.example.test/hook" },
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(probe.exitCode).toBe(0);
		expect(probe.stdout.toString().trim()).toBe("overlay:https://trusted.example.test/hook");
	});
});

describe("deliverEventWebhook", () => {
	it("POSTs the same journal row and records delivery once with the stable id", async () => {
		const namespaceDir = await tempRoot();
		const event = journalRow();
		const { delivery, attempts } = recordingDelivery([{ ok: true }]);
		await deliverEventWebhook(namespaceDir, minimalConfig(), event, () => JSON.stringify(event), delivery);
		expect(attempts).toHaveLength(1);
		expect(JSON.parse(attempts[0]!.body)).toEqual(event);
		const record = JSON.parse(await fs.readFile(outboxPath(namespaceDir, event.id), "utf8"));
		expect(record).toMatchObject({ event_id: event.id, status: "delivered", attempts: 1 });

		// Second call with the same row is a dedupe: no further POST.
		await deliverEventWebhook(namespaceDir, minimalConfig(), event, () => JSON.stringify(event), delivery);
		expect(attempts).toHaveLength(1);
	});

	it("uses a bounded filename for legal long stable IDs", async () => {
		const namespaceDir = await tempRoot();
		const sessionId = `s${"x".repeat(127)}`;
		const event = journalRow({
			id: `txn:${sessionId}:1:session.registered:session:${sessionId}`,
			session_id: sessionId,
		});
		const { delivery, attempts } = recordingDelivery([{ ok: true }]);
		await deliverEventWebhook(namespaceDir, minimalConfig(), event, () => JSON.stringify(event), delivery);
		expect(attempts).toHaveLength(1);
		const names = await fs.readdir(path.join(namespaceDir, "webhook-outbox"));
		expect(names).toEqual([`${createHash("sha256").update(event.id).digest("hex")}.json`]);
	});

	it("retries with exponential backoff and keeps the same id on redelivery", async () => {
		const namespaceDir = await tempRoot();
		const event = journalRow();
		const { delivery, attempts, sleeps } = recordingDelivery([
			{ ok: false, error: "http_503" },
			{ ok: false, error: "http_503" },
			{ ok: true },
		]);
		await deliverEventWebhook(namespaceDir, minimalConfig(), event, () => JSON.stringify(event), delivery);
		expect(attempts).toHaveLength(3);
		expect(sleeps).toEqual([500, 1000]);
		const record = JSON.parse(await fs.readFile(outboxPath(namespaceDir, event.id), "utf8"));
		expect(record).toMatchObject({ event_id: event.id, status: "delivered", attempts: 3, last_error: null });
	});

	it("gives up after bounded attempts without throwing", async () => {
		const namespaceDir = await tempRoot();
		const event = journalRow();
		const { delivery, attempts, sleeps } = recordingDelivery([new Error("sink on fire")]);
		await deliverEventWebhook(
			namespaceDir,
			minimalConfig({ maxAttempts: 2 }),
			event,
			() => JSON.stringify(event),
			delivery,
		);
		expect(attempts).toHaveLength(2);
		expect(sleeps).toEqual([500]);
		const record = JSON.parse(await fs.readFile(outboxPath(namespaceDir, event.id), "utf8"));
		expect(record).toMatchObject({ status: "failed", attempts: 2, last_error: "sink on fire" });
	});

	it("resumes a pending outbox record after a crash instead of restarting delivery", async () => {
		const namespaceDir = await tempRoot();
		const event = journalRow();
		// First process: one attempt fails, then the process dies before retrying.
		const first = recordingDelivery([new Error("http_503")]);
		first.delivery.sleep = async () => {
			throw new Error("process died before retry");
		};
		await expect(
			deliverEventWebhook(
				namespaceDir,
				minimalConfig({ maxAttempts: 3 }),
				event,
				() => JSON.stringify(event),
				first.delivery,
			),
		).rejects.toThrow("process died before retry");
		expect(first.attempts).toHaveLength(1);
		const afterCrash = JSON.parse(await fs.readFile(outboxPath(namespaceDir, event.id), "utf8"));
		expect(afterCrash).toMatchObject({ status: "pending", attempts: 1 });
		// Simulate a fresh process: new delivery seam, same durable outbox record.
		const second = recordingDelivery([{ ok: true }]);
		await deliverEventWebhook(
			namespaceDir,
			minimalConfig({ maxAttempts: 3 }),
			event,
			() => JSON.stringify(event),
			second.delivery,
		);
		expect(second.attempts).toHaveLength(1);
		const record = JSON.parse(await fs.readFile(outboxPath(namespaceDir, event.id), "utf8"));
		expect(record).toMatchObject({ status: "delivered", attempts: 2 });
	});

	it("recovers a partially published outbox record after a crash", async () => {
		const namespaceDir = await tempRoot();
		const event = journalRow();
		const file = outboxPath(namespaceDir, event.id);
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, '{"schema_version":1,"event_id":"event-000000000007"', "utf8");
		const { delivery, attempts } = recordingDelivery([{ ok: true }]);

		await deliverEventWebhook(namespaceDir, minimalConfig(), event, () => JSON.stringify(event), delivery);

		expect(attempts).toHaveLength(1);
		expect(JSON.parse(await fs.readFile(file, "utf8"))).toMatchObject({
			event_id: event.id,
			status: "delivered",
			attempts: 1,
		});
	});

	it("delivers nothing for events outside the configured session scope", async () => {
		const namespaceDir = await tempRoot();
		const inScope = journalRow({ id: "event-000000000010", session_id: "session-a" });
		const outOfScope = journalRow({ id: "event-000000000011", session_id: "session-z" });
		const unscoped = { ...journalRow({ id: "event-000000000012" }), session_id: undefined };
		const { delivery, attempts } = recordingDelivery([{ ok: true }]);
		const config = minimalConfig({ sessionIds: new Set(["session-a"]) });
		for (const event of [inScope, outOfScope, unscoped]) {
			await deliverEventWebhook(namespaceDir, config, event, () => JSON.stringify(event), delivery);
		}
		expect(attempts.map(attempt => JSON.parse(attempt.body).id)).toEqual([inScope.id]);
	});

	it("sends the bearer token from the token file, never inline config", async () => {
		const namespaceDir = await tempRoot();
		const tokenFile = path.join(namespaceDir, "secret-token");
		await fs.writeFile(tokenFile, "  tok-123  \n", "utf8");
		const event = journalRow();
		const { delivery, attempts } = recordingDelivery([{ ok: true }]);
		await deliverEventWebhook(
			namespaceDir,
			minimalConfig({ tokenFile }),
			event,
			() => JSON.stringify(event),
			delivery,
		);
		expect(attempts[0]!.token).toBe("tok-123");
	});

	it("fails closed when the token file is unreadable", async () => {
		const namespaceDir = await tempRoot();
		const event = journalRow();
		const { delivery, attempts } = recordingDelivery([{ ok: true }]);
		await expect(
			deliverEventWebhook(
				namespaceDir,
				minimalConfig({ tokenFile: path.join(namespaceDir, "missing-token") }),
				event,
				() => JSON.stringify(event),
				delivery,
			),
		).rejects.toThrow("coordinator_event_webhook_token_file_unreadable");
		expect(attempts).toHaveLength(0);
	});

	it("rejects outbox ids that are not journal row ids", async () => {
		const namespaceDir = await tempRoot();
		const { delivery } = recordingDelivery([{ ok: true }]);
		await expect(
			deliverEventWebhook(namespaceDir, minimalConfig(), { id: "../../etc/passwd" }, () => "{}", delivery),
		).rejects.toThrow("coordinator_event_webhook_event_id_invalid");
		await expect(
			fs
				.access(path.join(namespaceDir, "webhook-outbox"))
				.then(() => true)
				.catch(() => false),
		).resolves.toBe(false);
	});
});
