import { describe, expect, it } from "bun:test";
import {
	type ApplyBackendDeps,
	applyBrowserBackendChange,
	browserBackendOptions,
	runBrowserBackendSelector,
} from "../../src/tools/browser/backend-select";

function baseDeps(overrides: Partial<ApplyBackendDeps>): ApplyBackendDeps {
	let stored: "native" | "aside" = "native";
	return {
		target: "aside",
		platform: "darwin",
		getSetting: () => stored,
		setSetting: v => {
			stored = v;
		},
		restart: async () => {},
		probe: () => ({ ok: true, path: "/x/aside" }),
		...overrides,
	};
}

describe("browserBackendOptions", () => {
	it("hides Aside off macOS", () => {
		expect(browserBackendOptions("linux").map(o => o.value)).toEqual(["native"]);
		expect(browserBackendOptions("win32").map(o => o.value)).toEqual(["native"]);
	});
	it("shows Aside (live-profile) on macOS", () => {
		const opts = browserBackendOptions("darwin");
		expect(opts.map(o => o.value)).toEqual(["native", "aside"]);
		expect(opts.find(o => o.value === "aside")?.liveProfile).toBe(true);
	});
});

describe("applyBrowserBackendChange", () => {
	it("switches to aside on macOS when the CLI is present, awaiting restart", async () => {
		let restarted = false;
		const res = await applyBrowserBackendChange(
			baseDeps({
				restart: async () => {
					restarted = true;
				},
			}),
		);
		expect(res).toEqual({ status: "switched", backend: "aside" });
		expect(restarted).toBe(true);
	});

	it("rejects aside off macOS without changing the setting", async () => {
		let stored: "native" | "aside" = "native";
		const res = await applyBrowserBackendChange(
			baseDeps({
				platform: "linux",
				getSetting: () => stored,
				setSetting: v => {
					stored = v;
				},
			}),
		);
		expect(res.status).toBe("unchanged");
		expect(stored).toBe("native");
	});

	it("returns install-required (no execution) when CLI missing and no confirm handler", async () => {
		let stored: "native" | "aside" = "native";
		const res = await applyBrowserBackendChange(
			baseDeps({
				getSetting: () => stored,
				setSetting: v => {
					stored = v;
				},
				probe: () => ({ ok: false, searched: ["/x/aside"], manualInstallCommand: "cmd", url: "u" }),
			}),
		);
		expect(res.status).toBe("install-required");
		expect(stored).toBe("native"); // setting unchanged
	});

	it("leaves setting unchanged when typed-confirmation install is declined", async () => {
		let stored: "native" | "aside" = "native";
		const res = await applyBrowserBackendChange(
			baseDeps({
				getSetting: () => stored,
				setSetting: v => {
					stored = v;
				},
				probe: () => ({ ok: false, searched: [], manualInstallCommand: "cmd", url: "u" }),
				confirmInstall: async () => false,
			}),
		);
		expect(res.status).toBe("install-required");
		expect(stored).toBe("native");
	});

	it("switches after a confirmed install that re-probes successfully", async () => {
		let stored: "native" | "aside" = "native";
		let installed = false;
		const res = await applyBrowserBackendChange(
			baseDeps({
				getSetting: () => stored,
				setSetting: v => {
					stored = v;
				},
				probe: () =>
					installed
						? { ok: true, path: "/x/aside" }
						: { ok: false, searched: [], manualInstallCommand: "c", url: "u" },
				confirmInstall: async () => {
					installed = true;
					return true;
				},
			}),
		);
		expect(res).toEqual({ status: "switched", backend: "aside" });
		expect(stored as "native" | "aside").toBe("aside");
	});

	it("reverts the setting when the awaited restart fails (e.g. busy tab)", async () => {
		let stored: "native" | "aside" = "native";
		const res = await applyBrowserBackendChange(
			baseDeps({
				getSetting: () => stored,
				setSetting: v => {
					stored = v;
				},
				restart: async () => {
					throw new Error("default-backend tab(s) are busy");
				},
			}),
		);
		expect(res.status).toBe("error");
		expect(stored).toBe("native"); // reverted
	});

	it("is a no-op when target equals current backend", async () => {
		const res = await applyBrowserBackendChange(baseDeps({ target: "native", getSetting: () => "native" }));
		expect(res.status).toBe("unchanged");
	});
});

describe("runBrowserBackendSelector", () => {
	it("selects a backend, persists it, and awaits browser restart", async () => {
		let stored: "native" | "aside" = "native";
		let restarted = false;
		let status = "";
		const result = await runBrowserBackendSelector({
			platform: "darwin",
			getSetting: () => stored,
			setSetting: value => {
				stored = value;
			},
			restart: async () => {
				restarted = true;
			},
			probe: () => ({ ok: true, path: "/x/aside" }),
			select: async (options, initialIndex, title) => {
				expect(options.map(option => option.value)).toEqual(["native", "aside"]);
				expect(initialIndex).toBe(0);
				expect(title).toContain("Browser backend selection");
				return "aside";
			},
			showStatus: message => {
				status = message;
			},
		});

		expect(result).toEqual({ status: "switched", backend: "aside" });
		expect(stored as "native" | "aside").toBe("aside");
		expect(restarted).toBe(true);
		expect(status).toContain("switched to 'aside'");
	});
});
