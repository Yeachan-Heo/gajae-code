import { beforeAll, describe, expect, it } from "bun:test";
import { SessionObserverOverlayComponent } from "../../../src/modes/components/session-observer-overlay";
import { SessionObserverRegistry } from "../../../src/modes/session-observer-registry";
import * as themeModule from "../../../src/modes/theme/theme";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "../../../src/task";
import { EventBus } from "../../../src/utils/event-bus";

interface SubSpec {
	id: string;
	desc: string;
	agent: string;
	file: string;
}

function buildRegistry(subs: SubSpec[]): SessionObserverRegistry {
	const bus = new EventBus();
	const registry = new SessionObserverRegistry();
	registry.subscribeToEventBus(bus);
	registry.setMainSession("/tmp/session-observer-main.jsonl");
	subs.forEach((sub, i) => {
		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: sub.id,
			agent: sub.agent,
			agentSource: "builtin",
			description: sub.desc,
			status: "started",
			sessionFile: sub.file,
			index: i + 1,
		});
	});
	return registry;
}

function makeOverlay(registry: SessionObserverRegistry): {
	overlay: SessionObserverOverlayComponent;
	isDone: () => boolean;
} {
	let done = false;
	const overlay = new SessionObserverOverlayComponent(registry, () => {
		done = true;
	}, []);
	return { overlay, isDone: () => done };
}

function renderText(overlay: SessionObserverOverlayComponent, width: number): string {
	return overlay
		.render(width)
		.map(line => Bun.stripANSI(line))
		.join("\n");
}

const TWO_SUBS: SubSpec[] = [
	{ id: "1-executor", desc: "Implement ingestion pipeline", agent: "executor", file: "/tmp/sa-1.jsonl" },
	{ id: "2-planner", desc: "Sequence review UI work", agent: "planner", file: "/tmp/sa-2.jsonl" },
];

describe("SessionObserverOverlayComponent picker mode", () => {
	beforeAll(async () => {
		await themeModule.initTheme(false, undefined, undefined, "red-claw", "blue-crab");
	});

	it("opens in picker mode and lists the main session plus every subagent", () => {
		const { overlay } = makeOverlay(buildRegistry(TWO_SUBS));
		const out = renderText(overlay, 100);

		expect(out).toContain("Session Observer");
		expect(out).toContain("2 subagent(s)");
		expect(out).toContain("Main Session");
		expect(out).toContain("Implement ingestion pipeline");
		expect(out).toContain("Sequence review UI work");
		// Picker footer, not the transcript viewer footer.
		expect(out).toContain("j/k:navigate");
		expect(out).not.toContain("cycle agents");
	});

	it("keeps every rendered row within the viewport width", () => {
		const { overlay } = makeOverlay(buildRegistry(TWO_SUBS));
		for (const line of overlay.render(100).map(l => Bun.stripANSI(l))) {
			expect(Bun.stringWidth(line, { countAnsiEscapeCodes: false })).toBeLessThanOrEqual(100);
		}
	});

	it("Enter on a subagent opens the transcript viewer and Escape returns to the picker", () => {
		const { overlay } = makeOverlay(buildRegistry(TWO_SUBS));

		overlay.handleInput("\r");
		let out = renderText(overlay, 100);
		expect(out).toContain("cycle agents");
		expect(out).not.toContain("j/k:navigate");

		overlay.handleInput("\u001b");
		out = renderText(overlay, 100);
		expect(out).toContain("j/k:navigate");
		expect(out).not.toContain("cycle agents");
	});

	it("Enter on the main session row closes the overlay", () => {
		const { overlay, isDone } = makeOverlay(buildRegistry(TWO_SUBS));
		overlay.handleInput("g"); // jump to the top row (main session)
		overlay.handleInput("\r");
		expect(isDone()).toBe(true);
	});

	it("closes immediately when there are no subagent sessions", async () => {
		const bus = new EventBus();
		const registry = new SessionObserverRegistry();
		registry.subscribeToEventBus(bus);
		registry.setMainSession("/tmp/session-observer-main.jsonl");

		let done = false;
		new SessionObserverOverlayComponent(registry, () => {
			done = true;
		}, []);
		await new Promise<void>(resolve => queueMicrotask(resolve));
		expect(done).toBe(true);
	});
});
