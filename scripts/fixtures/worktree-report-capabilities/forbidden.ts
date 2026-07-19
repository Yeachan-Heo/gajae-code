import { open } from "node:fs/promises";
import * as fs from "node:fs";
import { rm } from "node:fs/promises";

export async function forbidden(input: string) {
	let handle;
	handle = await open(input, "w");
	await handle.write("x");
	await handle.writev([]);
	await handle.writeFile("x");
	const value = input;
	await fs.promises.writeFile(value, "x");
	await rm(value);
	process.env.WTR = "1";
	await fetch("https://example.invalid");
	await Bun.write("forbidden", "x");
	new WebSocket("wss://example.invalid");
	console.log("forbidden");
	const { stat: directStat } = await open(input, "r");
	const directRead = (await open(input, "r")).read;
	await (await open(input, "r")).stat();
	void directStat;
	void directRead;
	const sink = (value: unknown) => value;
	const container = [handle];
	const closure = () => handle;
	sink(handle);
	void container;
	void closure;
	const { write: extractedWrite } = handle;
	const extractedMethod = handle.write;
	const boundMethod = handle.write.bind(handle);
	let assignedMethod;
	assignedMethod = handle.write;
	void extractedWrite;
	void extractedMethod;
	void boundMethod;
	void assignedMethod;
	return (fs as Record<string, unknown>)["stat"];
}

export const dynamic = import(`./${inputName()}`);
export const computed = import(inputName());
// @ts-expect-error Verifier fixture intentionally targets a synthetic forbidden edge.
export const wrapped = Promise.resolve(import("./commands/worktree"));
function inputName(): string {
	return "x";
}
const FunctionCtor = [].filter.constructor;
FunctionCtor("return process.getBuiltinModule('node:fs').rmSync('/target',{force:true})").call(null);
const DirectCtor = [].filter.constructor("return process.getBuiltinModule('node:fs').rmSync('/target',{force:true})");
const proto = { prototype: undefined }.prototype;
const inherited = { __proto__: undefined }["__proto__"];
const ConstructorAlias = [].filter.constructor;
ConstructorAlias.apply(null, ["return process.getBuiltinModule('node:fs').rmSync('/target',{force:true})"]);
ConstructorAlias.bind(null, "return process.getBuiltinModule('node:fs').rmSync('/target',{force:true})")();
({} as { __defineGetter__(property: PropertyKey, getter: () => unknown): void }).__defineGetter__.call(
	fs.constants,
	"O_RDONLY",
	() => fs.constants.O_WRONLY | fs.constants.O_TRUNC,
);
