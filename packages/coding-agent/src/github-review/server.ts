/**
 * GitHub webhook HTTP server for the review bot.
 *
 *   GitHub (or tunnel) → POST <webhookPath> → HMAC verify → delivery dedup →
 *   router → embedded agent session (fire-and-forget; GitHub gets a fast 200).
 *
 * GET /health reports runner load so deploy scripts can avoid restarting the
 * process while reviews are running. An in-process sweeper runs on an
 * interval (no external cron needed).
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import type { GithubReviewConfig } from "./config";
import { WebhookRouter } from "./router";
import { InstructionRunner } from "./runner";
import { ReviewService } from "./service";
import { runSweep } from "./sweeper";

const ALLOWED_EVENTS = new Set(["pull_request", "issue_comment", "pull_request_review_comment"]);

/** Constant-time HMAC check of X-Hub-Signature-256. */
export function verifySignature(secret: string, body: Uint8Array, header: string | null | undefined): boolean {
	if (!header?.startsWith("sha256=")) return false;
	const expected = crypto.createHmac("sha256", secret).update(body).digest("hex");
	const got = header.slice("sha256=".length);
	if (got.length !== expected.length) return false;
	return crypto.timingSafeEqual(Buffer.from(got, "utf8"), Buffer.from(expected, "utf8"));
}

/**
 * Replay guard for webhook deliveries. GitHub redelivers with the same
 * `X-GitHub-Delivery` id; a captured signed payload replayed later gets a
 * fresh id, so ids are only accepted while their timestamp window is open,
 * and the log is persisted so a restart does not reset dedup.
 */
export class DeliveryLog {
	private seen = new Map<string, number>();

	constructor(
		private readonly filePath?: string,
		private readonly windowMs = 6 * 3600_000,
		private readonly capacity = 5000,
		private readonly now: () => number = Date.now,
	) {
		if (filePath && fs.existsSync(filePath)) {
			try {
				this.seen = new Map(
					Object.entries(JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, number>),
				);
			} catch {
				/* corrupt log → start fresh */
			}
		}
	}

	alreadySeen(id: string): boolean {
		const now = this.now();
		for (const [key, ts] of this.seen) {
			if (now - ts > this.windowMs) this.seen.delete(key);
		}
		if (this.seen.has(id)) return true;
		this.seen.set(id, now);
		while (this.seen.size > this.capacity) {
			const oldest = this.seen.keys().next().value;
			if (oldest === undefined) break;
			this.seen.delete(oldest);
		}
		this.persist();
		return false;
	}

	private persist(): void {
		if (!this.filePath) return;
		try {
			fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
			fs.writeFileSync(this.filePath, JSON.stringify(Object.fromEntries(this.seen)), { mode: 0o600 });
		} catch {
			/* memory dedup still works */
		}
	}
}

export interface GithubReviewServer {
	close(): Promise<void>;
	runner: InstructionRunner;
	service: ReviewService;
	port: number;
}

function readBody(req: http.IncomingMessage, limitBytes = 5 * 1024 * 1024): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > limitBytes) {
				reject(new Error("payload too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
	res.end(payload);
}

export async function startGithubReviewServer(
	config: GithubReviewConfig,
	log: (line: string) => void = line => console.log(`${new Date().toISOString()} ${line}`),
): Promise<GithubReviewServer> {
	const service = new ReviewService(config);
	const router = new WebhookRouter(config, service);
	const runner = new InstructionRunner(service, log);
	const deliveries = new DeliveryLog(path.join(config.dataDir, "deliveries.json"));

	const server = http.createServer((req, res) => {
		void (async () => {
			const url = new URL(req.url ?? "/", `http://${config.host}`);
			if (req.method === "GET" && url.pathname === "/health") {
				json(res, 200, { ok: true, ...runner.status() });
				return;
			}
			if (req.method !== "POST" || url.pathname !== config.webhookPath) {
				json(res, 404, { error: "not found" });
				return;
			}
			const body = await readBody(req);
			if (!verifySignature(config.webhookSecret, body, req.headers["x-hub-signature-256"] as string | undefined)) {
				json(res, 401, { error: "invalid signature" });
				return;
			}
			const event = (req.headers["x-github-event"] as string | undefined) ?? "";
			if (!ALLOWED_EVENTS.has(event)) {
				json(res, 200, { ok: true, skipped: "event" });
				return;
			}
			const delivery = (req.headers["x-github-delivery"] as string | undefined) ?? crypto.randomUUID();
			if (deliveries.alreadySeen(delivery)) {
				json(res, 200, { ok: true, skipped: "duplicate" });
				return;
			}
			let payload: Record<string, unknown>;
			try {
				payload = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
			} catch {
				json(res, 400, { error: "invalid json" });
				return;
			}
			const action = await router.route(payload);
			if (action.kind === "silent") {
				json(res, 200, { ok: true, skipped: action.reason });
				return;
			}
			runner.dispatch(delivery, action);
			json(res, 200, { ok: true, dispatched: true });
		})().catch(error => {
			log(`webhook request failed: ${String(error).slice(0, 400)}`);
			if (!res.headersSent) json(res, 500, { error: "internal" });
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(config.port, config.host, resolve);
	});
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : config.port;
	log(`github-review listening on ${config.host}:${port}${config.webhookPath} (max ${config.maxInflight} concurrent)`);

	let sweepTimer: ReturnType<typeof setInterval> | null = null;
	if (config.sweepIntervalSeconds > 0) {
		let sweeping = false;
		sweepTimer = setInterval(() => {
			if (sweeping) return;
			sweeping = true;
			void runSweep(service, { log })
				.catch(error => log(`sweep failed: ${String(error).slice(0, 400)}`))
				.finally(() => {
					sweeping = false;
				});
		}, config.sweepIntervalSeconds * 1000);
		sweepTimer.unref?.();
	}

	return {
		runner,
		service,
		port,
		async close() {
			if (sweepTimer) clearInterval(sweepTimer);
			await new Promise<void>(resolve => server.close(() => resolve()));
		},
	};
}
