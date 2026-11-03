import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eventTypeOrigin, monitorSessionOrigin, type OriginRef, originKey } from "@gajae-gateway/protocol";
import { maybeCreateThreadOnMention, settleDiscordDelivery, UnnamedThreads } from "../../adapter-discord/src/main";
import { discordMessageOrigin } from "../../adapter-discord/src/origin";
import type { GatewayConfig } from "../src/config";
import { type GatewayServer, startUnixServer } from "../src/server/server";
import { Store } from "../src/store";
import { resolveLaneReportOrigin, workAttemptDeliveryId } from "../src/store/groups/work";
import { attachTestBrokerOwnership, ScriptedSessionPort } from "./session-port.fake";

const rootOrigin: OriginRef = { platform: "discord", kind: "channel", conversationId: "parent-channel" };
const rootKey = originKey(rootOrigin);
const fixtures: Array<{
	home: string;
	server: GatewayServer;
	database: Store;
	port: ScriptedSessionPort;
	client: Awaited<ReturnType<typeof connect>>;
}> = [];

afterEach(async () => {
	for (const fixture of fixtures.splice(0).reverse()) {
		fixture.client.close();
		await fixture.server.stop();
	}
});

async function eventually<T>(read: () => T | Promise<T>, accept: (value: T) => boolean, label: string): Promise<T> {
	for (let attempt = 0; attempt < 600; attempt++) {
		const value = await read();
		if (accept(value)) return value;
		await Bun.sleep(5);
	}
	throw new Error(`timed out waiting for ${label}`);
}

async function connect(socketPath: string) {
	const frames: any[] = [];
	let buffered = Buffer.alloc(0);
	const socket = await Bun.connect({
		unix: socketPath,
		socket: {
			data(_socket, data) {
				buffered = Buffer.concat([buffered, Buffer.from(data)]);
				let newline = buffered.indexOf(10);
				while (newline >= 0) {
					const line = buffered.subarray(0, newline).toString("utf8");
					buffered = buffered.subarray(newline + 1);
					if (line) frames.push(JSON.parse(line));
					newline = buffered.indexOf(10);
				}
			},
		},
	});
	const client: {
		frames: any[];
		send(frame: unknown): void;
		close(): void;
		request(verb: string, params: unknown): Promise<any>;
	} = {
		frames,
		send: (frame: unknown) => socket.write(`${JSON.stringify(frame)}\n`),
		close: () => socket.end(),
		async request(verb: string, params: unknown): Promise<any> {
			const id = crypto.randomUUID();
			client.send({ v: "0.1", type: "request", id, verb, params });
			return await eventually<any>(() => frames.find((frame) => frame.id === id), Boolean, `${verb} response`);
		},
	};
	client.send({ v: "0.1", type: "hello", payload: { supportedVersions: ["0.1"] } });
	await eventually(
		() => frames,
		(value) => value.some((frame) => frame.type === "negotiated"),
		"socket negotiation",
	);
	return client;
}

async function bindPersonaSession(
	f: Awaited<ReturnType<typeof fixture>>,
	key: string,
	sessionId = crypto.randomUUID(),
): Promise<string> {
	const authority = f.database.inspectBrokerAuthority().authority;
	if (!authority) throw new Error("test broker authority missing");
	const recorded = f.database.transaction((tx) =>
		f.database.bindings.recordOwnedBinding(tx, {
			authority,
			sessionId,
			originKey: key,
			epoch: 0,
			repo: join(f.home, "workspace"),
		}),
	);
	if (!recorded) throw new Error("persona fixture binding lost its epoch");
	return sessionId;
}
async function fixture(
	options: {
		readonly ownerTarget?: OriginRef | false;
		readonly allowNested?: boolean;
		readonly channels?: GatewayConfig["channels"];
	} = {},
) {
	const home = await mkdtemp(join(tmpdir(), "lane-parent-report-"));
	const config: GatewayConfig = {
		schemaVersion: 1,
		home,
		gjc: { agentDir: join(home, "agent") },
		configPath: join(home, "config.json"),
		socketPath: join(home, "gateway.sock"),
		dbPath: join(home, "gateway.db"),
		logVerbosity: "info",
		dmPolicy: "open",
		...(options.ownerTarget === false ? {} : { ownerTarget: { origin: options.ownerTarget ?? rootOrigin } }),
		...(options.channels ? { channels: options.channels } : {}),
		...(options.allowNested === undefined ? {} : { work: { allowNested: options.allowNested } }),
	};
	const database = await Store.open(config.dbPath);
	const sessions = new Map<string, string>();
	const port = new ScriptedSessionPort({
		onBind: (input) => {
			const bindingKey = `${input.originKey}#${input.epoch}`;
			const known = database.bindings.getSessionRecord(input.originKey);
			const knownSessionId = known?.epoch === input.epoch && known.sessionId ? known.sessionId : undefined;
			const sessionId = sessions.get(bindingKey) ?? knownSessionId ?? crypto.randomUUID();
			sessions.set(bindingKey, sessionId);
			return sessionId;
		},
	});
	attachTestBrokerOwnership(database, port, join(home, "agent"));
	const server = await startUnixServer({ config, database, sessionPort: port, onStop: () => database.close() });
	const client = await connect(config.socketPath);
	const current = { home, server, database, port, client };
	fixtures.push(current);
	return current;
}

async function startPersonaTurn(
	f: Awaited<ReturnType<typeof fixture>>,
	origin: OriginRef,
	messageId: string,
	text = "human request",
) {
	const before = f.port.sends.length;
	const response = await f.client.request("chat.send", {
		origin,
		messageId,
		text,
		engagement: { mentioned: true, group: true, authorId: "human-1", authorName: "Alice" },
	});
	expect(response.error).toBeUndefined();
	const sends = await eventually(
		() => f.port.sends,
		(items) => items.length > before,
		"persona send",
	);
	return sends.at(-1)!;
}

async function startLane(f: Awaited<ReturnType<typeof fixture>>, name: string, callerSessionId?: string) {
	const response = await f.client.request("work.start", {
		name,
		text: `work for ${name}`,
		cwd: f.home,
		...(callerSessionId ? { callerSessionId } : {}),
	});
	return response;
}

async function settleLane(f: Awaited<ReturnType<typeof fixture>>, opRef: string, answer = "lane answer") {
	f.port.complete(opRef, answer);
	return await eventually(
		() => f.database.work.workAttemptGet(opRef),
		(runtime) => runtime?.settledAt !== undefined && runtime.settledAt !== null,
		`lane ${opRef} settlement`,
	);
}

