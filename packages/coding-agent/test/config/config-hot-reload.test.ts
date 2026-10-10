import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	type ConfigHotReloadCandidate,
	type ConfigHotReloadError,
	type ConfigHotReloadPaths,
	ConfigHotReloadWatcher,
} from "../../src/config/config-hot-reload";

const temporaryDirectories: string[] = [];
const watchers: ConfigHotReloadWatcher[] = [];

async function temporaryDirectory(): Promise<string> {
	const projectState = path.resolve(import.meta.dir, "../../../../.gjc");
	await fs.mkdir(projectState, { recursive: true });
	const directory = await fs.mkdtemp(path.join(projectState, "config-hot-reload-"));
	temporaryDirectories.push(directory);
	return directory;
}

async function configPaths(directory: string): Promise<ConfigHotReloadPaths> {
	await fs.mkdir(directory, { recursive: true });
	const paths = { configPath: path.join(directory, "config.yml"), modelsPath: path.join(directory, "models.yml") };
	await fs.writeFile(paths.configPath, "config: initial\n");
	await fs.writeFile(paths.modelsPath, "models: initial\n");
	return paths;
}

async function atomicReplace(filePath: string, text: string): Promise<void> {
	const replacementPath = `${filePath}.replacement`;
	await fs.writeFile(replacementPath, text);
	await fs.rename(replacementPath, filePath);
}

function createWatcher(
	onCandidate: (candidate: ConfigHotReloadCandidate, signal: AbortSignal) => void | Promise<void>,
	onError: (error: ConfigHotReloadError) => void = () => {},
	onValidate: (candidate: ConfigHotReloadCandidate) => void | Promise<void> = () => {},
): ConfigHotReloadWatcher {
	const watcher = new ConfigHotReloadWatcher({ onCandidate, onError, onValidate });
	watchers.push(watcher);
	return watcher;
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 3_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = read();
		if (value !== undefined) return value;
		await Bun.sleep(10);
	}
	throw new Error("Timed out waiting for configuration hot reload");
}

