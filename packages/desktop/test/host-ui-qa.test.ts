import { expect, test } from "bun:test";
import * as path from "node:path";
import type {
	DesktopFrame,
	DesktopMethod,
	DesktopSession,
	DesktopSnapshot,
} from "@gajae-code/desktop-host/protocol";
import type { FixtureSessionObservation, FixtureSnapshot } from "../scripts/qa-model-fixture";

interface WrapperConfig {
	serverUrl: string;
	token: string;
	modelFixture: { dataDir: string };
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

async function wrapper() {
	const root = path.resolve(import.meta.dir, "../../..");
	const child = Bun.spawn([process.execPath, "packages/desktop/scripts/host-ui-qa.ts"], {
		cwd: root,
		env: { PATH: process.env.PATH ?? "/usr/bin:/bin", GJC_DESKTOP_QA_MODEL_FIXTURE: "1" },
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
		const post = (name: string, body: unknown) => fetch(route(name), {
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

test("authenticated fixture cold restart replaces the host process on the same owned data and provider", async () => {
	const qa = await wrapper();
	try {
		const sessionId = crypto.randomUUID();
		expect((await qa.post("/fixture/cold-restart", { sessionId })).status).toBe(409);
		expect((await fetch(qa.route("/fixture/cold-restart"), { headers: { Origin: "http://127.0.0.1:1420" } })).status).toBe(405);
		expect((await fetch(qa.route("/fixture/cold-restart"), {
			method: "POST", headers: { Origin: "http://external.invalid", "Content-Type": "application/json" }, body: "{}",
		})).status).toBe(403);
		expect((await fetch(`${qa.config.serverUrl}/fixture/cold-restart`, {
			method: "POST", headers: { Origin: "http://127.0.0.1:1420" },
		})).status).toBe(401);
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
			const snapshot = await (await qa.post("/fixture/status", {})).json() as FixtureSnapshot;
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
		const receipt = await restarted.json() as {
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
			fixture = await (await qa.post("/fixture/status", {})).json() as FixtureSnapshot;
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
