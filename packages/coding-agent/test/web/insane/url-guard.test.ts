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
			"http://[fec0::1]/",
			"http://[fedf::1]/",
			"http://[100::1]/",
			"http://[2001:2::1]/",
			"http://[2001:db8::1]/",
			"http://[2002::1]/",
			"http://[3ffe::1]/",
			"http://[3fff::1]/",
			"http://[64:ff9b:1::7f00:1]/",
		];
		for (const url of literals) {
			const result = await validatePublicHttpUrlForInsane(url, { resolver: throwingResolver() });
			expect(result.ok).toBe(false);
		}
	});

	it("accepts a public global-unicast IPv6 literal without resolving", async () => {
		const result = await validatePublicHttpUrlForInsane("https://[2606:4700:4700::1111]/", {
			resolver: throwingResolver(),
		});
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.addresses).toEqual(["2606:4700:4700::1111"]);
	});

	it("rejects a DNS name that resolves to a private IP", async () => {
		const result = await validatePublicHttpUrlForInsane("https://sneaky.example/", {
			resolver: staticResolver({ "sneaky.example": ["10.1.2.3"] }),
		});
		expect(result.ok).toBe(false);
	});

	it("rejects DNS names that resolve to non-global IPv6 addresses", async () => {
		for (const address of ["fec0::1", "fedf::1", "100::1", "2001:2::1", "64:ff9b:1::7f00:1"]) {
			const result = await validatePublicHttpUrlForInsane("https://sneaky.example/", {
				resolver: staticResolver({ "sneaky.example": [address] }),
			});
			expect(result.ok).toBe(false);
		}
	});

	it("accepts a DNS name that resolves to public global-unicast IPv6", async () => {
		const result = await validatePublicHttpUrlForInsane("https://public-v6.example/", {
			resolver: staticResolver({ "public-v6.example": ["2606:4700:4700::1111"] }),
		});
		expect(result.ok).toBe(true);
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
		expect(isPrivateOrSpecialAddress("::ffff:8.8.8.8")).toBe(false);
		expect(isPrivateOrSpecialAddress("fe80::1")).toBe(true);
		for (const address of [
			"fec0::1",
			"fedf::1",
			"100::1",
			"2001:2::1",
			"2001:db8::1",
			"2002::1",
			"3ffe::1",
			"3fff::1",
			"64:ff9b:1::7f00:1",
		]) {
			expect(isPrivateOrSpecialAddress(address)).toBe(true);
		}
		expect(isPrivateOrSpecialAddress("2606:4700:4700::1111")).toBe(false);
		expect(isPrivateOrSpecialAddress("not-an-ip")).toBe(true);
	});
});
