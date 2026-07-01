import { describe, expect, it } from "bun:test";
import {
	type AsideReplProcess,
	AsideReplSession,
	type AsideRunPayload,
	boundedTail,
	buildAsideRunWrapper,
	isAsideFooter,
	parseAsideFrame,
} from "../../src/tools/browser/aside-driver";

const BEGIN = "__GJC_ASIDE_BEGIN__";
const END = "__GJC_ASIDE_END__";

function frame(nonce: string, payload: AsideRunPayload): string {
	const b64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
	return `${BEGIN}${nonce}\n${b64}\n${END}${nonce}\n[ok | 5ms]\n`;
}

/** Controllable fake REPL child; captures the submitted wrapper and lets tests emit stdout. */
class FakeProc implements AsideReplProcess {
	lastLine = "";
	killed = false;
	#stdout?: (c: string) => void;
	#exit?: (c: number | null) => void;
	writeLine(line: string): void {
		this.lastLine = line;
	}
	onStdout(cb: (c: string) => void): void {
		this.#stdout = cb;
	}
	onExit(cb: (c: number | null) => void): void {
		this.#exit = cb;
	}
	kill(): void {
		this.killed = true;
	}
	emit(chunk: string): void {
		this.#stdout?.(chunk);
	}
	exit(code: number | null = 0): void {
		this.#exit?.(code);
	}
	/** Extract the nonce from the wrapper the session just submitted. */
	nonce(): string {
		const m = /__GJC_ASIDE_BEGIN__("?)([^"\\]+)\1/.exec(this.lastLine);
		if (!m) throw new Error(`no nonce in submitted line: ${this.lastLine.slice(0, 120)}`);
		return m[2]!;
	}
}

function sessionWithFake(timeoutMs = 1000): { session: AsideReplSession; proc: FakeProc } {
	let proc!: FakeProc;
	const session = new AsideReplSession({
		cliPath: "/x/aside",
		timeoutMs,
		spawn: () => {
			proc = new FakeProc();
			return proc;
		},
	});
	return { session, proc };
}

describe("aside-driver pure helpers", () => {
	it("builds a single-line wrapper carrying base64 code + nonce sentinels", () => {
		const w = buildAsideRunWrapper("const p = await openTab('https://example.com/')\nreturn 1", "N1");
		expect(w.includes("\n")).toBe(false); // single physical line
		expect(w).toContain("__GJC_ASIDE_BEGIN__");
		expect(w).toContain("N1");
	});

	it("parses only the matching nonce frame, ignoring surrounding noise", () => {
		const noisy =
			"✔︎ Opened a new tab and set it active\n" +
			"some user console.log\n" +
			frame("N2", { ok: true, returnValue: 42 });
		const payload = parseAsideFrame(noisy, "N2");
		expect(payload).toEqual({ ok: true, returnValue: 42 });
	});

	it("returns null for a non-matching nonce", () => {
		expect(parseAsideFrame(frame("N3", { ok: true }), "OTHER")).toBeNull();
	});

	it("detects ok/error footers", () => {
		expect(isAsideFooter("[ok | 5ms]")).toBe("ok");
		expect(isAsideFooter("[error | 12ms]")).toBe("error");
		expect(isAsideFooter("hello")).toBeNull();
	});

	it("bounds long tails with a truncation notice", () => {
		const out = boundedTail("x".repeat(1000), 100);
		expect(out).toContain("truncated");
		expect(Buffer.byteLength(out)).toBeLessThan(300);
	});
});