async function silencePersona(f: Awaited<ReturnType<typeof fixture>>, opRef: string): Promise<void> {
	f.port.complete(opRef, "[SILENT]");
	await eventually(
		() => f.database.inbox.turnRow(opRef),
		(row) => row?.turn_state === "done",
		`silent persona turn ${opRef}`,
	);
}

function chatMessages(f: Awaited<ReturnType<typeof fixture>>) {
	return f.client.frames.filter((frame) => frame.type === "event" && frame.event === "chat.message");
}

for (const [label, origin] of [
	["AC-A discord thread", { platform: "discord", kind: "thread", conversationId: "thread-1", parentId: "channel-1" }],
	["AC-B slack channel", { platform: "slack", kind: "channel", conversationId: "C1" }],
	["AC-B slack thread", { platform: "slack", kind: "thread", conversationId: "C1:1700000000.000001", parentId: "C1" }],
] as const) {
	test(`${label}: lane report becomes an internal turn; persona reply is the only post`, async () => {
		const channels: GatewayConfig["channels"] =
			origin.platform === "discord"
				? { "channel-1": { engagement: "open" as const, audience: "all" as const } }
				: {
						"slack:C1": { engagement: "open" as const, audience: "all" as const },
						"slack:C1:1700000000.000001": { engagement: "open" as const, audience: "all" as const },
					};
		const f = await fixture({ ownerTarget: origin, channels });
		const persona = await startPersonaTurn(f, origin, `${label}-trigger`);
		const lane = await startLane(f, "worker", persona.sessionId);
		expect(lane.error).toBeUndefined();
		const work = lane.result;
		await settleLane(f, work.opRef, "bounded result");
		const reportRow = await eventually(
			() => f.database.inbox.turnRows(persona.opRef),
			(rows) =>
				rows.some(
					(row) =>
						row.source === "lane_report" && row.message_id === f.database.work.workAttemptGet(work.opRef)?.reportId,
				),
			"persona lane-report row",
		);
		const reportId = f.database.work.workAttemptGet(work.opRef)!.reportId;
		expect(reportRow.filter((row) => row.message_id === reportId)).toMatchObject([
			expect.objectContaining({
				source: "lane_report",
				origin_key: originKey(origin),
				turn_role: "steer",
				turn_state: "done",
			}),
		]);
		expect(chatMessages(f)).toHaveLength(0);
		expect(f.port.steers).toHaveLength(1);
		expect(f.port.steers[0]?.text).toContain("Internal report that arrived while you were working");
		expect(f.port.steers[0]?.text).not.toContain("Additional message from the user");
		expect(f.port.sendAttempts.some((send) => send.sessionId === work.sessionId)).toBe(true);
		f.port.complete(persona.opRef, "ack");
		await eventually(
			() => chatMessages(f),
			(messages) => messages.length === 1,
			"persona reply post",
		);
		expect(chatMessages(f).map((frame) => frame.payload.text)).toEqual(["ack"]);
		f.client.close();
	});
}

test("AC-A [SILENT] persona answer posts nothing", async () => {
	const origin: OriginRef = {
		platform: "discord",
		kind: "thread",
		conversationId: "thread-silent",
		parentId: "channel-silent",
	};
	const f = await fixture({
		ownerTarget: origin,
		channels: { "channel-silent": { engagement: "open", audience: "all" } },
	});
	const persona = await startPersonaTurn(f, origin, "silent-trigger");
	const lane = await startLane(f, "silent-worker", persona.sessionId);
	await settleLane(f, lane.result.opRef, "work done");
	await eventually(
		() => f.database.inbox.turnRows(persona.opRef),
		(rows) => rows.some((row) => row.source === "lane_report"),
		"internal lane report row",
	);
	f.port.complete(persona.opRef, "[SILENT]");
	await eventually(
		() => f.database.inbox.turnRow(persona.opRef),
		(row) => row?.turn_state === "done",
		"silent persona turn",
	);
	expect(chatMessages(f)).toHaveLength(0);
});

test("AC-C idle persona is woken with one send carrying the internal lane report", async () => {
	const f = await fixture();
	const personaSessionId = crypto.randomUUID();
	await bindPersonaSession(f, rootKey, personaSessionId);
	const lane = await startLane(f, "idle-worker", personaSessionId);
	await settleLane(f, lane.result.opRef, "idle report");
	const reportId = f.database.work.workAttemptGet(lane.result.opRef)!.reportId;
	const sends = await eventually(
		() => f.port.sends,
		(items) => items.some((send) => send.text.includes("[Internal report from another Gajae session")),
		"persona wake send",
	);
	const reportSend = sends.find((send) => send.text.includes("[Internal report from another Gajae session"))!;
	expect(reportSend.text).toContain("[lane idle-worker] completed: idle report");
	expect(reportSend.sessionId).toBe(personaSessionId);
	expect(f.database.inbox.turnRows(reportSend.opRef)).toMatchObject([
		expect.objectContaining({ message_id: reportId, source: "lane_report", origin_key: rootKey }),
	]);
	expect(chatMessages(f)).toHaveLength(0);
	f.port.complete(reportSend.opRef, "ack");
	await eventually(
		() => chatMessages(f),
		(messages) => messages.length === 1,
		"woken persona reply",
	);
	expect(chatMessages(f)[0]?.payload.text).toBe("ack");
});

test("a lane-report turn can [POST:] its result line to another configured channel", async () => {
	const f = await fixture({
		channels: {
			"parent-channel": { engagement: "open", audience: "all" },
			"report-room": { engagement: "open", audience: "all" },
		},
	});
	const personaSessionId = crypto.randomUUID();
	await bindPersonaSession(f, rootKey, personaSessionId);
	const lane = await startLane(f, "post-worker", personaSessionId);
	await settleLane(f, lane.result.opRef, "deployed");
	const sends = await eventually(
		() => f.port.sends,
		(items) => items.some((send) => send.text.includes("[Internal report from another Gajae session")),
		"persona wake send",
	);
	const reportSend = sends.find((send) => send.text.includes("[Internal report from another Gajae session"))!;
	f.port.complete(
		reportSend.opRef,
		"배포 끝났어\n[BREAK]\n[POST:discord/channel/report-room] 완료: 배포 <#parent-channel>",
	);
	await eventually(
		() => chatMessages(f),
		(messages) => messages.length === 2,
		"lane-report reply and post",
	);
	expect(chatMessages(f).map((frame) => [frame.payload.origin.conversationId, frame.payload.text])).toEqual([
		["parent-channel", "배포 끝났어"],
		["report-room", "완료: 배포 <#parent-channel>"],
	]);
	expect(f.database.outbox.rows().filter((row) => row.origin_key === "discord/channel/report-room")).toHaveLength(1);
});

