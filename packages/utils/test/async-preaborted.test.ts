import { expect, it } from "bun:test";
import { withTimeout } from "../src/async";

it("pre-aborted timeout observes an already-started rejected operation", async () => {
	const moduleUrl = new URL("../src/async.ts", import.meta.url).href;
	const script = `import{withTimeout}from${JSON.stringify(moduleUrl)};const c=new AbortController();c.abort(new Error('cancelled'));const errors=[];process.on('unhandledRejection',x=>errors.push(String(x)));try{await withTimeout(Promise.reject(Error('connection failed')),1000,'timeout',c.signal);}catch{}await Bun.sleep(20);console.log(JSON.stringify(errors));`;
	const child = Bun.spawn([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe" });
	const [text, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
	expect(JSON.parse(text.trim())).toEqual([]);
});

it("preserves the caller abort reason and ordinary settlement", async () => {
	const c = new AbortController();
	const reason = new Error("caller cancelled");
	c.abort(reason);
	await expect(withTimeout(Promise.resolve(42), 1000, "timeout", c.signal)).rejects.toBe(reason);
	expect(await withTimeout(Promise.resolve(42), 1000, "timeout")).toBe(42);
	const failure = new Error("original failure");
	await expect(withTimeout(Promise.reject(failure), 1000, "timeout")).rejects.toBe(failure);
});
it("keeps timeout and later abort behavior", async () => {
	const pending = Promise.withResolvers<void>();
	await expect(withTimeout(pending.promise, 1, "expired")).rejects.toThrow("expired");
	const c = new AbortController();
	const reason = new Error("later cancellation");
	const wrapped = withTimeout(pending.promise, 1000, "timeout", c.signal);
	c.abort(reason);
	await expect(wrapped).rejects.toBe(reason);
	pending.reject(new Error("late failure"));
	await Promise.resolve();
});
