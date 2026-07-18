import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { APP_ACTION_METADATA } from "../src/modes/action-registry";
import {
	dashboardSessions,
	SessionsDashboardComponent,
	sessionLivenessFromPresence,
} from "../src/modes/components/sessions-dashboard";
import { SelectorController } from "../src/modes/controllers/selector-controller";
import { initTheme } from "../src/modes/theme/theme";
import { TranscriptItemRegistry } from "../src/modes/transcript-item-registry";
import { type SessionInfo, SessionManager } from "../src/session/session-manager";
import { MemorySessionStorage } from "../src/session/session-storage";

initTheme();

class WriteTrackingStorage extends MemorySessionStorage {
	writes = 0;

	override writeTextSync(filePath: string, content: string): void {
		this.writes++;
		super.writeTextSync(filePath, content);
	}
}

const FIXTURE_NOW = Date.parse("2026-01-01T12:00:00.000Z");
const tempRoots: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function sessionText(id: string, cwd = "/work/project", title = "title"): string {
	return `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd, title })}\n${JSON.stringify({ type: "message", id: `${id}-message`, parentId: null, timestamp: "2026-01-01T00:01:00.000Z", message: { role: "user", content: "message", timestamp: 0 } })}\n`;
}

function sessionInfo(id: string, sessionPath: string): SessionInfo {
	return {
		path: sessionPath,
		id,
		cwd: "/very/deep/工程/日本語/프로젝트/with/a/path/that/does/not/fit",
		title: "漢字 café — a title that must truncate at forty columns",
		created: new Date("2026-01-01T00:00:00.000Z"),
		modified: new Date("2026-01-01T00:00:00.000Z"),
		messageCount: 1,
		size: 1,
		firstMessage: "fallback",
		allMessagesText: "fallback",
	};
}

