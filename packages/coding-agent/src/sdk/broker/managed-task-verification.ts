import { randomUUID } from "node:crypto";
import { StatePublicationUncertainError, StateWriteConflictError } from "../../gjc-runtime/state-writer";
import {
	defaultFinalizeChecks,
	type FinalizeChecks,
	ValidationObservationUncertainError,
	type ValidationRun,
} from "../../harness-control-plane/finalize";
import {
	buildReceipt,
	type ReceiptEnvelope,
	type ValidationEvidence,
	validateReceipt,
} from "../../harness-control-plane/receipts";
import {
	assertManagedManifestCurrent,
	captureManagedManifest,
	type ManagedDomainBinding,
	type ManagedManifest,
	type ManagedTaskAttempt,
	type ManagedTaskDefinition,
	type ManagedVerificationObservation,
	resourceCoversPath,
	transactManagedTaskDomain,
	within,
} from "./managed-task-dag";

const VERIFIER_SOURCE = "managed-task-verification";

export type ManagedVerificationStatus =
	| { status: "running"; executionId: string; started: false }
	| { status: "unknown"; executionId: string; started: boolean; reason?: string }
	| { status: "finished"; executionId: string; started: false; accepted: boolean }
	| { status: "accepted"; executionId: string; started: boolean; acceptedId: string; acceptedHash: string }
	| { status: "failed"; executionId: string; started: boolean; reason: string };

function requirePolicy(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}
function isCorruptAuthority(error: unknown): boolean {
	return error instanceof Error && /corrupt authority|established authority missing/.test(error.message);
}
function isStaleAcceptedEvidence(error: unknown): boolean {
	return error instanceof Error && error.message === "managed-task: content drift";
}
function isPublicationUncertainty(error: unknown): boolean {
	return (
		error instanceof ValidationObservationUncertainError ||
		error instanceof StatePublicationUncertainError ||
		error instanceof StateWriteConflictError ||
		isCorruptAuthority(error)
	);
}
function isKnownPolicyRefusal(error: unknown): boolean {
	if (!(error instanceof Error) || isPublicationUncertainty(error)) return false;
	return (
		isStaleAcceptedEvidence(error) ||
		error.message === "validation output escaped declared Q" ||
		error.message === "attempt is fenced" ||
		error.message === "attempt definition is not current" ||
		error.message === "missing frozen verification manifests" ||
		error.message === "missing terminal observations" ||
		error.message === "validation command failed" ||
		error.message === "receipt count mismatch" ||
		error.message === "receipt evidence is not trusted" ||
		error.message === "receipt binding mismatch"
	);
}

function unknownStatus(executionId: string, _error: unknown, started = true): ManagedVerificationStatus {
	return {
		status: "unknown",
		executionId,
		started,
		reason: "managed-task: verification unknown",
	};
}
function publicFailureReason(error: unknown): string {
	if (!(error instanceof Error)) return "verification failed";
	if (
		/corrupt authority|established authority missing|path is outside enrolled worktrees|content drift|resource conflict|untrusted acceptance|domain binding mismatch/.test(
			error.message,
		)
	)
		return "managed-task: verification refused";
	if (error.message.startsWith("managed-task:")) return "managed-task: verification refused";
	return "verification failed";
}
function canonicalArtifactPath(
	attempt: ManagedTaskAttempt,
	artifact: ManagedTaskDefinition["artifacts"][number],
): string {
	return (
		attempt.resources.find(
			resource => resource.declaration.kind === "path" && resource.declaration.path === artifact.path,
		)?.path ?? artifact.path
	);
}
function declaredRoleRoots(
	attempt: ManagedTaskAttempt,
	roles: ReadonlyArray<ManagedTaskDefinition["artifacts"][number]["role"]>,
): string[] {
	return [
		...new Set(
			attempt.definition.artifacts
				.filter(artifact => roles.includes(artifact.role))
				.map(artifact => canonicalArtifactPath(attempt, artifact)),
		),
	].sort();
}
function pathInRoleTree(roots: string[], targetPath: string): boolean {
	return roots.some(root => targetPath === root || within(root, targetPath));
}
function artifactAuthorized(attempt: ManagedTaskAttempt, targetPath: string, needed: "read" | "write"): boolean {
	return attempt.resources.some(resource => resourceCoversPath(resource, targetPath, needed));
}

