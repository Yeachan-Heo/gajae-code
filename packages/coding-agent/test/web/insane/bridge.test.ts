import { afterEach, describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import {
	type EngineRawOutput,
	INSANE_NOTES,
	type InsaneDependencyStatus,
	resetInsaneConcurrencyForTest,
	runEngineSubprocess,
	tryInsaneFetch,
} from "../../../src/web/insane/bridge";

const ALL_DEPS: InsaneDependencyStatus = { vendorPresent: true, python: true, curlCffi: true, browser: true };

function deps(overrides: Partial<InsaneDependencyStatus> = {}): () => Promise<InsaneDependencyStatus> {
	return async () => ({ ...ALL_DEPS, ...overrides });
}

function rawOutput(overrides: Partial<EngineRawOutput> = {}): EngineRawOutput {
	return { code: 0, stdout: "", stderr: "", timedOut: false, aborted: false, ...overrides };
}

afterEach(() => resetInsaneConcurrencyForTest());

describe("tryInsaneFetch dependency gating", () => {
	it("fails closed when vendor is missing", async () => {
		const r = await tryInsaneFetch("https://example.com", {
			prober: deps({ vendorPresent: false }),
			runner: async () => rawOutput(),
		});
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.notes).toContain(INSANE_NOTES.vendorMissing);
	});

	it("fails closed when python3 is missing", async () => {
		const r = await tryInsaneFetch("https://example.com", {
			prober: deps({ python: false }),
			runner: async () => rawOutput(),
		});
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.notes).toContain(INSANE_NOTES.noPython);
	});

	it("fails closed when curl_cffi is missing", async () => {
		const r = await tryInsaneFetch("https://example.com", {
			prober: deps({ curlCffi: false }),
			runner: async () => rawOutput(),
		});
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.notes).toContain(INSANE_NOTES.noCurlCffi);
	});

	it("fails closed when node/playwright/stealth are missing", async () => {
		const r = await tryInsaneFetch("https://example.com", {
			prober: deps({ browser: false }),
			runner: async () => rawOutput(),
		});
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.notes).toContain(INSANE_NOTES.noBrowser);
	});
});

describe("tryInsaneFetch JSON mapping", () => {
	it("maps ok:true content to success and preserves profile", async () => {
		const r = await tryInsaneFetch("https://example.com", {
			prober: deps(),
			runner: async () =>
				rawOutput({ stdout: JSON.stringify({ ok: true, content: "hello world", profile_used: "chrome" }) }),
		});
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.content).toBe("hello world");
			expect(r.profileUsed).toBe("chrome");
		}
	});

	it("maps the real CLI JSON envelope with bounded content to success", async () => {
		const r = await tryInsaneFetch("https://example.com", {
			prober: deps(),
			runner: async () =>
				rawOutput({
					stdout: JSON.stringify({
						ok: true,
						content: "bounded recovered content",
						content_length: 123456,
						content_truncated: true,
						profile_used: "phase0:reddit",
					}),
				}),
		});
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.content).toBe("bounded recovered content");
			expect(r.profileUsed).toBe("phase0:reddit");
		}
	});

	it("does not fake success for legacy ok:true JSON that only reports content_length", async () => {
		const r = await tryInsaneFetch("https://example.com", {
			prober: deps(),
			runner: async () => rawOutput({ stdout: JSON.stringify({ ok: true, content_length: 42 }) }),
		});
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.reason).toBe("empty-content");
			expect(r.notes).toContain(INSANE_NOTES.emptyContent);
		}
	});

	it("maps the engine auth_required verdict token to failure without bypass", async () => {
		const r = await tryInsaneFetch("https://example.com", {
			prober: deps(),
			runner: async () => rawOutput({ stdout: JSON.stringify({ ok: false, verdict: "auth_required" }) }),
		});
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.reason).toBe("auth-required");
			expect(r.notes).toContain(INSANE_NOTES.authRequired);
		}
	});

	it("also tolerates the human-readable authentication-required phrase", async () => {
		const r = await tryInsaneFetch("https://example.com", {
			prober: deps(),
			runner: async () => rawOutput({ stdout: JSON.stringify({ ok: false, verdict: "authentication required" }) }),
		});
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toBe("auth-required");
	});

	it("maps invalid JSON to a controlled failure", async () => {
		const r = await tryInsaneFetch("https://example.com", {
			prober: deps(),
			runner: async () => rawOutput({ stdout: "not json <html>" }),
		});
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.notes).toContain(INSANE_NOTES.invalidJson);
	});

	it("maps timeout to a controlled failure", async () => {
		const r = await tryInsaneFetch("https://example.com", {
			prober: deps(),
			runner: async () => rawOutput({ timedOut: true, code: null }),
		});
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toBe("timeout");
	});

	it("maps abort to a controlled failure", async () => {
		const r = await tryInsaneFetch("https://example.com", {
			prober: deps(),
			runner: async () => rawOutput({ aborted: true, code: null }),
		});
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toBe("aborted");
	});

	it("treats ok:true with empty content as failure", async () => {
		const r = await tryInsaneFetch("https://example.com", {
			prober: deps(),
			runner: async () => rawOutput({ stdout: JSON.stringify({ ok: true, content: "   " }) }),
		});
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.notes).toContain(INSANE_NOTES.emptyContent);
	});

	it("surfaces untried routes and playwright-mcp hints as notes", async () => {
		const r = await tryInsaneFetch("https://example.com", {
			prober: deps(),
			runner: async () =>
				rawOutput({
					stdout: JSON.stringify({
						ok: false,
						verdict: "blocked",
						untried_routes: ["mobile", "rss"],
						must_invoke_playwright_mcp: true,
					}),
				}),
		});
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.notes.some(n => n.includes("mobile, rss"))).toBe(true);
			expect(r.notes).toContain(INSANE_NOTES.mustBrowserMcp);
			expect(r.notes).toContain(INSANE_NOTES.verdict("blocked"));
		}
	});
});

