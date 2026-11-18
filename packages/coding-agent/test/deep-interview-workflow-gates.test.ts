import { describe, expect, it } from "bun:test";
import { decodeAskGateV1 } from "../src/coordinator-mcp/question-gate-codec";
import {
	type AskGateQuestion,
	buildAskGateAnswerSchema,
	classifyAskGateDisposition,
	DeepInterviewGateError,
	gateAnswerToResult,
	questionsToGates,
	questionToGate,
} from "../src/modes/shared/agent-wire/deep-interview-gate";
import {
	type GateContinuation,
	MemoryGateStore,
	WorkflowGateBroker,
} from "../src/modes/shared/agent-wire/workflow-gate-broker";
import { compileGateSchema, schemaHash, validateGateAnswer } from "../src/modes/shared/agent-wire/workflow-gate-schema";

function activeContinuation(): GateContinuation {
	let active = true;
	return {
		activate: () => {},
		terminalProof: "not_published",
		isLive: () => active,
		release: () => {
			active = false;
		},
	};
}

const singleQ: AskGateQuestion = {
	id: "q1",
	question: "Which auth method?",
	options: [{ label: "JWT" }, { label: "OAuth2" }, { label: "Session cookies" }],
	recommended: 0,
};

const multiQ: AskGateQuestion = {
	id: "q2",
	question: "Which storages?",
	options: [{ label: "SQLite" }, { label: "Postgres" }],
	multi: true,
};