function producedArtifacts(definition: ManagedTaskDefinition) {
	return definition.artifacts.filter(artifact => artifact.role === "output" || artifact.role === "read-write");
}

function readOnlyInputManifest(attempt: ManagedTaskAttempt): ManagedManifest {
	const inputRoots = declaredRoleRoots(attempt, ["input"]);
	const predecessor = new Set(attempt.predecessors.flatMap(item => item.produced.map(entry => entry.path)));
	return attempt.inputs.filter(
		entry =>
			pathInRoleTree(inputRoots, entry.path) ||
			predecessor.has(entry.path) ||
			[...predecessor].some(parent => within(parent, entry.path)),
	);
}
function producedPaths(attempt: ManagedTaskAttempt): string[] {
	const roots = declaredRoleRoots(attempt, ["output", "read-write"]);
	for (const root of roots)
		requirePolicy(artifactAuthorized(attempt, root, "write"), "produced artifact is not reserved");
	return roots;
}
function validationOutputRoots(attempt: ManagedTaskAttempt): string[] {
	const roots = declaredRoleRoots(attempt, ["validation-output"]);
	for (const root of roots)
		requirePolicy(artifactAuthorized(attempt, root, "write"), "validation output is not reserved");
	return roots;
}

async function capturePaths(binding: ManagedDomainBinding, paths: string[]): Promise<ManagedManifest> {
	if (paths.length === 0) return [];
	return captureManagedManifest(binding, paths);
}

function assertPresence(
	definition: ManagedTaskDefinition,
	produced: ManagedManifest,
	attempt: ManagedTaskAttempt,
): void {
	for (const artifact of producedArtifacts(definition)) {
		const canonical = canonicalArtifactPath(attempt, artifact);
		const entry = produced.find(item => item.path === canonical);
		if (artifact.presence === "required") requirePolicy(entry && entry.kind !== "absent", "absent required output");
		if (artifact.presence === "absent")
			requirePolicy(!entry || entry.kind === "absent", "output presence contract failed");
	}
}

function currentNodeDefinition(
	graphs: Array<{
		id: string;
		nodes?: Array<{ definition: { id: string }; hash: string; revision: number }>;
	}>,
	graphId: string,
	nodeId: string,
): { hash: string; revision: number } | undefined {
	return graphs.find(item => item.id === graphId)?.nodes?.find(node => node.definition.id === nodeId);
}

function findAttempt(
	stateGraphs: Array<{
		id: string;
		owner: string;
		attempts: ManagedTaskAttempt[];
		nodes?: Array<{ definition: { id: string }; hash: string; revision: number }>;
	}>,
	graphId: string,
	nodeId: string,
	owner: string,
): { graph: { id: string; owner: string; attempts: ManagedTaskAttempt[] }; attempt: ManagedTaskAttempt } {
	const graph = stateGraphs.find(item => item.id === graphId);
	requirePolicy(graph && graph.owner === owner, "graph owner mismatch");
	const current = currentNodeDefinition(stateGraphs, graphId, nodeId);
	requirePolicy(current, "node missing");
	const attempt = [...graph.attempts]
		.reverse()
		.find(
			item =>
				item.nodeId === nodeId &&
				item.taskRevision === current.revision &&
				item.definitionHash === current.hash &&
				item.fence === "current",
		);
	requirePolicy(attempt, "attempt missing");
	return { graph, attempt };
}

export async function markManagedVerificationUnknown(
	binding: ManagedDomainBinding,
	graphId: string,
	attemptId: string,
): Promise<void> {
	try {
		await transactManagedTaskDomain({ binding, internal: true }, async state => {
			const attempt = state.graphs.find(graph => graph.id === graphId)?.attempts.find(item => item.id === attemptId);
			requirePolicy(attempt, "attempt missing");
			if (attempt.validation === "running") attempt.validation = "unknown";
		});
	} catch (error) {
		if (error instanceof Error && /corrupt authority|established authority missing/.test(error.message)) {
			throw new Error("managed-task: corrupt authority");
		}
		throw error;
	}
}

export async function reconcileRunningManagedVerification(binding: ManagedDomainBinding): Promise<void> {
	await transactManagedTaskDomain({ binding, internal: true }, async state => {
		for (const graph of state.graphs) {
			for (const attempt of graph.attempts) {
				if (attempt.validation === "running") attempt.validation = "unknown";
			}
		}
	}).catch(error => {
		if (error instanceof Error && /established authority missing|corrupt/.test(error.message)) return;
		throw error;
	});
}