for (const [label, callerSessionId] of [
	["no caller id", undefined],
	["unknown caller id", "unknown-session-id"],
] as const) {
	test(`AC-D ${label} routes to the ownerTarget persona`, async () => {
		const f = await fixture();
		const personaSessionId = crypto.randomUUID();
		await bindPersonaSession(f, rootKey, personaSessionId);
		const lane = await startLane(f, `owner-${label.replaceAll(" ", "-")}`, callerSessionId);
		await settleLane(f, lane.result.opRef, "owner report");
		const runtime = f.database.work.workAttemptGet(lane.result.opRef)!;
		expect(runtime.parent).toMatchObject({ kind: "persona", originKey: rootKey });
		const report = await eventually(
			() => f.port.sends,
			(sends) => Boolean(sends.find((send) => send.text.includes("[Internal report from another Gajae session"))),
			"owner-target report turn",
		);
		const reportSend = report.find((send) => send.text.includes("[Internal report from another Gajae session"))!;
		expect(reportSend.sessionId).toBe(personaSessionId);
		expect(chatMessages(f)).toHaveLength(0);
		await silencePersona(f, reportSend.opRef);
	});
}

test("AC-D no ownerTarget settles durably as no_target without inbound row or post", async () => {
	const f = await fixture({ ownerTarget: false });
	const lane = await startLane(f, "status-only");
	await settleLane(f, lane.result.opRef, "no destination");
	const runtime = f.database.work.workAttemptGet(lane.result.opRef)!;
	expect(runtime).toMatchObject({ parent: null, decision: "no_target" });
	expect(f.database.work.laneReportsByParent("status-only")).toEqual([]);
	expect(f.database.outbox.rows()).toEqual([]);
	expect(f.database.inbox.turnRows(lane.result.opRef)).toEqual([]);
	expect(chatMessages(f)).toHaveLength(0);
});

const monitorTargetOrigin: OriginRef = {
	platform: "telegram",
	kind: "topic",
	conversationId: "-1004317403746.2",
	parentId: "-1004317403746",
};

function createMonitor(
	f: Awaited<ReturnType<typeof fixture>>,
	channelTarget: { readonly origin: unknown } | null,
): { readonly monitorId: string; readonly sessionKey: string } {
	const monitorId = crypto.randomUUID();
	f.database.transaction((tx) =>
		f.database.monitors.create(tx, {
			id: monitorId,
			name: `monitor-${monitorId.slice(0, 8)}`,
			triggerJson: JSON.stringify({ kind: "cron", schedule: "0 0 1 1 *" }),
			eventTypesJson: JSON.stringify(["github.activity"]),
			burstPolicy: "coalesce",
			channelTargetJson: channelTarget ? JSON.stringify(channelTarget) : null,
			enabled: false,
			instruction: null,
			modelJson: null,
			serviceTier: null,
		}),
	);
	return { monitorId, sessionKey: originKey(monitorSessionOrigin(monitorId, "github.activity")) };
}

async function captureParentLog<T>(run: () => Promise<T>): Promise<{ readonly value: T; readonly lines: string[] }> {
	const lines: string[] = [];
	const original = console.error;
	console.error = (...args: unknown[]) => {
		const line = args.map(String).join(" ");
		if (line.startsWith("work_parent_")) lines.push(line);
		original(...args);
	};
	try {
		return { value: await run(), lines };
	} finally {
		console.error = original;
	}
}

test("a lane started from a monitor turn reports to the monitor's channel target conversation", async () => {
	const f = await fixture();
	const targetKey = originKey(monitorTargetOrigin);
	const ownerSessionId = await bindPersonaSession(f, rootKey);
	const targetSessionId = await bindPersonaSession(f, targetKey);
	const monitor = createMonitor(f, { origin: monitorTargetOrigin });
	const monitorSessionId = await bindPersonaSession(f, monitor.sessionKey);
	const { value: lane, lines } = await captureParentLog(() => startLane(f, "monitor-fix", monitorSessionId));
	expect(lane.error).toBeUndefined();
	expect(lines).toEqual([
		`work_parent_resolved verb=start name=monitor-fix source=monitor kind=persona monitor=${monitor.monitorId}`,
	]);
	await settleLane(f, lane.result.opRef, "monitor fix done");
	const runtime = f.database.work.workAttemptGet(lane.result.opRef)!;
	expect(runtime.parent).toEqual({ kind: "persona", originKey: targetKey, origin: monitorTargetOrigin });
	const sends = await eventually(
		() => f.port.sends,
		(items) => items.some((send) => send.text.includes("[Internal report from another Gajae session")),
		"monitor target report turn",
	);
	const reportSend = sends.find((send) => send.text.includes("[Internal report from another Gajae session"))!;
	expect(reportSend.text).toContain("[lane monitor-fix] completed: monitor fix done");
	expect(reportSend.sessionId).toBe(targetSessionId);
	expect(reportSend.sessionId).not.toBe(ownerSessionId);
	expect(f.database.inbox.turnRows(reportSend.opRef)).toMatchObject([
		expect.objectContaining({ message_id: runtime.reportId, source: "lane_report", origin_key: targetKey }),
	]);
	await silencePersona(f, reportSend.opRef);
});

