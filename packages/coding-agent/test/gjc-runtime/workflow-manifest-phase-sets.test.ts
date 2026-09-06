import { describe, expect, it } from "bun:test";
import { getSkillManifest, serializeManifestProjection, typedArgsFor } from "../../src/gjc-runtime/workflow-manifest";

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
		expect(manifest.transitions).toContainEqual({ from: "interviewing", to: "handoff", verb: "crystallize" });
		for (const argument of ["input", "session-id", "slug", "json"]) {
			expect(
				typedArgsFor("deep-interview", "crystallize").find(item => item.name === argument)?.appliesToVerbs,
			).toContain("crystallize");
		}
		for (const argument of ["mode", "session-id", "json"]) {
			expect(
				typedArgsFor("deep-interview", "approve-execution").find(item => item.name === argument)?.appliesToVerbs,
			).toContain("approve-execution");
		}
		const seen = new Set<string>();
		for (const argument of manifest.typedArgs) {
			for (const verb of new Set(manifest.verbs.map(item => item.name))) {
				if (argument.appliesToVerbs !== undefined && !argument.appliesToVerbs.includes(verb)) continue;
				const key = `${verb}:${argument.name}`;
				expect(seen.has(key)).toBe(false);
				seen.add(key);
			}
		}
		const crystallizeInput = typedArgsFor("deep-interview", "crystallize").filter(item => item.name === "input");
		expect(crystallizeInput).toHaveLength(1);
		expect(crystallizeInput[0]?.required).toBe(true);
		const publicArgumentNames = (verb: string) =>
			typedArgsFor("deep-interview", verb)
				.filter(item => item.planned !== true)
				.map(item => item.name)
				.sort();
		expect(publicArgumentNames("api")).toEqual(["input"]);
		expect(publicArgumentNames("kickoff")).toEqual([
			"deep",
			"json",
			"quick",
			"session-id",
			"standard",
			"threshold",
			"threshold-source",
			"trace",
		]);
		expect(publicArgumentNames("write-spec")).toEqual([
			"deliberate",
			"force",
			"handoff",
			"json",
			"session-id",
			"slug",
			"spec",
			"stage",
		]);
		expect(publicArgumentNames("crystallize")).toEqual(["input", "json", "session-id", "slug"]);
		expect(publicArgumentNames("approve-execution")).toEqual(["json", "mode", "session-id"]);
		expect(typedArgsFor("deep-interview", "api").find(item => item.name === "input")).toMatchObject({
			name: "input",
			type: "string",
			appliesToVerbs: ["api"],
		});
		expect(typedArgsFor("deep-interview", "kickoff").find(item => item.name === "trace")).toMatchObject({
			name: "trace",
			type: "boolean",
			appliesToVerbs: ["kickoff"],
		});
		expect(typedArgsFor("deep-interview", "kickoff").find(item => item.name === "json")).toMatchObject({
			name: "json",
			type: "boolean",
		});
		expect(typedArgsFor("deep-interview", "write-spec").find(item => item.name === "force")).toMatchObject({
			name: "force",
			type: "boolean",
			appliesToVerbs: ["write-spec"],
		});
		expect(typedArgsFor("deep-interview", "write-spec").find(item => item.name === "session-id")).toMatchObject({
			name: "session-id",
			type: "string",
		});
		expect(typedArgsFor("deep-interview", "crystallize").find(item => item.name === "session-id")).toMatchObject({
			name: "session-id",
			type: "string",
			appliesToVerbs: ["crystallize", "approve-execution"],
		});
		expect(
			typedArgsFor("deep-interview", "approve-execution").find(item => item.name === "session-id"),
		).toMatchObject({
			name: "session-id",
			type: "string",
			appliesToVerbs: ["crystallize", "approve-execution"],
		});
		expect(
			typedArgsFor("deep-interview", "approve-execution").find(item => item.name === "mode")?.enumValues,
		).toEqual(["deep-interview"]);
		for (const verb of ["write", "stage", "crystallize"] as const) {
			const input = typedArgsFor("deep-interview", verb).filter(item => item.name === "input");
			expect(input, verb).toHaveLength(1);
			expect(input[0]?.required, verb).toBe(true);
		}
		expect(typedArgsFor("deep-interview", "crystallize").find(item => item.name === "slug")?.required).toBe(true);
	});

	it("does not leak deep-interview-only targets or arguments to other workflow manifests", () => {
		const targetVerbs = ["write-spec", "crystallize", "approve-execution"] as const;
		for (const skill of ["autoresearch", "ralplan", "ultragoal"] as const) {
			const manifest = getSkillManifest(skill);
			for (const target of targetVerbs) {
				expect(manifest.verbs.map(item => item.name)).not.toContain(target);
				expect(typedArgsFor(skill, target).filter(item => item.planned !== true)).toEqual([]);
			}
		}

		for (const skill of ["deep-interview", "ralplan", "ultragoal", "autoresearch"] as const) {
			for (const argument of getSkillManifest(skill).typedArgs) {
				if (argument.appliesToVerbs?.some(target => targetVerbs.includes(target as (typeof targetVerbs)[number]))) {
					expect(skill).toBe("deep-interview");
				}
			}
		}
	});

	it("keeps the checked-in manifest projection synchronized with the TypeScript source", async () => {
		const generated = new URL("../../src/gjc-runtime/workflow-manifest.generated.json", import.meta.url);
		expect(await Bun.file(generated).text()).toBe(serializeManifestProjection());
	});

	it("routes new ralplan runs through intent while retaining the legacy in-flight review edge", () => {
		const manifest = getSkillManifest("ralplan");
		expect(manifest.states.map(state => state.id)).toContain("intent");
		expect(manifest.transitions).toContainEqual({ from: "planner", to: "intent", verb: "write-artifact" });
		expect(manifest.transitions).toContainEqual({ from: "intent", to: "architect", verb: "write-artifact" });
		expect(manifest.transitions).toContainEqual({ from: "planner", to: "architect", verb: "write-artifact" });
	});
});