async function startOrObserve(
	binding: ManagedDomainBinding,
	input: { graphId: string; nodeId: string; owner: string },
): Promise<{ attempt: ManagedTaskAttempt; started: boolean }> {
	const result = await transactManagedTaskDomain({ binding, internal: true }, async state => {
		const { attempt } = findAttempt(state.graphs, input.graphId, input.nodeId, input.owner);
		requirePolicy(attempt.worker === "closed", "verification requires closed worker");
		requirePolicy(attempt.fence === "current", "attempt is fenced");
		requirePolicy(attempt.accepted === null || attempt.validation === "finished", "attempt already accepted");
		if (attempt.accepted !== null && attempt.validation === "finished") {
			await assertManagedManifestCurrent(binding, readOnlyInputManifest(attempt));
			if (attempt.produced) await assertManagedManifestCurrent(binding, attempt.produced);
			if (attempt.validationImmutable) await assertManagedManifestCurrent(binding, attempt.validationImmutable);
			return { attempt: structuredClone(attempt), started: false };
		}
		if (attempt.validation === "running" || attempt.validation === "unknown" || attempt.validation === "finished") {
			return { attempt: structuredClone(attempt), started: false };
		}
		requirePolicy(
			attempt.validation === "not-started" && attempt.verificationExecution === null,
			"verification already started",
		);
		requirePolicy(attempt.definition.validations.length > 0, "empty validation list");
		await assertManagedManifestCurrent(binding, readOnlyInputManifest(attempt));
		for (const predecessor of attempt.predecessors) await assertManagedManifestCurrent(binding, predecessor.produced);
		const produced = await capturePaths(binding, producedPaths(attempt));
		assertPresence(attempt.definition, produced, attempt);
		const validationImmutable = [...readOnlyInputManifest(attempt), ...produced].sort((left, right) =>
			left.path.localeCompare(right.path),
		);
		const validationOutputs = await capturePaths(binding, validationOutputRoots(attempt));
		attempt.produced = produced;
		attempt.validationImmutable = validationImmutable;
		attempt.validationOutputs = validationOutputs;
		attempt.verificationExecution = {
			executionId: `verify-${randomUUID()}`,
			workspace: attempt.definition.workspace,
			commands: attempt.definition.validations.map(command => ({ name: command.name, command: command.command })),
			observations: [],
			receipts: [],
		};
		attempt.validation = "running";
		return { attempt: structuredClone(attempt), started: true };
	});
	return result.result;
}

async function appendObservation(
	binding: ManagedDomainBinding,
	input: { graphId: string; attemptId: string; observation: ManagedVerificationObservation },
): Promise<void> {
	await transactManagedTaskDomain({ binding, internal: true }, async state => {
		const attempt = state.graphs
			.find(graph => graph.id === input.graphId)
			?.attempts.find(item => item.id === input.attemptId);
		requirePolicy(attempt?.verificationExecution, "verification execution missing");
		requirePolicy(attempt.validation === "running", "verification is not running");
		requirePolicy(
			attempt.verificationExecution.observations.length < attempt.verificationExecution.commands.length,
			"unexpected extra observation",
		);
		const expected = attempt.verificationExecution.commands[attempt.verificationExecution.observations.length]!;
		requirePolicy(
			input.observation.name === expected.name && input.observation.command === expected.command,
			"observation command mismatch",
		);
		attempt.verificationExecution.observations.push(input.observation);
	});
}

function trustedObservation(
	spec: { name: string; command: string },
	workspace: string,
	run: ValidationRun,
): ManagedVerificationObservation {
	requirePolicy(run.exactCommand === spec.command, "exact command mismatch");
	requirePolicy(run.cwd === workspace, "validation cwd mismatch");
	return { name: spec.name, command: spec.command, cwd: run.cwd, exitStatus: run.exitStatus, pass: run.pass };
}