for (const [label, channelTarget, reason] of [
	["without a channel target", null, "no_channel_target"],
	[
		"with a non-chat channel target",
		{ origin: { platform: "monitor", kind: "eventtype", conversationId: "x" } },
		"channel_target_not_chat",
	],
	["with a malformed channel target", { origin: { platform: "telegram" } }, "channel_target_invalid"],
] as const) {
	test(`a lane started from a monitor turn ${label} falls back to the owner with a recorded reason`, async () => {
		const f = await fixture();
		await bindPersonaSession(f, rootKey);
		const monitor = createMonitor(f, channelTarget);
		const monitorSessionId = await bindPersonaSession(f, monitor.sessionKey);
		const { value: lane, lines } = await captureParentLog(() => startLane(f, "monitor-owner", monitorSessionId));
		expect(lane.error).toBeUndefined();
		expect(lines).toEqual([
			`work_parent_resolved verb=start name=monitor-owner source=owner kind=persona fallback=monitor_${reason} monitor=${monitor.monitorId}`,
		]);
		await settleLane(f, lane.result.opRef, "owner fallback");
		expect(f.database.work.workAttemptGet(lane.result.opRef)!.parent).toMatchObject({
			kind: "persona",
			originKey: rootKey,
		});
		const sends = await eventually(
			() => f.port.sends,
			(items) => items.some((send) => send.text.includes("[Internal report from another Gajae session")),
			"owner fallback report turn",
		);
		await silencePersona(
			f,
			sends.find((send) => send.text.includes("[Internal report from another Gajae session"))!.opRef,
		);
	});
}

test("a lane started from a deleted monitor's session falls back to the owner with a recorded reason", async () => {
	const f = await fixture();
	await bindPersonaSession(f, rootKey);
	const monitor = createMonitor(f, { origin: monitorTargetOrigin });
	const monitorSessionId = await bindPersonaSession(f, monitor.sessionKey);
	f.database.transaction((tx) => f.database.monitors.delete(tx, monitor.monitorId));
	const { lines } = await captureParentLog(() => startLane(f, "monitor-gone", monitorSessionId));
	expect(lines).toEqual([
		`work_parent_resolved verb=start name=monitor-gone source=owner kind=persona fallback=monitor_not_found monitor=${monitor.monitorId}`,
	]);
});

test("a lane started from a legacy unscoped monitor session falls back to the owner with a recorded reason", async () => {
	const f = await fixture();
	await bindPersonaSession(f, rootKey);
	const legacySessionId = await bindPersonaSession(f, originKey(eventTypeOrigin("memory.audit")));
	const { lines } = await captureParentLog(() => startLane(f, "monitor-legacy", legacySessionId));
	expect(lines).toEqual([
		"work_parent_resolved verb=start name=monitor-legacy source=owner kind=persona fallback=monitor_id_missing",
	]);
});

test("a monitor without a usable target and no ownerTarget records the reason on the no-target line", async () => {
	const f = await fixture({ ownerTarget: false });
	const monitor = createMonitor(f, null);
	const monitorSessionId = await bindPersonaSession(f, monitor.sessionKey);
	const { value: lane, lines } = await captureParentLog(() => startLane(f, "monitor-nowhere", monitorSessionId));
	expect(lines).toEqual([
		`work_parent_resolved verb=start name=monitor-nowhere source=none kind=none fallback=monitor_no_channel_target monitor=${monitor.monitorId}`,
	]);
	await settleLane(f, lane.result.opRef, "nowhere");
	expect(f.database.work.workAttemptGet(lane.result.opRef)).toMatchObject({ parent: null, decision: "no_target" });
});

test("conversation-turn and terminal starts keep their parents next to a monitor with a channel target", async () => {
	const f = await fixture();
	const personaOrigin: OriginRef = { platform: "discord", kind: "channel", conversationId: "chat-room" };
	const personaSessionId = await bindPersonaSession(f, originKey(personaOrigin));
	await bindPersonaSession(f, rootKey);
	createMonitor(f, { origin: monitorTargetOrigin });
	const conversation = await captureParentLog(() => startLane(f, "from-chat", personaSessionId));
	const terminal = await captureParentLog(() => startLane(f, "from-terminal"));
	expect([...conversation.lines, ...terminal.lines]).toEqual([
		"work_parent_resolved verb=start name=from-chat source=session kind=persona",
		"work_parent_resolved verb=start name=from-terminal source=owner kind=persona",
	]);
	await settleLane(f, conversation.value.result.opRef, "chat result");
	await settleLane(f, terminal.value.result.opRef, "terminal result");
	expect(f.database.work.workAttemptGet(conversation.value.result.opRef)!.parent).toMatchObject({
		kind: "persona",
		originKey: originKey(personaOrigin),
	});
	expect(f.database.work.workAttemptGet(terminal.value.result.opRef)!.parent).toMatchObject({
		kind: "persona",
		originKey: rootKey,
	});
	const reports = await eventually(
		() => f.port.sends.filter((send) => send.text.includes("[Internal report from another Gajae session")),
		(items) => items.length === 2,
		"conversation and owner report turns",
	);
	for (const report of reports) await silencePersona(f, report.opRef);
});

test("AC-E work.start from a lane is refused by default before bind, send, or job creation", async () => {
	const f = await fixture();
	const parent = await startLane(f, "parent-lane");
	const binds = f.port.binds.length;
	const sends = f.port.sendAttempts.length;
	const response = await startLane(f, "refused-child", parent.result.sessionId);
	expect(response.error).toMatchObject({
		code: "unauthorized",
		detail: { reasonCode: "nested_lane_forbidden", verb: "start" },
	});
	expect(f.port.binds).toHaveLength(binds);
	expect(f.port.sendAttempts).toHaveLength(sends);
	expect(f.database.work.laneJobJson("lanejob-" + Buffer.from("refused-child").toString("hex"))).toBeUndefined();
});

test("AC-E work.run from a lane is refused before bind or waiter creation", async () => {
	const f = await fixture();
	const parent = await startLane(f, "run-parent");
	const binds = f.port.binds.length;
	const sends = f.port.sendAttempts.length;
	const response = await f.client.request("work.run", {
		name: "run-child",
		text: "response only",
		cwd: f.home,
		callerSessionId: parent.result.sessionId,
	});
	expect(response.error).toMatchObject({
		code: "unauthorized",
		detail: { reasonCode: "nested_lane_forbidden", verb: "run" },
	});
	expect(f.port.binds).toHaveLength(binds);
	expect(f.port.sendAttempts).toHaveLength(sends);
	expect(f.database.work.laneJobJson(`lanejob-${Buffer.from("run-child").toString("hex")}`)).toBeUndefined();
});

test("AC-E allowed nested work.run remains response-only", async () => {
	const f = await fixture({ allowNested: true });
	const parent = await startLane(f, "run-parent");
	const responsePromise = f.client.request("work.run", {
		name: "run-child",
		text: "response only",
		cwd: f.home,
		callerSessionId: parent.result.sessionId,
	});
	await eventually(
		() => f.port.sends,
		(sends) => sends.length === 2,
		"nested run send",
	);
	const run = f.port.sends[1]!;
	f.port.complete(run.opRef, "response result");
	const response = await responsePromise;
	expect(response.error).toBeUndefined();
	expect(response.result.text).toBe("response result");
	expect(f.database.work.workAttemptGet(run.opRef)).toMatchObject({ mode: "run", parent: null, decision: "no_target" });
	expect(f.database.work.laneReportsByParent("run-parent")).toEqual([]);
	expect(f.database.outbox.rows()).toEqual([]);
	expect(chatMessages(f)).toHaveLength(0);
});