describe("G007 WS5 adversarial dashboard evidence", () => {
	it("tolerates corrupt and empty transcripts without writes, but inventories every valid session", async () => {
		const storage = new WriteTrackingStorage();
		const dir = "/foreign/sessions";
		storage.writeTextSync(`${dir}/corrupt.jsonl`, "{not json}\n");
		storage.writeTextSync(`${dir}/empty.jsonl`, "");
		for (let index = 0; index < 1_100; index++) {
			storage.writeTextSync(
				`${dir}/${index}.jsonl`,
				sessionText(`session-${index}`, "/deep/日本語/path", "漢字 title"),
			);
		}
		const writesBeforeOpen = storage.writes;
		const sessions = await SessionManager.listForResumePickerReadOnly("/work", dir, storage);
		expect(sessions).toHaveLength(1_100);
		expect(storage.writes).toBe(writesBeforeOpen);

		const rows = dashboardSessions(sessions, {
			now: FIXTURE_NOW,
			readFile: () => {
				throw new Error("absent");
			},
		});
		const dashboard = new SessionsDashboardComponent(rows, () => {});
		const rendered = dashboard.render(40);
		expect(rendered.length).toBeLessThanOrEqual(Math.max(8, process.stdout.rows || 40));
		expect(rendered.join("\n")).toContain("漢字");
	});

	it("matches the ADR presence classification, including hostile sidecar shapes", () => {
		const sessionPath = "/fixture/session.jsonl";
		const read = (value: string) => () => value;
		expect(
			sessionLivenessFromPresence(
				sessionPath,
				read(JSON.stringify({ expiresAt: "2099-01-01T00:00:00.000Z" })),
				FIXTURE_NOW,
			),
		).toBe("unknown");
		expect(
			sessionLivenessFromPresence(
				sessionPath,
				read(JSON.stringify({ expiresAt: "2025-12-31T23:59:59.000Z" })),
				FIXTURE_NOW,
			),
		).toBe("stale");
		for (const malformed of [
			"{",
			JSON.stringify({}),
			JSON.stringify({ expiresAt: {} }),
			JSON.stringify({ expiresAt: null }),
			JSON.stringify([]),
		]) {
			expect(sessionLivenessFromPresence(sessionPath, read(malformed), FIXTURE_NOW)).toBe("unknown");
		}
		expect(
			sessionLivenessFromPresence(
				sessionPath,
				() => {
					throw new Error("absent");
				},
				FIXTURE_NOW,
			),
		).toBe("unknown");

		const root = fs.mkdtempSync(path.join(os.tmpdir(), "g007-presence-"));
		tempRoots.push(root);
		const transcript = path.join(root, "foreign.jsonl");
		fs.writeFileSync(transcript, sessionText("foreign"));
		fs.writeFileSync(`${transcript}.target`, "not json");
		fs.symlinkSync(`${transcript}.target`, `${transcript}.presence.json`);
		expect(sessionLivenessFromPresence(transcript, undefined, FIXTURE_NOW)).toBe("unknown");
		fs.unlinkSync(`${transcript}.presence.json`);
		fs.mkdirSync(`${transcript}.presence.json`);
		expect(sessionLivenessFromPresence(transcript, undefined, FIXTURE_NOW)).toBe("unknown");
		fs.rmdirSync(`${transcript}.presence.json`);
		fs.writeFileSync(`${transcript}.target`, JSON.stringify({ expiresAt: "2026-01-01T12:01:00.000Z" }));
		fs.symlinkSync(`${transcript}.target`, `${transcript}.presence.json`);
		expect(sessionLivenessFromPresence(transcript, undefined, FIXTURE_NOW)).toBe("unknown");
		fs.unlinkSync(`${transcript}.presence.json`);
		fs.writeFileSync(`${transcript}.presence.json`, "x".repeat(4_097));
		expect(sessionLivenessFromPresence(transcript, undefined, FIXTURE_NOW)).toBe("unknown");

		if (fs.constants.O_NOFOLLOW) {
			const openSync = vi.spyOn(fs, "openSync");
			const lstatSync = vi.spyOn(fs, "lstatSync");
			expect(sessionLivenessFromPresence("/device-like", undefined, FIXTURE_NOW)).toBe("unknown");
			expect(lstatSync).not.toHaveBeenCalled();
			expect(openSync).toHaveBeenCalledWith("/device-like.presence.json", expect.any(Number));
		}
	});

	it("records full overlay open-close behavior and zero fixture writes without stacking reopen calls", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "g007-dashboard-"));
		tempRoots.push(root);
		const transcript = path.join(root, "foreign.jsonl");
		fs.writeFileSync(transcript, sessionText("foreign"));
		const before = fs.statSync(transcript).mtimeMs;
		const listed = [sessionInfo("foreign", transcript)];
		vi.spyOn(SessionManager, "listAll").mockResolvedValue(listed);
		const writes = [
			vi.spyOn(fs, "writeFileSync"),
			vi.spyOn(fs, "appendFileSync"),
			vi.spyOn(fs.promises, "writeFile"),
			vi.spyOn(fs.promises, "appendFile"),
		];
		const hide = vi.fn();
		let dashboard: SessionsDashboardComponent | undefined;
		const editor = {};
		const ui = {
			showOverlay: vi.fn(component => {
				dashboard = component as SessionsDashboardComponent;
				return { hide };
			}),
			setFocus: vi.fn(),
			requestRender: vi.fn(),
		};
		const controller = new SelectorController({ ui, editor } as never);
		controller.showTranscriptViewer(new TranscriptItemRegistry());
		expect(ui.showOverlay).toHaveBeenCalledTimes(1);
		await controller.showSessionsDashboard();
		await controller.showSessionsDashboard();
		expect(ui.showOverlay).toHaveBeenCalledTimes(2);
		expect(dashboard).toBeDefined();
		dashboard?.handleInput("\x1b");
		expect(hide).toHaveBeenCalledTimes(1);
		expect(ui.setFocus).toHaveBeenLastCalledWith(editor);
		expect(ui.requestRender).toHaveBeenCalled();
		expect(writes.reduce((total, spy) => total + spy.mock.calls.length, 0)).toBe(0);
		expect(fs.statSync(transcript).mtimeMs).toBe(before);
	});

	it("exposes observation only: dashboard has no foreign-session dispatch action or input", () => {
		const ids = APP_ACTION_METADATA.map(action => action.id);
		expect(ids).toContain("app.session.dashboard");
		expect(ids).not.toContain("app.session.dispatch" as never);
		expect(ids).not.toContain("app.session.reply" as never);
		const dashboard = new SessionsDashboardComponent(
			[dashboardSessions([sessionInfo("foreign", "/foreign.jsonl")])[0]],
			() => {},
		);
		expect(dashboard.render(40).join("\n")).toContain("Read-only");
	});
});