function trustedReceipt(
	owner: string,
	workspace: string,
	executionId: string,
	index: number,
	spec: { name: string; command: string },
	observation: ManagedVerificationObservation,
): ReceiptEnvelope<ValidationEvidence> {
	requirePolicy(observation.exitStatus === 0 && observation.pass === true, "validation command failed");
	const envelope = buildReceipt<ValidationEvidence>({
		receiptId: `${executionId}:${index}`,
		sessionId: owner,
		family: "validation",
		source: VERIFIER_SOURCE,
		subject: { workspace, branch: null, head: null, commit: null },
		evidence: {
			command: spec.name,
			exactCommand: observation.command,
			cwd: observation.cwd,
			exitStatus: observation.exitStatus,
			pass: observation.pass,
			commitUnderTest: null,
		},
	});
	const outcome = validateReceipt(envelope);
	requirePolicy(outcome.valid, "receipt envelope invalid");
	requirePolicy(
		envelope.sessionId === owner &&
			envelope.subject.workspace === workspace &&
			envelope.source === VERIFIER_SOURCE &&
			envelope.family === "validation",
		"receipt binding mismatch",
	);
	requirePolicy(
		envelope.evidence.exactCommand === spec.command &&
			envelope.evidence.cwd === workspace &&
			envelope.evidence.exitStatus === 0 &&
			envelope.evidence.pass === true,
		"receipt evidence is not trusted",
	);
	return envelope;
}

async function acceptExecution(
	binding: ManagedDomainBinding,
	input: { graphId: string; attemptId: string; owner: string; envelopes: ReceiptEnvelope<ValidationEvidence>[] },
): Promise<{ id: string; hash: string }> {
	const result = await transactManagedTaskDomain({ binding, internal: true }, async state => {
		const attempt = state.graphs
			.find(graph => graph.id === input.graphId)
			?.attempts.find(item => item.id === input.attemptId);
		requirePolicy(attempt?.verificationExecution, "verification execution missing");
		requirePolicy(attempt.fence === "current", "attempt is fenced");
		const graph = state.graphs.find(item => item.id === input.graphId);
		requirePolicy(
			graph?.nodes.some(
				node =>
					node.definition.id === attempt.nodeId &&
					node.hash === attempt.definitionHash &&
					node.revision === attempt.taskRevision,
			),
			"attempt definition is not current",
		);
		requirePolicy(attempt.worker === "closed", "verification requires closed worker");
		requirePolicy(attempt.validation === "running", "verification is not running");
		requirePolicy(
			attempt.produced && attempt.validationImmutable && attempt.validationOutputs,
			"missing frozen verification manifests",
		);
		await assertManagedManifestCurrent(binding, attempt.validationImmutable);
		await assertManagedManifestCurrent(binding, attempt.produced);
		await assertManagedManifestCurrent(binding, readOnlyInputManifest(attempt));
		for (const predecessor of attempt.predecessors) await assertManagedManifestCurrent(binding, predecessor.produced);
		const qRoots = validationOutputRoots(attempt);
		const finalQ = await capturePaths(binding, qRoots);
		for (const entry of finalQ)
			requirePolicy(
				qRoots.some(root => entry.path === root || within(root, entry.path)),
				"validation output escaped declared Q",
			);
		const execution = attempt.verificationExecution;
		requirePolicy(execution.observations.length === execution.commands.length, "missing terminal observations");
		requirePolicy(
			execution.observations.every(observation => observation.pass && observation.exitStatus === 0),
			"validation command failed",
		);
		requirePolicy(input.envelopes.length === execution.commands.length, "receipt count mismatch");
		execution.receipts = input.envelopes.map(envelope => ({
			id: envelope.receiptId,
			hash: envelope.sha256,
			envelope: { ...envelope },
		}));
		attempt.validationOutputs = finalQ;
		attempt.validation = "finished";
		const accepted = { id: input.envelopes[0]!.receiptId, hash: input.envelopes[0]!.sha256 };
		attempt.accepted = accepted;
		return accepted;
	});
	return result.result;
}

async function failExecution(
	binding: ManagedDomainBinding,
	graphId: string,
	attemptId: string,
	reason: string,
): Promise<void> {
	await transactManagedTaskDomain({ binding, internal: true }, async state => {
		const attempt = state.graphs.find(graph => graph.id === graphId)?.attempts.find(item => item.id === attemptId);
		requirePolicy(attempt, "attempt missing");
		if (attempt.validation === "running") {
			attempt.validation = "finished";
			attempt.fence = attempt.fence === "current" ? "failed" : attempt.fence;
		}
		void reason;
	});
}