test("AC-F no sessions row falls back with one ledger row and one chat.message", async () => {
	const f = await fixture();
	const lane = await startLane(f, "fallback-worker");
	await settleLane(f, lane.result.opRef, "fallback body");
	const runtime = f.database.work.workAttemptGet(lane.result.opRef)!;
	expect(runtime.decision).toBe("fallback");
	expect(f.database.outbox.rows()).toHaveLength(1);
	expect(f.database.outbox.rows()[0]?.delivery_id).toBe(runtime.deliveryId);
	expect(f.database.outbox.rows()[0]?.origin_key).toBe(rootKey);
	await eventually(
		() => chatMessages(f),
		(messages) => messages.length === 1,
		"fallback post",
	);
	expect(chatMessages(f)[0]?.payload.text).toBe("[lane fallback-worker] completed: fallback body");
	await f.client.request("work.status", { name: "fallback-worker" });
	expect(f.database.outbox.rows()).toHaveLength(1);
	expect(chatMessages(f)).toHaveLength(1);
});

test("AC-F conflicting inbound id selects fallback atomically", async () => {
	const f = await fixture();
	await bindPersonaSession(f, rootKey);
	const lane = await startLane(f, "conflict-worker");
	const runtime = f.database.work.workAttemptGet(lane.result.opRef)!;
	expect(
		f.database.transaction((tx) =>
			f.database.inbox.enqueue(tx, {
				messageId: runtime.reportId,
				originKey: rootKey,
				originRefJson: JSON.stringify(rootOrigin),
				body: "conflicting platform id",
				source: "platform",
			}),
		),
	).toBe(true);
	await settleLane(f, lane.result.opRef, "conflict fallback");
	expect(f.database.work.workAttemptGet(lane.result.opRef)?.decision).toBe("fallback");
	expect(f.database.outbox.rows()).toHaveLength(1);
	expect(f.database.outbox.rows()[0]?.delivery_id).toBe(runtime.deliveryId);
	expect(f.database.inbox.pendingOldest(rootKey)).toMatchObject({ message_id: runtime.reportId, source: "platform" });
});

test("AC-F a quarantined nonterminal persona turn rejects report admission", async () => {
	const origin: OriginRef = { platform: "discord", kind: "channel", conversationId: "quarantined-parent" };
	const key = originKey(origin);
	const f = await fixture({
		ownerTarget: origin,
		channels: { "quarantined-parent": { engagement: "open", audience: "all" } },
	});
	const personaSessionId = await bindPersonaSession(f, key);
	f.database.transaction((tx) =>
		f.database.inbox.enqueue(tx, {
			messageId: "quarantine-human",
			originKey: key,
			originRefJson: JSON.stringify(origin),
			body: "nonterminal parent turn",
		}),
	);
	f.database.transaction((tx) =>
		f.database.inbox.bindTurn(tx, {
			messageId: "quarantine-human",
			originKey: key,
			epoch: 0,
			opRef: "gw-quarantined-persona-turn",
			sessionId: personaSessionId,
		}),
	);
	f.database.transaction((tx) => f.database.inbox.turnAccept(tx, "gw-quarantined-persona-turn"));
	const raw = new Database(join(f.home, "gateway.db"));
	try {
		raw
			.query("INSERT INTO broker_quarantine(kind, subject_id, cutover_id) VALUES ('inbound', ?, 'test-cutover')")
			.run("quarantine-human");
	} finally {
		raw.close();
	}
	const lane = await startLane(f, "quarantine-worker", personaSessionId);
	await settleLane(f, lane.result.opRef, "held report");
	expect(f.database.work.workAttemptGet(lane.result.opRef)?.decision).toBe("fallback");
	expect(f.database.outbox.rows()).toHaveLength(1);
	expect(f.database.inbox.turnRow("gw-quarantined-persona-turn")).toMatchObject({
		message_id: "quarantine-human",
		turn_state: "accepted",
	});
});

for (const reset of ["/new", "rebindEpoch"] as const) {
	test(`AC-I lane report follows origin after ${reset}`, async () => {
		const f = await fixture({ channels: { "parent-channel": { engagement: "open", audience: "all" } } });
		const persona = await startPersonaTurn(f, rootOrigin, `epoch-human-${reset}`);
		f.port.complete(persona.opRef, "initial response");
		await eventually(
			() => f.database.inbox.turnRow(persona.opRef),
			(row) => row?.turn_state === "done",
			"initial persona turn did not settle",
		);
		const lane = await startLane(f, `epoch-worker-${reset === "/new" ? "new" : "rebind"}`, persona.sessionId);
		if (reset === "/new") {
			const command = await f.client.request("chat.send", {
				origin: rootOrigin,
				text: "/new",
				messageId: `reset-${reset}`,
				engagement: { mentioned: true, group: true, authorId: "human-1" },
			});
			expect(command.error).toBeUndefined();
		} else {
			f.database.transaction((tx) => f.database.bindings.rotateEpoch(tx, rootKey));
		}
		const afterReset = f.database.bindings.getSessionRecord(rootKey)!;
		expect(afterReset.sessionId).toBe("");
		await settleLane(f, lane.result.opRef, "follows origin");
		const reportId = f.database.work.workAttemptGet(lane.result.opRef)!.reportId;
		const internalSend = await eventually(
			() => f.port.sends,
			(sends) => Boolean(sends.find((send) => send.text.includes("[Internal report from another Gajae session"))),
			"report was not sent to the rebound persona session",
		);
		const reportSend = internalSend.find((send) => send.text.includes("[Internal report from another Gajae session"))!;
		expect(reportSend.sessionId).not.toBe(persona.sessionId);
		expect(f.database.bindings.getSessionRecord(rootKey)?.epoch).toBe(afterReset.epoch);
		expect(f.database.inbox.turnRows(reportSend.opRef)).toMatchObject([
			expect.objectContaining({ message_id: reportId, source: "lane_report", origin_key: rootKey }),
		]);
		expect(f.database.work.workAttemptGet(lane.result.opRef)?.decision).toBe("reported");
		await silencePersona(f, reportSend.opRef);
	});
}

