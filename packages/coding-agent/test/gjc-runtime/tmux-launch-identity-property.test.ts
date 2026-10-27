import { describe, expect, it } from "bun:test";
import { trustedTmuxLaunchIdentityEnv } from "@gajae-code/coding-agent/gjc-runtime/tmux-sessions";
import type { ProjectEnvSnapshot } from "@gajae-code/utils/env-file";

const PROPERTY_SEED = 493;
const PROPERTY_INPUTS = 64;

function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let next = Math.imul(state ^ (state >>> 15), 1 | state);
		next = (next + Math.imul(next ^ (next >>> 7), 61 | next)) ^ next;
		return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
	};
}

describe("tmux launch identity property", () => {
	it("property: tmux launch identity snapshot agreement, seed 493, 64 inputs", () => {
		const keys = [
			"GJC_SESSION_ID",
			"GJC_COORDINATOR_SESSION_ID",
			"GJC_COORDINATOR_SESSION_STATE_FILE",
			"GJC_TMUX_SESSION",
		] as const;
		const random = mulberry32(PROPERTY_SEED);
		for (let index = 0; index < PROPERTY_INPUTS; index += 1) {
			const env: NodeJS.ProcessEnv = { GJC_TMUX_COMMAND: `tmux-${index}` };
			const snapshots: ProjectEnvSnapshot[] = [
				{ values: {}, dynamic: new Set<string>() },
				{ values: {}, dynamic: new Set<string>() },
			];
			for (const key of keys) {
				const projectValue = `project-${index}-${key}-${Math.floor(random() * 1_000_000_000)}`;
				const mode = Math.floor(random() * 4);
				const snapshot = snapshots[Math.floor(random() * snapshots.length)];
				if (!snapshot) throw new Error("property snapshot missing");
				if (mode === 0) {
					env[key] = `operator-${projectValue}`;
				} else if (mode === 1) {
					snapshot.values[key] = projectValue;
					env[key] = projectValue;
				} else if (mode === 2) {
					snapshot.values[key] = projectValue;
					env[key] = ` ${projectValue} `;
				} else {
					snapshot.values[key] = projectValue;
					snapshot.dynamic.add(key);
					env[key] = `expanded-${projectValue}`;
				}
			}
			const once = trustedTmuxLaunchIdentityEnv(env, snapshots);
			const twice = trustedTmuxLaunchIdentityEnv(once, snapshots);
			expect(twice).toEqual(once);
			expect(once.GJC_TMUX_COMMAND).toBe(`tmux-${index}`);
			for (const key of keys) {
				const rejected = snapshots.some(candidate => {
					const declared = candidate.values[key];
					return declared !== undefined && (candidate.dynamic.has(key) || declared === env[key]);
				});
				if (rejected || !env[key]?.trim()) expect(once[key]).toBeUndefined();
				else expect(once[key]).toBe(env[key]);
			}
		}
		for (const key of keys) {
			const declared = `value-${key}`;
			const operator = ` ${declared} `;
			const env: NodeJS.ProcessEnv = { [key]: operator };
			const snapshots: ProjectEnvSnapshot[] = [
				{ values: { [key]: declared }, dynamic: new Set<string>() },
				{ values: { [key]: declared }, dynamic: new Set<string>() },
			];
			const once = trustedTmuxLaunchIdentityEnv(env, snapshots);
			const twice = trustedTmuxLaunchIdentityEnv(once, snapshots);
			expect(twice).toEqual(once);
			expect(once[key]).toBe(operator);
		}
	});
});
