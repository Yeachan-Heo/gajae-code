// Prints the Vertex location this process resolves, and the request origin it
// would produce. Spawned with a controlled cwd so the caller can plant a project
// `.env`: the env module parses `projectEnv` at load time from `process.cwd()`.
import { resolveVertexLocationForTest } from "@gajae-code/ai/providers/google-vertex";

function outcome(): { location: string | null; origin: string | null; error: string | null } {
	try {
		const location = resolveVertexLocationForTest();
		const host = location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
		return { location, origin: new URL(`https://${host}/v1/x`).origin, error: null };
	} catch (err) {
		return { location: null, origin: null, error: (err as Error).message };
	}
}

console.log(JSON.stringify(outcome()));