describe("questionToGate", () => {
	it("emits a deep-interview question gate with option set + free-text schema", () => {
		const gate = questionToGate(singleQ);
		expect(gate.stage).toBe("deep-interview");
		expect(gate.kind).toBe("question");
		expect(gate.options).toEqual([
			{ value: { selected: ["JWT"] }, label: "JWT", description: "recommended" },
			{ value: { selected: ["OAuth2"] }, label: "OAuth2", description: undefined },
			{ value: { selected: ["Session cookies"] }, label: "Session cookies", description: undefined },
		]);
		const compiled = compileGateSchema(gate.schema);
		for (const option of gate.options ?? []) {
			expect(validateGateAnswer(compiled, "question", option.value)).toBeNull();
			expect(gateAnswerToResult(singleQ, option.value)).toEqual({
				id: "q1",
				question: singleQ.question,
				options: ["JWT", "OAuth2", "Session cookies"],
				multi: false,
				selectedOptions: [option.label],
				customInput: undefined,
			});
			expect(classifyAskGateDisposition(gate, option.value)).toBe("commit");
			expect(validateGateAnswer(compiled, "question", option.label)?.code).toBe("invalid_workflow_gate_answer");
		}
		// schema is the documented subset and accepts answers or clarification.
		expect(gate.schema.properties?.selected?.items?.enum).toEqual(["JWT", "OAuth2", "Session cookies"]);
		expect(gate.schema.properties?.other?.type).toBe("boolean");
		expect(gate.schema.properties?.action?.enum).toEqual(["answer", "clarify"]);
		expect(gate.schema.properties?.custom?.pattern).toBe("\\S");
		expect(gate.context?.stage_state).toMatchObject({
			question_id: "q1",
			multi: false,
			other_option: "Other (type your own)",
		});
	});

	it("maps a batch with valid single-item multi-select choices and explicit combination answers", () => {
		const gates = questionsToGates([singleQ, multiQ]);
		expect(gates).toEqual([questionToGate(singleQ), questionToGate(multiQ)]);
		const gate = questionToGate(multiQ);
		expect(gate.options?.map(option => option.value)).toEqual([{ selected: ["SQLite"] }, { selected: ["Postgres"] }]);
		const compiled = compileGateSchema(gate.schema);
		for (const option of gate.options ?? []) {
			expect(validateGateAnswer(compiled, "multi", option.value)).toBeNull();
			expect(gateAnswerToResult(multiQ, option.value).selectedOptions).toEqual([option.label]);
			expect(classifyAskGateDisposition(gate, option.value)).toBe("commit");
		}
		const combination = { selected: ["SQLite", "Postgres"] };
		expect(validateGateAnswer(compiled, "multi", combination)).toBeNull();
		expect(gateAnswerToResult(multiQ, combination).selectedOptions).toEqual(["SQLite", "Postgres"]);
		const duplicate = { selected: ["SQLite", "SQLite"] };
		expect(validateGateAnswer(compiled, "multi", duplicate)?.code).toBe("invalid_workflow_gate_answer");
		expect(() => gateAnswerToResult(multiQ, duplicate)).toThrow(/must be unique/);
	});

	it("preserves duplicate labels, recommendation positions, metadata, and reconstruction", () => {
		const question: AskGateQuestion = {
			id: "q-duplicates",
			question: "Round 0 | Topology confirmation | Ambiguity: 0.5",
			options: [{ label: "Same" }, { label: "Other (type your own)" }, { label: "Same" }],
			recommended: 2,
			workflowGate: { stage: "ralplan", kind: "approval" },
			allowEmpty: true,
			navigationLabel: "Next",
		};
		const labels = ["Same", "Other (type your own)", "Same"];
		const gate = questionToGate(question);
		expect(gate.stage).toBe("ralplan");
		expect(gate.kind).toBe("approval");
		expect(gate.options).toEqual([
			{ value: { selected: ["Same"] }, label: "Same", description: undefined },
			{ value: { selected: ["Other (type your own)"] }, label: "Other (type your own)", description: undefined },
			{ value: { selected: ["Same"] }, label: "Same", description: "recommended" },
		]);
		expect(gate.context).toEqual({
			title: question.question,
			prompt: question.question,
			stage_state: {
				question_id: "q-duplicates",
				multi: false,
				allow_empty: true,
				options: labels,
				other_option: "Other (type your own)",
				clarification_action: "clarify",
				navigation_label: "Next",
				round: 0,
				mode: "Topology confirmation",
				ambiguity: 0.5,
				topology_gate: true,
			},
		});
		const schema = buildAskGateAnswerSchema({ allowEmpty: true }, labels);
		expect(gate.schema).toEqual(schema);
		expect(schemaHash(gate.schema)).toBe(schemaHash(schema));
		const compiled = compileGateSchema(gate.schema);
		for (const option of gate.options ?? []) {
			expect(validateGateAnswer(compiled, "duplicates", option.value)).toBeNull();
			const result = gateAnswerToResult(question, option.value);
			expect(result.options).toEqual(labels);
			expect(result.selectedOptions).toEqual([option.label]);
			expect(result.customInput).toBeUndefined();
			expect(classifyAskGateDisposition(gate, option.value)).toBe("commit");
		}
	});

	it("keeps skip, custom, clarification, and navigation semantics without fabricated one-click input", () => {
		for (const navigationLabel of ["Next", "Done"] as const) {
			const question: AskGateQuestion = { ...singleQ, allowEmpty: true, navigationLabel };
			const gate = questionToGate(question);
			const compiled = compileGateSchema(gate.schema);
			expect(gate.context?.stage_state?.navigation_label).toBe(navigationLabel);
			expect(gate.options?.map(option => option.value)).toEqual([
				{ selected: ["JWT"] },
				{ selected: ["OAuth2"] },
				{ selected: ["Session cookies"] },
			]);
			for (const [answer, disposition] of [
				[{ selected: [] }, "resolve_without_commit"],
				[{ selected: [], other: true, custom: "Passkeys" }, "commit"],
				[{ action: "clarify", question: "Which is safer?" }, "resolve_without_commit"],
			] as const) {
				expect(validateGateAnswer(compiled, "navigation", answer)).toBeNull();
				expect(classifyAskGateDisposition(gate, answer)).toBe(disposition);
			}
			expect(gateAnswerToResult(question, { selected: [] })).toEqual({
				id: "q1",
				question: singleQ.question,
				options: ["JWT", "OAuth2", "Session cookies"],
				multi: false,
				selectedOptions: [],
			});
		}
		const requiredGate = questionToGate(singleQ);
		expect(validateGateAnswer(compileGateSchema(requiredGate.schema), "required", { selected: [] })?.code).toBe(
			"invalid_workflow_gate_answer",
		);
		expect(() => classifyAskGateDisposition(requiredGate, { selected: [] })).toThrow(/at least one option/);
		const freeTextGate = questionToGate({ ...singleQ, options: [] });
		expect(freeTextGate.options).toEqual([]);
		const custom = { selected: [], other: true, custom: "Passkeys" };
		expect(validateGateAnswer(compileGateSchema(freeTextGate.schema), "free-text", custom)).toBeNull();
		expect(classifyAskGateDisposition(freeTextGate, custom)).toBe("commit");
	});
});

