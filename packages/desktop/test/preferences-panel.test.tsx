import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DesktopPreferences } from "../../desktop-host/src/preferences-protocol";
import { PreferencesPanel, type PreferencesPanelProps } from "../src/PreferencesPanel";

// Browser-safe presentation inputs only; no SDK/backend implementation is replaced.
function preferences(): DesktopPreferences {
	return {
		profiles: [
			{
				id: "configured-review",
				name: "Shared review profile",
				description: null,
				group: "CODEX",
				groupRank: 0,
				available: true,
				source: "configured",
				active: true,
				default: false,
				roles: [{ id: "default", model: "fixture/model-one" }],
				capabilities: {
					selectSession: { available: true, reason: null },
					persistDefault: { available: false, reason: "Default-profile ownership CAS is unavailable." },
				},
			},
			{
				id: "builtin-review",
				name: "Shared review profile",
				description: null,
				group: "CODEX",
				groupRank: 0,
				available: true,
				source: "builtin",
				active: false,
				default: true,
				roles: [{ id: "default", model: "fixture/model-one" }],
				capabilities: {
					selectSession: { available: true, reason: null },
					persistDefault: { available: false, reason: "Default-profile ownership CAS is unavailable." },
				},
			},
			{
				id: "unavailable-profile",
				name: "Waiting for connection profile",
				description: "Profile description from settings",
				group: "CODEX",
				groupRank: 0,
				available: true,
				source: "configured",
				active: false,
				default: false,
				roles: [{ id: "default", model: "fixture/model-one" }],
				capabilities: {
					selectSession: { available: false, reason: "Session selection requires an available host." },
					persistDefault: { available: false, reason: "Default-profile ownership CAS is unavailable." },
				},
			},
		],
		roles: [
			{
				id: "executor",
				name: "Executor role",
				configured: true,
				model: { id: "shared-model", provider: "provider-a", name: "Shared model" },
				thinkingLevel: "high",
				configurationResolution: { origin: "layered", layers: ["global", "project", "runtime"] },
				canApply: { available: true, reason: null },
				scope: "session",
				canClear: { available: true, reason: null },
			},
			{
				id: "critic",
				name: "Reviewer role",
				configured: false,
				model: { id: "shared-model", provider: "provider-b", name: "Shared model" },
				thinkingLevel: null,
				configurationResolution: { origin: "default", layers: [] },
				canApply: { available: false, reason: "Role unavailable." },
				scope: null,
				canClear: { available: false, reason: "No session-owned role choice is present." },
			},
		],
		sampling: [
			{
				parameter: "temperature",
				configuredValue: 0,
				effectiveValue: 0,
				mode: "value",
				resolution: { origin: "runtime", layers: ["global", "runtime"] },
				application: "next-run",
				modelSupport: "unknown",
				canApply: { available: false, reason: "Sampling validation and model capabilities are unavailable." },
			},
			{
				parameter: "topK",
				configuredValue: -1,
				effectiveValue: null,
				mode: "provider-default",
				resolution: { origin: "project", layers: ["global", "project"] },
				application: "next-run",
				modelSupport: "unknown",
				canApply: { available: false, reason: "Sampling validation and model capabilities are unavailable." },
			},
			{
				parameter: "topP",
				configuredValue: null,
				effectiveValue: null,
				mode: "invalid",
				resolution: { origin: "global", layers: ["global"] },
				application: "next-run",
				modelSupport: "unknown",
				canApply: { available: false, reason: "Sampling validation and model capabilities are unavailable." },
			},
		],
	};
}

function render(overrides: Partial<PreferencesPanelProps> = {}): string {
	return renderToStaticMarkup(
		<PreferencesPanel
			preferences={preferences()}
			onRefresh={() => { throw new Error("Rendering must not refresh preferences"); }}
			onApply={() => { throw new Error("Rendering must not apply preferences"); }}
			{...overrides}
		/>,
	);
}

function profileOptions(html: string): string[] {
	return html.match(/<li class="profile-option"[\s\S]*?<\/li>/gu) ?? [];
}

function preferenceRows(html: string): string[] {
	return html.match(/<li class="preference-row"[\s\S]*?<\/li>/gu) ?? [];
}

