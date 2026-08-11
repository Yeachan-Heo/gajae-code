import { describe, expect, it, vi } from "bun:test";
import {
	BrowserRuntimeDiagnosticsMailbox,
	consoleErrorDiagnostic,
	instrumentBrowserRuntimeDiagnostics,
	maskBrowserRuntimeUrl,
	pageErrorDiagnostic,
	serializeRuntimeDiagnostics,
} from "@gajae-code/coding-agent/tools/browser/runtime-diagnostics";

describe("browser runtime diagnostics", () => {
	it("reduces http(s) URLs to origin only, never echoing path segments or query strings", () => {
		expect(maskBrowserRuntimeUrl("https://example.com/callback?token=secret#done")).toBe("https://example.com");
		// The maintainer's exact probe: a token embedded in the PATH must not leak.
		expect(maskBrowserRuntimeUrl("https://example.com/account/SESSION_TOKEN_ABC123?k=v")).toBe("https://example.com");
		expect(maskBrowserRuntimeUrl("https://user:pass@example.com:8443/u/alice@example.com?reset=1")).toBe(
			"https://example.com:8443",
		);
		// Origin excludes userinfo and default ports; the result is bounded and stable.
		expect(maskBrowserRuntimeUrl("http://example.com/very/long/path")).toBe("http://example.com");
		expect(maskBrowserRuntimeUrl("https://example.com/")).toBe("https://example.com");
	});

	it("does not echo non-parseable values; fixed engine literals pass through", () => {
		// Raw path values (no scheme) are not URLs — they are hashed irreversibly.
		const raw = maskBrowserRuntimeUrl("/account/SESSION_TOKEN");
		expect(raw).toMatch(/^\[non-url:[0-9a-f]{8}\]$/);
		expect(raw).not.toContain("SESSION_TOKEN");

		const garbage = maskBrowserRuntimeUrl("https://example.com:badport/secret");
		expect(garbage).toMatch(/^\[non-url:[0-9a-f]{8}\]$/);
		expect(garbage).not.toContain("secret");

		// Known engine script-URL literals are fixed and safe to surface.
		expect(maskBrowserRuntimeUrl("")).toBe("");
		expect(maskBrowserRuntimeUrl("eval")).toBe("eval");
		expect(maskBrowserRuntimeUrl("anonymous")).toBe("anonymous");
		expect(maskBrowserRuntimeUrl("__puppeteer_evaluation_script__")).toBe("__puppeteer_evaluation_script__");
	});

	it("keeps only safe about: paths and masks other schemes", () => {
		expect(maskBrowserRuntimeUrl("about:blank")).toBe("about:blank");
		expect(maskBrowserRuntimeUrl("about:config")).toBe("about:config");
		// about: paths are page-navigable; page-controlled names are dropped.
		expect(maskBrowserRuntimeUrl("about:evil/TOKEN")).toBe("about:…");
		expect(maskBrowserRuntimeUrl("data:text/plain,secret")).toBe("data:…");
		expect(maskBrowserRuntimeUrl("blob:https://example.com/secret")).toBe("blob:…");
		expect(maskBrowserRuntimeUrl("javascript:alert(1)")).toBe("javascript:…");
	});

	it("keeps only bounded page-error metadata with an allowlisted error class", () => {
		const diagnostic = pageErrorDiagnostic(
			{
				exceptionDetails: {
					url: "https://example.com/account/SESSION_TOKEN_ABC123?credential=secret",
					lineNumber: 12,
					columnNumber: 4,
					exception: { className: "TypeError" },
					text: "secret message",
				} as never,
			},
			"https://fallback.invalid/?secret",
		);

		expect(diagnostic).toMatchObject({
			kind: "pageerror",
			url: "https://example.com",
			line: 12,
			column: 4,
			class: "TypeError",
		});
		expect(JSON.stringify(diagnostic)).not.toContain("secret");
		expect(JSON.stringify(diagnostic)).not.toContain("SESSION_TOKEN");
	});

	it("omits page-controlled error class names instead of echoing them", () => {
		// The maintainer's probe: a page can throw `new CustomerAlice123()`.
		const pageControlled = pageErrorDiagnostic(
			{
				exceptionDetails: {
					exception: { className: "CustomerAlice123" },
				} as never,
			},
			"https://example.com/",
		);
		expect(pageControlled).not.toHaveProperty("class");
		expect(JSON.stringify(pageControlled)).not.toContain("CustomerAlice123");

		// Built-in classes keep passing through the fixed allowlist.
		for (const className of ["Error", "TypeError", "ReferenceError", "DOMException", "AggregateError"]) {
			expect(
				pageErrorDiagnostic({ exceptionDetails: { exception: { className } } } as never, "https://example.com/"),
			).toMatchObject({ class: className });
		}

		// Non-string class metadata is ignored.
		const nonString = pageErrorDiagnostic(
			{ exceptionDetails: { exception: { className: 42 } } } as never,
			"https://example.com/",
		);
		expect(nonString).not.toHaveProperty("class");
	});

	it("accepts console errors but ignores other console levels and argument values", () => {
		const error = consoleErrorDiagnostic(
			{
				type: "error",
				stackTrace: {
					callFrames: [{ url: "https://example.com/ui.js?token=secret", lineNumber: 8, columnNumber: 2 }],
				},
				args: [{ value: "secret argument" }],
			} as never,
			"https://fallback.invalid/",
		);
		expect(error).toMatchObject({
			kind: "console-error",
			url: "https://example.com",
			line: 8,
			column: 2,
		});
		expect(JSON.stringify(error)).not.toContain("secret");
		expect(consoleErrorDiagnostic({ type: "warning" }, "https://example.com/")).toBeUndefined();
	});

	it("subscribes through CDP and records only runtime error events", async () => {
		const handlers = new Map<string, (event: never) => void>();
		const send = vi.fn(async () => ({}));
		const session = {
			on: (name: string, handler: (event: never) => void) => handlers.set(name, handler),
			send,
			detach: vi.fn(async () => {}),
		};
		const page = {
			target: () => ({ createCDPSession: async () => session }),
			url: () => "https://example.com/current?token=secret",
		};
		const mailbox = new BrowserRuntimeDiagnosticsMailbox();

		const attached = await instrumentBrowserRuntimeDiagnostics(page as never, mailbox);
		expect(attached).toBe(session as never);
		expect(send).toHaveBeenCalledWith("Runtime.enable");

		handlers.get("Runtime.exceptionThrown")?.({
			exceptionDetails: {
				url: "https://example.com/account/SESSION_TOKEN_ABC123?token=secret",
				lineNumber: 3,
				exception: { className: "TypeError", description: "secret message" },
			},
		} as never);
		handlers.get("Runtime.consoleAPICalled")?.({ type: "warning" } as never);
		handlers.get("Runtime.consoleAPICalled")?.({
			type: "error",
			args: [{ value: "secret argument" }],
		} as never);

		const drained = mailbox.drain();
		expect(drained.runtimeDiagnostics.map(entry => entry.kind)).toEqual(["pageerror", "console-error"]);
		expect(JSON.stringify(drained)).not.toContain("secret");
		expect(JSON.stringify(drained)).not.toContain("SESSION_TOKEN");
		expect(drained.runtimeDiagnostics.map(entry => entry.url)).toEqual([
			"https://example.com",
			"https://example.com",
		]);
	});

	it("serializes within the total byte budget and marks truncation explicitly", () => {
		const entries = Array.from({ length: 20 }, (_, index) => ({
			kind: "console-error" as const,
			at: `2026-08-10T00:00:${String(index).padStart(2, "0")}.000Z`,
			// Over the per-field cap: page-controlled path strings stay bounded.
			url: `https://example.com/${"a".repeat(300)}`,
		}));

		const text = serializeRuntimeDiagnostics({ runtimeDiagnostics: entries, runtimeDiagnosticsDropped: 0 });
		expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(4 * 1024);

		const block = JSON.parse(text) as {
			runtimeDiagnostics: Array<{ at: string; url: string }>;
			runtimeDiagnosticsTruncated?: boolean;
		};
		expect(block.runtimeDiagnosticsTruncated).toBe(true);
		expect(block.runtimeDiagnostics.length).toBeGreaterThan(0);
		expect(block.runtimeDiagnostics.length).toBeLessThan(20);

		// Newest entries survive a tight budget, in original order; oldest are shed.
		const keptAt = block.runtimeDiagnostics.map(entry => entry.at);
		expect(keptAt.at(-1)).toBe("2026-08-10T00:00:19.000Z");
		expect(keptAt).toEqual([...keptAt].sort());

		// Per-field cap is visible: every url is bounded and ends with the truncation marker.
		for (const entry of block.runtimeDiagnostics) {
			expect(entry.url.length).toBeLessThanOrEqual(256);
			expect(entry.url.endsWith("…")).toBe(true);
		}
	});

	it("bounds the masked URL itself even for pathological hosts", () => {
		// A 100k-char synthetic host must never produce an unbounded diagnostic field;
		// the masker itself caps the origin with a visible marker.
		const masked = maskBrowserRuntimeUrl(`https://${"a".repeat(100_000)}.example.com/secret?token=t`);
		expect(masked.length).toBeLessThanOrEqual(256);
		expect(masked.endsWith("…")).toBe(true);
		expect(masked).not.toContain("secret");
		expect(masked).not.toContain("token");
	});

	it("flags truncation even when a single over-budget entry cannot be shed", () => {
		// Type-violating input only (the pipeline's `at` is always an ISO timestamp),
		// but an over-budget block must never be silent: the marker is explicit.
		const text = serializeRuntimeDiagnostics({
			runtimeDiagnostics: [{ kind: "console-error", at: "x".repeat(6_000), url: "https://example.com" }],
			runtimeDiagnosticsDropped: 0,
		});
		const block = JSON.parse(text) as { runtimeDiagnosticsTruncated?: boolean };
		expect(block.runtimeDiagnosticsTruncated).toBe(true);
	});

	it("keeps every entry when the block fits comfortably, with no truncation marker", () => {
		const entries = Array.from({ length: 20 }, (_, index) => ({
			kind: "console-error" as const,
			at: `2026-08-10T00:00:${String(index).padStart(2, "0")}.000Z`,
			url: "https://example.com",
		}));

		const text = serializeRuntimeDiagnostics({ runtimeDiagnostics: entries, runtimeDiagnosticsDropped: 2 });
		const block = JSON.parse(text) as {
			runtimeDiagnostics: unknown[];
			runtimeDiagnosticsDropped: number;
			runtimeDiagnosticsTruncated?: boolean;
		};
		expect(block.runtimeDiagnostics).toHaveLength(20);
		expect(block.runtimeDiagnosticsDropped).toBe(2);
		expect(block.runtimeDiagnosticsTruncated).toBeUndefined();
		expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(4 * 1024);
	});

	it("serializes the full masked pipeline without retaining secrets", () => {
		const mailbox = new BrowserRuntimeDiagnosticsMailbox();
		mailbox.push(
			pageErrorDiagnostic(
				{
					exceptionDetails: {
						url: "https://example.com/account/SESSION_TOKEN_ABC123?token=secret",
						lineNumber: 3,
						exception: { className: "CustomerAlice123", description: "secret message" },
					},
				} as never,
				"https://example.com/",
			),
		);
		mailbox.push(
			consoleErrorDiagnostic(
				{
					type: "error",
					stackTrace: { callFrames: [{ url: "https://example.com/ui.js?token=secret", lineNumber: 8 }] },
				} as never,
				"https://example.com/",
			)!,
		);

		const text = serializeRuntimeDiagnostics(mailbox.drain());
		expect(text).not.toContain("secret");
		expect(text).not.toContain("SESSION_TOKEN");
		expect(text).not.toContain("CustomerAlice123");
		expect(text).toContain('"kind": "pageerror"');
		expect(text).toContain('"kind": "console-error"');
	});

	it("retains the newest twenty entries, counts evictions, and drains once", () => {
		const mailbox = new BrowserRuntimeDiagnosticsMailbox();
		for (let index = 0; index < 22; index += 1) {
			mailbox.push({
				kind: "console-error",
				at: `2026-08-10T00:00:${String(index).padStart(2, "0")}.000Z`,
				url: `https://example.com/${index}`,
			});
		}

		const first = mailbox.drain();
		expect(first.runtimeDiagnostics).toHaveLength(20);
		expect(first.runtimeDiagnostics[0]?.url).toBe("https://example.com/2");
		expect(first.runtimeDiagnostics.at(-1)?.url).toBe("https://example.com/21");
		expect(first.runtimeDiagnosticsDropped).toBe(2);
		expect(mailbox.drain()).toEqual({ runtimeDiagnostics: [], runtimeDiagnosticsDropped: 0 });
	});
});
