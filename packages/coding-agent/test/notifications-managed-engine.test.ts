import { describe, expect, test } from "bun:test";
import { Settings } from "../src/config/settings";
import { ManagedNotificationDaemon, type ManagedNotificationDaemonFs } from "../src/notifications/managed-daemon";

class TestDaemon extends ManagedNotificationDaemon {
	constructor(fsImpl: ManagedNotificationDaemonFs) {
		super({ settings: Settings.isolated(), fs: fsImpl });
	}

	protected readRoots(): Promise<string[]> {
		return Promise.resolve([]);
	}

	public render(frame: Record<string, unknown>) {
		return this.renderFrame(frame);
	}
}

describe("shared managed notification daemon engine", () => {
	test("owns rate-limit pool and session registry outside presentation adapters", () => {
		const daemon = new TestDaemon({ readdir: async () => [] });
		expect(daemon.sessions.size).toBe(0);
		expect(daemon.pool.pending).toBe(0);
	});

	test("renders internal frames through shared renderer", () => {
		const daemon = new TestDaemon({ readdir: async () => [] });
		const send = daemon.render({ type: "turn_stream", sessionId: "s1", phase: "finalized", text: "**done**" });
		expect(send?.method).toBe("sendMessage");
		expect(send?.lane).toBe("finalized");
		expect(send?.text).toContain("done");
	});
});
