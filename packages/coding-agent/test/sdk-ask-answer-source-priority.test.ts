import { describe, expect, it } from "bun:test";
import { getAskAnswerSource, registerAskAnswerSource } from "@gajae-code/coding-agent/tools/ask-answer-registry";

describe("ask answer source priority", () => {
	it("selects the protocol source when it registers after an interactive source", () => {
		const sessionId = "priority-protocol-after-interactive";
		const interactive = { awaitAnswer: async () => undefined };
		const protocol = { awaitAnswer: async () => undefined };
		const disposeInteractive = registerAskAnswerSource(sessionId, interactive, "interactive");
		const disposeProtocol = registerAskAnswerSource(sessionId, protocol, "protocol");

		try {
			expect(getAskAnswerSource(sessionId)).toBe(protocol);
		} finally {
			disposeProtocol();
			disposeInteractive();
		}
	});

	it("selects the protocol source when an interactive source registers later", () => {
		const sessionId = "priority-interactive-after-protocol";
		const protocol = { awaitAnswer: async () => undefined };
		const interactive = { awaitAnswer: async () => undefined };
		const disposeProtocol = registerAskAnswerSource(sessionId, protocol, "protocol");
		const disposeInteractive = registerAskAnswerSource(sessionId, interactive, "interactive");

		try {
			expect(getAskAnswerSource(sessionId)).toBe(protocol);
		} finally {
			disposeInteractive();
			disposeProtocol();
		}
	});

	it("falls back to the interactive source after disposing the protocol source", () => {
		const sessionId = "priority-protocol-disposal";
		const protocol = { awaitAnswer: async () => undefined };
		const interactive = { awaitAnswer: async () => undefined };
		const disposeProtocol = registerAskAnswerSource(sessionId, protocol, "protocol");
		const disposeInteractive = registerAskAnswerSource(sessionId, interactive, "interactive");

		try {
			disposeProtocol();
			expect(getAskAnswerSource(sessionId)).toBe(interactive);
		} finally {
			disposeProtocol();
			disposeInteractive();
		}
	});

	it("keeps a protocol source ahead of a legacy two-argument interactive registration", () => {
		const sessionId = "priority-legacy-interactive";
		const protocol = { awaitAnswer: async () => undefined };
		const legacyInteractive = { awaitAnswer: async () => undefined };
		const disposeProtocol = registerAskAnswerSource(sessionId, protocol, "protocol");
		const disposeLegacyInteractive = registerAskAnswerSource(sessionId, legacyInteractive);

		try {
			expect(getAskAnswerSource(sessionId)).toBe(protocol);
			disposeProtocol();
			expect(getAskAnswerSource(sessionId)).toBe(legacyInteractive);
		} finally {
			disposeProtocol();
			disposeLegacyInteractive();
		}
	});

	it("selects the most recently registered protocol source", () => {
		const sessionId = "priority-protocol-lifo";
		const firstProtocol = { awaitAnswer: async () => undefined };
		const secondProtocol = { awaitAnswer: async () => undefined };
		const disposeFirst = registerAskAnswerSource(sessionId, firstProtocol, "protocol");
		const disposeSecond = registerAskAnswerSource(sessionId, secondProtocol, "protocol");

		try {
			expect(getAskAnswerSource(sessionId)).toBe(secondProtocol);
		} finally {
			disposeSecond();
			disposeFirst();
		}
	});

	it("returns undefined when no source is registered", () => {
		expect(getAskAnswerSource("priority-empty")).toBeUndefined();
	});
});
