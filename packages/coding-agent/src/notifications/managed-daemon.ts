import * as path from "node:path";
import type { Settings } from "../config/settings";
import { RateLimitPool } from "./rate-limit-pool";
import {
	CLIENT_PING_PONG_CAPABILITY,
	HEARTBEAT_INTERVAL_MS,
	HEARTBEAT_TTL_MS,
	NOTIFICATION_PROTOCOL_VERSION,
} from "./telegram-daemon";
import { readEndpoint } from "./telegram-reference";
import { renderThreadedFrame, type ThreadedSend } from "./threaded-render";

export interface ManagedNotificationDaemonFs {
	readdir(path: string): Promise<string[]>;
}

export interface ManagedSessionSocket {
	sessionId: string;
	token: string;
	ws: WebSocket;
	pending: Map<string, { sessionId: string; actionId: string }>;
	capable: boolean;
	lastPongAt: number;
	awaitingNonce: string | undefined;
	pingTimer: ReturnType<typeof setInterval> | undefined;
}

export interface ManagedNotificationDaemonOptions {
	settings: Settings;
	fs: ManagedNotificationDaemonFs;
	WebSocketImpl?: typeof WebSocket;
	now?: () => number;
	setIntervalImpl?: typeof setInterval;
	clearIntervalImpl?: typeof clearInterval;
	rateLimitPool?: RateLimitPool<{ send: ThreadedSend; topicId?: string }>;
}

export abstract class ManagedNotificationDaemon {
	readonly sessions = new Map<string, ManagedSessionSocket>();
	readonly pool: RateLimitPool<{ send: ThreadedSend; topicId?: string }>;

	protected constructor(protected readonly opts: ManagedNotificationDaemonOptions) {
		this.pool = opts.rateLimitPool ?? new RateLimitPool<{ send: ThreadedSend; topicId?: string }>({ now: opts.now });
	}

	async scanRoots(): Promise<void> {
		const rootState = await this.readRoots();
		for (const root of rootState) {
			const dir = path.join(root, "notifications");
			let files: string[];
			try {
				files = await this.opts.fs.readdir(dir);
			} catch {
				continue;
			}
			for (const file of files.filter(item => item.endsWith(".json"))) {
				const sessionId = path.basename(file, ".json");
				if (this.sessions.has(sessionId)) continue;
				try {
					const endpoint = readEndpoint(path.join(dir, file));
					this.connectSession(sessionId, endpoint.url, endpoint.token);
				} catch {}
			}
		}
	}

	connectSession(sessionId: string, url: string, token: string): ManagedSessionSocket {
		const WS = this.opts.WebSocketImpl ?? WebSocket;
		const ws = new WS(`${url}/?token=${encodeURIComponent(token)}`);
		const session: ManagedSessionSocket = {
			sessionId,
			token,
			ws,
			pending: new Map(),
			capable: false,
			lastPongAt: 0,
			awaitingNonce: undefined,
			pingTimer: undefined,
		};
		this.sessions.set(sessionId, session);
		ws.addEventListener("open", () => this.sendHello(session));
		ws.addEventListener("message", ev => {
			if (this.sessions.get(sessionId) !== session) return;
			void this.handleSessionMessage(session, JSON.parse(String(ev.data))).catch(() => undefined);
		});
		ws.addEventListener("close", () => this.dropSession(session));
		return session;
	}

	protected async handleSessionMessage(session: ManagedSessionSocket, msg: Record<string, unknown>): Promise<boolean> {
		if (msg.type === "hello") {
			const caps = Array.isArray(msg.capabilities) ? msg.capabilities : [];
			if (caps.includes(CLIENT_PING_PONG_CAPABILITY)) {
				session.capable = true;
				this.startLiveness(session);
			}
			return true;
		}
		if (msg.type === "pong") {
			if (typeof msg.nonce === "string" && msg.nonce === session.awaitingNonce) {
				session.awaitingNonce = undefined;
				session.lastPongAt = (this.opts.now ?? Date.now)();
			}
			return true;
		}
		return false;
	}

	protected renderFrame(frame: Record<string, unknown>): ThreadedSend | undefined {
		return renderThreadedFrame(frame);
	}

	protected dropSession(session: ManagedSessionSocket): void {
		const clearIntervalImpl = this.opts.clearIntervalImpl ?? clearInterval;
		if (session.pingTimer) {
			clearIntervalImpl(session.pingTimer);
			session.pingTimer = undefined;
		}
		if (this.sessions.get(session.sessionId) === session) this.sessions.delete(session.sessionId);
		if (session.ws.readyState !== WebSocket.CLOSED) {
			try {
				session.ws.close();
			} catch {}
		}
	}

	protected abstract readRoots(): Promise<string[]>;

	private sendHello(session: ManagedSessionSocket): void {
		if (session.ws.readyState !== WebSocket.OPEN) return;
		try {
			session.ws.send(
				JSON.stringify({
					type: "hello",
					protocolVersion: NOTIFICATION_PROTOCOL_VERSION,
					capabilities: [CLIENT_PING_PONG_CAPABILITY],
				}),
			);
		} catch {}
	}

	private startLiveness(session: ManagedSessionSocket): void {
		if (session.pingTimer) return;
		const setIntervalImpl = this.opts.setIntervalImpl ?? setInterval;
		const now = () => (this.opts.now ?? Date.now)();
		session.lastPongAt = now();
		session.pingTimer = setIntervalImpl(() => {
			if (this.sessions.get(session.sessionId) !== session) return;
			const t = now();
			if (t - session.lastPongAt >= HEARTBEAT_TTL_MS) {
				this.dropSession(session);
				return;
			}
			if (session.ws.readyState === WebSocket.OPEN) {
				const nonce = `${session.sessionId}:${t}:${Math.random().toString(36).slice(2)}`;
				session.awaitingNonce = nonce;
				try {
					session.ws.send(JSON.stringify({ type: "ping", nonce }));
				} catch {}
			}
		}, HEARTBEAT_INTERVAL_MS);
	}
}