describe("canonical ask options in the coordinator codec", () => {
	it("decodes producer answers without changing option order or recommendations", () => {
		const broker = new WorkflowGateBroker("run-codec", new MemoryGateStore());
		for (const question of [
			singleQ,
			multiQ,
			{ ...singleQ, allowEmpty: true, navigationLabel: "Done" as const },
			{ ...singleQ, options: [] },
			{ ...singleQ, workflowGate: { stage: "ralplan", kind: "approval" } as const },
		]) {
			const gate = broker.openGate(questionToGate(question), activeContinuation());
			expect(decodeAskGateV1(gate)).toEqual({
				schema_version: 1,
				labels: question.options.map(option => option.label),
				recommended_index: question.options.length > 0 ? (question.recommended ?? null) : null,
				multi: question.multi ?? false,
				allow_empty: question.allowEmpty === true,
				other_allowed: true,
				clarification_allowed: true,
			});
		}
	});

	it("rejects primitive, forged, incomplete, or noncanonical choices and schema mismatches", () => {
		const broker = new WorkflowGateBroker("run-codec-forged", new MemoryGateStore());
		const gate = broker.openGate(questionToGate(singleQ), activeContinuation());
		for (const value of [
			"JWT",
			{},
			{ selected: [] },
			{ selected: ["OAuth2"] },
			{ selected: ["JWT", "OAuth2"] },
			{ selected: ["JWT"], other: false },
			{ selected: ["JWT"], custom: "invented" },
			{ action: "clarify", question: "invented" },
		]) {
			expect(
				decodeAskGateV1({
					...gate,
					options: gate.options?.map((option, index) => (index === 0 ? { ...option, value } : option)),
				}),
			).toBeNull();
		}
		expect(decodeAskGateV1({ ...gate, schema: { type: "object" } })).toBeNull();
		expect(
			decodeAskGateV1({
				...gate,
				schema: { type: "object" },
				schema_hash: schemaHash({ type: "object" }),
			}),
		).toBeNull();
		expect(
			decodeAskGateV1({
				...gate,
				context: { ...gate.context, stage_state: { ...gate.context?.stage_state, options: ["OAuth2", "JWT"] } },
			}),
		).toBeNull();
	});
});

describe("gateAnswerToResult (human-path parity)", () => {
	it("decodes a single selection", () => {
		expect(gateAnswerToResult(singleQ, { selected: ["OAuth2"] })).toEqual({
			id: "q1",
			question: "Which auth method?",
			options: ["JWT", "OAuth2", "Session cookies"],
			multi: false,
			selectedOptions: ["OAuth2"],
			customInput: undefined,
		});
	});

	it("decodes multi selections", () => {
		const r = gateAnswerToResult(multiQ, { selected: ["SQLite", "Postgres"] });
		expect(r.selectedOptions).toEqual(["SQLite", "Postgres"]);
		expect(r.multi).toBe(true);
	});

	it("handles the Other free-text option", () => {
		const r = gateAnswerToResult(singleQ, { selected: [], other: true, custom: "Passkeys" });
		expect(r.selectedOptions).toEqual([]);
		expect(r.customInput).toBe("Passkeys");
	});
	it("handles clarification as a non-answer", () => {
		const r = gateAnswerToResult(singleQ, { action: "clarify", question: "How are JWT and OAuth2 different?" });
		expect(r.selectedOptions).toEqual([]);
		expect(r.customInput).toBeUndefined();
		expect(r.clarificationQuestion).toBe("How are JWT and OAuth2 different?");
	});

	it("rejects invalid answers", () => {
		expect(() => gateAnswerToResult(singleQ, { selected: [] })).toThrow(DeepInterviewGateError);
		expect(() => gateAnswerToResult(singleQ, { selected: ["Nope"] })).toThrow(/unknown option/);
		expect(() => gateAnswerToResult(singleQ, { selected: ["JWT", "OAuth2"] })).toThrow(/single selection/);
		expect(() => gateAnswerToResult(singleQ, { selected: [], other: true })).toThrow(/custom text is required/);
		expect(() => gateAnswerToResult(singleQ, { foo: 1 })).toThrow(/answer must be/);
		expect(() => gateAnswerToResult(singleQ, { action: "clarify", question: " \t\n " })).toThrow(
			/clarification question is required/,
		);
		expect(() =>
			gateAnswerToResult(singleQ, { action: "clarify", question: "Which one?", selected: ["JWT"] }),
		).toThrow(/answer must be/);
		expect(() =>
			gateAnswerToResult(singleQ, { action: "clarify", question: "Which one?", selected: [], other: false }),
		).toThrow(/answer must be/);
	});
});

