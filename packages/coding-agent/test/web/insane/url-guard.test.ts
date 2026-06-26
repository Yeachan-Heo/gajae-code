import { describe, expect, it } from "bun:test";
import {
	type AddressResolver,
	isPrivateOrSpecialAddress,
	validatePublicHttpUrl,
	validatePublicHttpUrlForInsane,
} from "../../../src/web/insane/url-guard";

// A resolver that must never be called for IP-literal / scheme / credential rejections.
function throwingResolver(): AddressResolver {
	return async () => {
		throw new Error("resolver must not be called");
	};
}

function staticResolver(map: Record<string, string[]>): AddressResolver {
	return async hostname => map[hostname] ?? [];
}

describe("validatePublicHttpUrlForInsane", () => {
	it("delegates to the shared public HTTP(S) URL guard", async () => {
		const options = { resolver: staticResolver({ "example.com": ["93.184.216.34"] }) };
		const shared = await validatePublicHttpUrl("https://example.com/path", options);
		const insane = await validatePublicHttpUrlForInsane("https://example.com/path", options);
		expect(insane).toEqual(shared);
	});

	it("accepts a normal https URL that resolves to a public IP", async () => {
		const result = await validatePublicHttpUrlForInsane("https://example.com/path", {
			resolver: staticResolver({ "example.com": ["93.184.216.34"] }),
		});
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.addresses).toContain("93.184.216.34");
	});

	it("rejects non-HTTP(S) schemes without resolving", async () => {
		for (const url of ["ftp://example.com", "file:///etc/passwd", "gopher://example.com"]) {
			const result = await validatePublicHttpUrlForInsane(url, { resolver: throwingResolver() });
			expect(result.ok).toBe(false);
		}
	});

	it("rejects URL credentials without resolving", async () => {
		const result = await validatePublicHttpUrlForInsane("https://user:pass@example.com", {
			resolver: throwingResolver(),
		});
		expect(result.ok).toBe(false);
	});

	it("rejects local/internal hostnames without resolving", async () => {
		for (const host of ["http://localhost/x", "http://api.local/x", "http://svc.internal/x"]) {
			const result = await validatePublicHttpUrlForInsane(host, { resolver: throwingResolver() });
			expect(result.ok).toBe(false);
		}
	});

	it("rejects private/loopback/link-local IP literals without resolving", async () => {
		const literals = [
			"http://127.0.0.1/",
			"http://10.0.0.1/",
			"http://169.254.1.1/",
			"http://192.168.1.1/",
			"http://172.16.0.1/",
			"http://[::1]/",
			"http://[::ffff:10.0.0.1]/",
		];
		for (const url of literals) {
			const result = await validatePublicHttpUrlForInsane(url, { resolver: throwingResolver() });
			expect(result.ok).toBe(false);
		}
	});

	it("rejects a DNS name that resolves to a private IP", async () => {
		const result = await validatePublicHttpUrlForInsane("https://sneaky.example/", {
			resolver: staticResolver({ "sneaky.example": ["10.1.2.3"] }),
		});
		expect(result.ok).toBe(false);
	});

	it("rejects when any resolved address is private (mixed records)", async () => {
		const result = await validatePublicHttpUrlForInsane("https://mixed.example/", {
			resolver: staticResolver({ "mixed.example": ["93.184.216.34", "192.168.0.5"] }),
		});
		expect(result.ok).toBe(false);
	});

	it("rejects when DNS resolution yields no addresses", async () => {
		const result = await validatePublicHttpUrlForInsane("https://empty.example/", {
			resolver: staticResolver({ "empty.example": [] }),
		});
		expect(result.ok).toBe(false);
	});
});

describe("isPrivateOrSpecialAddress", () => {
	it("classifies representative addresses", () => {
		expect(isPrivateOrSpecialAddress("8.8.8.8")).toBe(false);
		expect(isPrivateOrSpecialAddress("93.184.216.34")).toBe(false);
		expect(isPrivateOrSpecialAddress("127.0.0.1")).toBe(true);
		expect(isPrivateOrSpecialAddress("10.0.0.1")).toBe(true);
		expect(isPrivateOrSpecialAddress("169.254.0.1")).toBe(true);
		expect(isPrivateOrSpecialAddress("::1")).toBe(true);
		expect(isPrivateOrSpecialAddress("::ffff:10.0.0.1")).toBe(true);
		expect(isPrivateOrSpecialAddress("fe80::1")).toBe(true);
		expect(isPrivateOrSpecialAddress("not-an-ip")).toBe(true);
	});
});