test("AC-J closed channel admits an internal report without engagement", async () => {
	const origin: OriginRef = { platform: "discord", kind: "channel", conversationId: "closed-channel" };
	const key = originKey(origin);
	const f = await fixture({
		ownerTarget: origin,
		channels: { "closed-channel": { engagement: "closed", audience: "all" } },
	});
	await bindPersonaSession(f, key);
	const lane = await startLane(f, "closed-worker");
	await settleLane(f, lane.result.opRef, "closed report");
	const reportId = f.database.work.workAttemptGet(lane.result.opRef)!.reportId;
	const sends = await eventually(
		() => f.port.sends,
		(items) => items.some((send) => send.text.includes("[Internal report from another Gajae session")),
		"closed channel did not admit internal report",
	);
	const reportSend = sends.find((send) => send.text.includes("[Internal report from another Gajae session"))!;
	expect(f.database.inbox.turnRows(reportSend.opRef)).toMatchObject([
		expect.objectContaining({ message_id: reportId, source: "lane_report", origin_key: key }),
	]);
	expect(f.database.work.workAttemptGet(lane.result.opRef)?.decision).toBe("reported");
	await silencePersona(f, reportSend.opRef);
});

test("AC-J mention-open internal report does not alter botAudience state", async () => {
	const origin: OriginRef = { platform: "discord", kind: "channel", conversationId: "mention-open-channel" };
	const key = originKey(origin);
	const f = await fixture({
		ownerTarget: origin,
		channels: { "mention-open-channel": { engagement: "mention-open", audience: "all" } },
	});
	await bindPersonaSession(f, key);
	const stateKey = `bot-audience-state:${key}`;
	f.database.core.metaSet(stateKey, JSON.stringify({ admissions: ["existing-human-admission"], count: 1 }));
	const before = f.database.core.metaGet(stateKey);
	const lane = await startLane(f, "mention-open-worker");
	await settleLane(f, lane.result.opRef, "mention-open report");
	const sends = await eventually(
		() => f.port.sends,
		(items) => items.some((send) => send.text.includes("[Internal report from another Gajae session")),
		"mention-open channel did not admit internal report",
	);
	expect(f.database.core.metaGet(stateKey)).toBe(before);
	const reportSend = sends.find((send) => send.text.includes("[Internal report from another Gajae session"))!;
	await silencePersona(f, reportSend.opRef);
});

test("AC-J chat.send and chat.edit reject internal report ids", async () => {
	const f = await fixture();
	for (const messageId of ["lane-report-forbidden", "monitor-report:forbidden"]) {
		const send = await f.client.request("chat.send", {
			origin: rootOrigin,
			messageId,
			text: "forged internal row",
			engagement: { mentioned: true, group: true, authorId: "human-1" },
		});
		expect(send.error).toMatchObject({ code: "invalid_params" });
		const edit = await f.client.request("chat.edit", {
			origin: rootOrigin,
			messageId,
			text: "forged edit",
			engagement: { mentioned: true, group: true, authorId: "human-1" },
		});
		expect(edit.error).toMatchObject({ code: "invalid_params" });
	}
	expect(f.database.inbox.pendingCount(rootKey)).toBe(0);
	const humanCount = f.database.core.metaGet(`bot-audience-state:${rootKey}`);
	expect(humanCount).toBeUndefined();
});

test("A03 callerSessionId is an untrusted routing hint on the owner-trusted socket", async () => {
	const f = await fixture({ ownerTarget: false });
	const sessionId = crypto.randomUUID();
	const authority = f.database.inspectBrokerAuthority().authority;
	if (!authority) throw new Error("test broker authority missing");
	f.database.transaction((tx) =>
		f.database.bindings.recordOwnedBinding(tx, {
			authority,
			sessionId,
			originKey: rootKey,
			epoch: 0,
			repo: join(f.home, "workspace"),
		}),
	);
	const lane = await startLane(f, "spoofed-route", sessionId);
	await settleLane(f, lane.result.opRef, "untrusted hint result");
	const runtime = f.database.work.workAttemptGet(lane.result.opRef)!;
	expect(runtime.parent).toMatchObject({ kind: "persona", originKey: rootKey });
	expect(runtime.decision).toBe("reported");
	const sends = await eventually(
		() => f.port.sends,
		(items) =>
			items.some(
				(send) => send.sessionId === sessionId && send.text.includes("[Internal report from another Gajae session"),
			),
		"known presented caller id did not route to its persona origin",
	);
	const internalReport = sends.find(
		(send) => send.sessionId === sessionId && send.text.includes("[Internal report from another Gajae session"),
	)!;
	await silencePersona(f, internalReport.opRef);
});

// Issue #435: lane report thread routing for channel root origins
test("AC-435 Slack channel root trigger routes lane report to thread", async () => {
	const slackChannelOrigin: OriginRef = { platform: "slack", kind: "channel", conversationId: "C_issue435_slack" };
	const f = await fixture({
		ownerTarget: slackChannelOrigin,
		channels: { "slack:C_issue435_slack": { engagement: "open", audience: "all" } },
	});
	const triggerMessageId = "C_issue435_slack:1700000000.000435";
	const persona = await startPersonaTurn(f, slackChannelOrigin, triggerMessageId);
	const lane = await startLane(f, "ac435-slack-worker", persona.sessionId);
	expect(lane.error).toBeUndefined();
	await settleLane(f, lane.result.opRef, "slack thread result");
	const reportId = f.database.work.workAttemptGet(lane.result.opRef)!.reportId;
	const reportRows = await eventually(
		() => f.database.inbox.turnRows(persona.opRef),
		(rows) => rows.some((row) => row.source === "lane_report" && row.message_id === reportId),
		"lane report row for AC-435 slack",
	);
	const laneReportRow = reportRows.find((row) => row.source === "lane_report" && row.message_id === reportId)!;
	const laneReportOrigin = JSON.parse(laneReportRow.origin_ref_json) as OriginRef;
	expect(laneReportOrigin.kind).toBe("thread");
	expect(laneReportOrigin.platform).toBe("slack");
	expect(laneReportOrigin.conversationId).toBe(triggerMessageId);
	expect(laneReportOrigin.parentId).toBe(slackChannelOrigin.conversationId);
	f.port.complete(persona.opRef, "ack");
});

