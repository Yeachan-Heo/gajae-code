import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import { isHarnessLoopbackEndpointUrl } from "../../src/harness-control-plane/harness-endpoint-url";

const SEED = 619452;
const RUNS = 64;

describe("harness discovery url", () => {
	it("accepts loopback ws(s) origins, including case, whitespace, and numeric hosts", () => {
		for (const raw of [
			"ws://127.0.0.1:9",
			"ws://127.0.0.1:9/",
			"wss://127.0.0.1:443",
			"ws://localhost:9",
			"ws://LOCALHOST:9",
			"ws://[::1]:9",
			"ws://127.0.0.1",
			" wss://127.0.0.1:9 ",
			"ws://2130706433:9",
			"ws://localhost.:9",
			"ws://LOCALHOST.:9",
			"ws://127.0.0.1.:9",
			"wss://127.0.0.1",
			"wss://localhost",
		]) {
			expect(isHarnessLoopbackEndpointUrl(raw)).toBe(true);
		}
	});

	it("rejects non-loopback, path, query, userinfo, and other schemes", () => {
		for (const raw of [
			"ws://127.0.0.1:9/steal",
			"ws://127.0.0.1:9/steal?token=fake-token-from-repo",
			"wss://203.0.113.10:443",
			"ws://user:pw@127.0.0.1:9",
			"http://127.0.0.1:9",
			"ws://127.0.0.1:9#frag",
			"ws://127.0.0.1:9/#",
			"ws://127.0.0.1:9/?",
			"ws://127.0.0.1:9/?#",
			"ws://example.com:9",
			"ws://0.0.0.0:9",
			"",
		]) {
			expect(isHarnessLoopbackEndpointUrl(raw)).toBe(false);
		}
		expect(isHarnessLoopbackEndpointUrl(`ws://127.0.0.1:9/${"a".repeat(4096)}`)).toBe(false);
		expect(isHarnessLoopbackEndpointUrl(`${" ".repeat(2100)}ws://127.0.0.1:9`)).toBe(false);
	});

	it("property: harness loopback endpoint url, seed 619452, 64 inputs", () => {
		const host = fc.constantFrom("127.0.0.1", "localhost", "LOCALHOST", "[::1]");
		const port = fc.integer({ min: 1, max: 65535 });
		const scheme = fc.constantFrom("ws", "wss");
		fc.assert(
			fc.property(host, port, scheme, fc.boolean(), (chosenHost, chosenPort, chosenScheme, slash) => {
				const url = `${chosenScheme}://${chosenHost}:${chosenPort}${slash ? "/" : ""}`;
				expect(isHarnessLoopbackEndpointUrl(url)).toBe(true);
				expect(isHarnessLoopbackEndpointUrl(`${url}/steal`)).toBe(false);
				expect(isHarnessLoopbackEndpointUrl(`${url}?token=x`)).toBe(false);
				expect(isHarnessLoopbackEndpointUrl(`${url}#`)).toBe(false);
				expect(isHarnessLoopbackEndpointUrl(`${url}?`)).toBe(false);
				expect(isHarnessLoopbackEndpointUrl(`${chosenScheme}://user@${chosenHost}:${chosenPort}`)).toBe(false);
			}),
			{ seed: SEED, numRuns: RUNS },
		);
		fc.assert(
			fc.property(fc.constantFrom("http", "https", "file"), port, (chosenScheme, chosenPort) => {
				expect(isHarnessLoopbackEndpointUrl(`${chosenScheme}://127.0.0.1:${chosenPort}`)).toBe(false);
				expect(isHarnessLoopbackEndpointUrl(`ws://203.0.113.10:${chosenPort}`)).toBe(false);
			}),
			{ seed: SEED, numRuns: RUNS },
		);
		fc.assert(
			fc.property(fc.string({ maxLength: 180 }), raw => {
				const allowed = isHarnessLoopbackEndpointUrl(raw);
				expect(isHarnessLoopbackEndpointUrl(raw)).toBe(allowed);
				if (!allowed) return;
				const url = new URL(raw);
				const parsed = url.hostname
					.toLowerCase()
					.replace(/^\[|\]$/g, "")
					.replace(/\.$/, "");
				expect(url.protocol === "ws:" || url.protocol === "wss:").toBe(true);
				expect(parsed === "127.0.0.1" || parsed === "localhost" || parsed === "::1").toBe(true);
				expect(url.username).toBe("");
				expect(url.password).toBe("");
				expect(url.search).toBe("");
				expect(url.hash).toBe("");
				expect(url.href.includes("?")).toBe(false);
				expect(url.href.includes("#")).toBe(false);
				expect(url.pathname === "/" || url.pathname === "").toBe(true);
			}),
			{ seed: SEED, numRuns: RUNS },
		);
	});
});