describe("AsideReplSession", () => {
	it("resolves a framed success payload", async () => {
		const { session, proc } = sessionWithFake();
		const p = session.run("return 42");
		const nonce = proc.nonce();
		proc.emit(frame(nonce, { ok: true, returnValue: 42, displays: ["hi"] }));
		const payload = await p;
		expect(payload).toEqual({ ok: true, returnValue: 42, displays: ["hi"] });
	});

	it("resolves a framed error payload", async () => {
		const { session, proc } = sessionWithFake();
		const p = session.run("throw new Error('boom')");
		const nonce = proc.nonce();
		proc.emit(frame(nonce, { ok: false, error: { name: "Error", message: "boom" } }));
		const payload = await p;
		expect(payload.ok).toBe(false);
		expect(payload.error?.message).toBe("boom");
	});

	it("ignores unrelated output before the frame arrives", async () => {
		const { session, proc } = sessionWithFake();
		const p = session.run("return 1");
		const nonce = proc.nonce();
		proc.emit("✔︎ Opened a new tab\n");
		proc.emit("random daemon noise\n");
		proc.emit(frame(nonce, { ok: true, returnValue: 1 }));
		expect((await p).returnValue).toBe(1);
	});

	it("rejects on timeout and kills only this child", async () => {
		const { session, proc } = sessionWithFake(30);
		const p = session.run("while(true){}");
		await expect(p).rejects.toThrow(/timed out/i);
		expect(proc.killed).toBe(true);
	});

	it("rejects on abort and kills the child", async () => {
		const { session, proc } = sessionWithFake();
		const ac = new AbortController();
		const p = session.run("return 1", ac.signal);
		ac.abort();
		await expect(p).rejects.toThrow();
		expect(proc.killed).toBe(true);
	});

	it("enforces one pending run per tab (busy)", async () => {
		const { session, proc } = sessionWithFake();
		const p1 = session.run("return 1");
		await expect(session.run("return 2")).rejects.toThrow(/busy/i);
		proc.emit(frame(proc.nonce(), { ok: true, returnValue: 1 }));
		await p1;
	});

	it("rejects the pending run when the child exits early", async () => {
		const { session, proc } = sessionWithFake();
		const p = session.run("return 1");
		proc.exit(0);
		await expect(p).rejects.toThrow(/exited/i);
		expect(session.dead).toBe(true);
	});

	it("closes cleanly and refuses further runs", async () => {
		const { session, proc } = sessionWithFake();
		session.kill();
		expect(proc.killed).toBe(true);
		await expect(session.run("return 1")).rejects.toThrow(/closed/i);
	});
});

import { asidePayloadToRunResult, compileAsideActionSteps } from "../../src/tools/browser/aside-driver";

describe("compileAsideActionSteps", () => {
	it("maps verbs to Aside page/cua globals (no native tab helper)", () => {
		const code = compileAsideActionSteps([
			{ verb: "navigate", url: "https://example.com/" },
			{ verb: "click", selector: "#go" },
			{ verb: "observe" },
			{ verb: "screenshot" },
		]);
		expect(code).toContain("page.goto(s.url");
		expect(code).toContain("page.locator(s.selector).click()");
		expect(code).toContain("snapshot(page)");
		expect(code).toContain("cua.getVisibleScreenshot()");
		expect(code).not.toContain("tab.goto");
		expect(code).not.toContain("tab.id(");
	});

	it("rejects an invalid step", () => {
		// navigate without url is invalid
		expect(() => compileAsideActionSteps([{ verb: "navigate" }])).toThrow();
	});

	it("rejects id-addressed click/type actions with a clear Aside error", () => {
		expect(() => compileAsideActionSteps([{ verb: "click", id: 1 }])).toThrow(/Aside browser act.*numeric ids/i);
		expect(() => compileAsideActionSteps([{ verb: "type", id: 2, text: "hello" }])).toThrow(/use a selector/i);
	});
});

describe("asidePayloadToRunResult", () => {
	it("maps a success payload to RunResultOk", () => {
		const r = asidePayloadToRunResult({ ok: true, returnValue: 7, displays: ["a", "b"] });
		expect(r.returnValue).toBe(7);
		expect(r.displays).toEqual([
			{ type: "text", text: "a" },
			{ type: "text", text: "b" },
		]);
		expect(r.screenshots).toEqual([]);
	});

	it("throws a ToolError for an error payload", () => {
		expect(() => asidePayloadToRunResult({ ok: false, error: { message: "boom" } })).toThrow(/boom/);
	});
});
