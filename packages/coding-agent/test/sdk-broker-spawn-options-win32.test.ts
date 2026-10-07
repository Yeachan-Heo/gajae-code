import { expect, test } from "bun:test";
import { resolveBrokerLaunchMode } from "../src/sdk/broker/ensure";

test("production broker routing keeps POSIX trampoline and Windows hop semantics", () => {
	expect(resolveBrokerLaunchMode("linux", "discovery")).toBe("posix-trampoline");
	expect(resolveBrokerLaunchMode("darwin", "discovery")).toBe("posix-trampoline");
	expect(resolveBrokerLaunchMode("win32", "discovery")).toBe("windows-hop");
});

test("fixture leases launch the real broker process directly on every platform", () => {
	expect(resolveBrokerLaunchMode("linux", "fixture-lease")).toBe("direct");
	expect(resolveBrokerLaunchMode("darwin", "fixture-lease")).toBe("direct");
	expect(resolveBrokerLaunchMode("win32", "fixture-lease")).toBe("direct");
});