afterEach(async () => {
	for (const watcher of watchers.splice(0)) watcher.dispose();
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

describe("configuration hot reload watcher", () => {
	test("delivers file snapshots for config and models changes and deduplicates identical self-writes", async () => {
		const directory = await temporaryDirectory();
		const paths = await configPaths(path.join(directory, "config"));
		const candidates: ConfigHotReloadCandidate[] = [];
		let selfWriteDone = false;
		const watcher = createWatcher(async candidate => {
			candidates.push(candidate);
			if (candidate.config.text === "config: external\n" && !selfWriteDone) {
				selfWriteDone = true;
				await atomicReplace(candidate.config.path, candidate.config.text);
			}
		});

		await watcher.start(paths);
		await fs.writeFile(path.join(path.dirname(paths.configPath), "unrelated.txt"), "ignore");
		await fs.writeFile(path.join(path.dirname(paths.configPath), "agent.db"), "ignore");
		await fs.writeFile(path.join(path.dirname(paths.configPath), "agent.db-wal"), "ignore");
		await fs.writeFile(path.join(directory, "agent.db"), "ignore");
		await fs.writeFile(path.join(directory, "agent.db-wal"), "ignore");
		await Bun.sleep(120);
		expect(candidates).toHaveLength(0);

		await atomicReplace(paths.configPath, "config: external\n");
		const configCandidate = await waitFor(() => candidates[0]);
		expect(configCandidate.config).toMatchObject({ path: paths.configPath, text: "config: external\n" });
		expect(configCandidate.models).toMatchObject({ path: paths.modelsPath, text: "models: initial\n" });
		expect(configCandidate.config.identity).toMatch(/^[a-f0-9]{64}$/);
		await Bun.sleep(400);
		expect(candidates).toHaveLength(1);

		await atomicReplace(paths.modelsPath, "models: changed\n");
		const modelsCandidate = await waitFor(() => candidates[1]);
		expect(modelsCandidate.models.text).toBe("models: changed\n");
		expect(modelsCandidate.config.text).toBe("config: external\n");
	});

	test("watches the nearest existing ancestor and discovers a later-created config directory", async () => {
		const directory = await temporaryDirectory();
		const paths = {
			configPath: path.join(directory, "not-created", "nested", "config.yml"),
			modelsPath: path.join(directory, "not-created", "nested", "models.yml"),
		};
		const candidates: ConfigHotReloadCandidate[] = [];
		const watcher = createWatcher(candidate => {
			candidates.push(candidate);
		});
		await watcher.start(paths);

		await fs.mkdir(path.dirname(paths.configPath), { recursive: true });
		await fs.writeFile(paths.configPath, "config: appeared\n");
		await fs.writeFile(paths.modelsPath, "models: appeared\n");
		const candidate = await waitFor(() => candidates[0]);
		expect(candidate.config.text).toBe("config: appeared\n");
		expect(candidate.models.text).toBe("models: appeared\n");
	});

	test("reports delete and recreate snapshots for a watched file", async () => {
		const directory = await temporaryDirectory();
		const paths = await configPaths(path.join(directory, "config"));
		const candidates: ConfigHotReloadCandidate[] = [];
		const watcher = createWatcher(candidate => {
			candidates.push(candidate);
		});
		await watcher.start(paths);

		await fs.rm(paths.configPath);
		const removed = await waitFor(() => candidates[0]);
		expect(removed.config.text).toBeNull();

		await fs.writeFile(paths.configPath, "config: recreated\n");
		const recreated = await waitFor(() => candidates[1]);
		expect(recreated.config.text).toBe("config: recreated\n");
	});

	test("detects deletion and recreation of the watched parent directory", async () => {
		const directory = await temporaryDirectory();
		const paths = await configPaths(path.join(directory, "config"));
		const candidates: ConfigHotReloadCandidate[] = [];
		const watcher = createWatcher(candidate => {
			candidates.push(candidate);
		});
		await watcher.start(paths);

		await fs.rm(path.dirname(paths.configPath), { recursive: true });
		const removed = await waitFor(() => candidates[0]);
		expect(removed.config.text).toBeNull();
		expect(removed.models.text).toBeNull();

		await fs.mkdir(path.dirname(paths.configPath), { recursive: true });
		await fs.writeFile(paths.configPath, "config: parent-recreated\n");
		await fs.writeFile(paths.modelsPath, "models: parent-recreated\n");
		const recreated = await waitFor(() => candidates[1]);
		expect(recreated.config.text).toBe("config: parent-recreated\n");
		expect(recreated.models.text).toBe("models: parent-recreated\n");
	});

	test("reopens descendant watches after parent replacement evidence with unchanged identity", async () => {
		const directory = await temporaryDirectory();
		const parentDirectory = path.join(directory, "parent");
		const configDirectory = path.join(parentDirectory, "nested");
		const paths = await configPaths(configDirectory);
		const candidates: ConfigHotReloadCandidate[] = [];
		const realWatch = nodeFs.watch;
		let parentChangeListener: ((eventType: string, filename: string | Buffer | null) => void) | undefined;
		let descendantWatchCount = 0;
		const watchSpy = spyOn(nodeFs, "watch").mockImplementation(
			new Proxy(realWatch, {
				apply(target, receiver, args) {
					const watcher = Reflect.apply(target, receiver, args);
					if (String(args[0]) === parentDirectory && typeof args[1] === "function") {
						parentChangeListener = args[1] as (eventType: string, filename: string | Buffer | null) => void;
					}
					if (String(args[0]) === configDirectory) descendantWatchCount++;
					return watcher;
				},
			}),
		);
		const watcher = createWatcher(candidate => {
			candidates.push(candidate);
		});
		try {
			await watcher.start(paths);
			expect(parentChangeListener).toBeDefined();
			expect(descendantWatchCount).toBe(1);

			parentChangeListener!("rename", "nested");
			await waitFor(() => (descendantWatchCount > 1 ? true : undefined));
			parentChangeListener!("change", null);
			await waitFor(() => (descendantWatchCount > 2 ? true : undefined));
		} finally {
			watchSpy.mockRestore();
		}

		await atomicReplace(paths.configPath, "config: descendant-reopened\n");
		const candidate = await waitFor(() =>
			candidates.find(item => item.config.text === "config: descendant-reopened\n"),
		);
		expect(candidate.config.text).toBe("config: descendant-reopened\n");
	});

	test("watches canonical config targets and follows symlink retargeting", async () => {
		const directory = await temporaryDirectory();
		const linkDirectory = path.join(directory, "links");
		const firstTargetDirectory = path.join(directory, "first-target");
		const secondTargetDirectory = path.join(directory, "second-target");
		await Promise.all([fs.mkdir(linkDirectory), fs.mkdir(firstTargetDirectory), fs.mkdir(secondTargetDirectory)]);
		const configPath = path.join(linkDirectory, "config.yml");
		const firstTargetPath = path.join(firstTargetDirectory, "config.yml");
		const secondTargetPath = path.join(secondTargetDirectory, "config.yml");
		const modelsPath = path.join(linkDirectory, "models.yml");
		await fs.writeFile(firstTargetPath, "config: target-one\n");
		await fs.writeFile(modelsPath, "models: initial\n");
		await fs.symlink(firstTargetPath, configPath);
		const paths = { configPath, modelsPath };
		const candidates: ConfigHotReloadCandidate[] = [];
		const watcher = createWatcher(candidate => {
			candidates.push(candidate);
		});
		await watcher.start(paths);

		await atomicReplace(firstTargetPath, "config: target-one-updated\n");
		await waitFor(() => candidates.find(candidate => candidate.config.text === "config: target-one-updated\n"));

		await fs.writeFile(secondTargetPath, "config: target-two\n");
		const replacementLink = `${configPath}.replacement`;
		await fs.symlink(secondTargetPath, replacementLink);
		await fs.rename(replacementLink, configPath);
		await waitFor(() => candidates.find(candidate => candidate.config.text === "config: target-two\n"));

		await atomicReplace(secondTargetPath, "config: target-two-updated\n");
		const retargeted = await waitFor(() =>
			candidates.find(candidate => candidate.config.text === "config: target-two-updated\n"),
		);
		expect(retargeted.config.path).toBe(configPath);
		expect(retargeted.config.text).toBe("config: target-two-updated\n");
	});

	test("rebinds after rapid parent replacement and retries a transient watch failure", async () => {
		const directory = await temporaryDirectory();
		const configDirectory = path.join(directory, "config");
		const paths = await configPaths(configDirectory);
		const candidates: ConfigHotReloadCandidate[] = [];
		const errors: ConfigHotReloadError[] = [];
		const realWatch = nodeFs.watch;
		let failedInitialWatch = false;
		const watchSpy = spyOn(nodeFs, "watch").mockImplementation(
			new Proxy(realWatch, {
				apply(target, receiver, args) {
					if (String(args[0]) === configDirectory && !failedInitialWatch) {
						failedInitialWatch = true;
						throw Object.assign(new Error("private watcher failure"), { code: "EACCES" });
					}
					return Reflect.apply(target, receiver, args);
				},
			}),
		);
		const watcher = createWatcher(
			candidate => {
				candidates.push(candidate);
			},
			error => {
				errors.push(error);
			},
		);
		try {
			await watcher.start(paths);
		} finally {
			watchSpy.mockRestore();
		}
		expect(failedInitialWatch).toBe(true);
		expect(errors).toHaveLength(1);
		expect(errors[0]?.message).not.toContain(configDirectory);

		const retiredDirectory = path.join(directory, "config-retired");
		await fs.rename(configDirectory, retiredDirectory);
		await fs.mkdir(configDirectory);
		await fs.writeFile(paths.configPath, "config: rapid-replacement\n");
		await fs.writeFile(paths.modelsPath, "models: rapid-replacement\n");
		await Bun.sleep(220);

		await fs.writeFile(paths.configPath, "config: later-save\n");
		const laterSave = await waitFor(() =>
			candidates.find(candidate => candidate.config.text === "config: later-save\n"),
		);
		expect(laterSave.models.text).toBe("models: rapid-replacement\n");
		expect(errors).toHaveLength(1);
	});

	test("re-arms a transient directory-watch open failure before a config-only save", async () => {
		const directory = await temporaryDirectory();
		const configDirectory = path.join(directory, "config");
		const paths = await configPaths(configDirectory);
		const candidates: ConfigHotReloadCandidate[] = [];
		const errors: ConfigHotReloadError[] = [];
		const realWatch = nodeFs.watch;
		let configWatchAttempts = 0;
		let recovered = false;
		const watchSpy = spyOn(nodeFs, "watch").mockImplementation(
			new Proxy(realWatch, {
				apply(target, receiver, args) {
					const isConfigDirectory = String(args[0]) === configDirectory;
					if (isConfigDirectory) {
						configWatchAttempts++;
						if (configWatchAttempts === 1) {
							throw Object.assign(new Error("private watcher failure"), { code: "EACCES" });
						}
					}
					const watcher = Reflect.apply(target, receiver, args);
					if (isConfigDirectory && configWatchAttempts === 2) recovered = true;
					return watcher;
				},
			}),
		);
		const watcher = createWatcher(
			candidate => {
				candidates.push(candidate);
			},
			error => {
				errors.push(error);
			},
		);
		try {
			await watcher.start(paths);
			await waitFor(() => (recovered ? true : undefined));
		} finally {
			watchSpy.mockRestore();
		}

		await atomicReplace(paths.configPath, "config: recovered after open failure\n");
		const recoveredCandidate = await waitFor(() =>
			candidates.find(candidate => candidate.config.text === "config: recovered after open failure\n"),
		);
		expect(recoveredCandidate.models.text).toBe("models: initial\n");
		expect(errors).toHaveLength(1);
	});

	test("re-arms a directory watcher after a runtime error before a config-only save", async () => {
		const directory = await temporaryDirectory();
		const configDirectory = path.join(directory, "config");
		const paths = await configPaths(configDirectory);
		const candidates: ConfigHotReloadCandidate[] = [];
		const errors: ConfigHotReloadError[] = [];
		const realWatch = nodeFs.watch;
		let configWatchAttempts = 0;
		let configWatcher: nodeFs.FSWatcher | undefined;
		let recovered = false;
		const watchSpy = spyOn(nodeFs, "watch").mockImplementation(
			new Proxy(realWatch, {
				apply(target, receiver, args) {
					const watcher = Reflect.apply(target, receiver, args);
					if (String(args[0]) === configDirectory) {
						configWatchAttempts++;
						if (configWatchAttempts === 1) configWatcher = watcher;
						if (configWatchAttempts === 2) recovered = true;
					}
					return watcher;
				},
			}),
		);
		const watcher = createWatcher(
			candidate => {
				candidates.push(candidate);
			},
			error => {
				errors.push(error);
			},
		);
		try {
			await watcher.start(paths);
			expect(configWatcher).toBeDefined();
			configWatcher!.emit("error", Object.assign(new Error("private runtime watcher failure"), { code: "EIO" }));
			await waitFor(() => (recovered ? true : undefined));
		} finally {
			watchSpy.mockRestore();
		}

		await atomicReplace(paths.configPath, "config: recovered after runtime failure\n");
		const recoveredCandidate = await waitFor(() =>
			candidates.find(candidate => candidate.config.text === "config: recovered after runtime failure\n"),
		);
		expect(recoveredCandidate.models.text).toBe("models: initial\n");
		expect(errors).toHaveLength(1);
	});

	test("coalesces pending changes to the newest revision and aborts older application", async () => {
		const directory = await temporaryDirectory();
		const paths = await configPaths(path.join(directory, "config"));
		const calls: { candidate: ConfigHotReloadCandidate; signal: AbortSignal }[] = [];
		const releaseFirst = Promise.withResolvers<void>();
		const validated: ConfigHotReloadCandidate[] = [];
		const watcher = createWatcher(
			async (candidate, signal) => {
				calls.push({ candidate, signal });
				if (candidate.config.text === "config: first\n") {
					await releaseFirst.promise;
				}
			},
			() => {},
			candidate => {
				validated.push(candidate);
			},
		);
		await watcher.start(paths);

		try {
			await atomicReplace(paths.configPath, "config: first\n");
			await waitFor(() => calls[0]);
			await atomicReplace(paths.configPath, "config: second\n");
			await waitFor(() => (calls[0]?.signal.aborted ? true : undefined));
			await atomicReplace(paths.configPath, "config: newest\n");
			await waitFor(() => validated.find(candidate => candidate.config.text === "config: newest\n"));
		} finally {
			releaseFirst.resolve();
		}
		const latestCall = await waitFor(() => calls[1]);
		expect(calls[0]?.signal.aborted).toBe(true);
		expect(latestCall.candidate.config.text).toBe("config: newest\n");
		expect(calls).toHaveLength(2);
	});

	test("bounds debounce while filesystem events continue", async () => {
		const directory = await temporaryDirectory();
		const paths = await configPaths(path.join(directory, "config"));
		const candidates: ConfigHotReloadCandidate[] = [];
		const watcher = createWatcher(candidate => {
			candidates.push(candidate);
		});
		await watcher.start(paths);

		const startedAt = Date.now();
		const writes = (async () => {
			for (let index = 0; index < 18; index += 1) {
				await fs.writeFile(paths.configPath, `config: burst-${index}\n`);
				await Bun.sleep(20);
			}
		})();
		const first = await waitFor(() => candidates[0]);
		expect(Date.now() - startedAt).toBeLessThan(700);
		await writes;
		const latest = await waitFor(() => candidates.find(candidate => candidate.config.text === "config: burst-17\n"));
		expect(first.revision).toBeLessThan(latest.revision);
	});

	test("retries a transient apply failure for the unchanged snapshot", async () => {
		const directory = await temporaryDirectory();
		const paths = await configPaths(path.join(directory, "config"));
		const attempts: ConfigHotReloadCandidate[] = [];
		const errors: ConfigHotReloadError[] = [];
		const watcher = createWatcher(
			candidate => {
				attempts.push(candidate);
				if (attempts.length === 1) {
					throw Object.assign(new Error("temporary apply contention"), { code: "EAGAIN" });
				}
			},
			error => {
				errors.push(error);
			},
		);
		await watcher.start(paths);

		await atomicReplace(paths.configPath, "config: transient-recovered\n");
		await waitFor(() => attempts[1]);
		expect(attempts[1]?.config.text).toBe("config: transient-recovered\n");
		expect(attempts[1]?.revision).toBe(attempts[0]?.revision);
		expect(attempts[1]?.config.identity).toBe(attempts[0]?.config.identity);
		await Bun.sleep(550);
		expect(attempts).toHaveLength(2);
		expect(errors.map(error => error.operation)).toEqual(["apply"]);
	});

	test("bounds retries for a repeatedly transient apply failure", async () => {
		const directory = await temporaryDirectory();
		const paths = await configPaths(path.join(directory, "config"));
		const attempts: ConfigHotReloadCandidate[] = [];
		const watcher = createWatcher(candidate => {
			attempts.push(candidate);
			throw Object.assign(new Error("temporary apply contention"), { code: "EBUSY" });
		});
		await watcher.start(paths);

		await atomicReplace(paths.configPath, "config: retry-limit\n");
		await waitFor(() => (attempts.length === 3 ? true : undefined));
		await Bun.sleep(550);
		expect(attempts).toHaveLength(3);
		expect(new Set(attempts.map(candidate => candidate.revision)).size).toBe(1);
	});

	test("retries a publication failure only when it has an explicit retryability signal", async () => {
		const directory = await temporaryDirectory();
		const paths = await configPaths(path.join(directory, "config"));
		const attempts: ConfigHotReloadCandidate[] = [];
		const watcher = createWatcher(candidate => {
			attempts.push(candidate);
			if (attempts.length === 1) {
				throw Object.assign(new Error("catalog changed during preflight"), {
					code: "PUBLICATION_FAILED",
					retryable: true,
				});
			}
		});
		await watcher.start(paths);

		await atomicReplace(paths.configPath, "config: catalog-churn\n");
		await waitFor(() => attempts[1]);
		expect(attempts[1]?.revision).toBe(attempts[0]?.revision);
		await Bun.sleep(550);
		expect(attempts).toHaveLength(2);
	});

	test("does not retry an ordinary publication failure", async () => {
		const directory = await temporaryDirectory();
		const paths = await configPaths(path.join(directory, "config"));
		const attempts: ConfigHotReloadCandidate[] = [];
		const watcher = createWatcher(candidate => {
			attempts.push(candidate);
			throw Object.assign(new Error("publication rejected"), { code: "PUBLICATION_FAILED" });
		});
		await watcher.start(paths);

		await atomicReplace(paths.configPath, "config: deterministic-publication-error\n");
		await waitFor(() => attempts[0]);
		await Bun.sleep(550);
		expect(attempts).toHaveLength(1);
	});

	test("does not retry a transient failure after a newer snapshot supersedes it", async () => {
		const directory = await temporaryDirectory();
		const paths = await configPaths(path.join(directory, "config"));
		const attempts: ConfigHotReloadCandidate[] = [];
		const errors: ConfigHotReloadError[] = [];
		const watcher = createWatcher(
			candidate => {
				attempts.push(candidate);
				if (candidate.config.text === "config: superseded\n") {
					throw Object.assign(new Error("temporary apply contention"), { code: "EAGAIN" });
				}
			},
			error => {
				errors.push(error);
			},
		);
		await watcher.start(paths);

		await atomicReplace(paths.configPath, "config: superseded\n");
		await waitFor(() => errors[0]);
		await atomicReplace(paths.configPath, "config: newest\n");
		await waitFor(() => attempts.find(candidate => candidate.config.text === "config: newest\n"));
		await Bun.sleep(200);
		expect(attempts.map(candidate => candidate.config.text)).toEqual(["config: superseded\n", "config: newest\n"]);
	});

	test("does not retry an apply failure after its signal is aborted", async () => {
		const directory = await temporaryDirectory();
		const paths = await configPaths(path.join(directory, "config"));
		const attempts: ConfigHotReloadCandidate[] = [];
		const errors: ConfigHotReloadError[] = [];
		const firstStarted = Promise.withResolvers<void>();
		const watcher = createWatcher(
			async (candidate, signal) => {
				attempts.push(candidate);
				if (candidate.config.text !== "config: abort-me\n") return;
				firstStarted.resolve();
				const aborted = Promise.withResolvers<void>();
				signal.addEventListener("abort", () => aborted.resolve(), { once: true });
				await aborted.promise;
				throw Object.assign(new Error("temporary apply contention"), { code: "EBUSY" });
			},
			error => {
				errors.push(error);
			},
		);
		await watcher.start(paths);

		await atomicReplace(paths.configPath, "config: abort-me\n");
		await firstStarted.promise;
		await atomicReplace(paths.configPath, "config: after-abort\n");
		await waitFor(() => attempts.find(candidate => candidate.config.text === "config: after-abort\n"));
		await Bun.sleep(200);
		expect(attempts.map(candidate => candidate.config.text)).toEqual(["config: abort-me\n", "config: after-abort\n"]);
		expect(errors).toEqual([]);
	});

	test("reports safe callback errors and accepts a later repaired snapshot", async () => {
		const directory = await temporaryDirectory();
		const paths = await configPaths(path.join(directory, "config"));
		const errors: ConfigHotReloadError[] = [];
		const accepted: ConfigHotReloadCandidate[] = [];
		let rejectedAttempts = 0;
		const watcher = createWatcher(
			candidate => {
				if (candidate.config.text === "config: invalid secret-value\n") {
					rejectedAttempts++;
					throw new Error("private config contents: secret-value");
				}
				accepted.push(candidate);
			},
			error => {
				errors.push(error);
			},
		);
		await watcher.start(paths);

		await atomicReplace(paths.configPath, "config: invalid secret-value\n");
		const diagnostic = await waitFor(() => errors[0]);
		expect(diagnostic.operation).toBe("apply");
		expect(diagnostic.message).not.toContain("secret-value");
		await Bun.sleep(550);
		expect(rejectedAttempts).toBe(1);

		await atomicReplace(paths.configPath, "config: repaired\n");
		const candidate = await waitFor(() => accepted[0]);
		expect(candidate.config.text).toBe("config: repaired\n");
	});

	test("invalid newer candidates do not cancel a validated pending candidate", async () => {
		const directory = await temporaryDirectory();
		const paths = await configPaths(path.join(directory, "config"));
		const calls: { candidate: ConfigHotReloadCandidate; signal: AbortSignal }[] = [];
		const errors: ConfigHotReloadError[] = [];
		const firstStarted = Promise.withResolvers<void>();
		const pendingValidated = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		const watcher = createWatcher(
			async (candidate, signal) => {
				calls.push({ candidate, signal });
				if (candidate.config.text === "config: first\n") {
					firstStarted.resolve();
					await releaseFirst.promise;
				}
			},
			error => {
				errors.push(error);
			},
			candidate => {
				if (candidate.config.text === "config: pending\n") pendingValidated.resolve();
				if (candidate.config.text === "config: invalid secret\n") {
					throw new Error("invalid config contained secret");
				}
			},
		);
		await watcher.start(paths);

		await atomicReplace(paths.configPath, "config: first\n");
		await firstStarted.promise;
		await atomicReplace(paths.configPath, "config: pending\n");
		await pendingValidated.promise;
		await Bun.sleep(15);
		const abortedBeforeInvalid = calls[0]?.signal.aborted;
		await atomicReplace(paths.configPath, "config: invalid secret\n");
		const validationError = await waitFor(() => errors[0]);
		expect(validationError.operation).toBe("validate");
		expect(validationError.message).not.toContain("secret");
		expect(calls[0]?.signal.aborted).toBe(abortedBeforeInvalid);

		releaseFirst.resolve();
		const pendingCall = await waitFor(() => calls.find(call => call.candidate.config.text === "config: pending\n"));
		expect(pendingCall.signal.aborted).toBe(false);
		expect(calls.some(call => call.candidate.config.text === "config: invalid secret\n")).toBe(false);

		await atomicReplace(paths.configPath, "config: repaired\n");
		await waitFor(() => calls.find(call => call.candidate.config.text === "config: repaired\n"));
		await atomicReplace(paths.configPath, "config: invalid secret\n");
		await waitFor(() => errors[1]);
		expect(errors).toHaveLength(2);
	});

	test("an older delayed validation cannot run after a newer candidate applies", async () => {
		const directory = await temporaryDirectory();
		const paths = await configPaths(path.join(directory, "config"));
		const applied: ConfigHotReloadCandidate[] = [];
		const errors: ConfigHotReloadError[] = [];
		let oldValidationStarted = false;
		const releaseOldValidation = Promise.withResolvers<void>();
		const watcher = createWatcher(
			candidate => {
				applied.push(candidate);
			},
			error => {
				errors.push(error);
			},
			candidate => {
				if (candidate.config.text !== "config: old\n") return;
				oldValidationStarted = true;
				return releaseOldValidation.promise;
			},
		);
		await watcher.start(paths);

		try {
			await atomicReplace(paths.configPath, "config: old\n");
			await waitFor(() => (oldValidationStarted ? true : undefined));
			await atomicReplace(paths.configPath, "config: newest\n");
			await waitFor(() => applied.find(candidate => candidate.config.text === "config: newest\n"));
		} finally {
			releaseOldValidation.resolve();
		}
		await Bun.sleep(120);
		expect(applied.map(candidate => candidate.config.text)).toEqual(["config: newest\n"]);
		expect(errors).toEqual([]);
	});

	test("deduplicates read errors until a successful read recovers", async () => {
		const directory = await temporaryDirectory();
		const paths = await configPaths(path.join(directory, "config"));
		const errors: ConfigHotReloadError[] = [];
		const candidates: ConfigHotReloadCandidate[] = [];
		const watcher = createWatcher(
			candidate => {
				candidates.push(candidate);
			},
			error => {
				errors.push(error);
			},
		);
		await watcher.start(paths);
		await fs.rm(paths.configPath);
		await fs.mkdir(paths.configPath);
		await atomicReplace(paths.modelsPath, "models: initial\n");
		await waitFor(() => errors[0]);
		expect(errors[0]?.operation).toBe("read");
		expect(errors[0]?.message).not.toContain(paths.configPath);

		await atomicReplace(paths.modelsPath, "models: repeated-read\n");
		await Bun.sleep(160);
		expect(errors).toHaveLength(1);

		await fs.rm(paths.configPath, { recursive: true });
		await atomicReplace(paths.configPath, "config: read-recovered\n");
		const recovered = await waitFor(() =>
			candidates.find(candidate => candidate.config.text === "config: read-recovered\n"),
		);
		expect(recovered.config.text).toBe("config: read-recovered\n");

		await fs.rm(paths.configPath);
		await fs.mkdir(paths.configPath);
		await atomicReplace(paths.modelsPath, "models: read-failed-again\n");
		await waitFor(() => errors[1]);
		expect(errors).toHaveLength(2);
	});

	test("rebinds paths and dispose prevents late callbacks", async () => {
		const directory = await temporaryDirectory();
		const firstPaths = await configPaths(path.join(directory, "first"));
		const nextPaths = await configPaths(path.join(directory, "next"));
		const calls: { candidate: ConfigHotReloadCandidate; signal: AbortSignal }[] = [];
		const watcher = createWatcher(async (candidate, signal) => {
			calls.push({ candidate, signal });
			if (candidate.config.text === "config: active\n") {
				const aborted = Promise.withResolvers<void>();
				signal.addEventListener("abort", () => aborted.resolve(), { once: true });
				await aborted.promise;
			}
		});
		await watcher.start(firstPaths);
		await watcher.rebind(nextPaths);

		await atomicReplace(firstPaths.configPath, "config: stale\n");
		await Bun.sleep(140);
		expect(calls).toHaveLength(0);

		await atomicReplace(nextPaths.configPath, "config: active\n");
		await waitFor(() => calls[0]);
		watcher.dispose();
		expect(calls[0]?.signal.aborted).toBe(true);
		await atomicReplace(nextPaths.configPath, "config: after-dispose\n");
		await Bun.sleep(140);
		expect(calls).toHaveLength(1);
	});

	test("does not report watcher initialization failures from a retired binding", async () => {
		const directory = await temporaryDirectory();
		const firstDirectory = path.join(directory, "first");
		const firstPaths = await configPaths(firstDirectory);
		const nextPaths = await configPaths(path.join(directory, "next"));
		const errors: ConfigHotReloadError[] = [];
		const watcher = createWatcher(
			() => {},
			error => {
				errors.push(error);
			},
		);
		const realStat = fs.stat;
		const delayedStat = Promise.withResolvers<nodeFs.Stats>();
		let firstDirectoryStatCalls = 0;
		let statBlocked = false;
		let statSettled = false;
		const statSpy = spyOn(fs, "stat").mockImplementation(
			new Proxy(realStat, {
				apply(target, receiver, args) {
					if (String(args[0]) === firstDirectory) {
						firstDirectoryStatCalls++;
						if (firstDirectoryStatCalls === 3) {
							statBlocked = true;
							return delayedStat.promise;
						}
					}
					return Reflect.apply(target, receiver, args);
				},
			}),
		);
		const starting = watcher.start(firstPaths);
		try {
			await waitFor(() => (statBlocked ? true : undefined));
			await watcher.rebind(nextPaths);
			statSettled = true;
			delayedStat.reject(new Error("retired watcher initialization failure"));
			await starting;
			expect(errors).toEqual([]);
		} finally {
			if (!statSettled) {
				statSettled = true;
				delayedStat.reject(new Error("test cleanup"));
			}
			statSpy.mockRestore();
			await starting.catch(() => {});
		}
	});
});
