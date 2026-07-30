import { fuzzyFind } from "@gajae-code/natives";
import { branch, config, diff, head, repo } from "../../utils/git";
import type { HandlerContext, HandlerResult, MethodHandler } from "./handlers";

type RecordValue = Record<string, unknown>;
type SearchSession = { roots: string[] };

const sessions = new Map<string, SearchSession>();

function record(value: unknown): RecordValue | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as RecordValue) : undefined;
}

const invalidParams = (): HandlerResult => ({ ok: false, errorKey: "invalidParams" });
const notFound = (): HandlerResult => ({ ok: false, errorKey: "notFound" });
const internalError = (): HandlerResult => ({ ok: false, errorKey: "internalError" });

function stringArray(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every(item => typeof item === "string") ? value : undefined;
}

async function searchRoot(root: string, query: string): Promise<unknown[]> {
	const result = await fuzzyFind({
		query,
		path: root,
		hidden: false,
		gitignore: true,
		cache: true,
		maxResults: 100,
	});
	return result.matches;
}

/** One-shot fuzzy file search over the current workspace (or optional direct-call overrides). */
const fuzzyFileSearchHandler: MethodHandler = async params => {
	const p = record(params);
	if (params !== undefined && p === undefined) return invalidParams();
	const query = typeof p?.query === "string" ? p.query : "";
	const root = typeof p?.root === "string" ? p.root : process.cwd();
	try {
		return { ok: true, result: { files: await searchRoot(root, query) } };
	} catch {
		return internalError();
	}
};

const fuzzyFileSearchSessionStartHandler: MethodHandler = (params, context) => {
	const p = record(params);
	const roots = p && stringArray(p.roots);
	if (!p || typeof p.sessionId !== "string" || !roots || roots.length === 0) return invalidParams();
	sessions.set(key(p.sessionId, context), { roots: [...roots] });
	return { ok: true, result: {} };
};

const fuzzyFileSearchSessionStopHandler: MethodHandler = (params, context) => {
	const p = record(params);
	if (!p || typeof p.sessionId !== "string") return invalidParams();
	const sessionKey = key(p.sessionId, context);
	if (!sessions.delete(sessionKey)) return notFound();
	return { ok: true, result: {} };
};

const fuzzyFileSearchSessionUpdateHandler: MethodHandler = async (params, context) => {
	const p = record(params);
	if (!p || typeof p.sessionId !== "string" || typeof p.query !== "string") return invalidParams();
	const query = p.query;
	const session = sessions.get(key(p.sessionId, context));
	if (!session) return notFound();
	try {
		const files = (await Promise.all(session.roots.map(root => searchRoot(root, query)))).flat();
		context?.emitTo?.(context.connectionId ?? "", "fuzzyFileSearch/sessionUpdated", {
			sessionId: p.sessionId,
			query: p.query,
			files,
		});
		return { ok: true, result: {} };
	} catch {
		return internalError();
	}
};

function key(sessionId: string, context?: HandlerContext): string {
	return `${context?.connectionId ?? ""}\u0000${sessionId}`;
}

/** Return the working-tree diff against the configured upstream tracking branch. */
const gitDiffToRemoteHandler: MethodHandler = async params => {
	const p = record(params);
	if (!p || typeof p.cwd !== "string") return invalidParams();
	try {
		const repository = await repo.root(p.cwd);
		if (!repository) return notFound();
		const currentBranch = await branch.current(p.cwd);
		let upstream: string | undefined;
		if (currentBranch) {
			const remoteName = await config.get(p.cwd, `branch.${currentBranch}.remote`);
			const mergeRef = await config.get(p.cwd, `branch.${currentBranch}.merge`);
			if (remoteName && mergeRef) {
				const mergeBranch = mergeRef.replace(/^refs\/heads\//, "");
				upstream = `${remoteName}/${mergeBranch}`;
			}
		}
		if (!upstream) return notFound();
		const [sha, text] = await Promise.all([head.sha(p.cwd), diff(p.cwd, { base: upstream })]);
		if (!sha) return notFound();
		return { ok: true, result: { sha, diff: text } };
	} catch {
		return notFound();
	}
};

export const workspaceQueryHandlers: Record<string, MethodHandler> = {
	fuzzyFileSearch: fuzzyFileSearchHandler,
	"fuzzyFileSearch/sessionStart": fuzzyFileSearchSessionStartHandler,
	"fuzzyFileSearch/sessionStop": fuzzyFileSearchSessionStopHandler,
	"fuzzyFileSearch/sessionUpdate": fuzzyFileSearchSessionUpdateHandler,
	gitDiffToRemote: gitDiffToRemoteHandler,
};

export function getWorkspaceSearchSessionCount(): number {
	return sessions.size;
}