describe("end-to-end via the broker", () => {
	it("emits the question gate and validates the answer against the advertised schema", async () => {
		const advanced: unknown[] = [];
		const broker = new WorkflowGateBroker("run-di", new MemoryGateStore(), {
			advance: (_gate, answer) => {
				advanced.push(answer);
			},
		});
		const gate = broker.openGate(questionToGate(singleQ), activeContinuation());
		expect(broker.listPendingGates()).toEqual([gate]);

		// A schema-invalid answer (selected not an array) is rejected, gate stays pending.
		const bad = await broker.resolve({ gate_id: gate.gate_id, answer: { selected: "OAuth2" } });
		expect(bad.status).toBe("rejected");
		// A schema-invalid single-select answer cannot combine a normal option and Other.
		const combined = await broker.resolve({
			gate_id: gate.gate_id,
			answer: { selected: ["JWT"], other: true, custom: "Passkeys" },
		});
		expect(combined.status).toBe("rejected");
		expect(combined.error?.errors.some(e => e.keyword === "anyOf")).toBe(true);
		const blankOther = await broker.resolve({
			gate_id: gate.gate_id,
			answer: { selected: [], other: true, custom: " \t\n " },
		});
		expect(blankOther.status).toBe("rejected");
		expect(blankOther.error?.errors.some(e => e.keyword === "pattern")).toBe(true);
		const blankClarification = await broker.resolve({
			gate_id: gate.gate_id,
			answer: { action: "clarify", question: " \t\n " },
		});
		expect(blankClarification.status).toBe("rejected");
		expect(blankClarification.error?.errors.some(e => e.keyword === "pattern")).toBe(true);
		// A schema-valid answer is accepted and decodes to the human-path result.
		const answer = gate.options?.[0]?.value;
		expect(answer).toEqual({ selected: ["JWT"] });
		const good = await broker.resolve({ gate_id: gate.gate_id, answer });
		expect(good.status).toBe("accepted");
		expect(advanced).toEqual([{ selected: ["JWT"] }]);
		expect(gateAnswerToResult(singleQ, advanced[0]).selectedOptions).toEqual(["JWT"]);
	});

	it("rejects oversized structured deep-interview Other answers while keeping the gate pending", async () => {
		const advanced: unknown[] = [];
		const broker = new WorkflowGateBroker("run-di-oversized", new MemoryGateStore(), {
			advance: (_gate, answer) => {
				advanced.push(answer);
			},
		});
		const question: AskGateQuestion = {
			...singleQ,
			deepInterview: { round: 1, component: "auth", dimension: "goal", ambiguity: 0.5 },
		};
		const gate = broker.openGate(questionToGate(question), activeContinuation());
		const oversized = await broker.resolve({
			gate_id: gate.gate_id,
			answer: { selected: [], other: true, custom: "한".repeat(10_001) },
		});

		expect(oversized.status).toBe("rejected");
		expect(oversized.error?.errors.some(error => error.keyword === "maxLength")).toBe(true);
		expect(broker.listPendingGates()).toContainEqual(gate);
		expect(advanced).toEqual([]);

		const boundary = await broker.resolve({
			gate_id: gate.gate_id,
			answer: { selected: [], other: true, custom: "한".repeat(10_000) },
		});
		expect(boundary.status).toBe("accepted");
		expect(advanced).toHaveLength(1);
	});

	it("accepts single-select normal selection, Other-only, and clarification paths", async () => {
		const advanced: unknown[] = [];
		const broker = new WorkflowGateBroker("run-di-valid", new MemoryGateStore(), {
			advance: (_gate, answer) => {
				advanced.push(answer);
			},
		});
		const selectionGate = broker.openGate(questionToGate(singleQ), activeContinuation());
		expect(broker.listPendingGates()).toEqual([selectionGate]);

		const selection = await broker.resolve({ gate_id: selectionGate.gate_id, answer: { selected: ["JWT"] } });
		expect(selection.status).toBe("accepted");

		const otherGate = broker.openGate(questionToGate(singleQ), activeContinuation());

		const other = await broker.resolve({
			gate_id: otherGate.gate_id,
			answer: { selected: [], other: true, custom: "Passkeys" },
		});
		expect(other.status).toBe("accepted");

		const clarifyGate = broker.openGate(questionToGate(singleQ), activeContinuation());

		const clarify = await broker.resolve({
			gate_id: clarifyGate.gate_id,
			answer: { action: "clarify", question: "What does OAuth2 imply here?" },
		});
		expect(clarify.status).toBe("accepted");
		expect(advanced).toEqual([
			{ selected: ["JWT"] },
			{ selected: [], other: true, custom: "Passkeys" },
			{ action: "clarify", question: "What does OAuth2 imply here?" },
		]);
	});
});

