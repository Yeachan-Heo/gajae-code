import { describe, expect, test } from "bun:test";
import {
	decideMenuInbound,
	isSyntheticActionId,
	MENU_GUIDANCE,
	makeSyntheticActionId,
	parseMenuTrigger,
	redirectTypedSlash,
	TOP_LEVEL_MENU,
} from "../src/notifications/command-menu";

describe("command-menu parseMenuTrigger", () => {
	test("matches /menu and the short alias /m only", () => {
		expect(parseMenuTrigger("/menu")).toBe(true);
		expect(parseMenuTrigger("  /MENU  ")).toBe(true);
		expect(parseMenuTrigger("/m")).toBe(true);
		expect(parseMenuTrigger("  /M  ")).toBe(true);
		expect(parseMenuTrigger("/menu skills")).toBe(false);
		expect(parseMenuTrigger("/menuish")).toBe(false);
		expect(parseMenuTrigger("/model")).toBe(false);
		expect(parseMenuTrigger("menu")).toBe(false);
	});
});

describe("command-menu top-level palette", () => {
	test("renders the MVP categories in order (no Help)", () => {
		expect(TOP_LEVEL_MENU.map(e => e.category)).toEqual(["skills", "model", "notify"]);
		expect(TOP_LEVEL_MENU.map(e => e.label)).toEqual(["Skills", "Model", "Notify"]);
	});
});

describe("command-menu synthetic action ids", () => {
	test("namespaced ids round-trip and are disjoint from workflow ask ids", () => {
		for (const kind of ["menu", "submenu", "model"] as const) {
			const id = makeSyntheticActionId(kind, "abc-123");
			expect(id).toBe(`${kind}:abc-123`);
			expect(isSyntheticActionId(id)).toBe(true);
			expect(isSyntheticActionId(id)).toBe(true);
		}
	});

	test("generated ids are unique and synthetic", () => {
		const a = makeSyntheticActionId("menu");
		const b = makeSyntheticActionId("menu");
		expect(a).not.toBe(b);
		expect(isSyntheticActionId(a)).toBe(true);
	});

	test("rejects non-synthetic ids (workflow ask/gate ids)", () => {
		expect(isSyntheticActionId("ask:xyz")).toBe(false);
		expect(isSyntheticActionId("gate-123")).toBe(false);
		expect(isSyntheticActionId("menu:")).toBe(false);
		expect(isSyntheticActionId(":abc")).toBe(false);
		expect(isSyntheticActionId("plain")).toBe(false);
	});
});

describe("command-menu redirectTypedSlash", () => {
	test("does not redirect the /menu trigger, config commands, or free text", () => {
		expect(redirectTypedSlash("/menu")).toEqual({ redirect: false });
		expect(redirectTypedSlash("/verbose")).toEqual({ redirect: false });
		expect(redirectTypedSlash("keep going")).toEqual({ redirect: false });
	});

	test("redirects raw typed commands to the menu guidance", () => {
		const r = redirectTypedSlash("/skill:ralplan go");
		expect(r.redirect).toBe(true);
		if (r.redirect) expect(r.message).toBe(MENU_GUIDANCE);
	});

	test("redirects denied commands with the policy reason plus guidance", () => {
		const r = redirectTypedSlash("/model gpt-5");
		expect(r.redirect).toBe(true);
		if (r.redirect) {
			expect(r.message).toContain("Model menu");
			expect(r.message).toContain(MENU_GUIDANCE);
		}
	});
});

describe("command-menu decideMenuInbound", () => {
	test("/menu opens the menu", () => {
		expect(decideMenuInbound("/menu")).toEqual({ kind: "open_menu" });
	});

	test("raw typed command yields guidance, not passthrough", () => {
		const d = decideMenuInbound("/skill:ralplan go");
		expect(d.kind).toBe("guidance");
		if (d.kind === "guidance") expect(d.message).toBe(MENU_GUIDANCE);
	});

	test("denied command yields guidance with reason", () => {
		const d = decideMenuInbound("/model gpt-5");
		expect(d.kind).toBe("guidance");
		if (d.kind === "guidance") expect(d.message).toContain("Model menu");
	});

	test("ordinary text and config commands pass through", () => {
		expect(decideMenuInbound("keep going")).toEqual({ kind: "passthrough" });
		expect(decideMenuInbound("/verbose")).toEqual({ kind: "passthrough" });
	});
});
