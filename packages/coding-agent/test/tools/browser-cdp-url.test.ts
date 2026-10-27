import { describe, expect, it } from "bun:test";
import { assertLoopbackCdpUrl } from "../../src/tools/browser/cdp-url";

describe("assertLoopbackCdpUrl", () => {
	it("allows loopback CDP URLs and rejects other hosts", () => {
		expect(assertLoopbackCdpUrl("http://127.0.0.1:9222")).toBe("http://127.0.0.1:9222");
		expect(assertLoopbackCdpUrl("http://localhost:9222/")).toBe("http://localhost:9222/");
		expect(assertLoopbackCdpUrl("http://[::1]:9222")).toBe("http://[::1]:9222");
		expect(() => assertLoopbackCdpUrl("http://169.254.169.254/latest/meta-data")).toThrow(/non-loopback/);
		expect(() => assertLoopbackCdpUrl("http://10.255.255.1:9222")).toThrow(/non-loopback/);
		expect(() => assertLoopbackCdpUrl("file:///tmp/browser")).toThrow(/non-loopback/);
	});
});
