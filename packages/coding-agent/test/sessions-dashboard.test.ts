import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	dashboardSessions,
	SessionsDashboardComponent,
	sessionLivenessFromPresence,
} from "@gajae-code/coding-agent/modes/components/sessions-dashboard";
import { SelectorController } from "@gajae-code/coding-agent/modes/controllers/selector-controller";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { MemorySessionStorage, type SessionStorageWriter } from "@gajae-code/coding-agent/session/session-storage";
import { getAgentDir, setAgentDir } from "@gajae-code/utils";

initTheme();
class WriteTrackingStorage extends MemorySessionStorage {
	writes = 0;

	override writeTextSync(filePath: string, content: string): void {
		this.writes++;
		super.writeTextSync(filePath, content);
	}

	override async writeText(filePath: string, content: string): Promise<void> {
		this.writes++;
		await super.writeText(filePath, content);
	}

	override openWriter(
		filePath: string,
		options?: { flags?: "a" | "w"; onError?: (error: Error) => void },
	): SessionStorageWriter {
		this.writes++;
		return super.openWriter(filePath, options);
	}
}

function sessionText(id: string, cwd: string, title: string, message: string): string {
	return `${[
		JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd, title }),
		JSON.stringify({
			type: "message",
			id: `${id}-message`,
			parentId: null,
			timestamp: "2026-01-01T00:01:00.000Z",
			message: { role: "user", content: message, timestamp: 0 },
		}),
	].join("\n")}\n`;
}

function snapshotDirectory(root: string): Array<{ path: string; content: string; size: number; mtimeMs: number }> {
	return fs
		.readdirSync(root, { recursive: true, withFileTypes: true })
		.filter(entry => entry.isFile())
		.map(entry => {
			const filePath = path.join(entry.parentPath, entry.name);
			const stat = fs.statSync(filePath);
			return {
				path: path.relative(root, filePath),
				content: fs.readFileSync(filePath, "utf8"),
				size: stat.size,
				mtimeMs: stat.mtimeMs,
			};
		})
		.sort((a, b) => a.path.localeCompare(b.path));
}