describe("tryInsaneFetch concurrency cap", () => {
	it("rejects attempts beyond the concurrency limit", async () => {
		let release!: () => void;
		const gate = new Promise<void>(resolve => {
			release = resolve;
		});
		const slowRunner = async (): Promise<EngineRawOutput> => {
			await gate;
			return rawOutput({ stdout: JSON.stringify({ ok: true, content: "x" }) });
		};
		const first = tryInsaneFetch("https://example.com", { prober: deps(), runner: slowRunner, concurrencyLimit: 1 });
		// Give the first call a tick to increment in-flight.
		await new Promise(r => setTimeout(r, 5));
		const second = await tryInsaneFetch("https://example.com", {
			prober: deps(),
			runner: slowRunner,
			concurrencyLimit: 1,
		});
		expect(second.ok).toBe(false);
		if (!second.ok) expect(second.notes).toContain(INSANE_NOTES.concurrency);
		release();
		await first;
	});
});

// Fake child process for runEngineSubprocess kill/reap tests.
class FakeChild extends EventEmitter {
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	killed: string[] = [];
	kill(signal?: string): boolean {
		this.killed.push(signal ?? "SIGTERM");
		return true;
	}
}

describe("runEngineSubprocess hardening", () => {
	it("kills the child on timeout", async () => {
		const child = new FakeChild();
		const fakeSpawn = (() => child) as unknown as typeof import("node:child_process").spawn;
		const promise = runEngineSubprocess({ url: "https://example.com", timeoutMs: 1 }, { spawnImpl: fakeSpawn });
		// Let the timeout fire, then simulate the process exiting after the kill.
		await new Promise(r => setTimeout(r, 20));
		expect(child.killed.length).toBeGreaterThan(0);
		child.emit("close", null);
		const out = await promise;
		expect(out.timedOut).toBe(true);
	});

	it("kills the child on abort", async () => {
		const child = new FakeChild();
		const fakeSpawn = (() => child) as unknown as typeof import("node:child_process").spawn;
		const controller = new AbortController();
		const promise = runEngineSubprocess(
			{ url: "https://example.com", timeoutMs: 10_000, signal: controller.signal },
			{ spawnImpl: fakeSpawn },
		);
		controller.abort();
		await new Promise(r => setTimeout(r, 5));
		expect(child.killed.length).toBeGreaterThan(0);
		child.emit("close", null);
		const out = await promise;
		expect(out.aborted).toBe(true);
	});

	it("parses stdout from a completed child", async () => {
		const child = new FakeChild();
		const fakeSpawn = (() => child) as unknown as typeof import("node:child_process").spawn;
		const promise = runEngineSubprocess({ url: "https://example.com", timeoutMs: 10_000 }, { spawnImpl: fakeSpawn });
		child.stdout.emit("data", Buffer.from('{"ok":true,'));
		child.stdout.emit("data", Buffer.from('"content":"hi"}'));
		child.emit("close", 0);
		const out = await promise;
		expect(out.stdout).toBe('{"ok":true,"content":"hi"}');
		expect(out.code).toBe(0);
		expect(out.timedOut).toBe(false);
	});
});