// A Discord channel message id does not prove that a thread exists.
test("AC-435 Discord channel root trigger keeps the lane report at the channel root", async () => {
	const discordChannelOrigin: OriginRef = { platform: "discord", kind: "channel", conversationId: "discord-ch-435" };
	const f = await fixture({
		ownerTarget: discordChannelOrigin,
		channels: { "discord-ch-435": { engagement: "open", audience: "all" } },
	});
	const triggerMessageId = "discord-trigger-msg-id";
	const persona = await startPersonaTurn(f, discordChannelOrigin, triggerMessageId);
	const lane = await startLane(f, "ac435-discord-worker", persona.sessionId);
	expect(lane.error).toBeUndefined();
	await settleLane(f, lane.result.opRef, "discord thread result");
	const reportId = f.database.work.workAttemptGet(lane.result.opRef)!.reportId;
	const reportRows = await eventually(
		() => f.database.inbox.turnRows(persona.opRef),
		(rows) => rows.some((row) => row.source === "lane_report" && row.message_id === reportId),
		"lane report row for AC-435 discord",
	);
	const laneReportRow = reportRows.find((row) => row.source === "lane_report" && row.message_id === reportId)!;
	const laneReportOrigin = JSON.parse(laneReportRow.origin_ref_json) as OriginRef;
	expect(laneReportOrigin).toEqual(discordChannelOrigin);
	f.port.complete(persona.opRef, "ack");
});

test("AC-455 synthetic lane-report trigger ids stay on the Discord channel origin", () => {
	const discordChannelOrigin: OriginRef = { platform: "discord", kind: "channel", conversationId: "discord-ch-455" };
	const syntheticTriggerMessageId = `lane-report-${"0123456789abcdef".repeat(4)}`;
	const resolvedOriginRefJson = resolveLaneReportOrigin(
		{
			kind: "persona",
			originKey: originKey(discordChannelOrigin),
			origin: discordChannelOrigin,
			triggerMessageId: syntheticTriggerMessageId,
		},
		JSON.stringify(discordChannelOrigin),
	);
	expect(JSON.parse(resolvedOriginRefJson)).toEqual(discordChannelOrigin);
});

test("Discord channel report wakes an idle persona and posts its reply at the channel root", async () => {
	const f = await fixture({ channels: { "parent-channel": { engagement: "open", audience: "all" } } });
	const persona = await startPersonaTurn(f, rootOrigin, "ordinary-channel-message");
	const lane = await startLane(f, "idle-channel-worker", persona.sessionId);
	await silencePersona(f, persona.opRef);
	await settleLane(f, lane.result.opRef, "channel result");
	const reportId = f.database.work.workAttemptGet(lane.result.opRef)!.reportId;
	const sends = await eventually(
		() => f.port.sends,
		(items) => items.some((send) => send.text.includes("[Internal report from another Gajae session")),
		"idle persona report send",
	);
	const reportSend = sends.find((send) => send.text.includes("[Internal report from another Gajae session"))!;
	const reportRow = f.database.inbox.turnRows(reportSend.opRef).find((row) => row.message_id === reportId)!;
	expect(JSON.parse(reportRow.origin_ref_json)).toEqual(rootOrigin);
	f.port.complete(reportSend.opRef, "channel ack");
	await eventually(
		() => chatMessages(f),
		(items) => items.length === 1,
		"channel reply post",
	);
	expect(chatMessages(f)[0]?.payload.origin).toEqual(rootOrigin);
	expect(chatMessages(f)[0]?.payload.text).toBe("channel ack");
});

for (const visibility of ["public", "private", undefined] as const) {
	test(`Discord ${visibility ?? "unknown"} thread report preserves its admitted origin`, () => {
		const origin: OriginRef = {
			platform: "discord",
			kind: "thread",
			conversationId: "real-thread",
			parentId: "parent-channel",
			...(visibility ? { threadVisibility: visibility } : {}),
		};
		const json = JSON.stringify(origin);
		expect(
			resolveLaneReportOrigin(
				{ kind: "persona", originKey: originKey(origin), origin, triggerMessageId: "thread-message" },
				json,
			),
		).toBe(json);
	});
}

test("Slack channel report rejects a trigger message from a different channel", () => {
	const origin: OriginRef = { platform: "slack", kind: "channel", conversationId: "C1" };
	const json = JSON.stringify(origin);
	expect(
		resolveLaneReportOrigin(
			{ kind: "persona", originKey: originKey(origin), origin, triggerMessageId: "C2:1700000000.000001" },
			json,
		),
	).toBe(json);
});

