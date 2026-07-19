import * as fs from "node:fs";
import { type Component, Container, matchesKey, truncateToWidth } from "@gajae-code/tui";
import type { SessionInfo } from "../../session/session-manager";
import { theme } from "../theme/theme";

const PRESENCE_MAX_BYTES = 4096;
const PRESENCE_MAX_FUTURE_MS = 5 * 60 * 1000;
const PRESENCE_OPEN_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW ?? 0);

function readPresenceFile(filePath: string): string {
	if (!fs.constants.O_NOFOLLOW) throw new Error("No no-follow presence reads available");
	const descriptor = fs.openSync(filePath, PRESENCE_OPEN_FLAGS);
	try {
		const stat = fs.fstatSync(descriptor);
		if (!stat.isFile() || stat.size > PRESENCE_MAX_BYTES) throw new Error("Invalid presence sidecar");
		const bytes = Buffer.alloc(stat.size);
		const bytesRead = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
		if (bytesRead !== bytes.length) throw new Error("Incomplete presence sidecar");
		return bytes.toString("utf8");
	} finally {
		fs.closeSync(descriptor);
	}
}

function isPresenceRecord(value: unknown): value is PresenceRecord {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		typeof (value as { expiresAt?: unknown }).expiresAt === "string"
	);
}

function fit(line: string, width: number): string {
	return truncateToWidth(line, Math.max(0, width));
}

export type SessionLiveness = "active" | "stale" | "unknown";

export interface DashboardSession {
	id: string;
	cwd: string;
	title: string;
	modified: Date;
	messageCount: number;
	messageCountIsEstimate?: boolean;
	liveness: SessionLiveness;
}

interface PresenceRecord {
	expiresAt: string;
}

/**
 * Reads the opt-in presence sidecar beside a session transcript. A missing or
 * malformed sidecar deliberately means unknown: transcript modification time is
 * not a process-liveness signal.
 */
export function sessionLivenessFromPresence(
	sessionPath: string,
	readFile: (filePath: string) => string = readPresenceFile,
	now = Date.now(),
): SessionLiveness {
	try {
		const content = readFile(`${sessionPath}.presence.json`);
		if (Buffer.byteLength(content, "utf8") > PRESENCE_MAX_BYTES) return "unknown";
		const record: unknown = JSON.parse(content);
		if (!isPresenceRecord(record)) return "unknown";
		const expiresAt = Date.parse(record.expiresAt);
		if (!Number.isFinite(expiresAt) || expiresAt > now + PRESENCE_MAX_FUTURE_MS) return "unknown";
		return expiresAt > now ? "active" : "stale";
	} catch {
		return "unknown";
	}
}

export function dashboardSessions(
	sessions: readonly SessionInfo[],
	options: { readFile?: (filePath: string) => string; now?: number } = {},
): DashboardSession[] {
	return sessions.map(session => ({
		id: session.id,
		cwd: session.cwd,
		title: session.title ?? session.firstMessage,
		modified: session.modified,
		messageCountIsEstimate: session.messageCountIsEstimate,
		messageCount: session.messageCount,
		liveness: sessionLivenessFromPresence(session.path, options.readFile, options.now),
	}));
}

/** Read-only top-level inventory. This component never opens, resumes, or mutates a session. */
export class SessionsDashboardComponent extends Container {
	#scrollOffset = 0;

	constructor(
		private readonly sessions: readonly DashboardSession[],
		private readonly onClose: () => void,
		private readonly requestRender?: () => void,
	) {
		super();
	}

	override render(width: number): string[] {
		const viewportSessions = this.#viewportSessions();
		const maxScroll = Math.max(0, this.sessions.length - viewportSessions);
		this.#scrollOffset = Math.min(this.#scrollOffset, maxScroll);
		const visible = this.sessions.slice(this.#scrollOffset, this.#scrollOffset + viewportSessions);
		const position =
			this.sessions.length === 0
				? "[0/0]"
				: `[${this.#scrollOffset + 1}-${this.#scrollOffset + visible.length}/${this.sessions.length}]`;
		return [
			fit(theme.bold("Sessions dashboard"), width),
			fit(theme.fg("dim", "Read-only — use /resume to open a session."), width),
			"",
			...(visible.length === 0
				? [fit(theme.fg("dim", "No persisted sessions found."), width)]
				: visible.flatMap(session => new SessionDashboardRow(session).render(width))),
			fit(theme.fg("dim", `${position}  ↑/↓:scroll  PgUp/PgDn:page  Esc:close`), width),
		];
	}

	handleInput(keyData: string): void {
		if (matchesKey(keyData, "escape")) {
			this.onClose();
			return;
		}
		const maxScroll = Math.max(0, this.sessions.length - this.#viewportSessions());
		if (matchesKey(keyData, "up")) this.#scrollOffset = Math.max(0, this.#scrollOffset - 1);
		else if (matchesKey(keyData, "down")) this.#scrollOffset = Math.min(maxScroll, this.#scrollOffset + 1);
		else if (matchesKey(keyData, "pageUp"))
			this.#scrollOffset = Math.max(0, this.#scrollOffset - this.#viewportSessions());
		else if (matchesKey(keyData, "pageDown"))
			this.#scrollOffset = Math.min(maxScroll, this.#scrollOffset + this.#viewportSessions());
		else return;
		this.requestRender?.();
	}

	#viewportSessions(): number {
		// Each session takes two lines. Reserve the heading, description, spacer,
		// and controls line so the overlay never grows with the session inventory.
		return Math.max(1, Math.floor((Math.max(8, process.stdout.rows || 40) - 4) / 2));
	}
}

class SessionDashboardRow implements Component {
	constructor(private readonly session: DashboardSession) {}
	invalidate(): void {}

	render(width: number): string[] {
		const status =
			this.session.liveness === "active"
				? theme.fg("success", "active")
				: this.session.liveness === "stale"
					? theme.fg("warning", "stale")
					: theme.fg("dim", "unknown");
		const modified = Number.isFinite(this.session.modified.getTime())
			? this.session.modified
					.toISOString()
					.replace("T", " ")
					.replace(/\.\d{3}Z$/, "Z")
			: "unknown time";
		const title = this.session.title.replaceAll(/\s+/g, " ").trim();
		const cwd = this.session.cwd.replaceAll(/\s+/g, " ").trim();
		const count = this.session.messageCountIsEstimate
			? `~${this.session.messageCount} messages`
			: `${this.session.messageCount} messages`;
		const fullMetadata = `· ${count} · ${modified}`;
		const compactMetadata = `· ${this.session.messageCountIsEstimate ? `~${this.session.messageCount}` : this.session.messageCount} msgs`;
		const metadata = width >= 48 ? fullMetadata : width >= 24 ? compactMetadata : "";
		const titleWidth = Math.max(0, width - 2 - metadata.length - (metadata ? 1 : 0));
		return [
			fit(
				` ${status} ${truncateToWidth(title, titleWidth)}${metadata ? ` ${theme.fg("dim", metadata)}` : ""}`,
				width,
			),
			fit(`   ${theme.fg("dim", cwd)}`, width),
		];
	}
}