describe("sessions dashboard", () => {
	afterEach(() => vi.restoreAllMocks());

	it("lists fixture sessions with read-only metadata and presence liveness", async () => {
		const storage = new WriteTrackingStorage();
		const sessionDir = "/fixtures/sessions";
		const activePath = `${sessionDir}/active.jsonl`;
		const stalePath = `${sessionDir}/stale.jsonl`;
		const unknownPath = `${sessionDir}/unknown.jsonl`;
		storage.writeTextSync(activePath, sessionText("active", "/work/active", "Active title", "first active message"));
		storage.writeTextSync(stalePath, sessionText("stale", "/work/stale", "Stale title", "first stale message"));
		storage.writeTextSync(
			unknownPath,
			sessionText("unknown", "/work/unknown", "Unknown title", "first unknown message"),
		);
		storage.writes = 0;

		const sessions = await SessionManager.listForResumePickerReadOnly("/work", sessionDir, storage);
		const presence = new Map([
			[`${activePath}.presence.json`, JSON.stringify({ expiresAt: "2026-01-01T12:01:00.000Z" })],
			[`${stalePath}.presence.json`, JSON.stringify({ expiresAt: "2025-12-31T00:00:00.000Z" })],
		]);
		const lstatSync = vi.spyOn(fs, "lstatSync");
		const rows = dashboardSessions(sessions, {
			now: Date.parse("2026-01-01T12:00:00.000Z"),
			readFile: filePath => {
				const value = presence.get(filePath);
				if (value === undefined) throw new Error("missing presence");
				return value;
			},
		});

		expect(rows).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "active",
					cwd: "/work/active",
					title: "Active title",
					messageCount: 1,
					liveness: "active",
				}),
				expect.objectContaining({
					id: "stale",
					cwd: "/work/stale",
					title: "Stale title",
					messageCount: 1,
					liveness: "stale",
				}),
				expect.objectContaining({
					id: "unknown",
					cwd: "/work/unknown",
					title: "Unknown title",
					messageCount: 1,
					liveness: "unknown",
				}),
			]),
		);
		expect(lstatSync).not.toHaveBeenCalled();
		expect(storage.writes).toBe(0);
	});

	it("does not infer liveness from missing or malformed presence", () => {
		expect(sessionLivenessFromPresence("/fixture/a.jsonl", () => "not json", 0)).toBe("unknown");
		expect(
			sessionLivenessFromPresence(
				"/fixture/a.jsonl",
				() => {
					throw new Error("missing");
				},
				0,
			),
		).toBe("unknown");
	});

	it("marks prefix-only message counts as estimates in the dashboard", async () => {
		const storage = new MemorySessionStorage();
		const sessionDir = "/fixtures/large-sessions";
		const transcript = `${sessionDir}/large.jsonl`;
		storage.writeTextSync(transcript, `${sessionText("large", "/work/large", "Large title", "first").repeat(100)}`);
		const [session] = await SessionManager.listForResumePickerReadOnly("/work", sessionDir, storage);
		expect(session?.messageCountIsEstimate).toBe(true);
		const rendered = new SessionsDashboardComponent(dashboardSessions([session!]), () => {}).render(80).join("\n");
		expect(rendered).toContain(`~${session!.messageCount} messages`);
	});

	it("fits CJK titles and status variants within narrow visible widths", () => {
		const rows = (["active", "stale", "unknown"] as const).map(liveness => ({
			id: liveness,
			cwd: "/工程/日本語/프로젝트/with\ttabs",
			title: `漢字 café ${liveness} title`,
			modified: new Date("2026-01-01T00:00:00.000Z"),
			messageCount: 12,
			liveness,
		}));
		for (const width of [1, 8, 24, 40]) {
			for (const line of new SessionsDashboardComponent(rows, () => {}).render(width)) {
				expect(Bun.stringWidth(line.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, ""))).toBeLessThanOrEqual(width);
			}
		}
	});

	it("keeps a 24-row dashboard bounded while paging to the last session", () => {
		const rows = Array.from({ length: 32 }, (_, index) => ({
			id: `session-${index}`,
			cwd: `/projects/${index}`,
			title: `Session ${index}`,
			modified: new Date("2026-01-01T00:00:00.000Z"),
			messageCount: index,
			liveness: "unknown" as const,
		}));
		const descriptor = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		Object.defineProperty(process.stdout, "rows", { configurable: true, value: 24 });
		try {
			const dashboard = new SessionsDashboardComponent(rows, () => {});
			expect(dashboard.render(80)).toHaveLength(24);
			dashboard.handleInput("\u001b[6~");
			dashboard.handleInput("\u001b[6~");
			dashboard.handleInput("\u001b[6~");
			let rendered = dashboard.render(80).join("\n");
			expect(rendered).toContain("Session 31");
			expect(rendered).toContain("[23-32/32]");

			dashboard.handleInput("\u001b[5~");
			rendered = dashboard.render(80).join("\n");
			expect(rendered).toContain("[13-22/32]");

			dashboard.handleInput("\u001b[A");
			rendered = dashboard.render(80).join("\n");
			expect(rendered).toContain("[12-21/32]");

			dashboard.handleInput("\u001b[B");
			rendered = dashboard.render(80).join("\n");
			expect(rendered).toContain("[13-22/32]");
		} finally {
			if (descriptor) Object.defineProperty(process.stdout, "rows", descriptor);
			else Reflect.deleteProperty(process.stdout, "rows");
		}
	});

	it("uses the production global inventory and dashboard open path without mutating foreign sessions", async () => {
		const originalAgentDir = getAgentDir();
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "sessions-dashboard-"));
		setAgentDir(agentDir);
		try {
			const sessionsRoot = path.join(agentDir, "sessions");
			const cwdA = path.join(agentDir, "workspaces", "a");
			const cwdB = path.join(agentDir, "workspaces", "b");
			fs.mkdirSync(cwdA, { recursive: true });
			fs.mkdirSync(cwdB, { recursive: true });
			const older = path.join(SessionManager.getDefaultSessionDir(cwdA, agentDir), "older.jsonl");
			const newer = path.join(SessionManager.getDefaultSessionDir(cwdB, agentDir), "newer.jsonl");
			fs.mkdirSync(path.dirname(older), { recursive: true });
			fs.mkdirSync(path.dirname(newer), { recursive: true });
			fs.writeFileSync(older, sessionText("older", cwdA, "Older", "first"));
			fs.writeFileSync(newer, sessionText("newer", cwdB, "Newer", "second"));
			fs.writeFileSync(`${older}.presence.json`, "{");
			fs.utimesSync(older, new Date("2026-01-01T00:00:00.000Z"), new Date("2026-01-01T00:00:00.000Z"));
			fs.utimesSync(newer, new Date("2026-01-02T00:00:00.000Z"), new Date("2026-01-02T00:00:00.000Z"));
			const before = snapshotDirectory(sessionsRoot);
			const mutations = [
				vi.spyOn(fs, "writeFileSync"),
				vi.spyOn(fs, "appendFileSync"),
				vi.spyOn(fs, "renameSync"),
				vi.spyOn(fs, "unlinkSync"),
				vi.spyOn(fs.promises, "writeFile"),
				vi.spyOn(fs.promises, "appendFile"),
				vi.spyOn(fs.promises, "rename"),
				vi.spyOn(fs.promises, "unlink"),
			];

			const sessions = await SessionManager.listAll();
			expect(sessions.map(session => session.id)).toEqual(["newer", "older"]);
			expect(dashboardSessions(sessions).find(session => session.id === "older")?.liveness).toBe("unknown");
			let dashboard: SessionsDashboardComponent | undefined;
			const editor = {};
			const ui = {
				showOverlay: vi.fn(component => {
					dashboard = component as SessionsDashboardComponent;
					return { hide: vi.fn() };
				}),
				setFocus: vi.fn(),
				requestRender: vi.fn(),
			};
			await new SelectorController({ ui, editor } as never).showSessionsDashboard();
			expect(dashboard?.render(80).join("\n")).toContain("Newer");
			expect(mutations.reduce((count, mutation) => count + mutation.mock.calls.length, 0)).toBe(0);
			expect(snapshotDirectory(sessionsRoot)).toEqual(before);
		} finally {
			setAgentDir(originalAgentDir);
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});
});