for (const source of ["public", "private", "unknown", "auto-created"] as const) {
	for (const state of ["idle", "idle-at-start", "busy"] as const) {
		test(`Discord ${source} thread work report stays in the same thread with ${state} persona`, async () => {
			const channelId = "parent-channel";
			const threadId = "actual-thread";
			const messageId = "trigger-message";
			const origin =
				source === "auto-created"
					? await maybeCreateThreadOnMention(
							{
								id: messageId,
								content: "<@bot> investigate",
								author: { id: "human-1" },
								channel: { id: channelId },
								startThread: async () => ({ id: threadId }),
							} as Parameters<typeof maybeCreateThreadOnMention>[0],
							{ mentioned: true, group: true, authorId: "human-1" },
							{ platform: "discord", kind: "channel", conversationId: channelId },
							undefined,
							new UnnamedThreads(),
						)
					: discordMessageOrigin({
							author: { id: "human-1" },
							channel: {
								id: threadId,
								parentId: channelId,
								isThread: () => true,
								...(source === "unknown" ? {} : { type: source === "public" ? 11 : 12 }),
							},
						});
			const f = await fixture({ channels: { [channelId]: { engagement: "open", audience: "all" } } });
			// Keep a real channel persona present: selecting it would disclose the report.
			const channelPersona = await startPersonaTurn(f, rootOrigin, "channel-request");
			await silencePersona(f, channelPersona.opRef);
			const persona = await startPersonaTurn(f, origin, messageId);
			if (state === "idle-at-start") await silencePersona(f, persona.opRef);
			const lane = await startLane(f, "thread-worker", persona.sessionId);
			expect(lane.error).toBeUndefined();
			const runtime = f.database.work.workAttemptGet(lane.result.opRef)!;
			expect(runtime.parent).toEqual({
				kind: "persona",
				originKey: originKey(origin),
				origin,
				...(state === "idle-at-start" ? {} : { triggerMessageId: messageId }),
			});
			if (state === "idle") await silencePersona(f, persona.opRef);
			await settleLane(f, lane.result.opRef, "thread-only result");
			let replyOpRef = persona.opRef;
			if (state !== "busy") {
				const sends = await eventually(
					() => f.port.sends,
					(items) => items.some((send) => send.text.includes("[Internal report from another Gajae session")),
					"thread persona wake",
				);
				const reportSend = sends.find((send) => send.text.includes("[Internal report from another Gajae session"))!;
				expect(reportSend.sessionId).toBe(persona.sessionId);
				replyOpRef = reportSend.opRef;
			}
			const rows = await eventually(
				() => f.database.inbox.turnRows(replyOpRef),
				(items) => items.some((row) => row.message_id === runtime.reportId),
				"thread report inbox row",
			);
			const reportRow = rows.find((row) => row.message_id === runtime.reportId)!;
			expect(reportRow.origin_key).toBe(originKey(origin));
			expect(JSON.parse(reportRow.origin_ref_json)).toEqual(origin);
			if (state === "busy") {
				expect(reportRow.turn_role).toBe("steer");
				expect(f.port.steers).toHaveLength(1);
				expect(f.port.steers[0]?.text).toContain("Internal report that arrived while you were working");
			}
			expect(f.database.inbox.turnRows(channelPersona.opRef).some((row) => row.source === "lane_report")).toBe(false);
			expect(chatMessages(f)).toHaveLength(0);
			f.port.complete(replyOpRef, "thread result acknowledged");
			await eventually(
				() => chatMessages(f),
				(items) => items.length === 1,
				"thread reply delivery",
			);
			const payload = chatMessages(f)[0]!.payload;
			expect(payload.origin).toEqual(origin);
			const fetched: string[] = [];
			const sent: Array<[string, unknown]> = [];
			const confirmed: string[] = [];
			await settleDiscordDelivery(
				{
					request: async <T>(verb: string) => {
						confirmed.push(verb);
						return {} as T;
					},
				},
				{
					channels: {
						fetch: async (id: string) => {
							fetched.push(id);
							return { send: async (body: unknown) => void sent.push([id, body]) };
						},
					},
				},
				payload,
			);
			expect(fetched).toEqual([threadId]);
			expect(sent).toHaveLength(1);
			expect(sent[0]?.[0]).toBe(threadId);
			expect(confirmed).toEqual(["delivery.confirm"]);
		});
	}
}

for (const ownerTarget of [false, rootOrigin] as const) {
	for (const state of ["busy", "idle"] as const) {
		test(`Slack report-woken follow-up keeps channel parent with ${state} persona and ${ownerTarget ? "different" : "no"} owner`, async () => {
			const origin: OriginRef = { platform: "slack", kind: "channel", conversationId: "C_followup" };
			const f = await fixture({
				ownerTarget,
				channels: { "slack:C_followup": { engagement: "open", audience: "all" } },
			});
			const persona = await startPersonaTurn(f, origin, "C_followup:1700000000.000001");
			const lane = await startLane(f, "slack-first", persona.sessionId);
			await silencePersona(f, persona.opRef);
			await settleLane(f, lane.result.opRef, "first report");
			const sends = await eventually(
				() => f.port.sends,
				(items) => items.some((send) => send.text.includes("[Internal report from another Gajae session")),
				"Slack report wake",
			);
			const report = sends.find((send) => send.text.includes("[Internal report from another Gajae session"))!;
			expect(report.sessionId).toBe(persona.sessionId);
			const reportRow = f.database.inbox.turnRow(report.opRef)!;
			expect(JSON.parse(reportRow.origin_ref_json)).toMatchObject({ kind: "thread", parentId: "C_followup" });
			if (state === "idle") await silencePersona(f, report.opRef);
			const followup = await startLane(f, "slack-followup", report.sessionId);
			expect(followup.error).toBeUndefined();
			expect(f.database.work.workAttemptGet(followup.result.opRef)?.parent).toEqual({
				kind: "persona",
				originKey: originKey(origin),
				origin,
				...(state === "busy" ? { triggerMessageId: reportRow.message_id } : {}),
			});
			if (state === "busy") await silencePersona(f, report.opRef);
			await settleLane(f, followup.result.opRef, "[SILENT]");
		});
	}
}

for (const type of [12, undefined] as const) {
	test(`Discord ${type === 12 ? "private" : "unknown"} thread fallback fails closed when missing`, async () => {
		const origin = discordMessageOrigin({
			author: { id: "human-1" },
			channel: {
				id: "missing-thread",
				parentId: "parent-channel",
				isThread: () => true,
				type,
			},
		});
		const f = await fixture({ channels: { "parent-channel": { engagement: "open", audience: "all" } } });
		const persona = await startPersonaTurn(f, origin, "thread-trigger");
		const lane = await startLane(f, "thread-fallback", persona.sessionId);
		await silencePersona(f, persona.opRef);
		const runtime = f.database.work.workAttemptGet(lane.result.opRef)!;
		// An occupied inbound id refuses report admission and exercises direct fallback delivery.
		f.database.transaction((tx) =>
			f.database.inbox.enqueue(tx, {
				messageId: runtime.reportId,
				originKey: originKey(origin),
				originRefJson: JSON.stringify(origin),
				body: "conflicting platform message",
				source: "platform",
			}),
		);
		await settleLane(f, lane.result.opRef, "private result");
		expect(f.database.work.workAttemptGet(lane.result.opRef)?.decision).toBe("fallback");
		await eventually(
			() => chatMessages(f),
			(items) => items.length === 1,
			"thread fallback delivery",
		);
		const payload = chatMessages(f)[0]!.payload;
		expect(payload.origin).toEqual(origin);
		const fetched: string[] = [];
		const sent: unknown[] = [];
		const settlements: string[] = [];
		await settleDiscordDelivery(
			{
				request: async <T>(verb: string) => {
					settlements.push(verb);
					return {} as T;
				},
			},
			{
				channels: {
					fetch: async (id: string) => {
						fetched.push(id);
						if (id === origin.conversationId) throw Object.assign(new Error("Unknown Channel"), { code: 10003 });
						return { send: async (body: unknown) => void sent.push(body) };
					},
				},
			},
			payload,
		);
		expect(fetched).toEqual([origin.conversationId]);
		expect(sent).toEqual([]);
		expect(settlements).toEqual(["delivery.fail"]);
	});
}
