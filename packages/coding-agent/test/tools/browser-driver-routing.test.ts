import { describe, expect, it } from "bun:test";
import type { AnyBrowserHandle, AsideBrowserHandle, NativeBrowserHandle } from "../../src/tools/browser/registry";
import type { BrowserTabInfo, NativeReadyInfo } from "../../src/tools/browser/tab-protocol";

describe("browser driver discrimination (Phase 2 boundary)", () => {
	it("discriminates native vs aside handles by driver", () => {
		const native = { driver: "native" } as Pick<NativeBrowserHandle, "driver">;
		const aside = { driver: "aside" } as Pick<AsideBrowserHandle, "driver">;
		expect(native.driver).toBe("native");
		expect(aside.driver).toBe("aside");
	});

	it("narrows AnyBrowserHandle by driver and keeps native fields native-only", () => {
		function describe(handle: AnyBrowserHandle): string {
			if (handle.driver === "native") {
				// Native-only fields are accessible only after narrowing to native.
				return `native:${handle.browser ? "browser" : "no-browser"}:${handle.stealth ? "stealth" : "none"}`;
			}
			// Aside branch has cliPath + liveProfile, and NO browser/stealth/targetId.
			return `aside:${handle.cliPath}:${handle.liveProfile}`;
		}

		const aside: AsideBrowserHandle = {
			driver: "aside",
			key: "aside:/x/aside",
			kind: { kind: "aside", cliPath: "/x/aside", liveProfile: true, defaultBackend: true },
			cliPath: "/x/aside",
			refCount: 0,
			liveProfile: true,
		};
		expect(describe(aside)).toBe("aside:/x/aside:true");

		// @ts-expect-error — Aside handles must not carry a Puppeteer browser field.
		void aside.browser;
		// @ts-expect-error — Aside handles must not carry native stealth state.
		void aside.stealth;
	});

	it("keeps targetId native-only: BrowserTabInfo has no targetId, NativeReadyInfo does", () => {
		const info: BrowserTabInfo = { url: "https://example.com/", viewport: { width: 1, height: 1 } };
		const native: NativeReadyInfo = { url: info.url, viewport: info.viewport, targetId: "T1" };
		expect(native.targetId).toBe("T1");
		// @ts-expect-error — backend-neutral BrowserTabInfo must not expose a CDP targetId.
		void info.targetId;
	});
});
