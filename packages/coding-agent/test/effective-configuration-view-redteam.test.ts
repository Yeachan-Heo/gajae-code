import { describe, expect, it } from "bun:test";
import {
	createScopedConfigurationTransientStatusView,
	renderScopedConfigurationTransientStatusLines,
} from "../src/config/effective-configuration-view";
import type { ScopedConfigurationMutationReceipt } from "../src/config/scoped-configuration-mutation";

function receipt(
	status: ScopedConfigurationMutationReceipt["status"],
	reason: ScopedConfigurationMutationReceipt["reason"],
	overrides: Partial<ScopedConfigurationMutationReceipt> = {},
): ScopedConfigurationMutationReceipt {
	return {
		status,
		reason,
		scope: "project",
		safePath: "/Users/example/repo/.gjc/config.yml",
		beforeRevision: "before-revision",
		afterRevision: "after-revision",
		beforeDigest: "before-digest",
		afterDigest: "after-digest",
		timing: "next_session",
		confirmation: "not_applicable",
		durability: status === "committed" || status === "applied" ? "committed" : "none",
		patches: [{ op: "set", path: "model.default" }],
		...overrides,
	};
}

describe("effective configuration view red-team safety", () => {
	it("adapts every mutation outcome without optimistic success", () => {
		const cases: Array<[ScopedConfigurationMutationReceipt["status"], ScopedConfigurationMutationReceipt["reason"]]> =
			[
				["committed", null],
				["applied", null],
				["degraded", "runtime_postcommit_failed"],
				["conflict", "scope_conflict"],
				["locked", "scope_locked"],
				["rejected", "invalid_patch"],
			];
		for (const [status, reason] of cases) {
			const view = createScopedConfigurationTransientStatusView(receipt(status, reason));
			expect(view.status).toBe(status);
			expect(view.optimisticSuccess).toBe(false);
			expect(view.statusLabel.toLowerCase()).toBe(status);
			expect(view.lines.join("\n")).toContain(`Outcome: ${view.statusLabel}`);
		}
	});

	it("distinguishes reload mismatch from runtime degradation and preserves timing", () => {
		const reloadMismatch = createScopedConfigurationTransientStatusView(
			receipt("degraded", "persistent_reload_mismatch", {
				confirmation: "unconfirmed",
				durability: "committed_unconfirmed",
			}),
		);
		const runtime = createScopedConfigurationTransientStatusView(
			receipt("degraded", "runtime_postcommit_failed", {
				timing: "current_runtime",
				confirmation: "unconfirmed",
				durability: "committed_unconfirmed",
			}),
		);
		const rejectedRuntime = createScopedConfigurationTransientStatusView(
			receipt("rejected", "runtime_precommit_failed"),
		);

		expect(reloadMismatch.degradation).toBe("reload_mismatch");
		expect(reloadMismatch.recovery.code).toBe("reload_and_verify");
		expect(reloadMismatch.headline).toContain("unconfirmed");
		expect(runtime.degradation).toBe("runtime");
		expect(runtime.timingLabel).toBe("Current runtime");
		expect(runtime.recovery.code).toBe("repair_runtime");
		expect(rejectedRuntime.status).toBe("rejected");
		expect(rejectedRuntime.recovery.code).toBe("retry_runtime");
	});

	it("redacts secrets, control characters, and long paths from status output", () => {
		const secret = "do-not-render-this-secret-value";
		const view = createScopedConfigurationTransientStatusView(
			receipt("degraded", "persistent_reload_mismatch", {
				safePath: `\u001b]8;;file://${secret}\u0007/Users/example/repo/secrets/config.yml`,
				patches: [
					{ op: "set", path: `auth.token.${secret}` },
					{ op: "clear", path: "model.default" },
				],
			}),
		);
		const rendered = renderScopedConfigurationTransientStatusLines(view, { width: 24 }).join("\n");
		expect(view.targetPath).toBe("<redacted-path>");
		expect(view.patches).toEqual([
			{ op: "set", path: "<redacted-path>" },
			{ op: "clear", path: "model.default" },
		]);

		expect(JSON.stringify(view)).not.toContain(secret);
		expect(rendered).not.toContain(secret);
		for (const line of renderScopedConfigurationTransientStatusLines(view, { width: 24 })) {
			expect(line).not.toMatch(/\x1b|[\u0000-\u001f\u007f]/u);
		}
	});

	it("keeps narrow no-color status lines within terminal-cell widths", () => {
		const view = createScopedConfigurationTransientStatusView(
			receipt("rejected", "invalid_patch", { timing: "current_runtime" }),
		);
		for (const line of renderScopedConfigurationTransientStatusLines(view, 12)) {
			expect(line.length).toBeGreaterThanOrEqual(0);
			expect(line).not.toMatch(/\x1b/u);
		}
	});
});
