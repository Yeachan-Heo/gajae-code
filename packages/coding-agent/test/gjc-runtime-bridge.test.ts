import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGjcRuntimeBridge, runGjcRuntimeBridgeWithHudSidecar } from "../src/commands/gjc-runtime-bridge";

let cleanupRoot: string | undefined;

afterEach(async () => {
	if (cleanupRoot) {
		await rm(cleanupRoot, { recursive: true, force: true });
		cleanupRoot = undefined;
	}
});

describe("gjc runtime bridge", () => {
	it("delegates private endpoints to the configured gjc-compatible runtime", async () => {
		cleanupRoot = await mkdtemp(join(tmpdir(), "gjc-runtime-bridge-"));
		const logPath = join(cleanupRoot, "argv.log");
		const runtimePath = join(cleanupRoot, "gjc-runtime.sh");
		await writeFile(
			runtimePath,
			`#!/bin/sh\nprintf '%s\\n' "$GJC_RUNTIME_BRIDGE_ACTIVE|$1|$2|$3" > ${JSON.stringify(logPath)}\n`,
			{ mode: 0o755 },
		);

		const result = runGjcRuntimeBridge("ultragoal", ["status", "--json"], {
			GJC_RUNTIME_BINARY: runtimePath,
			PATH: "",
		});

		expect(result).toEqual({ status: 0 });
		expect(await readFile(logPath, "utf-8")).toBe("1|ultragoal|status|--json\n");
	});

	it("suggests the bundled skill entrypoint for bridged workflow skills", () => {
		const result = runGjcRuntimeBridge("ralplan", ["--consensus"], { PATH: "" });

		expect(result.status).toBe(1);
		expect(result.error).toContain("gjc ralplan is a private runtime bridge command");
		expect(result.error).toContain("Inside a GJC agent session, invoke /skill:ralplan instead");
		expect(result.error).toContain("GJC_RUNTIME_BINARY");
	});

	it("does not suggest skill activation for bridged utility endpoints", () => {
		const result = runGjcRuntimeBridge("state", ["read"], { PATH: "" });

		expect(result.status).toBe(1);
		expect(result.error).toContain("gjc state is a private runtime bridge command");
		expect(result.error).toContain("Configure GJC_RUNTIME_BINARY with a GJC-compatible private runtime binary");
		expect(result.error).not.toContain("/skill:state");
	});

	it("streams workflow HUD sidecar payloads without changing child status", async () => {
		cleanupRoot = await mkdtemp(join(tmpdir(), "gjc-runtime-bridge-"));
		const runtimePath = join(cleanupRoot, "gjc-runtime.sh");
		await writeFile(
			runtimePath,
			`#!/bin/sh
printf '{"version":1,"skill":"ralplan","phase":"planner","hud":{"version":1,"chips":[{"label":"stage","value":"planner"}]}}' > "$GJC_WORKFLOW_HUD_SIDECAR"
/bin/sleep 0.2
printf '{"version":1,"skill":"ralplan","phase":"critic","hud":{"version":1,"chips":[{"label":"stage","value":"critic"}]}}' > "$GJC_WORKFLOW_HUD_SIDECAR"
`,
			{ mode: 0o755 },
		);
		const payloads: string[] = [];

		const result = await runGjcRuntimeBridgeWithHudSidecar("ralplan", ["--direct"], {
			env: { GJC_RUNTIME_BINARY: runtimePath, PATH: "" },
			sidecarSkill: "ralplan",
			pollIntervalMs: 25,
			onHudPayload: payload => {
				payloads.push(payload.phase ?? "");
			},
		});

		expect(result.status).toBe(0);
		expect(result.hudPayload?.phase).toBe("critic");
		expect(payloads).toContain("planner");
		expect(payloads).toContain("critic");
	});

	it("keeps HUD callback failures non-fatal", async () => {
		cleanupRoot = await mkdtemp(join(tmpdir(), "gjc-runtime-bridge-"));
		const runtimePath = join(cleanupRoot, "gjc-runtime.sh");
		await writeFile(
			runtimePath,
			`#!/bin/sh
printf '{"version":1,"skill":"ralplan","hud":{"version":1,"chips":[{"label":"stage","value":"critic"}]}}' > "$GJC_WORKFLOW_HUD_SIDECAR"
`,
			{ mode: 0o755 },
		);

		const result = await runGjcRuntimeBridgeWithHudSidecar("ralplan", [], {
			env: { GJC_RUNTIME_BINARY: runtimePath, PATH: "" },
			sidecarSkill: "ralplan",
			onHudPayload: () => {
				throw new Error("hud-write-failed");
			},
		});

		expect(result.status).toBe(0);
		expect(result.error).toBeUndefined();
		expect(result.hudPayload?.hud.chips?.[0]?.value).toBe("critic");
	});

	it("tries the legacy runtime candidate when the HUD bridge primary candidate is missing", async () => {
		cleanupRoot = await mkdtemp(join(tmpdir(), "gjc-runtime-bridge-"));
		const logPath = join(cleanupRoot, "argv.log");
		const runtimePath = join(cleanupRoot, "gjc-runtime.sh");
		await writeFile(
			runtimePath,
			`#!/bin/sh
printf '%s\n' "$1|$2" > ${JSON.stringify(logPath)}
printf '{"version":1,"skill":"ralplan","hud":{"version":1,"chips":[{"label":"stage","value":"legacy"}]}}' > "$GJC_WORKFLOW_HUD_SIDECAR"
`,
			{ mode: 0o755 },
		);

		const result = await runGjcRuntimeBridgeWithHudSidecar("ralplan", ["--direct"], {
			env: {
				GJC_RUNTIME_BINARY: join(cleanupRoot, "missing-runtime"),
				GJC_LEGACY_RUNTIME_BINARY: runtimePath,
				PATH: "",
			},
			sidecarSkill: "ralplan",
		});

		expect(result.status).toBe(0);
		expect(await readFile(logPath, "utf-8")).toBe("ralplan|--direct\n");
		expect(result.hudPayload?.hud.chips?.[0]?.value).toBe("legacy");
	});

	it("keeps child failure authoritative even with a valid sidecar", async () => {
		cleanupRoot = await mkdtemp(join(tmpdir(), "gjc-runtime-bridge-"));
		const runtimePath = join(cleanupRoot, "gjc-runtime.sh");
		await writeFile(
			runtimePath,
			`#!/bin/sh
printf '{"version":1,"skill":"ralplan","hud":{"version":1,"chips":[{"label":"stage","value":"critic"}]}}' > "$GJC_WORKFLOW_HUD_SIDECAR"
exit 7
`,
			{ mode: 0o755 },
		);

		const result = await runGjcRuntimeBridgeWithHudSidecar("ralplan", [], {
			env: { GJC_RUNTIME_BINARY: runtimePath, PATH: "" },
			sidecarSkill: "ralplan",
			pollIntervalMs: 25,
		});

		expect(result.status).toBe(7);
		expect(result.hudPayload?.hud.chips?.[0]?.value).toBe("critic");
	});
});
