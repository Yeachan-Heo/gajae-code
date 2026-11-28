import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { DesktopFrame, DesktopMethod, DesktopSession, DesktopSnapshot } from "@gajae-code/desktop-host/protocol";
import {
	type FixtureSessionObservation,
	type FixtureSnapshot,
	QA_DEMONSTRATIONS,
	QA_EDIT_DEMO_FILE,
	QA_KEY,
	QA_MODEL_IDS,
	QA_PROVIDER,
} from "../scripts/qa-model-fixture";

interface WrapperConfig {
	serverUrl: string;
	token: string;
	bootstrapUrl: string;
	lifetimeMinutes: number;
	expiresAt: string;
	project: string;
	modelFixture: {
		dataDir: string;
		initialHold: boolean;
		requestLimit: number;
		onboarding: boolean;
		onboardingCredential?: { provider: string; key: string };
		demonstrations: unknown;
		editDemoFile: string;
	};
}

interface HostStatus {
	root: string;
	dataDir: string;
	pid: number;
	generation: number;
	providerBaseUrl: string;
	providerCounts: { requests: number; titleRequests: number };
	session?: FixtureSessionObservation;
}

async function waitFor(predicate: () => boolean, label: string) {
	const deadline = Date.now() + 30000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
		await Bun.sleep(10);
	}
}

const repositoryRoot = path.resolve(import.meta.dir, "../../..");

async function wrapper(env: Record<string, string> = {}) {
	const child = Bun.spawn([process.execPath, "packages/desktop/scripts/host-ui-qa.ts"], {
		cwd: repositoryRoot,
		env: { PATH: process.env.PATH ?? "/usr/bin:/bin", GJC_DESKTOP_QA_MODEL_FIXTURE: "1", ...env },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const ready = Promise.withResolvers<WrapperConfig>();
	const deadline = setTimeout(() => ready.reject(new Error("QA wrapper did not start")), 30000);
	const stderr = Bun.readableStreamToText(child.stderr);
	const stdout = (async () => {
		const reader = child.stdout.getReader();
		const decoder = new TextDecoder();
		let pending = "";
		let configured = false;
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				pending += decoder.decode(value, { stream: true });
				let end = pending.indexOf("\n");
				while (end >= 0) {
					const line = pending.slice(0, end);
					pending = pending.slice(end + 1);
					if (!configured && line) {
						ready.resolve(JSON.parse(line) as WrapperConfig);
						configured = true;
					}
					end = pending.indexOf("\n");
				}
			}
			if (!configured) ready.reject(new Error("QA wrapper exited before startup"));
		} catch (error) {
			ready.reject(error);
			throw error;
		} finally {
			reader.releaseLock();
		}
	})();
	void stdout.catch(() => {});
	const connection = new AbortController();
	let reading: Promise<void> | undefined;
	const close = async () => {
		clearTimeout(deadline);
		if (child.exitCode === null) {
			const force = setTimeout(() => child.kill("SIGKILL"), 3000);
			try {
				child.kill("SIGTERM");
				await child.exited;
			} finally {
				clearTimeout(force);
			}
		}
		connection.abort();
		await Promise.allSettled([stdout, stderr, reading]);
	};
	try {
		const config = await ready.promise;
		clearTimeout(deadline);
		const query = new URLSearchParams({ token: config.token, client: crypto.randomUUID() });
		const origin = "http://127.0.0.1:1420";
		const route = (name: string) => `${config.serverUrl}${name}?${query}`;
		const post = (name: string, body: unknown) =>
			fetch(route(name), {
				method: "POST",
				headers: { Origin: origin, "Content-Type": "application/json" },
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(45000),
			});
		const frames: DesktopFrame[] = [];
		const connect = async () => {
			const events = await fetch(route("/events"), { headers: { Origin: origin }, signal: connection.signal });
			expect(events.status).toBe(200);
			if (!events.body) throw new Error("Missing QA event stream");
			reading = (async () => {
				const reader = events.body!.getReader();
				const decoder = new TextDecoder();
				let pending = "";
				try {
					for (;;) {
						const { done, value } = await reader.read();
						if (done) break;
						pending += decoder.decode(value, { stream: true });
						let end = pending.indexOf("\n\n");
						while (end >= 0) {
							const event = pending.slice(0, end);
							pending = pending.slice(end + 2);
							if (event.startsWith("data: ")) frames.push(JSON.parse(event.slice(6)) as DesktopFrame);
							end = pending.indexOf("\n\n");
						}
					}
				} finally {
					reader.releaseLock();
				}
			})();
			void reading.catch(() => {});
		};
		const call = async <T>(method: DesktopMethod, params: Record<string, unknown> = {}): Promise<T> => {
			const id = crypto.randomUUID();
			expect((await post("/request", { id, method, params })).status).toBe(200);
			await waitFor(() => frames.some(frame => frame.type === "response" && frame.id === id), `${method} response`);
			const response = frames.find(frame => frame.type === "response" && frame.id === id);
			if (response?.type !== "response") throw new Error("Missing host response");
			if (!response.ok) throw new Error(response.error);
			return response.result as T;
		};
		const status = async (sessionId: string): Promise<HostStatus> => {
			const response = await post("/fixture/host-status", { sessionId });
			expect(response.status).toBe(200);
			return response.json() as Promise<HostStatus>;
		};
		return { child, config, post, connect, call, status, frames, stderr, stdout, close, route };
	} catch (error) {
		await close();
		throw error;
	}
}

