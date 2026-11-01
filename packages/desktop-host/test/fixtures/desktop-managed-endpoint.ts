import * as fs from "node:fs/promises";
import * as path from "node:path";
import { endpointIncarnation } from "../../../coding-agent/src/sdk/broker/endpoint-authority";
import { processIncarnation } from "../../../coding-agent/src/sdk/broker/process-incarnation";
import { resolveSessionLocator, SessionIndex } from "../../../coding-agent/src/sdk/broker/session-index";
import { CursorRegistry } from "../../../coding-agent/src/sdk/host/query/cursor";
import {
	QueryHandlers,
	type QueryRequest,
	type SessionSurface,
} from "../../../coding-agent/src/sdk/host/query/handlers";
import { RevisionStore } from "../../../coding-agent/src/sdk/host/query/revision-store";
import type { Q10Model } from "../../../coding-agent/src/sdk/models";
import { type SessionAttachment, SessionRouter, type SessionRouterFrame } from "../../../coding-agent/src/sdk/router";

/** Test-only SDK custody fixture. It records a real host process and endpoint,
 * then uses the production Router's descriptor-bound authority checks. */
export async function createDesktopManagedEndpointAuthority(input: {
	agentDir: string;
	cwd: string;
	sessionId: string;
	generation: number;
}) {
	const stateRoot = path.join(input.cwd, ".gjc", "state");
	const index = new SessionIndex(input.agentDir);
	await index.open();
	const incarnation = processIncarnation(process.pid);
	if (!incarnation) throw new Error("Fixture process identity unavailable");
	await index.append({
		type: "host_registered",
		sessionId: input.sessionId,
		locator: await resolveSessionLocator(input.cwd, stateRoot),
		endpointGeneration: input.generation,
		pid: process.pid,
		hostIncarnation: incarnation,
		processIncarnation: incarnation,
		endpointMtimeMs: (await fs.stat(path.join(stateRoot, "sdk", `${input.sessionId}.json`))).mtimeMs,
	});
	await index.refresh();
	const indexed = index.listSessions().sessions.find(item => item.sessionId === input.sessionId);
	const binding = indexed && endpointIncarnation(indexed, input.sessionId);
	if (!binding) throw new Error("Fixture endpoint authority unavailable");
	return {
		binding,
		createRouter: (onFrame: (attachment: SessionAttachment, frame: SessionRouterFrame) => void) =>
			new SessionRouter({
				agentDir: input.agentDir,
				sessionIds: [input.sessionId],
				deps: { onFrame, createIndex: () => index },
			}),
	};
}

/** Keep oversized Q10/Q23 serialization in SDK custody rather than hand-writing wire DTOs. */
export function createDesktopManagedModelQueries(sessionId: string, models: () => Q10Model[]) {
	const unsupported = (): never => {
		throw new Error("Query is outside the model paging fixture");
	};
	const surface: SessionSurface = {
		getModels: models,
		getTranscriptEntries: unsupported,
		getContextSnapshot: unsupported,
		getGoalState: unsupported,
		getTodoState: unsupported,
		getDiff: unsupported,
		getUsage: unsupported,
		getSkillState: unsupported,
		getGates: unsupported,
		getConfigItems: unsupported,
		getSessionMetadata: unsupported,
		getStats: unsupported,
		getBranchCandidates: unsupported,
		getLastAssistant: unsupported,
		getCapabilities: unsupported,
		getAuthProviders: unsupported,
		getTools: unsupported,
		getQueueMessages: unsupported,
		getExtensions: unsupported,
		getJobs: unsupported,
	};
	const revisions = new RevisionStore(sessionId);
	const cursors = new CursorRegistry("fixture-secret", revisions);
	const queries = new QueryHandlers(surface, sessionId, revisions, cursors);
	return {
		dispatch: (request: QueryRequest) => queries.dispatch(request),
		close: async () => {
			cursors.close();
			await revisions.close();
		},
	};
}
