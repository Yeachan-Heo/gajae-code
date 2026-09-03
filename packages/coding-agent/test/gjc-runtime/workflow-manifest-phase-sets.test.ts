import { describe, expect, it } from "bun:test";
import { getSkillManifest } from "../../src/gjc-runtime/workflow-manifest";

describe("workflow manifest phase sets", () => {
	it("preserves the resolved phase memberships for every workflow skill", () => {
		for (const skill of ["deep-interview", "ralplan", "ultragoal", "autoresearch"] as const) {
			expect(getSkillManifest(skill).stopReleasingPhases).toEqual([
				"complete",
				"completed",
				"failed",
				"cancelled",
				"canceled",
				"inactive",
			]);
		}
		expect(getSkillManifest("ralplan").phaseLock).toEqual([
			"final",
			"handoff",
			"complete",
			"completed",
			"failed",
			"cancelled",
			"canceled",
			"inactive",
		]);
		expect(getSkillManifest("ralplan").canonicalOverrides).toEqual(getSkillManifest("ralplan").phaseLock);
	});

	it("exposes the autoresearch lifecycle (intake -> research -> verdict) with its four runtime verbs", () => {
		const manifest = getSkillManifest("autoresearch");
		expect(manifest.states.map(state => state.id)).toEqual([
			"intake",
			"research",
			"verdict",
			"complete",
			"failed",
			"cancelled",
			"handoff",
		]);
		expect(manifest.initialState).toBe("intake");
		expect(manifest.terminalStates).toEqual(["complete", "failed", "cancelled", "handoff"]);
		const verbNames = manifest.verbs.map(item => item.name);
		for (const verb of ["read", "write", "clear", "handoff"]) {
			expect(verbNames).toContain(verb);
		}
		expect(manifest.transitions).toEqual(
			expect.arrayContaining([
				{ from: "intake", to: "research", verb: "write" },
				{ from: "research", to: "verdict", verb: "write" },
				{ from: "verdict", to: "research", verb: "write" },
			]),
		);
	});

	it("exposes deep-interview crystallize and explicit approval command contracts", () => {
		const manifest = getSkillManifest("deep-interview");
		const verbNames = manifest.verbs.map(item => item.name);
		expect(verbNames).toContain("crystallize");
		expect(verbNames).toContain("approve-execution");
		for (const argument of ["input", "session-id", "slug", "json"]) {
			expect(manifest.typedArgs.find(item => item.name === argument)?.appliesToVerbs).toContain("crystallize");
		}
		expect(manifest.typedArgs.find(item => item.name === "json")?.appliesToVerbs).toContain("approve-execution");
	});

	it("routes new ralplan runs through intent while retaining the legacy in-flight review edge", () => {
		const manifest = getSkillManifest("ralplan");
		expect(manifest.states.map(state => state.id)).toContain("intent");
		expect(manifest.transitions).toContainEqual({ from: "planner", to: "intent", verb: "write-artifact" });
		expect(manifest.transitions).toContainEqual({ from: "intent", to: "architect", verb: "write-artifact" });
		expect(manifest.transitions).toContainEqual({ from: "planner", to: "architect", verb: "write-artifact" });
	});
});