test("the script header lists every demonstration prompt verbatim", async () => {
	const source = await Bun.file(path.resolve(import.meta.dir, "../scripts/host-ui-qa.ts")).text();
	const header = source.slice(0, source.indexOf("\nimport "));
	for (const [name, demonstration] of Object.entries(QA_DEMONSTRATIONS))
		expect(header).toContain(`//   ${name}: ${demonstration.prompt}\n`);
});

test("invalid or misplaced run controls are refused before any state exists", async () => {
	const cases: Array<[Record<string, string>, string]> = [
		[{ GJC_DESKTOP_QA_LIFETIME_MINUTES: "0" }, "GJC_DESKTOP_QA_LIFETIME_MINUTES must be an integer from 1 to 240"],
		[{ GJC_DESKTOP_QA_LIFETIME_MINUTES: "241" }, "from 1 to 240"],
		[{ GJC_DESKTOP_QA_LIFETIME_MINUTES: "1e2" }, "from 1 to 240"],
		[{ GJC_DESKTOP_QA_INITIAL_HOLD: "false" }, "GJC_DESKTOP_QA_INITIAL_HOLD must be 0 or 1"],
		[{ GJC_DESKTOP_QA_REQUEST_LIMIT: "513" }, "GJC_DESKTOP_QA_REQUEST_LIMIT must be an integer from 1 to 512"],
		[
			{ GJC_DESKTOP_QA_MODEL_FIXTURE: "", GJC_DESKTOP_QA_INITIAL_HOLD: "0" },
			"require GJC_DESKTOP_QA_MODEL_FIXTURE=1",
		],
		[
			{ GJC_DESKTOP_QA_MODEL_FIXTURE: "", GJC_DESKTOP_QA_REQUEST_LIMIT: "100" },
			"require GJC_DESKTOP_QA_MODEL_FIXTURE=1",
		],
		[{ GJC_DESKTOP_QA_ONBOARDING: "true" }, "GJC_DESKTOP_QA_ONBOARDING must be 0 or 1"],
		[{ GJC_DESKTOP_QA_MODEL_FIXTURE: "", GJC_DESKTOP_QA_ONBOARDING: "1" }, "require GJC_DESKTOP_QA_MODEL_FIXTURE=1"],
	];
	const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-qa-refusal-")));
	try {
		for (const [env, message] of cases) {
			const child = Bun.spawn([process.execPath, "packages/desktop/scripts/host-ui-qa.ts"], {
				cwd: repositoryRoot,
				env: {
					PATH: process.env.PATH ?? "/usr/bin:/bin",
					GJC_DESKTOP_QA_MODEL_FIXTURE: "1",
					TMPDIR: scratch,
					...env,
				},
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			const [code, stdout, stderr] = await Promise.all([
				child.exited,
				Bun.readableStreamToText(child.stdout),
				Bun.readableStreamToText(child.stderr),
			]);
			expect(code).not.toBe(0);
			expect(stdout).toBe("");
			expect(stderr).toContain(message);
			expect(await fs.readdir(scratch)).toEqual([]);
		}
	} finally {
		await fs.rm(scratch, { recursive: true, force: true });
	}
}, 45000);

test("an interactive run streams its first prompt at once and reports its run controls", async () => {
	const started = Date.now();
	const qa = await wrapper({
		GJC_DESKTOP_QA_INITIAL_HOLD: "0",
		GJC_DESKTOP_QA_LIFETIME_MINUTES: "90",
		GJC_DESKTOP_QA_REQUEST_LIMIT: "200",
	});
	try {
		expect(qa.config.lifetimeMinutes).toBe(90);
		const expires = Date.parse(qa.config.expiresAt) - started;
		expect(expires).toBeGreaterThan(89 * 60 * 1000);
		expect(expires).toBeLessThanOrEqual(90 * 60 * 1000 + 30000);
		expect(qa.config.modelFixture).toMatchObject({ initialHold: false, requestLimit: 200, onboarding: false });
		expect(qa.config.modelFixture.onboardingCredential).toBeUndefined();
		await qa.connect();
		const snapshot = await qa.call<DesktopSnapshot>("bootstrap");
		const seeded = snapshot.sessions.find(session => session.title === "Short conversation");
		if (!seeded) throw new Error("Missing short fixture session");
		await qa.call("session.select", { sessionId: seeded.id });
		// Nothing releases this prompt: it must finish on its own.
		await qa.call("prompt", { sessionId: seeded.id, text: "first prompt without a hold" });
		const status = (await (await qa.post("/fixture/status", {})).json()) as FixtureSnapshot;
		expect(status).toMatchObject({ holdNext: false, requestLimit: 200 });
		expect(status.requests[0]).toMatchObject({ id: 1, state: "completed", held: false, released: false });
		// The printed demonstrations are the exact prompts the Host tests run.
		expect(qa.config.modelFixture.demonstrations).toEqual(QA_DEMONSTRATIONS);
		expect(qa.config.modelFixture.editDemoFile).toBe(path.join(qa.config.project, QA_EDIT_DEMO_FILE));
		await qa.call("prompt", { sessionId: seeded.id, text: QA_DEMONSTRATIONS.edit.prompt });
		const diff = await qa.call<Array<{ path: string; status: string; patch: string }>>("diff.get", {
			sessionId: seeded.id,
		});
		const demo = diff.find(file => file.path === QA_EDIT_DEMO_FILE);
		expect(demo?.status).not.toBe("??");
		expect(demo?.patch).toContain("-status: draft\n-reviewer: none\n+status: reviewed\n+reviewer: desktop-qa\n");
		expect(diff.find(file => file.path === "qa-untracked.txt")?.status).toBe("??");
		await qa.call("shutdown");
		expect(await qa.child.exited).toBe(0);
	} finally {
		await qa.close();
	}
}, 60000);

test("onboarding mode starts with no models, admits only the fixture key and keeps sign-in flows out", async () => {
	const qa = await wrapper({ GJC_DESKTOP_QA_ONBOARDING: "1", GJC_DESKTOP_QA_INITIAL_HOLD: "0" });
	try {
		expect(qa.config.modelFixture).toMatchObject({
			onboarding: true,
			onboardingCredential: { provider: QA_PROVIDER, key: QA_KEY },
		});
		await qa.connect();
		const snapshot = await qa.call<DesktopSnapshot>("bootstrap");
		expect(snapshot.models).toEqual([]);
		const request = (method: string, params: Record<string, unknown>) =>
			qa.post("/request", { id: crypto.randomUUID(), method, params });
		// A sign-in would start a real provider flow; answer and cancel only act on a flow it created.
		for (const [method, params] of [
			["auth.login", { provider: "openai-codex" }],
			["auth.answer", { flowId: crypto.randomUUID(), promptId: crypto.randomUUID(), value: "confirm" }],
			["auth.cancel", { flowId: crypto.randomUUID() }],
		] as const)
			expect((await request(method, params)).status).toBe(403);
		for (const params of [
			{ provider: "openai", key: QA_KEY },
			{ provider: QA_PROVIDER, key: "a-real-looking-key" },
		])
			expect((await request("auth.setKey", params)).status).toBe(403);
		expect(await qa.call<string[]>("auth.keyProviders")).toContain(QA_PROVIDER);
		expect(await qa.call("auth.state")).toBeNull();
		expect(Array.isArray(await qa.call("auth.providers"))).toBe(true);
		await qa.call("auth.setKey", { provider: QA_PROVIDER, key: QA_KEY });
		const published = qa.frames.findLast(frame => frame.type === "snapshot");
		if (published?.type !== "snapshot") throw new Error("No snapshot after the key was stored");
		expect(published.snapshot.models.map(model => model.id)).toEqual(QA_MODEL_IDS.map(id => `${QA_PROVIDER}/${id}`));
		const created = await qa.call<DesktopSession>("session.create", { projectId: snapshot.projects[0]!.id });
		expect(created.model).toBe(`${QA_PROVIDER}/qa-reasoning`);
		await qa.call("prompt", { sessionId: created.id, text: "first onboarded turn through the bridge" });
		// The tool features' reads and saves reach the Host.
		const tools = await qa.call<{ active: string[] }>("tools.list", { sessionId: created.id });
		await qa.call("tools.set", { sessionId: created.id, names: tools.active });
		expect((await request("tool.detail", { sessionId: created.id, callId: "qa-tool-call-1" })).status).toBe(200);
		await qa.call("shutdown");
		expect(await qa.child.exited).toBe(0);
	} finally {
		await qa.close();
	}
}, 60000);

test("the bridge admits Disconnect and Connect, and a disconnected conversation refuses a prompt", async () => {
	const qa = await wrapper({ GJC_DESKTOP_QA_INITIAL_HOLD: "0" });
	try {
		await qa.connect();
		const snapshot = await qa.call<DesktopSnapshot>("bootstrap");
		const created = await qa.call<DesktopSession>("session.create", { projectId: snapshot.projects[0]!.id });
		await qa.call("prompt", { sessionId: created.id, text: "a turn before disconnecting" });
		const released = await qa.call<{ disconnected: boolean; session?: DesktopSession }>("session.disconnect", {
			sessionId: created.id,
		});
		expect(released.disconnected).toBe(true);
		expect(released.session?.connection).toEqual({ state: "disconnected" });
		await expect(qa.call("prompt", { sessionId: created.id, text: "refused while disconnected" })).rejects.toThrow(
			"Connect",
		);
		const connected = await qa.call<DesktopSession>("session.connect", { sessionId: created.id });
		expect(connected.connection).toEqual({ state: "connected" });
		await qa.call("shutdown");
		expect(await qa.child.exited).toBe(0);
	} finally {
		await qa.close();
	}
}, 60000);

test("requested QA shutdown delivers its final frame and exits successfully", async () => {
	const qa = await wrapper();
	try {
		await qa.connect();
		await qa.call("shutdown");
		expect(await qa.child.exited).toBe(0);
		expect(await qa.stderr).not.toContain("Host terminated unexpectedly");
		await qa.stdout;
	} finally {
		await qa.close();
	}
}, 45000);

test("each harness run clears recovery storage on its first page load only", async () => {
	const recoveryDatabase = "gjc.desktop.delivery-recovery";
	const composerDrafts = "gjc.desktop.composer-drafts";
	// The harness must clear exactly the storage the app reads; a product rename must fail here.
	const desktopSource = (file: string) => Bun.file(path.resolve(import.meta.dir, "../src", file)).text();
	expect(await desktopSource("delivery-recovery.ts")).toContain(`indexedDB.open("${recoveryDatabase}"`);
	expect(await desktopSource("App.tsx")).toContain(`localStorage.getItem("${composerDrafts}")`);
	const qa = await wrapper();
	try {
		const bootstrap = await fetch(qa.config.bootstrapUrl);
		expect(bootstrap.status).toBe(200);
		const source = await bootstrap.text();
		// One origin's storage as an earlier run left it: a recovery record and a saved draft.
		const local = new Map<string, string>([
			["gjc.desktop.qa-run", "an-earlier-run"],
			[composerDrafts, '{"earlier-session":"earlier draft"}'],
		]);
		const deleted: string[] = [];
		const load = () => {
			const page = new Function("location", "window", "addEventListener", "localStorage", "indexedDB", source);
			page(
				{ origin: "http://127.0.0.1:1420" },
				{},
				() => {},
				{
					getItem: (key: string) => local.get(key) ?? null,
					setItem: (key: string, value: string) => local.set(key, value),
					removeItem: (key: string) => local.delete(key),
				},
				{ deleteDatabase: (name: string) => deleted.push(name) },
			);
		};
		load();
		expect(deleted).toEqual([recoveryDatabase]);
		expect(local.has(composerDrafts)).toBe(false);
		// The app records work during this run; reloading the page must keep it for recovery QA.
		local.set(composerDrafts, '{"current-session":"current draft"}');
		load();
		load();
		expect(deleted).toEqual([recoveryDatabase]);
		expect(local.get(composerDrafts)).toBe('{"current-session":"current draft"}');
		await qa.connect();
		await qa.call("shutdown");
		expect(await qa.child.exited).toBe(0);
	} finally {
		await qa.close();
	}
}, 45000);

test("authenticated fixture cold restart replaces the host process on the same owned data and provider", async () => {
	const qa = await wrapper();
	try {
		const sessionId = crypto.randomUUID();
		expect((await qa.post("/fixture/cold-restart", { sessionId })).status).toBe(409);
		expect(
			(await fetch(qa.route("/fixture/cold-restart"), { headers: { Origin: "http://127.0.0.1:1420" } })).status,
		).toBe(405);
		expect(
			(
				await fetch(qa.route("/fixture/cold-restart"), {
					method: "POST",
					headers: { Origin: "http://external.invalid", "Content-Type": "application/json" },
					body: "{}",
				})
			).status,
		).toBe(403);
		expect(
			(
				await fetch(`${qa.config.serverUrl}/fixture/cold-restart`, {
					method: "POST",
					headers: { Origin: "http://127.0.0.1:1420" },
				})
			).status,
		).toBe(401);
		await qa.connect();
		for (const extra of [{ root: "/tmp/nonowned" }, { dataDir: "/tmp/nonowned" }, { key: "real-secret" }])
			expect((await qa.post("/fixture/cold-restart", { sessionId, ...extra })).status).toBe(400);
		expect((await qa.post("/fixture/cold-restart", { sessionId })).status).toBe(400);
		const snapshot = await qa.call<DesktopSnapshot>("bootstrap");
		const seeded = snapshot.sessions.find(session => session.title === "Long conversation");
		if (!seeded) throw new Error("Missing long fixture session");
		await qa.call("session.select", { sessionId: seeded.id });
		const initial = await qa.status(seeded.id);
		expect(initial.session?.selectedLeafId).toBe("m119");
		expect(initial.providerCounts).toEqual({ requests: 0, titleRequests: 0 });
		const firstTurn = qa.call("prompt", { sessionId: seeded.id, text: "persist a real turn before cold restart" });
		void firstTurn.catch(() => {});
		const firstDeadline = Date.now() + 30000;
		while (true) {
			const snapshot = (await (await qa.post("/fixture/status", {})).json()) as FixtureSnapshot;
			if (snapshot.requests.length === 1) break;
			if (Date.now() > firstDeadline) throw new Error("No pre-restart provider request");
			await Bun.sleep(10);
		}
		expect((await qa.post("/fixture/release", { requestId: 1 })).status).toBe(200);
		await firstTurn;
		const before = await qa.status(seeded.id);
		expect(before.providerCounts.requests).toBe(1);
		expect(before.session?.selectedLeafId).not.toBe(initial.session?.selectedLeafId);
		const restarted = await qa.post("/fixture/cold-restart", { sessionId: seeded.id });
		expect(restarted.status).toBe(200);
		const receipt = (await restarted.json()) as {
			before: HostStatus;
			after: HostStatus;
			terminated: { pid: number; signal: string; exitCode: number };
			requiresBootstrap: boolean;
		};
		expect(receipt.before).toEqual(before);
		expect(receipt.terminated).toMatchObject({ pid: before.pid, signal: "SIGKILL" });
		expect(() => process.kill(before.pid, 0)).toThrow();
		expect(receipt.after.pid).not.toBe(before.pid);
		expect(receipt.after.generation).toBe(before.generation + 1);
		expect(receipt.after.root).toBe(before.root);
		expect(receipt.after.dataDir).toBe(before.dataDir);
		expect(receipt.after.providerBaseUrl).toBe(before.providerBaseUrl);
		expect(receipt.after.providerCounts).toEqual(before.providerCounts);
		expect(receipt.requiresBootstrap).toBe(true);
		// The SAME event stream carries the new real host's bootstrap and session frames.
		await qa.call("bootstrap");
		const selected = await qa.call<DesktopSession>("session.select", { sessionId: seeded.id });
		expect(selected.id).toBe(seeded.id);
		const after = await qa.status(seeded.id);
		if (!before.session) throw new Error("Missing pre-restart session observation");
		expect(after.session).toEqual({ ...before.session, pid: after.pid });
		expect(after.providerCounts).toEqual(before.providerCounts);
		expect((await qa.post("/fixture/hold", {})).status).toBe(200);
		const prompting = qa.call("prompt", { sessionId: seeded.id, text: "continuation after actual cold restart" });
		void prompting.catch(() => {});
		let fixture: FixtureSnapshot | undefined;
		const deadline = Date.now() + 30000;
		do {
			fixture = (await (await qa.post("/fixture/status", {})).json()) as FixtureSnapshot;
			if (fixture.requests.length === 2) break;
			await Bun.sleep(10);
		} while (Date.now() <= deadline);
		if (fixture.requests.length !== 2) throw new Error("No post-restart provider request");
		expect((await qa.post("/fixture/cold-restart", { sessionId: seeded.id })).status).toBe(409);
		expect(fixture.requests[0]?.state).toBe("completed");
		expect(fixture.requests[1]?.id).toBe(2);
		expect((await qa.post("/fixture/release", { requestId: 2 })).status).toBe(200);
		await prompting;
		expect((await qa.status(seeded.id)).providerCounts.requests).toBe(2);
		await qa.call("shutdown");
		expect(await qa.child.exited).toBe(0);
		expect(await qa.stderr).not.toContain("Host terminated unexpectedly");
		expect(await Bun.file(path.join(qa.config.modelFixture.dataDir, "catalog.json")).exists()).toBe(false);
	} finally {
		await qa.close();
	}
}, 120000);
