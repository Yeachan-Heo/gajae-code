import { beforeAll, describe, expect, it } from "bun:test";
import fc from "fast-check";
import { SessionSelectorComponent } from "../src/modes/components/session-selector";
import { getThemeByName, setThemeInstance } from "../src/modes/theme/theme";
import type { SessionInfo } from "../src/session/session-manager";

const OSC52 = "\x1b]52;c;";
const OSC0 = "\x1b]0;";
const OSC8 = "\x1b]8;;https://attacker.invalid/";
const BEL = "\x07";
const CSI_UP = "\x1b[1A";
const CSI_ERASE = "\x1b[2K";
const SEED = 20261028;

beforeAll(async () => {
	const loaded = await getThemeByName("red-claw");
	if (!loaded) throw new Error("Failed to load red-claw theme");
	setThemeInstance(loaded);
});

function info(id: string, title: string | undefined, firstMessage: string): SessionInfo {
	return {
		path: `sessions/${id}.jsonl`,
		id,
		cwd: "project",
		title,
		starred: false,
		created: new Date("2026-01-02T00:00:00.000Z"),
		modified: new Date("2026-01-02T00:00:00.000Z"),
		messageCount: 1,
		size: 12,
		firstMessage,
		allMessagesText: firstMessage,
	};
}

function picker(sessions: SessionInfo[]): SessionSelectorComponent {
	return new SessionSelectorComponent(
		sessions,
		() => {},
		() => {},
		() => {},
		async () => true,
	);
}

function render(sessions: SessionInfo[], width = 80): string {
	return picker(sessions).render(width).join("\n");
}

describe("resume picker display", () => {
	it("does not draw session title or first-message terminal controls", () => {
		const raw = render([
			info(
				"one",
				`${OSC52}UEFZTE9BRA==${BEL}${OSC0}title${BEL}${CSI_UP}${CSI_ERASE}Plan notes`,
				`${OSC8}click${BEL}Hello\n\nworld\x1b]8;;${BEL}`,
			),
		]);
		expect(raw).not.toContain("\x1b]");
		expect(raw).not.toContain(CSI_UP);
		expect(raw).not.toContain(CSI_ERASE);
		expect(raw).not.toContain(BEL);
		expect(raw).toContain("Plan notes");
		expect(raw).toContain("Hello  world");
	});

	it("still shows spaced titles, letter case, and newline-per-space messages", () => {
		const raw = render([
			info("a", "  Keep me  ", "Hello\n\nworld"),
			info("b", "Alpha", "ALPHA note"),
			info("c", "note [1A] ok", "plain"),
		]);
		expect(raw).toContain("  Keep me  ");
		expect(raw).toContain("Hello  world");
		expect(raw).toContain("Alpha");
		expect(raw).toContain("ALPHA note");
		expect(raw).toContain("note [1A] ok");
	});

	it("drops a control-only title and keeps the sanitized delete name", () => {
		const component = picker([
			info("del", `${OSC52}UEFZTE9BRA==${BEL}${CSI_UP}Delete me`, `${OSC0}gone${BEL}fallback`),
		]);
		component.handleInput("\x1b[3~");
		const raw = component.render(80).join("\n");
		expect(raw).not.toContain("\x1b]");
		expect(raw).not.toContain(CSI_UP);
		expect(raw).not.toContain(BEL);
		expect(raw).toContain("Delete me");
	});

	it("strips a control sequence inside the kept width before truncation", () => {
		const prefix = "K".repeat(24);
		const raw = render([info("tail", `Keep${OSC52}PAYLOAD${BEL}${prefix}${"Y".repeat(400)}`, "short note")], 48);
		expect(raw).not.toContain("\x1b]");
		expect(raw).not.toContain("PAYLOAD");
		expect(raw).toContain("Keep");
		expect(raw).toContain(prefix.slice(0, 8));
		expect(raw).toContain("short note");
		expect(raw).not.toContain("Y".repeat(80));
	});

	it("property: picker rows drop OSC and cursor controls, seed 20261028, 64 inputs", () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 24 }), extra => {
				const raw = render([
					info("p", `${OSC0}t${BEL}${extra}`, `${OSC52}${extra}${BEL}${OSC8}x${BEL}${CSI_UP}msg`),
				]);
				expect(raw).not.toContain("\x1b]");
				expect(raw).not.toContain(CSI_UP);
				expect(raw).not.toContain(BEL);
			}),
			{ seed: SEED, numRuns: 64 },
		);
	});
});