describe("desktop preferences presentation", () => {
	test("keeps actual active and saved-default states independent and disambiguates equal profile names", () => {
		const html = render();
		const [active, savedDefault, unavailable] = profileOptions(html);
		expect(active).toContain('data-active="true"');
		expect(active).not.toContain('data-default="true"');
		expect(active).toContain("In use in this conversation");
		expect(active).toContain("Configured");
		expect(active).toContain("<code>configured-review</code>");
		expect(savedDefault).toContain('data-default="true"');
		expect(savedDefault).not.toContain('data-active="true"');
		expect(savedDefault).toContain("Saved default profile");
		expect(savedDefault).toContain("Built-in");
		expect(savedDefault).toContain("<code>builtin-review</code>");
		expect(active).toContain("Shared review profile (configured-review): apply to this conversation");
		expect(savedDefault).toContain("Shared review profile (builtin-review): apply to this conversation");
		expect(unavailable).not.toContain('data-active="true"');
		expect(unavailable).not.toContain('data-default="true"');
		expect(unavailable).toContain("Profile description from settings");
	});

	test("disables unsupported scope actions with their original scoped reasons, without withholding session selection", () => {
		const html = render();
		const [active, savedDefault, unavailable] = profileOptions(html);
		const sessionButton = savedDefault?.match(/<button[^>]*aria-label="[^"]*: apply to this conversation"[^>]*>/u)?.[0];
		expect(sessionButton).toBeDefined();
		expect(sessionButton).not.toContain('disabled=""');
		expect(active).toMatch(/<button[^>]*aria-label="[^"]*: save as default profile"[^>]*disabled=""/u);
		expect(unavailable).toMatch(/<button[^>]*aria-label="[^"]*: apply to this conversation"[^>]*disabled=""/u);
		expect(unavailable).toMatch(/<button[^>]*aria-label="[^"]*: save as default profile"[^>]*disabled=""/u);
		expect(unavailable).toContain("This conversation: Session selection requires an available host.");
		expect(unavailable).toContain("Saving the default: Default-profile ownership CAS is unavailable.");
		expect(html).not.toContain("Most recently used model (MRU) history");
		expect(html).toContain("Apply to this conversation");
	});

	test("renders resolved role identities, configuration state, thinking and map provenance as read-only", () => {
		const [executor, critic] = preferenceRows(render());
		expect(executor).toContain("Explicitly configured");
		expect(executor).toContain("Shared model");
		expect(executor).toContain("provider-a / shared-model");
		expect(executor).toContain("<dt>Reasoning level</dt><dd>high</dd>");
		expect(executor).toContain("Multiple layers");
		expect(executor).toContain("Global → Project → Runtime");
		expect(executor).toContain("Change in model selection · applies to this conversation only");
		expect(executor).not.toContain("<button");
		expect(critic).toContain("Inherited or default");
		expect(critic).toContain("provider-b / shared-model");
		expect(critic).toContain("<dt>Reasoning level</dt><dd>Not set</dd>");
		expect(critic).toContain("Default");
		expect(critic).toContain("Cannot change: Role unavailable.");
		expect(critic).not.toContain("<button");
		expect(render()).not.toContain("Role map provenance");
	});

	test("labels durable default model capability without adding another role editor", () => {
		const data = preferences();
		data.roles[0]!.id = "default";
		data.roles[0]!.scope = "default";
		data.roles[0]!.canClear = { available: false, reason: "The default model cannot be cleared." };
		const row = preferenceRows(render({ preferences: data }))[0];
		expect(row).toContain("Change in model selection · saved to shared settings");
		expect(row).not.toContain("<button");
	});

	test("preserves zero, provider-default -1, invalid values and next-run semantics without inferring provider support", () => {
		const html = render();
		const [, , zero, sentinel, invalid] = preferenceRows(html);
		expect(zero).toContain("<dt>Merged setting value</dt><dd>0</dd>");
		expect(zero).toContain("<dt>Next run option value</dt><dd>0</dd>");
		expect(zero).toContain("Runtime · Layers: Global → Runtime");
		expect(sentinel).toContain("<dd>-1 · Provider default</dd>");
		expect(sentinel).toContain("<dt>Next run option value</dt><dd>No explicit option value</dd>");
		expect(sentinel).toContain("Project · Layers: Global → Project");
		expect(invalid).toContain("No value · Invalid setting");
		expect(invalid).not.toContain("Provider default");
		for (const row of [zero, sentinel, invalid]) {
			expect(row).toContain("Unknown");
			expect(row).toContain("Sampling validation and model capabilities are unavailable.");
			expect(row).toMatch(/<button[^>]*disabled=""[^>]*>Sampling is read-only<\/button>/u);
		}
		expect(html).toContain("Applies to the next run.");
		expect(html).toContain("Per-model support is unknown.");
		expect(html).not.toContain("<input");
		expect(html).not.toContain("<select");
	});

	test("distinguishes unloaded, loading, failed, empty and idle states without optimistic application notices", () => {
		const unloaded = render({ preferences: null });
		expect(unloaded).toContain("No preference information.");
		expect(unloaded).not.toContain('role="status"');
		const loading = render({ preferences: null, pending: true });
		expect(loading).toContain('aria-busy="true"');
		expect(loading).toContain('role="status"');
		expect(loading).toContain("Loading preferences…");
		expect(loading).not.toContain("No preference information.");
		const failed = render({ preferences: null, error: "No host response was received." });
		expect(failed).toContain('role="alert"');
		expect(failed).toContain("No host response was received.");
		expect(failed).not.toContain("Loading");
		expect(failed).not.toContain("No preference information.");
		const empty = render({ preferences: { profiles: [], roles: [], sampling: [] } });
		expect(empty).toContain("No model profiles available.");
		expect(empty).toContain("No per-role model information.");
		expect(empty).toContain("No sampling settings information.");
		const idle = render();
		expect(idle).toContain('aria-busy="false"');
		expect(idle).not.toContain('role="status"');
		expect(idle).not.toContain('role="alert"');
		expect(idle).not.toContain("Applied successfully");
	});

	test("locks every action while pending and retains authoritative values and visible errors", () => {
		const html = render({ pending: true, error: "The profile change request was rejected." });
		const buttons = html.match(/<button\b[^>]*>/gu) ?? [];
		expect(buttons.length).toBeGreaterThan(0);
		for (const button of buttons) expect(button).toContain('disabled=""');
		expect(html).toContain("Waiting for the settings connection or a request…");
		expect(html).toContain("The profile change request was rejected.");
		expect(html).toContain("The values below are the last received.");
		expect(profileOptions(html)[0]).toContain('data-active="true"');
		expect(profileOptions(html)[1]).not.toContain('data-active="true"');
		expect(html).not.toContain("Settings were applied");
	});

	test("keeps profile actions available so a change made during a run still reaches the host", () => {
		const html = render();
		const refreshButton = html.match(/<button\b[^>]*>[\s\S]*?Refresh<\/button>/u)?.[0];
		expect(refreshButton).toBeDefined();
		expect(refreshButton).not.toContain('disabled=""');
		expect(html).toContain('aria-busy="false"');
		expect(html).not.toContain("Profiles cannot be changed while a run is active.");
		const profiles = profileOptions(html);
		expect(profiles).toHaveLength(3);
		// The active conversation profile and the unavailable one refuse their own apply
		// button; a running turn never enters that decision.
		const applyDisabled = profiles.map(profile => (profile.match(/<button\b[^>]*>/gu) ?? [])[0]!.includes('disabled=""'));
		expect(applyDisabled).toEqual([true, false, true]);
		expect(preferenceRows(html)).toEqual(preferenceRows(render({ pending: false })));
	});

	test("does not invent active/default profiles or resolved models when the DTO has none", () => {
		const data = preferences();
		for (const profile of data.profiles) {
			profile.active = false;
			profile.default = false;
		}
		data.roles[0]!.model = null;
		const html = render({ preferences: data });
		expect(html).not.toContain('data-active="true"');
		expect(html).not.toContain('data-default="true"');
		expect(html).not.toContain("In use in this conversation");
		expect(html).not.toContain("Saved default profile</span>");
		expect(preferenceRows(html)[0]).toContain("No resolved model");
		expect(preferenceRows(html)[0]).not.toContain("provider-a");
	});

	test("escapes untrusted profile, model, reason and error labels instead of interpreting HTML", () => {
		const data = preferences();
		const hostile = '<img src=x onerror="alert(1)">';
		data.profiles[0]!.name = hostile;
		data.profiles[0]!.id = hostile;
		data.profiles[0]!.description = hostile;
		data.profiles[0]!.capabilities.persistDefault.reason = hostile;
		data.roles[0]!.name = hostile;
		data.roles[0]!.model = { id: hostile, name: hostile, provider: hostile };
		data.roles[0]!.canApply.reason = hostile;
		data.sampling[0]!.canApply.reason = hostile;
		const html = render({ preferences: data, error: hostile });
		expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
		expect(html).not.toContain("<img");
		expect(html).not.toContain(hostile);
		expect(html).toContain('role="alert"');
	});
});
