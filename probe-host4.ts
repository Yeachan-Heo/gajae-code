import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DesktopHost } from "./packages/desktop-host/src/host";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-profile-probe-"));
const project = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-profile-project-"));
const frames: any[] = [];
const host = new DesktopHost({ dataDir, emit: frame => frames.push(frame) });
const call = async <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
	const id = crypto.randomUUID();
	const before = frames.length;
	await host.handle({ id, method, params } as any);
	const reply = frames.slice(before).find(f => f.type === "response" && f.id === id);
	if (!reply) throw new Error(`no response for ${method}`);
	if (!reply.ok) throw new Error(`${method}: ${reply.error}`);
	return reply.result as T;
};
const opened = await call<{ id: string }>("project.open", { path: project });
await call<unknown>("session.create", { projectId: opened.id });
await Bun.sleep(2000);
const last = frames.filter(f => f.type === "snapshot").at(-1)?.snapshot;
const session = last?.sessions?.[0];
console.log("model:", session?.model ?? null);
console.log("messages:", JSON.stringify((session?.messages ?? []).map((m: any) => `${m.role}: ${String(m.text).slice(0, 80)}`)));
await fs.rm(dataDir, { recursive: true, force: true });
await fs.rm(project, { recursive: true, force: true });
process.exit(0);
