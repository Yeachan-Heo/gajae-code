import { describe, expect, it } from "bun:test";
import {
	type BrokerTaskArtifactOwnerCleanupFields,
	decodeBrokerTaskArtifactOwnerCleanupFields,
	parseBrokerTaskArtifactOwnerRetirementDisposition,
	serializeBrokerTaskArtifactOwnerRetirementDisposition,
} from "../src/sdk/broker/task-artifact-owner-validation";
import type { TaskArtifactOwnerStorageContext } from "../src/session/task-artifact-owner-codec";
import {
	EMPTY_PAYLOAD_SHA256,
	OWNER_DELETION_SCHEMA_VERSION,
	OWNER_RETIREMENT_SCHEMA_VERSION,
	OWNER_SCHEMA_VERSION,
	ownerAbsolutePath,
	ownerIdForSession,
	parseTaskArtifactOwnerDeletionEvidence,
	parseTaskArtifactOwnerRetirementContinuation,
} from "../src/session/task-artifact-owner-codec";

const sessionId = "broker-owner-validation-session";
const sessionsRoot = "/tmp/broker-owner-validation";
const locator = {
	schemaVersion: OWNER_SCHEMA_VERSION,
	ownerId: ownerIdForSession(sessionId),
	directoryDev: "100",
	directoryIno: "101",
};
const parentIdentity = { dev: "200", ino: "201" };
const context: TaskArtifactOwnerStorageContext = {
	rootAuthority: { canonicalPath: sessionsRoot, dev: 3n, ino: 4n },
	sessionsRoot,
	securityPolicy: "default",
	profileAgentDir: "/tmp/broker-owner-validation-profile",
};
const ownerPath = ownerAbsolutePath(context, locator.ownerId);
const evidence = {
	schemaVersion: OWNER_DELETION_SCHEMA_VERSION,
	sessionId,
	locator,
	parentIdentity,
	treeSnapshot: {
		rootDev: locator.directoryDev,
		rootIno: locator.directoryIno,
		entries: [
			{
				relativePath: "",
				kind: "directory",
				dev: locator.directoryDev,
				ino: locator.directoryIno,
				nlink: "1",
				size: "0",
				mtimeNs: "700",
				ctimeNs: "701",
			},
			{
				relativePath: "data.bin",
				kind: "file",
				dev: "102",
				ino: "103",
				nlink: "1",
				size: "6",
				mtimeNs: "702",
				ctimeNs: "703",
				sha256: "c".repeat(64),
			},
		],
	},
};
const parsedEvidence = parseTaskArtifactOwnerDeletionEvidence(evidence);
const sidePath = `${sessionsRoot}/.task-artifact-owners/.gjc-receipt-side`;

function continuation(
	extra: Record<string, unknown> = {},
	retainedTree: typeof evidence.treeSnapshot = evidence.treeSnapshot,
): Record<string, unknown> {
	return {
		schemaVersion: OWNER_RETIREMENT_SCHEMA_VERSION,
		parentIdentity,
		retainedRootPath: ownerPath,
		retainedTreeSnapshot: retainedTree,
		...extra,
	};
}

function cleanupFields(overrides: Record<string, unknown> = {}): BrokerTaskArtifactOwnerCleanupFields {
	return {
		taskArtifactOwnerDeletionEvidence: evidence,
		...overrides,
	};
}