describe("questionToGate structured deep-interview metadata", () => {
	it("uses structured metadata for stage_state when present", () => {
		const gate = questionToGate({
			id: "q-struct",
			question: "Round 1 | Component: Conflict Detection | Targeting: Goal | Ambiguity: 66%\n\nWhich triggers?",
			options: [{ label: "A only" }, { label: "All four" }],
			deepInterview: {
				round_id: "r-1",
				round: 1,
				component: "conflict-detection",
				dimension: "goal",
				ambiguity: 0.66,
			},
		});
		const state = gate.context?.stage_state as Record<string, unknown>;
		expect(state.deep_interview_metadata).toBe(true);
		expect(state.round).toBe(1);
		expect(state.component).toBe("conflict-detection");
		expect(state.dimension).toBe("goal");
		expect(state.ambiguity).toBe(0.66);
		expect(state.round_id).toBe("r-1");
	});

	it("structured metadata wins over conflicting question text", () => {
		const gate = questionToGate({
			id: "q-conflict",
			question: "Round 99 | Topology confirmation | Ambiguity: 80%",
			options: [{ label: "x" }],
			deepInterview: { round: 2, component: "bidirectional-ambiguity", dimension: "constraints", ambiguity: 0.4 },
		});
		const state = gate.context?.stage_state as Record<string, unknown>;
		expect(state.round).toBe(2);
		expect(state.deep_interview_metadata).toBe(true);
		// The regex would have parsed round 99 / topology_gate from the text; metadata overrides it.
		expect(state.topology_gate).toBeUndefined();
	});

	it("falls back to regex parsing when metadata is absent (unchanged behavior)", () => {
		const gate = questionToGate({
			id: "q-regex",
			question: "Round 3 | Targeting: Constraints | Ambiguity: 40%",
			options: [{ label: "x" }],
		});
		const state = gate.context?.stage_state as Record<string, unknown>;
		expect(state.round).toBe(3);
		expect(state.deep_interview_metadata).toBeUndefined();
	});
});

