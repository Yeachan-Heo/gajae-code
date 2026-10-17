import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SessionIndex } from "../src/sdk/broker/session-index";
import {
	applySessionLaunchEnvironment,
	createSessionChildEnvironment,
	hasSessionPathOverride,
	isValidSessionLaunchEnvironment,
	type SessionLaunchEnvironment,
	sessionEnvironmentNames,
} from "../src/sdk/session-environment";

test("session launch environment overlays a child environment without mutating its broker parent", () => {
	const parent = { PATH: "/usr/bin:/bin", GH_TOKEN: "broker-secret" };
	const child: Record<string, string> = { ...parent };
	const environment: SessionLaunchEnvironment = {
		env: { PATH: "/guarded/bin:/usr/bin:/bin" },
		unsetEnv: ["GH_TOKEN"],
	};

	expect(isValidSessionLaunchEnvironment(environment.env, environment.unsetEnv)).toBe(true);
	applySessionLaunchEnvironment(child, environment);

	expect(parent).toEqual({ PATH: "/usr/bin:/bin", GH_TOKEN: "broker-secret" });
	expect(child).toEqual({ PATH: "/guarded/bin:/usr/bin:/bin" });
	expect(sessionEnvironmentNames(environment)).toEqual({ set: ["PATH"], unset: ["GH_TOKEN"] });
	expect(JSON.stringify(sessionEnvironmentNames(environment))).not.toContain("broker-secret");

	const specialNameEnv = Object.fromEntries([["__proto__", "literal-value"]]) as Record<string, string>;
	const specialNameChild: Record<string, string> = {};
	expect(isValidSessionLaunchEnvironment(specialNameEnv, undefined)).toBe(true);
	applySessionLaunchEnvironment(specialNameChild, { env: specialNameEnv });
	expect(Object.hasOwn(specialNameChild, "__proto__")).toBe(true);
	expect(Object.getOwnPropertyDescriptor(specialNameChild, "__proto__")?.value).toBe("literal-value");
});

test("session child environments apply set and unset values without mutating inherited values", () => {
	const inheritedEnvironment = {
		SESSION_VALUE: "host-value",
		SESSION_UNSET: "host-secret",
		SESSION_KEEP: "preserved",
	};
	const childEnvironment = createSessionChildEnvironment(
		{ env: { SESSION_VALUE: "session-value" }, unsetEnv: ["SESSION_UNSET"] },
		inheritedEnvironment,
	);

	expect(childEnvironment).toEqual({ SESSION_VALUE: "session-value", SESSION_KEEP: "preserved" });
	expect(inheritedEnvironment).toEqual({
		SESSION_VALUE: "host-value",
		SESSION_UNSET: "host-secret",
		SESSION_KEEP: "preserved",
	});
	expect(createSessionChildEnvironment(undefined, inheritedEnvironment)).toBeUndefined();
});

test("session launch environment rejects invalid, conflicting, and host-control variables", () => {
	expect(isValidSessionLaunchEnvironment({ PATH: "/safe", GH_TOKEN: "secret" }, ["GH_TOKEN"])).toBe(false);
	expect(isValidSessionLaunchEnvironment({ PATH: 7 }, undefined)).toBe(false);
	expect(isValidSessionLaunchEnvironment({ "bad=name": "value" }, undefined)).toBe(false);
	expect(isValidSessionLaunchEnvironment({ GJC_STATE_ROOT: "/outside" }, undefined)).toBe(false);
	expect(isValidSessionLaunchEnvironment(undefined, ["PI_SESSION_FILE"])).toBe(false);
	expect(isValidSessionLaunchEnvironment({ BUN_OPTIONS: "--preload=./bootstrap.js" }, undefined)).toBe(false);
	expect(isValidSessionLaunchEnvironment({ NODE_OPTIONS: "--require=./bootstrap.js" }, undefined)).toBe(false);
	expect(isValidSessionLaunchEnvironment({ LD_PRELOAD: "/tmp/bootstrap.so" }, undefined)).toBe(false);
	expect(isValidSessionLaunchEnvironment({ LD_LIBRARY_PATH: "/tmp/native-libs" }, undefined)).toBe(false);
	expect(isValidSessionLaunchEnvironment(undefined, ["LD_AUDIT"])).toBe(false);
	expect(isValidSessionLaunchEnvironment({ DYLD_INSERT_LIBRARIES: "/tmp/bootstrap.dylib" }, undefined)).toBe(false);
	expect(isValidSessionLaunchEnvironment({ DYLD_LIBRARY_PATH: "/tmp/native-libs" }, undefined)).toBe(false);
	expect(isValidSessionLaunchEnvironment({ FOO: "bad\0value" }, undefined)).toBe(false);
});

test("session launch environment matches Windows keys case-insensitively and POSIX keys exactly", () => {
	const windowsEnvironment: Record<string, string | undefined> = {
		Path: "/inherited/bin",
		Api_Token: "inherited-secret",
		KEEP: "inherited",
	};
	const overlay: SessionLaunchEnvironment = {
		env: { PATH: "/session/bin" },
		unsetEnv: ["API_TOKEN"],
	};

	expect(isValidSessionLaunchEnvironment(overlay.env, overlay.unsetEnv, "win32")).toBe(true);
	applySessionLaunchEnvironment(windowsEnvironment, overlay, "win32");
	expect(windowsEnvironment).toEqual({ PATH: "/session/bin", KEEP: "inherited" });

	const posixEnvironment: Record<string, string | undefined> = {
		Path: "/inherited/bin",
		Api_Token: "inherited-secret",
	};
	applySessionLaunchEnvironment(posixEnvironment, overlay, "linux");
	expect(posixEnvironment).toEqual({
		Path: "/inherited/bin",
		Api_Token: "inherited-secret",
		PATH: "/session/bin",
	});
	expect(isValidSessionLaunchEnvironment({ PATH: "upper", path: "lower" }, undefined, "linux")).toBe(true);
	expect(isValidSessionLaunchEnvironment({ PATH: "upper", path: "lower" }, undefined, "win32")).toBe(false);
});

