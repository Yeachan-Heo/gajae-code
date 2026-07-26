import { describe, expect, it } from "bun:test";
import { resolveStartupTimeoutMs } from "../../src/runtime-mcp/manager";
import type { MCPServerConfig } from "../../src/runtime-mcp/types";
import { ACP_MCP_REQUEST_TIMEOUT_MS, ACP_MCP_STARTUP_HEADROOM_MS } from "../../src/sdk/acp/mcp";

// Option B for PR #3164: the long MCP startup ceiling is scoped to ACP
// lifecycle launches only. Ordinary consumers (CLI/SDK `mcpConfigPath`, plugin
// bundles, project/user configs) keep the short default, so a config with a
// large `timeout` cannot hang startup for ~30s.

const DEFAULT_CEILING_MS = 1_750;
const BASE_STARTUP_MS = 250;
const GRACE_MS = 500;

function stdioServer(timeout?: number): MCPServerConfig {
	return {
		type: "stdio",
		command: "/usr/bin/true",
		args: [],
		...(timeout !== undefined ? { timeout } : {}),
	} as MCPServerConfig;
}

describe("MCP startup ceiling is ACP-scoped (PR #3164 Option B)", () => {
	it("caps non-ACP consumers at the short default even for a huge configured timeout", () => {
		// A hostile/slow config asking for 10 minutes must not get it.
		expect(resolveStartupTimeoutMs([stdioServer(600_000)])).toBe(DEFAULT_CEILING_MS);
		// The PR's global value must NOT be reachable without an explicit budget.
		expect(resolveStartupTimeoutMs([stdioServer(30_000)])).toBe(DEFAULT_CEILING_MS);
		expect(resolveStartupTimeoutMs([stdioServer(30_000)])).toBeLessThan(30_500);
	});

	it("keeps the no-timeout and modest-timeout behavior unchanged for non-ACP consumers", () => {
		// No configured timeout at all -> base startup wait.
		expect(resolveStartupTimeoutMs([stdioServer()])).toBe(BASE_STARTUP_MS);
		// A modest timeout still gets timeout + grace, below the ceiling.
		expect(resolveStartupTimeoutMs([stdioServer(400)])).toBe(400 + GRACE_MS);
	});
	it("caps the default no-timeout wait to a sub-250 ms readiness ceiling", () => {
		expect(resolveStartupTimeoutMs([stdioServer()], 1)).toBe(1);
		expect(resolveStartupTimeoutMs([stdioServer()], 249)).toBe(249);
	});

	it("grants an ACP lifecycle launch the larger budget it was given", () => {
		// With ample budget, an ACP MCP server gets its full configured timeout
		// plus grace - far above the default ceiling non-ACP consumers keep.
		const ampleBudget = 60_000;
		expect(resolveStartupTimeoutMs([stdioServer(ACP_MCP_REQUEST_TIMEOUT_MS)], ampleBudget)).toBe(
			ACP_MCP_REQUEST_TIMEOUT_MS + GRACE_MS,
		);
		expect(resolveStartupTimeoutMs([stdioServer(ACP_MCP_REQUEST_TIMEOUT_MS)], ampleBudget)).toBeGreaterThan(
			DEFAULT_CEILING_MS,
		);
		// The remaining readiness budget caps the wait when it is the smaller of
		// the two, so a slow handshake cannot outlive the deadline.
		expect(resolveStartupTimeoutMs([stdioServer(600_000)], 20_000)).toBe(20_000);
	});

	it("ignores a non-positive or non-finite budget and falls back to the default ceiling", () => {
		// Defensive: a caller must never be able to disable the ceiling by
		// passing junk. Real exhaustion is handled by the caller's fail-fast.
		for (const budget of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(resolveStartupTimeoutMs([stdioServer(600_000)], budget)).toBe(DEFAULT_CEILING_MS);
		}
	});

	it("honors a tiny lifecycle startup ceiling", () => {
		expect(resolveStartupTimeoutMs([stdioServer(600_000)], 10)).toBe(10);
	});

	it("reserves headroom so MCP startup cannot consume the whole readiness window", () => {
		// The caller computes: remaining = deadline - now - headroom.
		expect(ACP_MCP_STARTUP_HEADROOM_MS).toBeGreaterThan(0);
		const deadlineAt = 10_000;
		const now = 1_000;
		const remaining = deadlineAt - now - ACP_MCP_STARTUP_HEADROOM_MS;
		expect(remaining).toBeLessThan(deadlineAt - now);
		expect(resolveStartupTimeoutMs([stdioServer(600_000)], remaining)).toBe(remaining);
	});
});