export async function verifyManagedTaskAttempt(input: {
	binding: ManagedDomainBinding;
	graphId: string;
	nodeId: string;
	owner: string;
	runner?: FinalizeChecks;
}): Promise<ManagedVerificationStatus> {
	let started: { attempt: ManagedTaskAttempt; started: boolean };
	try {
		started = await startOrObserve(input.binding, {
			graphId: input.graphId,
			nodeId: input.nodeId,
			owner: input.owner,
		});
	} catch (error) {
		if (isCorruptAuthority(error)) return unknownStatus("unreadable", error, false);
		if (isStaleAcceptedEvidence(error))
			return {
				status: "failed",
				executionId: "accepted",
				started: false,
				reason: "managed-task: verification refused",
			};
		throw error;
	}
	const execution = started.attempt.verificationExecution;
	requirePolicy(execution, "verification execution missing");
	if (!started.started) {
		if (started.attempt.validation === "unknown")
			return { status: "unknown", executionId: execution.executionId, started: false };
		if (started.attempt.validation === "running")
			return { status: "running", executionId: execution.executionId, started: false };
		if (started.attempt.accepted)
			return {
				status: "accepted",
				executionId: execution.executionId,
				started: false,
				acceptedId: started.attempt.accepted.id,
				acceptedHash: started.attempt.accepted.hash,
			};
		return {
			status: "finished",
			executionId: execution.executionId,
			started: false,
			accepted: false,
		};
	}
	const workspace = execution.workspace;
	const runner = input.runner ?? defaultFinalizeChecks(workspace);
	const envelopes: ReceiptEnvelope<ValidationEvidence>[] = [];
	try {
		for (const [index, spec] of execution.commands.entries()) {
			const run = await runner.runValidation(spec);
			const observation = trustedObservation(spec, workspace, run);
			await appendObservation(input.binding, { graphId: input.graphId, attemptId: started.attempt.id, observation });
			if (!observation.pass || observation.exitStatus !== 0) {
				await failExecution(input.binding, input.graphId, started.attempt.id, "validation command failed");
				return {
					status: "failed",
					executionId: execution.executionId,
					started: true,
					reason: "validation command failed",
				};
			}
			envelopes.push(trustedReceipt(input.owner, workspace, execution.executionId, index, spec, observation));
		}
		try {
			const accepted = await acceptExecution(input.binding, {
				graphId: input.graphId,
				attemptId: started.attempt.id,
				owner: input.owner,
				envelopes,
			});
			return {
				status: "accepted",
				executionId: execution.executionId,
				started: true,
				acceptedId: accepted.id,
				acceptedHash: accepted.hash,
			};
		} catch (error) {
			if (isPublicationUncertainty(error) || isCorruptAuthority(error)) {
				try {
					await markManagedVerificationUnknown(input.binding, input.graphId, started.attempt.id);
				} catch (markError) {
					if (isPublicationUncertainty(markError) || isCorruptAuthority(markError) || isCorruptAuthority(error))
						return unknownStatus(execution.executionId, isCorruptAuthority(markError) ? markError : error);
					throw markError;
				}
				return unknownStatus(execution.executionId, error);
			}
			if (isKnownPolicyRefusal(error) || isStaleAcceptedEvidence(error)) {
				await failExecution(input.binding, input.graphId, started.attempt.id, publicFailureReason(error));
				return {
					status: "failed",
					executionId: execution.executionId,
					started: true,
					reason: publicFailureReason(error),
				};
			}
			try {
				await markManagedVerificationUnknown(input.binding, input.graphId, started.attempt.id);
			} catch (markError) {
				if (isPublicationUncertainty(markError) || isCorruptAuthority(markError) || isCorruptAuthority(error))
					return unknownStatus(execution.executionId, isCorruptAuthority(markError) ? markError : error);
				throw markError;
			}
			return unknownStatus(execution.executionId, error);
		}
	} catch (error) {
		try {
			await markManagedVerificationUnknown(input.binding, input.graphId, started.attempt.id);
		} catch (markError) {
			if (isPublicationUncertainty(markError) || isCorruptAuthority(markError) || isCorruptAuthority(error))
				return unknownStatus(execution.executionId, isCorruptAuthority(markError) ? markError : error);
			throw markError;
		}
		if (isPublicationUncertainty(error) || isCorruptAuthority(error))
			return unknownStatus(execution.executionId, error);
		return {
			status: "failed",
			executionId: execution.executionId,
			started: true,
			reason: publicFailureReason(error),
		};
	}
}
