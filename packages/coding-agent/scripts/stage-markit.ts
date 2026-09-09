import * as fs from "node:fs/promises";
import * as module from "node:module";
import * as path from "node:path";

const packageRoot = path.resolve(import.meta.dir, "..");
const receiptName = ".markit-pack-owner.json";

interface Manifest {
	name: string;
	version: string;
	dependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

async function resolvePackage(name: string, importer: string): Promise<string> {
	const require = module.createRequire(path.join(importer, "package.json"));
	for (const modules of require.resolve.paths(`${name}/package.json`) ?? []) {
		const candidate = path.join(modules, name);
		if (await Bun.file(path.join(candidate, "package.json")).exists()) return fs.realpath(candidate);
	}
	throw new Error(`Cannot stage runtime dependency ${name} from ${importer}`);
}

async function assertPatchedMarkit(directory: string): Promise<void> {
	const manifest: Manifest = await Bun.file(path.join(directory, "package.json")).json();
	const extract = await Bun.file(path.join(directory, "dist/converters/pdf/extract.js")).text();
	const markit = await Bun.file(path.join(directory, "dist/markit.js")).text();
	if (
		manifest.name !== "markit-ai" ||
		manifest.version !== "0.5.3" ||
		/require\(["']mupdf["']\)/u.test(extract) ||
		!extract.includes("\nlet mupdf;\n") ||
		!extract.includes('mupdf = await import("mupdf")') ||
		!extract.includes('new Error("MuPDF module initialization failed", { cause })') ||
		!markit.includes("new AggregateError(errors.map((entry) => entry.error)") ||
		!markit.includes("{ cause: errors[0].error }")
	)
		throw new Error(
			"Publishing requires the patched markit-ai@0.5.3 installation; run the repository Bun install first",
		);
	await fs.access(path.join(directory, "LICENSE"));
}

/** Copy installed runtime packages, not registry bytes or a root-only patch recipe. */
export async function stageMarkit(sourcePackage: string, targetPackage: string): Promise<void> {
	const source = await resolvePackage("markit-ai", sourcePackage);
	await assertPatchedMarkit(source);
	const target = path.join(targetPackage, "node_modules/markit-ai");
	await fs.mkdir(path.dirname(target), { recursive: true });
	// An exclusive mkdir establishes ownership. Never replace installed user dependencies.
	await fs.mkdir(target);
	try {
		async function copyPackage(from: string, to: string, ancestors: Map<string, string>): Promise<void> {
			await fs.mkdir(to, { recursive: true });
			for (const entry of await fs.readdir(from)) {
				if (entry === "node_modules" || entry.startsWith(".bun-tag-")) continue;
				await fs.cp(path.join(from, entry), path.join(to, entry), {
					recursive: true,
					dereference: true,
					force: false,
					errorOnExist: true,
				});
			}
			const manifest: Manifest = await Bun.file(path.join(from, "package.json")).json();
			const available = new Map(ancestors).set(manifest.name, from);
			const optional = manifest.optionalDependencies ?? {};
			const names = new Set([
				...Object.keys(manifest.dependencies ?? {}),
				...Object.keys(optional),
				...Object.keys(manifest.peerDependencies ?? {}),
			]);
			for (const name of [...names].sort()) {
				let dependency: string;
				try {
					dependency = await resolvePackage(name, from);
				} catch (error) {
					if (name in optional || manifest.peerDependenciesMeta?.[name]?.optional) continue;
					throw error;
				}
				if (available.get(name) === dependency) continue;
				await copyPackage(dependency, path.join(to, "node_modules", name), available);
			}
		}
		await copyPackage(source, target, new Map());
		async function normalizeModes(directory: string): Promise<void> {
			await fs.chmod(directory, 0o755);
			for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
				const filename = path.join(directory, entry.name);
				if (entry.isDirectory()) await normalizeModes(filename);
				else if (entry.isFile()) {
					const mode = (await fs.stat(filename)).mode;
					await fs.chmod(filename, mode & 0o111 ? 0o755 : 0o644);
				} else throw new Error(`Unsupported staged package entry: ${filename}`);
			}
		}
		await normalizeModes(target);
		await assertPatchedMarkit(target);
		const mupdf = await resolvePackage("mupdf", target);
		if (!mupdf.startsWith(`${await fs.realpath(target)}${path.sep}`)) {
			throw new Error("Staged Markit must contain its own MuPDF runtime");
		}
		await fs.access(path.join(mupdf, "LICENSE"));
		await fs.access(path.join(mupdf, "dist/mupdf.js"));
		await fs.access(path.join(mupdf, "dist/mupdf-wasm.wasm"));
	} catch (error) {
		await fs.rm(target, { recursive: true, force: true });
		throw error;
	}
}

async function directPack(): Promise<void> {
	const receipt = path.join(packageRoot, receiptName);
	const handle = await fs.open(receipt, "wx");
	try {
		await stageMarkit(packageRoot, packageRoot);
		const metadata = await fs.lstat(path.join(packageRoot, "node_modules/markit-ai"));
		await handle.writeFile(JSON.stringify({ dev: metadata.dev, ino: metadata.ino }));
	} catch (error) {
		await fs.rm(receipt);
		throw error;
	} finally {
		await handle.close();
	}
}

async function cleanupDirectPack(): Promise<void> {
	const receipt = path.join(packageRoot, receiptName);
	const owner: { dev: number; ino: number } = await Bun.file(receipt).json();
	const target = path.join(packageRoot, "node_modules/markit-ai");
	const metadata = await fs.lstat(target);
	if (!metadata.isDirectory() || metadata.dev !== owner.dev || metadata.ino !== owner.ino) {
		throw new Error("Refusing to clean a Markit directory not owned by this pack operation");
	}
	await fs.rm(target, { recursive: true });
	await fs.rm(receipt);
}

if (import.meta.main) {
	if (process.argv[2] === "stage") await directPack();
	else if (process.argv[2] === "cleanup") await cleanupDirectPack();
	else throw new Error("Expected stage or cleanup");
}