describe("questionToGate confused_terms + references adapter context", () => {
	it("threads bounded confused_terms and references into stage_state", () => {
		const gate = questionToGate({
			id: "q-adapter",
			question: "Round 1 | Component: Intake | Targeting: Goal | Ambiguity: 50%\n\nWhat is the core entity?",
			options: [{ label: "Task" }, { label: "Project" }],
			deepInterview: {
				round: 1,
				component: "intake",
				dimension: "goal",
				ambiguity: 0.5,
				confused_terms: ["idempotency", "backpressure"],
				references: [
					{
						reference_id: "r1",
						label: "RFC 42",
						origin: "user",
						url: "https://example.com/rfc42",
						excerpt: "the contract; see $() note",
					},
				],
			},
		});
		const state = gate.context?.stage_state as Record<string, unknown>;
		expect(state.confused_terms).toEqual(["idempotency", "backpressure"]);
		expect(Array.isArray(state.references)).toBe(true);
		expect((state.references as Array<Record<string, unknown>>)[0]?.reference_id).toBe("r1");
	});

	it("accepts emoji adapter metadata at code-point boundaries", () => {
		const term = "😀".repeat(256);
		const longText = "😀".repeat(2048);
		const gate = questionToGate({
			id: "q-non-ascii-boundary",
			question: "Round 1 | Ambiguity: 50%",
			options: [{ label: "x" }],
			deepInterview: {
				round_id: "😀".repeat(128),
				round: 1,
				component: "😀".repeat(128),
				dimension: "😀".repeat(128),
				ambiguity: 0.5,
				confused_terms: [term],
				references: [{ reference_id: term, label: term, origin: term, url: longText, excerpt: longText }],
			},
		});

		const state = gate.context?.stage_state as Record<string, unknown>;
		expect(state.confused_terms).toEqual([term]);
		expect(state.references).toEqual([
			{ reference_id: term, label: term, origin: term, url: longText, excerpt: longText },
		]);
		expect(state.round_id).toBe("😀".repeat(128));
	});

	it("rejects adapter metadata beyond character-count boundaries", () => {
		expect(() =>
			questionToGate({
				id: "q-non-ascii-overflow",
				question: "Round 1 | Ambiguity: 50%",
				options: [{ label: "x" }],
				deepInterview: {
					round: 1,
					component: "intake",
					dimension: "goal",
					ambiguity: 0.5,
					confused_terms: ["😀".repeat(257)],
				},
			}),
		).toThrow(/confused_terms/);
	});

	it("rejects emoji core metadata beyond 128 code points", () => {
		const base = {
			id: "q-core-overflow",
			question: "Round 1 | Ambiguity: 50%",
			options: [{ label: "x" }],
		};
		for (const field of ["round_id", "component", "dimension"] as const)
			expect(() =>
				questionToGate({
					...base,
					deepInterview: {
						round_id: "r1",
						round: 1,
						component: "c",
						dimension: "goal",
						ambiguity: 0.5,
						[field]: "😀".repeat(129),
					},
				}),
			).toThrow(new RegExp(field));
	});

	it("omits adapter context when absent (unchanged behavior)", () => {
		const gate = questionToGate({
			id: "q-noadapter",
			question: "Round 2 | Targeting: Constraints | Ambiguity: 40%",
			options: [{ label: "x" }],
			deepInterview: { round: 2, component: "intake", dimension: "constraints", ambiguity: 0.4 },
		});
		const state = gate.context?.stage_state as Record<string, unknown>;
		expect(state.confused_terms).toBeUndefined();
		expect(state.references).toBeUndefined();
	});

	it("rejects malformed confused_terms and references", () => {
		expect(() =>
			questionToGate({
				id: "q-bad-terms",
				question: "Round 1 | Ambiguity: 50%",
				options: [{ label: "x" }],
				deepInterview: {
					round: 1,
					component: "intake",
					dimension: "goal",
					ambiguity: 0.5,
					confused_terms: [123 as unknown as string],
				},
			}),
		).toThrow(/confused_terms/);
		expect(() =>
			questionToGate({
				id: "q-bad-refs",
				question: "Round 1 | Ambiguity: 50%",
				options: [{ label: "x" }],
				deepInterview: {
					round: 1,
					component: "intake",
					dimension: "goal",
					ambiguity: 0.5,
					references: [
						{ reference_id: "r1" } as unknown as { reference_id: string; label: string; origin: string },
					],
				},
			}),
		).toThrow(/references/);
	});

	it("rejects sparse arrays and prototype-backed adapter references", () => {
		const sparseTerms = new Array<string>(1);
		expect(() =>
			questionToGate({
				id: "q-sparse-terms",
				question: "Round 1 | Ambiguity: 50%",
				options: [{ label: "x" }],
				deepInterview: {
					round: 1,
					component: "intake",
					dimension: "goal",
					ambiguity: 0.5,
					confused_terms: sparseTerms,
				},
			}),
		).toThrow(/confused_terms/);

		const inherited = Object.create({ reference_id: "r1", label: "label", origin: "user" }) as {
			reference_id: string;
			label: string;
			origin: string;
		};
		expect(() =>
			questionToGate({
				id: "q-inherited-reference",
				question: "Round 1 | Ambiguity: 50%",
				options: [{ label: "x" }],
				deepInterview: {
					round: 1,
					component: "intake",
					dimension: "goal",
					ambiguity: 0.5,
					references: [inherited],
				},
			}),
		).toThrow(/references/);
	});

	it("rejects every adapter string field one character beyond its schema limit", () => {
		const base = {
			id: "q-adapter-overflow",
			question: "Round 1 | Ambiguity: 50%",
			options: [{ label: "x" }],
		};
		for (const field of ["reference_id", "label", "origin"] as const)
			expect(() =>
				questionToGate({
					...base,
					deepInterview: {
						round: 1,
						component: "intake",
						dimension: "goal",
						ambiguity: 0.5,
						references: [{ reference_id: "r1", label: "label", origin: "user", [field]: "😀".repeat(257) }],
					},
				}),
			).toThrow(/references/);
		for (const field of ["url", "excerpt"] as const)
			expect(() =>
				questionToGate({
					...base,
					deepInterview: {
						round: 1,
						component: "intake",
						dimension: "goal",
						ambiguity: 0.5,
						references: [{ reference_id: "r1", label: "label", origin: "user", [field]: "😀".repeat(2049) }],
					},
				}),
			).toThrow(/references/);
	});
});
