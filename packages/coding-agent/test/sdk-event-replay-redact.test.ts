import { describe, expect, test } from "bun:test";
import { SessionEventStream, SessionSdkHost, setSessionOutboundRedact } from "../src/sdk/host";

const MARKER = "PLAINTEXT_REPLAY_MARKER";
const REDACTED_KINDS = [
	"turn_stream",
	"context_update",
	"image_attachment",
	"file_attachment",
	"reasoning_summary",
	"tool_activity",
] as const;

function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(1664525, state) + 1013904223) >>> 0;
		return state;
	};
}

describe("session event replay redaction", () => {
	test("property: session id capture, seed 516, 64 inputs", () => {
		const next = mulberry32(516);
		const alphabet = "abcdefghijklmnopqrstuvwxyz";
		const genId = (): string => {
			let id = "s";
			const length = 1 + (next() % 8);
			for (let n = 0; n < length; n++) id += alphabet[next() % alphabet.length]!;
			return id;
		};
		const reference = (frame: Record<string, unknown>): string | undefined => {
			if (typeof frame.sessionId === "string") return frame.sessionId;
			const payload = frame.payload;
			if (!payload || typeof payload !== "object") return undefined;
			const sessionId = (payload as { sessionId?: unknown }).sessionId;
			return typeof sessionId === "string" ? sessionId : undefined;
		};
		const withheld = (stream: SessionEventStream): boolean =>
			!stream.replay(0).events.some(event => event.kind === "turn_stream");
		for (let i = 0; i < 64; i++) {
			const mode = next() % 7;
			const top = genId();
			const nested = genId();
			const frame: Record<string, unknown> = { kind: "activity", payload: { state: "idle" } };
			if (mode === 0) frame.sessionId = top;
			else if (mode === 1) frame.payload = { state: "idle", sessionId: nested };
			else if (mode === 2) {
				frame.sessionId = top;
				frame.payload = { state: "idle", sessionId: nested };
			} else if (mode === 3) frame.sessionId = null;
			else if (mode === 4) frame.sessionId = next() % 1000;
			else if (mode === 5) frame.payload = { state: "idle", sessionId: null };
			else frame.payload = null;
			const expected = reference(frame);
			const stream = new SessionEventStream();
			stream.emit(frame);
			stream.emit({ kind: "turn_stream", payload: { text: MARKER } });
			const other = `${expected ?? "none"}-other-${i}`;
			setSessionOutboundRedact(other, true);
			expect(withheld(stream)).toBe(false);
			if (expected !== undefined) {
				setSessionOutboundRedact(expected, true);
				expect(withheld(stream)).toBe(true);
				const once = stream.replay(0).events.map(event => String(event.kind));
				expect(stream.replay(0).events.map(event => String(event.kind))).toEqual(once);
				setSessionOutboundRedact(expected, false);
				expect(withheld(stream)).toBe(false);
			}
			setSessionOutboundRedact(other, false);
			if (expected !== undefined) setSessionOutboundRedact(expected, false);
		}
	});

	test("property: replay kind filter, seed 516, 64 inputs", () => {
		const next = mulberry32(516);
		const alphabet = "abcdefghijklmnopqrstuvwxyz_";
		const kinds: string[] = [];
		for (let i = 0; i < 64; i++) {
			const length = 1 + (next() % 16);
			let kind = "";
			for (let n = 0; n < length; n++) kind += alphabet[next() % alphabet.length]!;
			kinds.push(kind);
		}
		for (const kind of REDACTED_KINDS) kinds.push(kind);
		const stream = new SessionEventStream({ ringSize: 256 });
		for (const kind of kinds) stream.emit({ kind, payload: { text: MARKER } });
		expect(stream.replay(0).events.map(event => String(event.kind))).toEqual(kinds);
		stream.setOutboundRedact(true);
		const hidden = new Set<string>(REDACTED_KINDS);
		const kept = kinds.filter(kind => !hidden.has(kind));
		expect(stream.replay(0).events.map(event => String(event.kind))).toEqual(kept);
		expect(stream.replay(0).events.map(event => String(event.kind))).toEqual(kept);
		stream.setOutboundRedact(false);
		expect(stream.replay(0).events.map(event => String(event.kind))).toEqual(kinds);
	});

	test("config_update and session policy both withhold stored plaintext", () => {
		const stream = new SessionEventStream();
		stream.emit({ name: "session_ready", sessionId: "policy-session" });
		stream.emit({ kind: "turn_stream", payload: { text: MARKER } });
		stream.emit({ kind: "activity", payload: { state: "idle" } });
		setSessionOutboundRedact("policy-session", true);
		expect(stream.replay(0).events.map(event => event.kind)).not.toContain("turn_stream");
		expect(stream.replay(0).events.map(event => event.kind)).toContain("activity");
		setSessionOutboundRedact("policy-session", false);
		expect(stream.replay(0).events.map(event => event.kind)).toContain("turn_stream");
		stream.emit({ kind: "config_update", payload: { type: "config_update", redact: true } });
		expect(stream.replay(0).events.map(event => event.kind)).not.toContain("turn_stream");
		expect(JSON.stringify(stream.replay(0).events)).not.toContain(MARKER);
		setSessionOutboundRedact("policy-session", false);
	});

	test("a generation reset replay withholds the same redacted kinds", () => {
		const stream = new SessionEventStream();
		stream.emit({ kind: "turn_stream", payload: { text: MARKER } });
		stream.emit({ kind: "activity", payload: { state: "idle" } });
		stream.setOutboundRedact(true);
		const replay = stream.replay(0, stream.generation + 1);
		expect(replay.gap?.kind).toBe("generation_reset");
		expect(replay.events.map(event => event.kind)).toEqual(["activity"]);
		expect(JSON.stringify(replay.events)).not.toContain(MARKER);
	});

	test("event_replay withholds stored plaintext after redaction and keeps activity", async () => {
		let receive!: (connectionId: string, frame: Record<string, unknown>) => void;
		const sent: Array<Record<string, unknown>> = [];
		const host = new SessionSdkHost({
			sessionId: "replay-redact",
			stateRoot: "/tmp/replay-redact",
			token: "token",
			sendFrame: (_connectionId, frame) => {
				sent.push(frame);
				return "written";
			},
			onFrame: handler => {
				receive = handler;
				return () => {};
			},
		});
		await host.start();
		try {
			host.emitEvent({ kind: "turn_stream", payload: { type: "turn_stream", text: MARKER } });
			host.emitEvent({
				kind: "context_update",
				payload: { type: "context_update", cwd: "secret-dir", diff: "secret.diff" },
			});
			host.emitEvent({ kind: "activity", payload: { type: "activity", state: "idle" } });
			const kindsOf = async (id: string): Promise<string[]> => {
				receive("client", { type: "event_replay", id, sinceSeq: 0 });
				await Bun.sleep(0);
				const frame = sent.at(-1)!;
				expect(frame.type).toBe("event_replay_result");
				expect(frame.ok).toBe(true);
				return (frame.events as Array<{ kind: string }>).map(event => event.kind);
			};
			const open = await kindsOf("open");
			expect(open).toContain("turn_stream");
			expect(open).toContain("context_update");
			expect(open).toContain("activity");
			host.events.setOutboundRedact(true);
			const closed = await kindsOf("closed");
			expect(closed).not.toContain("turn_stream");
			expect(closed).not.toContain("context_update");
			expect(closed).toContain("activity");
			const body = JSON.stringify(sent.at(-1));
			expect(body).not.toContain(MARKER);
			expect(body).not.toContain("secret.diff");
		} finally {
			host.events.setOutboundRedact(false);
			await host.stop();
		}
	});
});
