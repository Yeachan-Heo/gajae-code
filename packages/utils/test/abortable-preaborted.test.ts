import { expect, it } from "bun:test";

it("pre-aborted wrapper observes a rejected already-started promise without process-level rejection", async () => {
	const moduleUrl = new URL("../src/abortable.ts", import.meta.url).href;
	const script = `import{untilAborted}from${JSON.stringify(moduleUrl)};const c=new AbortController();c.abort();const e=[];process.on('unhandledRejection',x=>e.push(String(x)));try{await untilAborted(c.signal,Promise.reject(Error('upstream failure')));}catch{}await Bun.sleep(20);console.log(JSON.stringify(e));`;
	const child = Bun.spawn([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe" });
	const [text, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
	expect(JSON.parse(text.trim())).toEqual([]);
});
it("pre-aborted lazy work is not invoked", async () => {
	const { untilAborted } = await import("../src/abortable");
	const c = new AbortController();
	c.abort();
	let called = 0;
	await expect(
		untilAborted(c.signal, async () => {
			called++;
		}),
	).rejects.toThrow();
	expect(called).toBe(0);
});

it("preserves ordinary result and rejection and settles on a later abort", async () => {
	const { untilAborted } = await import("../src/abortable");
	const controller = new AbortController();
	expect(await untilAborted(controller.signal, Promise.resolve(42))).toBe(42);
	await expect(untilAborted(controller.signal, Promise.reject(new Error("original")))).rejects.toThrow("original");
	const pending = Promise.withResolvers<void>();
	const wrapped = untilAborted(controller.signal, pending.promise);
	controller.abort(new Error("stop"));
	await expect(wrapped).rejects.toThrow("stop");
	pending.reject(new Error("late work failure"));
	await Promise.resolve();
});
