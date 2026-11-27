import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import {
	type AddressResolver,
	isPrivateIPv4,
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

	it("accepts DNS names that resolve to NAT64 well-known prefix with public IPv4", async () => {
		const result = await validatePublicHttpUrlForInsane("https://public-nat64.example/", {
			resolver: staticResolver({
				"public-nat64.example": ["223.130.200.236", "64:ff9b::df82:c8ec"],
			}),
		});
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.addresses).toContain("64:ff9b::df82:c8ec");
	});

	it("rejects DNS names that resolve to NAT64 well-known prefix with private IPv4", async () => {
		const result = await validatePublicHttpUrlForInsane("https://private-nat64.example/", {
			resolver: staticResolver({
				"private-nat64.example": ["64:ff9b::a00:1"], // 64:ff9b::10.0.0.1
			}),
		});
		expect(result.ok).toBe(false);
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
		expect(isPrivateOrSpecialAddress("192.88.99.2")).toBe(true);
		expect(isPrivateOrSpecialAddress("192.88.99.1")).toBe(true);
		expect(isPrivateOrSpecialAddress("::ffff:192.88.99.2")).toBe(true);
		expect(isPrivateOrSpecialAddress("192.88.98.2")).toBe(false);
		expect(isPrivateOrSpecialAddress("192.31.196.1")).toBe(false);
		expect(isPrivateOrSpecialAddress("192.52.193.1")).toBe(false);
		expect(isPrivateOrSpecialAddress("192.175.48.1")).toBe(false);
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

	it("handles NAT64 well-known prefix addresses", () => {
		// 64:ff9b::df82:c8ec = 64:ff9b::223.130.200.236 (public IPv4)
		expect(isPrivateOrSpecialAddress("64:ff9b::df82:c8ec")).toBe(false);
		// 64:ff9b::5808:101 = 64:ff9b::88.8.1.1 (public IPv4)
		expect(isPrivateOrSpecialAddress("64:ff9b::5808:101")).toBe(false);
		// 64:ff9b::a00:1 = 64:ff9b::10.0.0.1 (private IPv4)
		expect(isPrivateOrSpecialAddress("64:ff9b::a00:1")).toBe(true);
		// 64:ff9b::ac10:1 = 64:ff9b::172.16.0.1 (private IPv4)
		expect(isPrivateOrSpecialAddress("64:ff9b::ac10:1")).toBe(true);
		// 64:ff9b::c0a8:1 = 64:ff9b::192.168.0.1 (private IPv4)
		expect(isPrivateOrSpecialAddress("64:ff9b::c0a8:1")).toBe(true);
		// 64:ff9b::7f00:1 = 64:ff9b::127.0.0.1 (loopback)
		expect(isPrivateOrSpecialAddress("64:ff9b::7f00:1")).toBe(true);
	});

	it("blocks NAT64-wrapped private IPv4 ranges and special addresses", () => {
		// RFC 1918: 10/8, 172.16/12, 192.168/16
		expect(isPrivateOrSpecialAddress("64:ff9b::a00:0")).toBe(true); // 10.0.0.0
		expect(isPrivateOrSpecialAddress("64:ff9b::a7f:ffff")).toBe(true); // 10.127.255.255
		expect(isPrivateOrSpecialAddress("64:ff9b::ac10:0")).toBe(true); // 172.16.0.0
		expect(isPrivateOrSpecialAddress("64:ff9b::ac1f:ffff")).toBe(true); // 172.31.255.255
		expect(isPrivateOrSpecialAddress("64:ff9b::c0a8:0")).toBe(true); // 192.168.0.0
		expect(isPrivateOrSpecialAddress("64:ff9b::c0a8:ffff")).toBe(true); // 192.168.255.255
		// RFC 791 §3.2: 0.0/8 (this network)
		expect(isPrivateOrSpecialAddress("64:ff9b::0:0")).toBe(true); // 0.0.0.0
		// RFC 6598: 100.64/10 (CGNAT shared address space)
		expect(isPrivateOrSpecialAddress("64:ff9b::6440:0")).toBe(true); // 100.64.0.0
		expect(isPrivateOrSpecialAddress("64:ff9b::647f:ffff")).toBe(true); // 100.127.255.255
		// RFC 3927: 169.254/16 (link-local)
		expect(isPrivateOrSpecialAddress("64:ff9b::a9fe:0")).toBe(true); // 169.254.0.0
		expect(isPrivateOrSpecialAddress("64:ff9b::a9fe:ffff")).toBe(true); // 169.254.255.255
		// RFC 5737: 192.0.2/24 (documentation)
		expect(isPrivateOrSpecialAddress("64:ff9b::c000:200")).toBe(true); // 192.0.2.0
		// RFC 5737: 198.51.100/24 (documentation)
		expect(isPrivateOrSpecialAddress("64:ff9b::c633:6400")).toBe(true); // 198.51.100.0
		// RFC 5737: 203.0.113/24 (documentation)
		expect(isPrivateOrSpecialAddress("64:ff9b::cb00:7100")).toBe(true); // 203.0.113.0
		// RFC 2544: 198.18/15 (benchmarking)
		expect(isPrivateOrSpecialAddress("64:ff9b::c612:0")).toBe(true); // 198.18.0.0
		expect(isPrivateOrSpecialAddress("64:ff9b::c613:ffff")).toBe(true); // 198.19.255.255
		// RFC 3068: 192.88.99/24 (6to4 anycast)
		expect(isPrivateOrSpecialAddress("64:ff9b::c058:6300")).toBe(true); // 192.88.99.0
		// RFC 5771: 224/4 (multicast)
		expect(isPrivateOrSpecialAddress("64:ff9b::e000:0")).toBe(true); // 224.0.0.0
		expect(isPrivateOrSpecialAddress("64:ff9b::efff:ffff")).toBe(true); // 239.255.255.255
		// RFC 1112: 240/4 (reserved)
		expect(isPrivateOrSpecialAddress("64:ff9b::f000:0")).toBe(true); // 240.0.0.0
		expect(isPrivateOrSpecialAddress("64:ff9b::ffff:ffff")).toBe(true); // 255.255.255.255 (broadcast)
	});

	it("blocks NAT64 local-use prefix even with public IPv4 suffix", () => {
		// 64:ff9b:1::/48 is always blocked, regardless of IPv4 suffix
		expect(isPrivateOrSpecialAddress("64:ff9b:1::0:0")).toBe(true); // local-use + 0.0.0.0
		expect(isPrivateOrSpecialAddress("64:ff9b:1::808:808")).toBe(true); // local-use + 8.8.8.8 (public!)
		expect(isPrivateOrSpecialAddress("64:ff9b:1::5808:101")).toBe(true); // local-use + 88.8.1.1 (public!)
		expect(isPrivateOrSpecialAddress("64:ff9b:1::df82:c8ec")).toBe(true); // local-use + 223.130.200.236 (public!)
	});

	it("property: NAT64 well-known prefix classification matches embedded IPv4, fc.property seed 31648, numRuns 256", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 255 }),
				fc.integer({ min: 0, max: 255 }),
				fc.integer({ min: 0, max: 255 }),
				fc.integer({ min: 0, max: 255 }),
				(a, b, c, d) => {
					const ipv4Str = `${a}.${b}.${c}.${d}`;
					const expectedPrivate = isPrivateIPv4(ipv4Str);
					// Convert IPv4 to hex: a.b.c.d -> a*256+b : c*256+d
					const hex1 = ((a << 8) | b).toString(16);
					const hex2 = ((c << 8) | d).toString(16);
					const nat64Addr = `64:ff9b::${hex1}:${hex2}`;
					const actualPrivate = isPrivateOrSpecialAddress(nat64Addr);
					expect(actualPrivate).toBe(expectedPrivate);
				},
			),
			{ seed: 31648, numRuns: 256 },
		);
	});
});