test("session PATH detection follows platform-specific environment names", () => {
	expect(hasSessionPathOverride({ env: { Path: "/session/bin" } }, "win32")).toBe(true);
	expect(hasSessionPathOverride({ env: { Path: "/session/bin" } }, "linux")).toBe(false);
	expect(hasSessionPathOverride({ unsetEnv: ["PATH"] }, "linux")).toBe(true);
	expect(hasSessionPathOverride(undefined, "win32")).toBe(false);
});

test("session launch environment survives session-index rotation and is absent from public rows", async () => {
	const agentDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-session-environment-index-"));
	const cwd = path.join(agentDir, "workspace");
	const stateRoot = path.join(cwd, ".gjc", "state");
	const locator = { cwd, worktreeRoot: null, stateRoot };
	try {
		const index = await new SessionIndex(agentDir).open();
		await index.append({
			type: "host_registered",
			sessionId: "environment-resume",
			locator,
			endpointGeneration: 1,
			pid: process.pid,
			sessionEnvironment: { env: { SESSION_SECRET: "stored-secret", PATH: "/guarded/bin" }, unsetEnv: ["GH_TOKEN"] },
		});
		await index.append({
			type: "host_unregistered",
			sessionId: "environment-resume",
			locator,
			endpointGeneration: 1,
			pid: process.pid,
		});

		expect(JSON.stringify(index.listSessions())).not.toContain("stored-secret");
		await index.snapshot();

		const reopened = await new SessionIndex(agentDir).open();
		expect(reopened.findSessionLaunchEnvironment("environment-resume", stateRoot)).toEqual({
			env: { SESSION_SECRET: "stored-secret", PATH: "/guarded/bin" },
			unsetEnv: ["GH_TOKEN"],
		});
	} finally {
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

test("session deletion purges only its state-root environment while retaining registration evidence", async () => {
	const agentDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-session-environment-delete-"));
	const cwd = path.join(agentDir, "workspace");
	const stateRoot = path.join(cwd, ".gjc", "state");
	const locator = { cwd, worktreeRoot: null, stateRoot };
	const survivingCwd = path.join(agentDir, "surviving-workspace");
	const survivingStateRoot = path.join(survivingCwd, ".gjc", "state");
	const survivingLocator = { cwd: survivingCwd, worktreeRoot: null, stateRoot: survivingStateRoot };
	const indexDir = path.join(agentDir, "sdk", "sessions");
	try {
		const index = await new SessionIndex(agentDir).open();
		await index.append({
			type: "host_registered",
			sessionId: "deleted-environment",
			locator: survivingLocator,
			endpointGeneration: 1,
			pid: process.pid,
			sessionEnvironment: {
				env: { SURVIVING_SECRET: "surviving-session-secret" },
				unsetEnv: ["SURVIVING_UNSET"],
			},
		});
		await index.append({
			type: "host_registered",
			sessionId: "deleted-environment",
			locator,
			endpointGeneration: 1,
			pid: process.pid,
			sessionEnvironment: { env: { SESSION_SECRET: "deleted-session-secret" } },
		});
		await index.append({
			type: "session_deleted",
			sessionId: "deleted-environment",
			locator,
			endpointGeneration: 1,
			pid: process.pid,
		});

		const snapshotText = await fs.readFile(path.join(indexDir, "index.snapshot.json"), "utf8");
		const logText = await fs.readFile(path.join(indexDir, "index.jsonl"), "utf8");
		const snapshot = JSON.parse(snapshotText) as { events: Array<Record<string, unknown>> };
		const retainedRegistration = snapshot.events.find(
			event =>
				event.type === "host_registered" &&
				(event.locator as { stateRoot?: string } | undefined)?.stateRoot === stateRoot,
		);
		const survivingRegistration = snapshot.events.find(
			event =>
				event.type === "host_registered" &&
				(event.locator as { stateRoot?: string } | undefined)?.stateRoot === survivingStateRoot,
		);
		expect(retainedRegistration).toMatchObject({ sessionId: "deleted-environment", pid: process.pid });
		expect(retainedRegistration).not.toHaveProperty("sessionEnvironment");
		expect(survivingRegistration).toHaveProperty("sessionEnvironment", {
			env: { SURVIVING_SECRET: "surviving-session-secret" },
			unsetEnv: ["SURVIVING_UNSET"],
		});
		expect(snapshotText).not.toContain("deleted-session-secret");
		expect(snapshotText).toContain("surviving-session-secret");
		expect(logText).not.toContain("deleted-session-secret");
		expect(index.findSessionLaunchEnvironment("deleted-environment", stateRoot)).toBeUndefined();
		expect(index.findSessionLaunchEnvironment("deleted-environment", survivingStateRoot)).toEqual({
			env: { SURVIVING_SECRET: "surviving-session-secret" },
			unsetEnv: ["SURVIVING_UNSET"],
		});

		const reopened = await new SessionIndex(agentDir).open();
		expect(reopened.findSessionLaunchEnvironment("deleted-environment", stateRoot)).toBeUndefined();
		expect(reopened.findSessionLaunchEnvironment("deleted-environment", survivingStateRoot)).toEqual({
			env: { SURVIVING_SECRET: "surviving-session-secret" },
			unsetEnv: ["SURVIVING_UNSET"],
		});
		expect(reopened.listSessions().sessions).not.toContainEqual(
			expect.objectContaining({
				sessionId: "deleted-environment",
			}),
		);
	} finally {
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});
