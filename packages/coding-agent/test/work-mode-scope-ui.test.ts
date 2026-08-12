import { expect, test } from "bun:test";
import {
	createWorkModeScopeSelectionView,
	renderWorkModeScopeLines,
	WORK_MODE_SCOPE_CHOICES,
	type WorkModeScope,
} from "../src/config/work-mode-view";

test("keeps four scope labels, timing, selection, and disabled reasons exact at terminal widths", () => {
	const disabledScopes = new Set<WorkModeScope>(["session", "project", "user"]);
	const disabledReasons = new Map<WorkModeScope, string>([
		["session", "Session activation is unavailable"],
		["project", "Project defaults require a project root"],
		["user", "User defaults are locked by policy"],
	]);
	const view = createWorkModeScopeSelectionView({
		selectedScope: "project",
		disabledScopes,
		disabledReasons,
	});

	expect(WORK_MODE_SCOPE_CHOICES).toEqual([
		{ scope: "turn", label: "Apply this turn" },
		{ scope: "session", label: "Apply this session" },
		{ scope: "project", label: "Set project default (next session)" },
		{ scope: "user", label: "Set user default (next session)" },
	]);
	expect(view.selectedScope).toBe("project");
	expect(view.choices).toEqual([
		{ scope: "turn", label: "Apply this turn", enabled: true, reason: undefined },
		{
			scope: "session",
			label: "Apply this session",
			enabled: false,
			reason: "Session activation is unavailable",
		},
		{
			scope: "project",
			label: "Set project default (next session)",
			enabled: false,
			reason: "Project defaults require a project root",
		},
		{
			scope: "user",
			label: "Set user default (next session)",
			enabled: false,
			reason: "User defaults are locked by policy",
		},
	]);

	const wideLines = renderWorkModeScopeLines(view, 120).map(line => Bun.stripANSI(line));
	expect(wideLines).toEqual([
		"Apply this turn",
		"Apply this session (Session activation is unavailable)",
		"> Set project default (next session) (Project defaults require a project root)",
		"Set user default (next session) (User defaults are locked by policy)",
	]);
	expect(wideLines.every(line => !line.includes("\u001b["))).toBe(true);

	const narrowLines = renderWorkModeScopeLines(view, 32).map(line => Bun.stripANSI(line));
	expect(narrowLines).toHaveLength(4);
	expect(narrowLines.every(line => line.length <= 32)).toBe(true);
	expect(narrowLines[0]).toBe("Apply this turn");
	expect(narrowLines[2]).toContain("Set project default");
});
