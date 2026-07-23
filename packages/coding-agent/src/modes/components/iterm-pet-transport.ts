/** Protocol-correct direct and managed iTerm2 Pet capability transport. */
import { parseITerm2CapabilityReply, wrapITerm2RecordForTmux } from "@gajae-code/tui";
export const PET_CAPABILITY_DRAIN_MAX_MS = 100;
export const PET_CAPABILITY_QUIESCENCE_MS = 25;
export const PET_CAPABILITY_QUERY_TIMEOUT_MS = 1000;
export const PET_TOPOLOGY_POLL_MS = 250;
export type PetTransportMode = "direct" | "managed";
export type PetUnavailableReason =
	| "not-iterm2"
	| "tty-unavailable"
	| "missing-f"
	| "invalid-f"
	| "probe-timeout"
	| "topology-ineligible"
	| "topology-lost"
	| "zero-client-recovery"
	| "cleanup-failed";
export type PetTransportAvailability = Readonly<{
	available: boolean;
	mode: PetTransportMode;
	reason?: PetUnavailableReason;
	epoch: number;
}>;
export type PetTransportClock = Readonly<{
	now(): number;
	setTimeout(callback: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}>;
export type PetTransportInput = Readonly<{
	drain(maxMs: number, quiescenceMs: number): Promise<void>;
	onData(callback: (data: Uint8Array | string) => PetInputResult | undefined): () => void;
}>;
export type PetInputResult = Readonly<{ consume?: true; data?: string }>;
export type NativePetUi = Readonly<{
	drainInput(maxMs: number, quiescenceMs: number): Promise<void>;
	addInputListener(callback: (data: string | Uint8Array) => unknown): () => void;
	submitTerminalOutput(
		request: Readonly<{ operation: Readonly<{ type: "raster-probe"; bytes: Uint8Array }> }>,
	): Promise<Readonly<{ status?: string; written?: number }>>;
	notifyTerminalLifecycle(
		event: Readonly<{
			kind: "availability-restored" | "explicit-cleanup";
			source: "transport";
			terminalGeneration: number;
		}>,
	): Promise<unknown>;
	readonly terminalGeneration: number;
}>;
export type PetTransportOutput = Readonly<{
	write(bytes: Uint8Array): Promise<Readonly<{ status: "written" | "failed" }>>;
	notifyLifecycle?(
		event: Readonly<{ kind: "availability-restored" | "explicit-cleanup"; terminalGeneration: number }>,
	): Promise<unknown>;
}>;
export type PetTmuxResult = Readonly<{ status: number; stdout: string; stderr?: string }>;
export type PetTmuxRunner = (argv: readonly string[]) => Promise<PetTmuxResult | string>;
export type PetTmuxTopology = Readonly<{
	clients: number;
	paneId?: string;
	ownedPaneId?: string;
	clientId?: string;
	clientVersion?: string;
}>;
const text = (v: Uint8Array | string) => (typeof v === "string" ? v : new TextDecoder().decode(v));
export function hasItermFileCapability(v: Uint8Array | string): boolean {
	return parseITerm2CapabilityReply(v) === "complete-f";
}
export function consumeCapabilityInput(callback: (data: Uint8Array | string) => void) {
	const marker = "\x1b]1337;Capabilities";
	const maxFragment = 8192;
	let fragment = "";
	return (data: string | Uint8Array): PetInputResult | undefined => {
		const combined = fragment + text(data);
		fragment = "";
		let offset = 0;
		let consumed = false;
		let passthrough = "";
		while (offset < combined.length) {
			const start = combined.indexOf(marker, offset);
			if (start < 0) {
				const suffixLength = Math.min(marker.length - 1, combined.length - offset);
				const candidate = combined.slice(combined.length - suffixLength);
				const keep = candidate && marker.startsWith(candidate) ? candidate : "";
				passthrough += combined.slice(offset, combined.length - keep.length);
				fragment = keep;
				break;
			}
			passthrough += combined.slice(offset, start);
			const end = combined.slice(start + marker.length).search(/(?:\x07|\x1b\\)/);
			if (end < 0) {
				const pending = combined.slice(start);
				if (pending.length <= maxFragment) fragment = pending;
				else passthrough += pending;
				consumed = true;
				break;
			}
			const terminator = combined[start + marker.length + end];
			const length = marker.length + end + (terminator === "\x1b" ? 2 : 1);
			callback(combined.slice(start, start + length));
			consumed = true;
			offset = start + length;
		}
		if (passthrough) return { data: passthrough };
		return consumed || fragment ? { consume: true } : undefined;
	};
}
export function capabilityProbe() {
	return new TextEncoder().encode("\x1b]1337;Capabilities\x07");
}
const result = (r: PetTmuxResult | string): PetTmuxResult => (typeof r === "string" ? { status: 0, stdout: r } : r);

export function isItermCandidate(
	env: NodeJS.ProcessEnv = Bun.env,
	tty = Boolean(process.stdin.isTTY && process.stdout.isTTY),
): boolean {
	const v = env.TERM_PROGRAM_VERSION?.split(".").map(Number);
	return env.TERM_PROGRAM === "iTerm.app" && tty && !!v && v[0] >= 3 && (v[0] > 3 || (v[1] ?? 0) >= 5);
}
export function createNativePetTransport(o: {
	ui: NativePetUi;
	env?: NodeJS.ProcessEnv;
	topology?: () => Promise<PetTmuxTopology>;
}): ItermPetTransport | undefined {
	const env = o.env ?? Bun.env;
	const managed = Boolean(
		env.GJC_TMUX_ACTIVE_SESSION?.trim() && env.TMUX_PANE?.trim() && env.GJC_MANAGED_OWNER_RUN_ID?.trim(),
	);
	const tmuxContext = Boolean(env.TMUX_PANE?.trim() || env.GJC_TMUX_ACTIVE_SESSION?.trim());
	if (tmuxContext && !managed) return undefined;
	if (!isItermCandidate(env, true)) return undefined;
	const clock: PetTransportClock = { now: Date.now, setTimeout, clearTimeout };
	const input: PetTransportInput = {
		drain: (a, b) => o.ui.drainInput?.(a, b) ?? Promise.resolve(),
		onData: cb => {
			const consume = consumeCapabilityInput(cb);
			return o.ui.addInputListener((d: string | Uint8Array) => consume(d));
		},
	};
	const output: PetTransportOutput = {
		write: async bytes => {
			const r = await o.ui.submitTerminalOutput({ operation: { type: "raster-probe", bytes } });
			return { status: r?.status === "written" || (r?.written ?? 0) > 0 ? "written" : "failed" };
		},
		notifyLifecycle: e =>
			o.ui.notifyTerminalLifecycle({ ...e, source: "transport", terminalGeneration: o.ui.terminalGeneration }),
	};
	const tmux: PetTmuxRunner | undefined = managed
		? async argv => {
				const p = Bun.spawn(["tmux", ...argv], { stdout: "pipe", stderr: "pipe" });
				return {
					status: await p.exited,
					stdout: await new Response(p.stdout).text(),
					stderr: await new Response(p.stderr).text(),
				};
			}
		: undefined;
	return new ItermPetTransport({
		mode: managed ? "managed" : "direct",
		ttyCandidate: true,
		clock,
		input,
		output,
		tmux,
		paneId: env.TMUX_PANE,
		sessionTarget: env.GJC_TMUX_ACTIVE_SESSION,
		topology: o.topology,
	});
}

export class ItermPetTransport {
	#epoch = 0;
	#available = false;
	#reason?: PetUnavailableReason;
	#pending = false;
	#unsubscribe?: () => void;
	#timeout?: unknown;
	#disposed = false;
	#poll?: unknown;
	#listeners = new Set<(a: PetTransportAvailability) => void>();
	#snapshot?: "unset" | { value: string };
	#restored = false;
	#restoreInFlight?: Promise<void>;
	#paneTransaction: Promise<void> = Promise.resolve();
	readonly #clock;
	readonly #input;
	readonly #output;
	readonly #tmux;
	readonly #ttyCandidate;
	readonly #paneId?: string;
	readonly #sessionTarget?: string;
	readonly #topology?: () => Promise<PetTmuxTopology>;
	readonly #mode: PetTransportMode;
	readonly #expectedClientId?: string;
	#observedClientId?: string;
	#pendingResolve?: (availability: PetTransportAvailability) => void;
	constructor(
		o: Readonly<{
			mode?: PetTransportMode;
			ttyCandidate?: boolean;
			clock: PetTransportClock;
			input: PetTransportInput;
			output: PetTransportOutput;
			tmux?: PetTmuxRunner;
			ownedPaneId?: string;
			paneId?: string;
			sessionTarget?: string;
			topology?: () => Promise<PetTmuxTopology>;
			expectedClientId?: string;
		}>,
	) {
		this.#mode = o.mode ?? "direct";
		this.#ttyCandidate = o.ttyCandidate ?? true;
		this.#clock = o.clock;
		this.#input = o.input;
		this.#output = o.output;
		this.#tmux = o.tmux;
		this.#paneId = o.ownedPaneId ?? o.paneId;
		this.#sessionTarget = o.sessionTarget;
		this.#topology = o.topology;
		this.#expectedClientId = o.expectedClientId;
	}
	#notifyLifecycle(
		event: Readonly<{ kind: "availability-restored" | "explicit-cleanup"; terminalGeneration: number }>,
	) {
		try {
			const notification = this.#output.notifyLifecycle?.(event);
			if (notification !== undefined) void notification.catch(() => undefined);
		} catch {
			// Lifecycle notifications are observational and must not affect transport state.
		}
	}

	get availability() {
		return { available: this.#available, mode: this.#mode, reason: this.#reason, epoch: this.#epoch };
	}
	async refreshManagedClient(row: number, column: number): Promise<boolean> {
		if (this.#mode === "direct") return true;
		if (!Number.isInteger(row) || row < 0 || !Number.isInteger(column) || column < 0) return false;
		if (!this.#available || !this.#tmux || this.#observedClientId === undefined || this.#paneId === undefined)
			return false;
		if (this.#expectedClientId !== undefined && this.#expectedClientId !== this.#observedClientId) return false;
		const clientId = this.#observedClientId;
		const epoch = this.#epoch;
		const deadline = this.#clock.now() + 250;
		const isCurrent = () =>
			!this.#disposed &&
			this.#available &&
			this.#tmux !== undefined &&
			this.#epoch === epoch &&
			this.#observedClientId === clientId &&
			(this.#expectedClientId === undefined || this.#expectedClientId === clientId);
		while (this.#clock.now() <= deadline) {
			if (!isCurrent()) return false;
			try {
				const pane = result(
					await this.#tmux(["display-message", "-p", "-t", this.#paneId, "#{cursor_y}\t#{cursor_x}"]),
				);
				if (!isCurrent() || pane.status !== 0) return false;
				const match = /^([0-9]+)\t([0-9]+)$/.exec(pane.stdout.trim());
				if (!match) return false;
				const observedRow = Number(match[1]);
				const observedColumn = Number(match[2]);
				if (!Number.isSafeInteger(observedRow) || !Number.isSafeInteger(observedColumn)) return false;
				if (observedRow === row && observedColumn === column) {
					const refreshed = result(await this.#tmux(["refresh-client", "-t", clientId])).status === 0;
					return refreshed && isCurrent();
				}
			} catch {
				return false;
			}
			const { promise, resolve } = Promise.withResolvers<void>();
			this.#clock.setTimeout(resolve, 10);
			await promise;
		}
		return false;
	}
	subscribe(cb: (a: PetTransportAvailability) => void) {
		this.#listeners.add(cb);
		return () => this.#listeners.delete(cb);
	}
	#emit() {
		for (const cb of this.#listeners) {
			try {
				cb(this.availability);
			} catch {
				// Availability observers are isolated from transport completion.
			}
		}
	}
	async probe() {
		if (this.#disposed || this.#pending) return this.availability;
		if (this.#mode === "managed") return this.inspectManagedTopology();
		return this.#probeAfterEligibility();
	}
	async #probeAfterEligibility() {
		if (this.#disposed || this.#pending) return this.availability;
		this.#pending = true;
		const epoch = ++this.#epoch;
		this.#available = false;
		this.#emit();
		if (this.#mode === "managed") {
			let prepared = false;
			try {
				prepared = await this.#queuePaneTransaction(() => this.#prepareManagedPane(epoch));
			} catch {
				prepared = false;
			}
			if (!prepared) {
				if (epoch !== this.#epoch || this.#disposed) return this.availability;
				this.#finish("topology-ineligible");
				await this.#restore(epoch);
				return this.availability;
			}
		}
		if (epoch !== this.#epoch || this.#disposed) return this.availability;
		try {
			await this.#input.drain(PET_CAPABILITY_DRAIN_MAX_MS, PET_CAPABILITY_QUIESCENCE_MS);
		} catch {
			if (epoch !== this.#epoch || this.#disposed) return this.availability;
			this.#finish("probe-timeout");
			await this.#restore(epoch);
			if (epoch !== this.#epoch || this.#disposed) return this.availability;
			return this.availability;
		}
		if (epoch !== this.#epoch || this.#disposed) return this.availability;
		if (!this.#ttyCandidate) return this.#finish("tty-unavailable");
		const probe = capabilityProbe();
		const bytes =
			this.#mode === "managed"
				? new TextEncoder().encode(wrapITerm2RecordForTmux(new TextDecoder().decode(probe)))
				: probe;
		const { promise, resolve } = Promise.withResolvers<PetTransportAvailability>();
		this.#pendingResolve = resolve;
		let buffer = "";
		let acknowledged = false;
		const cleanup = () => {
			this.#clock.clearTimeout(this.#timeout);
			this.#timeout = undefined;
			this.#unsubscribe?.();
			this.#unsubscribe = undefined;
		};
		const finish = (reason?: PetUnavailableReason) => {
			if (!this.#pending || epoch !== this.#epoch || this.#disposed) return;
			cleanup();
			this.#pendingResolve = undefined;
			this.#finish(reason);
			if (reason) void this.#restore(epoch);
			resolve(this.availability);
		};
		this.#unsubscribe = this.#input.onData(d => {
			if (!acknowledged) return;
			buffer += text(d);
			const reply = parseITerm2CapabilityReply(buffer);
			if (reply === "complete-f") finish();
			else if (reply === "missing-f" || reply === "invalid-f") finish(reply);
			if (buffer.length > 8192) buffer = buffer.slice(-4096);
		});
		let writeResult: Promise<Readonly<{ status: "written" | "failed" }>>;
		try {
			writeResult = this.#output.write(bytes);
		} catch {
			finish("probe-timeout");
			return promise;
		}
		Promise.resolve(writeResult)
			.then(written => {
				if (epoch !== this.#epoch || this.#disposed) {
					cleanup();
					return;
				}
				if (written.status !== "written") {
					finish("probe-timeout");
					return;
				}
				acknowledged = true;
				this.#timeout = this.#clock.setTimeout(() => finish("probe-timeout"), PET_CAPABILITY_QUERY_TIMEOUT_MS);
			})
			.catch(() => finish("probe-timeout"));
		return promise;
	}
	retry() {
		return this.#mode === "managed" ? this.inspectManagedTopology() : this.probe();
	}
	#finish(reason?: PetUnavailableReason) {
		this.#pending = false;
		this.#available = !reason;
		this.#reason = reason;
		this.#emit();
		if (this.#available && !reason)
			this.#notifyLifecycle({ kind: "availability-restored", terminalGeneration: this.#epoch });
		return this.availability;
	}
	async revoke(reason: PetUnavailableReason = "topology-lost"): Promise<PetTransportAvailability> {
		this.#epoch++;
		this.#clock.clearTimeout(this.#timeout);
		this.#timeout = undefined;
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		this.#pending = false;
		this.#available = false;
		this.#reason = reason;
		this.#observedClientId = undefined;
		const availability = this.availability;
		const resolve = this.#pendingResolve;
		this.#pendingResolve = undefined;
		this.#emit();
		resolve?.(availability);
		await this.#restore(this.#epoch);
		return availability;
	}
	#queuePaneTransaction<T>(transaction: () => Promise<T>): Promise<T> {
		const queued = this.#paneTransaction.then(transaction, transaction);
		this.#paneTransaction = queued.then(
			() => undefined,
			() => undefined,
		);
		return queued;
	}
	async #restoreManagedPane(epoch?: number) {
		if (
			this.#mode !== "managed" ||
			!this.#tmux ||
			!this.#paneId ||
			this.#snapshot === undefined ||
			this.#restored ||
			(epoch !== undefined && (epoch !== this.#epoch || this.#disposed))
		)
			return;
		if (this.#restoreInFlight) return this.#restoreInFlight;
		const snapshot = this.#snapshot;
		const argv =
			snapshot === "unset"
				? ["set-option", "-u", "-p", "-t", this.#paneId, "allow-passthrough"]
				: ["set-option", "-p", "-t", this.#paneId, "allow-passthrough", snapshot.value];
		this.#restoreInFlight = (async () => {
			let r: PetTmuxResult;
			try {
				r = result(await this.#tmux!(argv));
			} catch {
				this.#reason = "cleanup-failed";
				this.#available = false;
				this.#emit();
				return;
			}
			if (r.status !== 0) {
				this.#reason = "cleanup-failed";
				this.#available = false;
				this.#emit();
				return;
			}
			if (this.#snapshot === snapshot) {
				this.#restored = true;
				this.#snapshot = undefined;
				if (this.#reason === "cleanup-failed") this.#reason = undefined;
				this.#notifyLifecycle({ kind: "explicit-cleanup", terminalGeneration: this.#epoch });
			}
		})();
		try {
			await this.#restoreInFlight;
		} finally {
			this.#restoreInFlight = undefined;
		}
	}
	async #restore(epoch?: number) {
		return this.#queuePaneTransaction(() => this.#restoreManagedPane(epoch));
	}
	async #prepareManagedPane(epoch: number): Promise<boolean> {
		if (!this.#tmux || !this.#paneId) return false;
		const isCurrent = () => epoch === this.#epoch && !this.#disposed;
		if (this.#snapshot !== undefined) {
			const current = result(
				await this.#tmux(["show-options", "-A", "-p", "-v", "-t", this.#paneId, "allow-passthrough"]),
			);
			if (!isCurrent()) return false;
			if (current.status === 0 && current.stdout.replace(/\r?\n$/, "") === "on") return true;
			await this.#restoreManagedPane();
			if (this.#snapshot !== undefined) return false;
		}
		const q = result(await this.#tmux(["show-options", "-q", "-p", "-v", "-t", this.#paneId, "allow-passthrough"]));
		if (!isCurrent() || q.status !== 0) return false;
		const snapshot = q.stdout.replace(/\r?\n$/, "") === "" ? "unset" : { value: q.stdout.replace(/\r?\n$/, "") };
		this.#snapshot = snapshot;
		this.#restored = false;
		const set = result(await this.#tmux(["set-option", "-p", "-t", this.#paneId, "allow-passthrough", "on"]));
		if (!isCurrent() || set.status !== 0) {
			await this.#restoreManagedPane(epoch);
			return false;
		}
		const verify = result(
			await this.#tmux(["show-options", "-A", "-p", "-v", "-t", this.#paneId, "allow-passthrough"]),
		);
		if (
			epoch !== this.#epoch ||
			this.#disposed ||
			verify.status !== 0 ||
			verify.stdout.replace(/\r?\n$/, "") !== "on"
		) {
			await this.#restoreManagedPane(epoch);
			return false;
		}
		return true;
	}
	async inspectManagedTopology() {
		if (this.#disposed) return this.availability;
		const epoch = this.#epoch;
		const isCurrent = () => epoch === this.#epoch && !this.#disposed;
		if (this.#topology) {
			let t: PetTmuxTopology;
			try {
				t = await this.#topology();
			} catch {
				if (!isCurrent()) return this.availability;
				return this.#finish("topology-ineligible");
			}
			if (!isCurrent()) return this.availability;
			if (
				t.clients === 1 &&
				((t.paneId !== undefined && t.paneId !== this.#paneId) ||
					(t.ownedPaneId !== undefined && t.ownedPaneId !== this.#paneId) ||
					(t.clientId !== undefined && t.clientId !== (this.#expectedClientId ?? this.#observedClientId)))
			) {
				return this.revoke("topology-ineligible");
			}
			if (t.clients === 1 && t.clientId !== undefined && this.#observedClientId === undefined) {
				this.#observedClientId = t.clientId;
			}
			if (t.clients === 0) {
				return this.revoke("zero-client-recovery");
			}
			if (t.clients !== 1) {
				return this.revoke("topology-ineligible");
			}
			if (this.#available) return this.availability;
			return this.#probeAfterEligibility();
		}
		if (!this.#tmux || !this.#paneId) return this.#finish("topology-ineligible");
		let r: PetTmuxResult;
		try {
			r = result(
				await this.#tmux(["list-clients", "-t", this.#sessionTarget ?? "=", "-F", "#{client_name}\t#{client_tty}"]),
			);
		} catch {
			if (!isCurrent()) return this.availability;
			return this.#finish("topology-ineligible");
		}
		if (!isCurrent()) return this.availability;
		if (r.status !== 0) return this.#finish("topology-ineligible");
		const rows = r.stdout.split(/\r?\n/).filter(x => x.length > 0);
		if (rows.length !== 1) {
			return this.revoke(rows.length === 0 ? "zero-client-recovery" : "topology-ineligible");
		}
		const [clientId] = rows[0].split("\t");
		if (!clientId) return this.revoke("topology-ineligible");
		let pane: PetTmuxResult;
		try {
			pane = result(await this.#tmux(["display-message", "-p", "-t", clientId, "#{pane_id}"]));
		} catch {
			if (!isCurrent()) return this.availability;
			return this.revoke("topology-ineligible");
		}
		if (!isCurrent()) return this.availability;
		if (
			pane.status !== 0 ||
			pane.stdout.trim() !== this.#paneId ||
			((this.#expectedClientId ?? this.#observedClientId) !== undefined &&
				(this.#expectedClientId ?? this.#observedClientId) !== clientId)
		)
			return this.revoke("topology-ineligible");
		if (this.#observedClientId === undefined) this.#observedClientId = clientId;
		if (this.#available) return this.availability;
		return this.#probeAfterEligibility();
	}
	startManagedPolling() {
		if (this.#mode !== "managed" || this.#poll) return;
		const tick = async () => {
			if (this.#disposed) return;
			await this.inspectManagedTopology();
			if (!this.#disposed) this.#poll = this.#clock.setTimeout(() => void tick(), PET_TOPOLOGY_POLL_MS);
		};
		void tick();
	}
	stopManagedPolling() {
		if (this.#poll !== undefined) this.#clock.clearTimeout(this.#poll);
		this.#poll = undefined;
	}
	async dispose() {
		if (this.#disposed) return;
		this.stopManagedPolling();
		await this.revoke("topology-lost");
		this.#disposed = true;
		this.#listeners.clear();
	}
}