describe("broker task artifact owner validation", () => {
	it("round-trips strict owner dispositions and preserves native diagnostic roles", () => {
		const diagnostics = {
			ok: false,
			code: "cleanup_pending",
			detachedPath: `${ownerPath}.removing`,
			retainedSuccessorPath: sidePath,
			windowsErrorCode: "0x00000020",
		};
		const retainedTree = evidence.treeSnapshot;
		const exactContinuation = continuation(
			{
				detachedPaths: [`${ownerPath}.removing`],
				nativeCodes: ["cleanup_pending"],
				retainedSuccessorPaths: [sidePath],
				windowsErrorCodes: ["0x00000020"],
			},
			retainedTree,
		);
		const disposition = { kind: "cleanup_pending", nativeOutcome: diagnostics };
		const outcome = parseBrokerTaskArtifactOwnerRetirementDisposition(
			disposition,
			context,
			parsedEvidence,
			parseContinuation(exactContinuation),
		);
		const encoded = serializeBrokerTaskArtifactOwnerRetirementDisposition(outcome);
		expect<unknown>(encoded).toEqual(disposition);
		expect(encoded).not.toHaveProperty("evidence");
		expect(encoded).not.toHaveProperty("continuation");

		expect(() =>
			parseBrokerTaskArtifactOwnerRetirementDisposition(
				{ ...disposition, extra: true },
				context,
				parsedEvidence,
				parseContinuation(exactContinuation),
			),
		).toThrow();
		expect(() =>
			parseBrokerTaskArtifactOwnerRetirementDisposition(
				{ ...disposition, evidence },
				context,
				parsedEvidence,
				parseContinuation(exactContinuation),
			),
		).toThrow();
		expect(() =>
			parseBrokerTaskArtifactOwnerRetirementDisposition(
				{ ...disposition, nativeOutcome: { ...diagnostics, retainedPlaceholderPath: sidePath } },
				context,
				parsedEvidence,
				parseContinuation(exactContinuation),
			),
		).toThrow();
	});

	it("decodes outcome variants with explicit evidence and continuation, without promoting completion to proof", () => {
		const uncertain = {
			kind: "uncertain",
			reason: "retained namespace identity could not be refreshed",
		};
		const decodedUncertain = parseBrokerTaskArtifactOwnerRetirementDisposition(
			uncertain,
			context,
			parsedEvidence,
			parseContinuation(continuation()),
		);
		expect<unknown>(serializeBrokerTaskArtifactOwnerRetirementDisposition(decodedUncertain)).toEqual(uncertain);

		const payloadRetiredTree = {
			...evidence.treeSnapshot,
			entries: [
				evidence.treeSnapshot.entries[0],
				{
					...evidence.treeSnapshot.entries[1],
					size: "0",
					sha256: EMPTY_PAYLOAD_SHA256,
				},
			],
		};
		const payloadOutcome = {
			ok: false,
			code: "cleanup_pending",
			payloadDurable: true,
		};
		const payloadContinuation = continuation(
			{ nativeCodes: ["cleanup_pending"], payloadDurable: true, retainedRootPath: `${ownerPath}.removing` },
			payloadRetiredTree,
		);
		const payloadDisposition = {
			kind: "payload_retired",
			namespace: "retained",
			nativeOutcome: payloadOutcome,
		};
		const decodedPayload = parseBrokerTaskArtifactOwnerRetirementDisposition(
			payloadDisposition,
			context,
			parsedEvidence,
			parseContinuation(payloadContinuation),
		);
		expect<unknown>(serializeBrokerTaskArtifactOwnerRetirementDisposition(decodedPayload)).toEqual(
			payloadDisposition,
		);

		// A completed wire DTO without native-success fields is malformed; parsing a structural DTO below
		// exercises only serialization shape and is never used as live retirement proof.
		expect(() =>
			parseBrokerTaskArtifactOwnerRetirementDisposition({ kind: "completed" }, context, parsedEvidence, undefined),
		).toThrow();

		// Structural codec acceptance only: this fixture does not establish that native retirement occurred.
		const completedDisposition = { kind: "completed", nativeOutcome: { ok: true } };
		const decodedCompleted = parseBrokerTaskArtifactOwnerRetirementDisposition(
			completedDisposition,
			context,
			parsedEvidence,
			undefined,
		);
		expect(decodedCompleted.kind).toBe("completed");
		expect<unknown>(serializeBrokerTaskArtifactOwnerRetirementDisposition(decodedCompleted)).toEqual(
			completedDisposition,
		);
	});

	it("accepts empty legacy owner state and returns named, frozen decoded fields", () => {
		const empty = decodeBrokerTaskArtifactOwnerCleanupFields({}, context, sessionId, "artifacts", false);
		expect(empty.deletionEvidence).toBeUndefined();
		expect(empty.retirementOutcome).toBeUndefined();
		expect(empty.cleanupDiagnostic).toBeUndefined();
		expect(Object.isFrozen(empty)).toBe(true);

		const decoded = decodeBrokerTaskArtifactOwnerCleanupFields(
			cleanupFields({ taskArtifactOwnerCleanupError: "task_artifact_owner_native_removal_uncertain" }),
			context,
			sessionId,
			"artifacts",
			false,
		);
		expect(decoded.deletionEvidence).toEqual(parsedEvidence);
		expect(decoded.cleanupDiagnostic).toBe("task_artifact_owner_native_removal_uncertain");
	});

	it("rejects foreign sessions, foreign-root continuations, spliced parents, and expanding trees", () => {
		expect(() =>
			decodeBrokerTaskArtifactOwnerCleanupFields(cleanupFields(), context, "other-session", "artifacts", false),
		).toThrow();
		expect(() =>
			parseTaskArtifactOwnerDeletionEvidence({
				...evidence,
				parentIdentity: { dev: "-200", ino: "201" },
			}),
		).toThrow();
		expect(() =>
			parseTaskArtifactOwnerDeletionEvidence({
				...evidence,
				locator: { ...locator, directoryIno: "018" },
			}),
		).toThrow();

		const foreignContext: TaskArtifactOwnerStorageContext = {
			...context,
			sessionsRoot: `${sessionsRoot}-other-profile`,
		};
		expect(() =>
			decodeBrokerTaskArtifactOwnerCleanupFields(
				cleanupFields({ taskArtifactOwnerRetirementContinuation: continuation() }),
				foreignContext,
				sessionId,
				"artifacts",
				false,
			),
		).toThrow();

		expect(() =>
			decodeBrokerTaskArtifactOwnerCleanupFields(
				cleanupFields({
					taskArtifactOwnerRetirementContinuation: continuation({ parentIdentity: { dev: "200", ino: "999" } }),
				}),
				context,
				sessionId,
				"artifacts",
				false,
			),
		).toThrow();
		const expanded = {
			...evidence.treeSnapshot,
			entries: [
				...evidence.treeSnapshot.entries,
				{ ...evidence.treeSnapshot.entries[1], relativePath: "new-authority.bin", ino: "104" },
			],
		};
		expect(() =>
			decodeBrokerTaskArtifactOwnerCleanupFields(
				cleanupFields({ taskArtifactOwnerRetirementContinuation: continuation({}, expanded) }),
				context,
				sessionId,
				"artifacts",
				false,
			),
		).toThrow();
	});

	it("rejects contradictory owner flags, missing dispositions, and transcript deletion outside its authorized phase", () => {
		const pendingDisposition = {
			kind: "cleanup_pending",
			nativeOutcome: { ok: false, code: "cleanup_pending" },
		};
		const pendingContinuation = continuation({ nativeCodes: ["cleanup_pending"] });
		const validPending = {
			taskArtifactOwnerRetirementContinuation: pendingContinuation,
			taskArtifactOwnerRetirementOutcome: pendingDisposition,
		};
		expect(() =>
			decodeBrokerTaskArtifactOwnerCleanupFields(
				cleanupFields({ taskArtifactOwnerRetired: true }),
				context,
				sessionId,
				"artifacts",
				false,
			),
		).toThrow();
		const structurallyCompleted = decodeBrokerTaskArtifactOwnerCleanupFields(
			cleanupFields({
				taskArtifactOwnerRetirementOutcome: {
					kind: "completed",
					nativeOutcome: { ok: true },
				},
				taskArtifactOwnerRetired: true,
			}),
			context,
			sessionId,
			"artifacts",
			false,
		);
		// The completed wire DTO is parser data, not live physical-retirement evidence.
		expect(structurallyCompleted.retirementOutcome?.kind).toBe("completed");
		expect(structurallyCompleted.retired).toBe(true);
		expect(() =>
			decodeBrokerTaskArtifactOwnerCleanupFields(
				cleanupFields({ taskArtifactOwnerPayloadRetired: true }),
				context,
				sessionId,
				"artifacts",
				false,
			),
		).toThrow();
		expect(() =>
			decodeBrokerTaskArtifactOwnerCleanupFields(
				cleanupFields({
					...validPending,
					taskArtifactOwnerPayloadRetired: true,
					taskArtifactOwnerNamespaceRetained: true,
				}),
				context,
				sessionId,
				"artifacts",
				false,
			),
		).toThrow();
		expect(() =>
			decodeBrokerTaskArtifactOwnerCleanupFields(
				cleanupFields({ taskArtifactOwnerTranscriptDeleted: true, ...validPending }),
				context,
				sessionId,
				"transcript",
				true,
			),
		).toThrow();
		expect(() =>
			decodeBrokerTaskArtifactOwnerCleanupFields(
				cleanupFields({ taskArtifactOwnerTranscriptDeleted: true, ...validPending }),
				context,
				sessionId,
				"artifacts",
				false,
			),
		).toThrow();
		const transcriptDone = decodeBrokerTaskArtifactOwnerCleanupFields(
			cleanupFields({ taskArtifactOwnerTranscriptDeleted: true, ...validPending }),
			context,
			sessionId,
			"artifacts",
			true,
		);
		expect(transcriptDone.transcriptDeleted).toBe(true);
		expect(transcriptDone.retirementOutcome?.kind).toBe("cleanup_pending");
		expect(() =>
			decodeBrokerTaskArtifactOwnerCleanupFields(
				cleanupFields({ taskArtifactOwnerTranscriptDeleted: true }),
				context,
				sessionId,
				"artifacts",
				true,
			),
		).toThrow();
	});

	it("requires disposition flags to agree in both directions and rejects unknown owner keys", () => {
		const completedWithoutAuthority = {
			kind: "completed",
			nativeOutcome: { ok: false, code: "cleanup_pending" },
		};
		expect(() =>
			decodeBrokerTaskArtifactOwnerCleanupFields(
				cleanupFields({ taskArtifactOwnerRetirementOutcome: completedWithoutAuthority }),
				context,
				sessionId,
				"artifacts",
				false,
			),
		).toThrow();
		expect(() =>
			decodeBrokerTaskArtifactOwnerCleanupFields(
				cleanupFields({
					taskArtifactOwnerRetirementContinuation: continuation({ nativeCodes: ["cleanup_pending"] }),
					taskArtifactOwnerRetirementOutcome: {
						kind: "cleanup_pending",
						nativeOutcome: { ok: false, code: "cleanup_pending" },
					},
					taskArtifactOwnerNamespaceRetained: true,
				}),
				context,
				sessionId,
				"artifacts",
				false,
			),
		).toThrow();
		const scrubbedTree = {
			...evidence.treeSnapshot,
			entries: [
				evidence.treeSnapshot.entries[0],
				{ ...evidence.treeSnapshot.entries[1], size: "0", sha256: EMPTY_PAYLOAD_SHA256 },
			],
		};
		const retainedContinuation = continuation(
			{ retainedRootPath: `${ownerPath}.removing`, nativeCodes: ["cleanup_pending"], payloadDurable: true },
			scrubbedTree,
		);
		const payloadState = {
			taskArtifactOwnerRetirementContinuation: retainedContinuation,
			taskArtifactOwnerRetirementOutcome: {
				kind: "payload_retired",
				namespace: "retained",
				nativeOutcome: { ok: false, code: "cleanup_pending", payloadDurable: true },
			},
			taskArtifactOwnerPayloadRetired: true,
			taskArtifactOwnerNamespaceRetained: true,
		};
		const validPayloadState = decodeBrokerTaskArtifactOwnerCleanupFields(
			cleanupFields(payloadState),
			context,
			sessionId,
			"artifacts",
			false,
		);
		expect(validPayloadState.payloadRetired).toBe(true);
		expect(validPayloadState.namespaceRetained).toBe(true);
		expect(validPayloadState.retirementOutcome?.kind).toBe("payload_retired");
		for (const missing of [
			"taskArtifactOwnerNamespaceRetained",
			"taskArtifactOwnerPayloadRetired",
			"taskArtifactOwnerRetirementOutcome",
		]) {
			const incomplete: Record<string, unknown> = { ...payloadState };
			delete incomplete[missing];
			expect(() =>
				decodeBrokerTaskArtifactOwnerCleanupFields(
					cleanupFields(incomplete),
					context,
					sessionId,
					"artifacts",
					false,
				),
			).toThrow("task_artifact_owner_cleanup_state_invalid");
		}
		expect(() =>
			decodeBrokerTaskArtifactOwnerCleanupFields(
				{ ...cleanupFields(), unrecognizedOwnerClaim: true },
				context,
				sessionId,
				"artifacts",
				false,
			),
		).toThrow();
		expect(() =>
			decodeBrokerTaskArtifactOwnerCleanupFields(
				cleanupFields({ taskArtifactOwnerCleanupError: "" }),
				context,
				sessionId,
				"artifacts",
				false,
			),
		).toThrow();
	});
});

function parseContinuation(value: unknown) {
	return parseTaskArtifactOwnerRetirementContinuation(context, parsedEvidence, value);
}
