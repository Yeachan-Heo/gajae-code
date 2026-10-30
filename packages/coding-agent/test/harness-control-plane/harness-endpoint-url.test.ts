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
			"ws://127.0.0.2:9",
			"ws://127.1.2.3:9",
			"ws://2130706434:9",
			"ws://localhost.:9",
			"ws://LOCALHOST.:9",
			"ws://127.0.0.1.:9",
			"wss://127.0.0.1",
			"wss://localhost",
			"ws://127.1:9",
			"ws://0x7f000001:9",
			"ws://127.0.0.1:9/steal/..",
			"ws://127.0.0.1:80",
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
			"ws://127.0.0.1.evil:9",
			"ws://localhost.evil:9",
			"",
		]) {
			expect(isHarnessLoopbackEndpointUrl(raw)).toBe(false);
		}
		expect(isHarnessLoopbackEndpointUrl(`ws://127.0.0.1:9/${"a".repeat(4096)}`)).toBe(false);
		expect(isHarnessLoopbackEndpointUrl(`${" ".repeat(2100)}ws://127.0.0.1:9`)).toBe(false);
	});

	it("rejects port zero and IPv4-mapped IPv6 and keeps port one and IPv6 loopback", () => {
		for (const raw of [
			"ws://127.0.0.1:0",
			"ws://localhost:0",
			"ws://[::1]:0",
			" ws://127.0.0.1:0 ",
			"wss://127.0.0.1:0",
			"ws://[::ffff:127.0.0.1]:9",
			"ws://[::FFFF:127.0.0.1]:9",
			"ws://[::ffff:7f00:1]:9",
			"ws://[::ffff:127.0.0.1]:1",
		]) {
			expect(isHarnessLoopbackEndpointUrl(raw)).toBe(false);
		}
		for (const raw of ["ws://127.0.0.1:1", "ws://[::1]:1", "ws://[::1]:9", " wss://127.0.0.1:1 "]) {
			expect(isHarnessLoopbackEndpointUrl(raw)).toBe(true);
		}
	});

	it("property: harness loopback endpoint url, seed 619452, 64 inputs", () => {
		const host = fc.constantFrom("127.0.0.1", "127.0.0.2", "127.1.2.3", "localhost", "LOCALHOST", "[::1]");
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
		const octet = fc.integer({ min: 0, max: 255 });
		fc.assert(
			fc.property(octet, octet, octet, port, (a, b, c, chosenPort) => {
				expect(isHarnessLoopbackEndpointUrl(`ws://127.${a}.${b}.${c}:${chosenPort}`)).toBe(true);
				expect(isHarnessLoopbackEndpointUrl(`wss://127.${a}.${b}.${c}:${chosenPort}/steal`)).toBe(false);
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
				const v4 = parsed.split(".");
				const ipv4Loopback =
					v4.length === 4 &&
					v4.every(part => /^[0-9]{1,3}$/.test(part) && Number(part) <= 255) &&
					Number(v4[0]) === 127;
				expect(url.protocol === "ws:" || url.protocol === "wss:").toBe(true);
				expect(ipv4Loopback || parsed === "localhost" || parsed === "::1").toBe(true);
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
		const loopbackHost = fc.constantFrom("127.0.0.1", "127.0.0.2", "localhost", "[::1]");
		fc.assert(
			fc.property(loopbackHost, scheme, (chosenHost, chosenScheme) => {
				expect(isHarnessLoopbackEndpointUrl(`${chosenScheme}://${chosenHost}:0`)).toBe(false);
				expect(isHarnessLoopbackEndpointUrl(`${chosenScheme}://${chosenHost}:1`)).toBe(true);
			}),
			{ seed: SEED, numRuns: RUNS },
		);
		fc.assert(
			fc.property(scheme, port, (chosenScheme, chosenPort) => {
				expect(isHarnessLoopbackEndpointUrl(`${chosenScheme}://[::ffff:127.0.0.1]:${chosenPort}`)).toBe(false);
				expect(isHarnessLoopbackEndpointUrl(`${chosenScheme}://[::ffff:7f00:1]:${chosenPort}`)).toBe(false);
			}),
			{ seed: SEED, numRuns: RUNS },
		);
	});
});
