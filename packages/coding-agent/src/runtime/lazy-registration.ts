import type { LazyService } from "./lazy-service";

export interface LazyRegistration<TContext, TEvent> {
	id: string;
	event: string;
	service: LazyService<{ handle(event: TEvent, context: TContext): void | Promise<void> }>;
	delivery: "await" | "buffer";
}

export interface LazyRegistrationDispatcherOptions {
	maxBufferedPerRegistration?: number;
	/** Dropped buffered events resolve without delivery after this callback, when provided. */
	onDropped?(info: { registrationId: string; event: string; droppedCount: number }): void;
}

type BufferedDelivery<TContext, TEvent> = {
	payload: TEvent;
	context: TContext;
	resolve: () => void;
	reject: (cause: unknown) => void;
};

type RegistrationRecord<TContext, TEvent> = {
	registration: LazyRegistration<TContext, TEvent>;
	active: boolean;
	queue: BufferedDelivery<TContext, TEvent>[];
	drainPromise?: Promise<void>;
	awaitTail: Promise<void>;
	bufferTail: Promise<void>;
};

const DEFAULT_MAX_BUFFERED = 64;

export function createLazyRegistrationDispatcher<TContext, TEvent>(
	opts: LazyRegistrationDispatcherOptions = {},
): {
	register(reg: LazyRegistration<TContext, TEvent>): () => void;
	dispatch(event: string, payload: TEvent, context: TContext): Promise<void>;
	dispose(): Promise<void>;
} {
	const maxBufferedPerRegistration = normalizeCapacity(opts.maxBufferedPerRegistration);
	const registrations = new Map<string, RegistrationRecord<TContext, TEvent>>();
	let disposed = false;
	let disposePromise: Promise<void> | undefined;

	const settleQueue = (record: RegistrationRecord<TContext, TEvent>, cause?: unknown): void => {
		for (const item of record.queue.splice(0)) {
			if (cause === undefined) item.resolve();
			else item.reject(cause);
		}
	};

	const handle = async (
		record: RegistrationRecord<TContext, TEvent>,
		payload: TEvent,
		context: TContext,
	): Promise<void> => {
		if (!record.active) return;
		const handler = await record.registration.service.get(record.registration.event);
		if (!record.active) return;
		await handler.handle(payload, context);
	};

	const drainBuffer = (record: RegistrationRecord<TContext, TEvent>): Promise<void> => {
		if (record.drainPromise) return record.drainPromise;
		record.drainPromise = (async () => {
			try {
				await record.registration.service.get(record.registration.event);
				while (record.active && record.queue.length > 0) {
					const item = record.queue.shift()!;
					try {
						const handler = await record.registration.service.get(record.registration.event);
						if (record.active) await handler.handle(item.payload, item.context);
						item.resolve();
					} catch (cause) {
						item.reject(cause);
					}
				}
				if (!record.active) settleQueue(record);
			} catch (cause) {
				settleQueue(record, cause);
			}
		})().finally(() => {
			record.drainPromise = undefined;
			if (record.active && record.queue.length > 0) void drainBuffer(record);
		});
		return record.drainPromise;
	};

	const enqueue = (record: RegistrationRecord<TContext, TEvent>, payload: TEvent, context: TContext): Promise<void> =>
		new Promise((resolve, reject) => {
			if (maxBufferedPerRegistration === 0 || record.queue.length >= maxBufferedPerRegistration) {
				if (maxBufferedPerRegistration > 0) record.queue.shift()?.resolve();
				opts.onDropped?.({
					registrationId: record.registration.id,
					event: record.registration.event,
					droppedCount: 1,
				});
				if (maxBufferedPerRegistration === 0) resolve();
			}
			if (maxBufferedPerRegistration > 0) record.queue.push({ payload, context, resolve, reject });
			void drainBuffer(record);
		});

	const deliverAwait = (
		record: RegistrationRecord<TContext, TEvent>,
		payload: TEvent,
		context: TContext,
	): Promise<void> => {
		const delivery = record.awaitTail.then(
			() => handle(record, payload, context),
			() => handle(record, payload, context),
		);
		record.awaitTail = delivery.catch(() => undefined);
		return delivery;
	};

	const deliverReadyBuffer = (
		record: RegistrationRecord<TContext, TEvent>,
		payload: TEvent,
		context: TContext,
	): Promise<void> => {
		const delivery = record.bufferTail.then(
			() => handle(record, payload, context),
			() => handle(record, payload, context),
		);
		record.bufferTail = delivery.catch(() => undefined);
		return delivery;
	};

	return {
		register(reg): () => void {
			if (disposed) throw new Error("Lazy registration dispatcher has been disposed.");
			if (registrations.has(reg.id)) throw new Error(`Lazy registration "${reg.id}" is already registered.`);
			const record: RegistrationRecord<TContext, TEvent> = {
				registration: reg,
				active: true,
				queue: [],
				awaitTail: Promise.resolve(),
				bufferTail: Promise.resolve(),
			};
			registrations.set(reg.id, record);
			return () => {
				if (!record.active) return;
				record.active = false;
				if (registrations.get(reg.id) === record) registrations.delete(reg.id);
				settleQueue(record);
			};
		},
		async dispatch(event, payload, context): Promise<void> {
			if (disposed) throw new Error("Lazy registration dispatcher has been disposed.");
			const matching = [...registrations.values()].filter(
				record => record.active && record.registration.event === event,
			);
			for (const record of matching) {
				if (record.registration.delivery === "await") {
					await deliverAwait(record, payload, context);
					continue;
				}
				const serviceState = record.registration.service.status().state;
				if (record.drainPromise || serviceState === "idle" || serviceState === "initializing") {
					await enqueue(record, payload, context);
					continue;
				}
				if (serviceState === "ready") {
					await deliverReadyBuffer(record, payload, context);
					continue;
				}
				await record.registration.service.get(`event:${event}`);
			}
		},
		dispose(): Promise<void> {
			if (disposePromise) return disposePromise;
			disposed = true;
			const records = [...registrations.values()];
			registrations.clear();
			for (const record of records) {
				record.active = false;
				settleQueue(record);
			}
			disposePromise = Promise.all(records.map(record => record.registration.service.dispose())).then(
				() => undefined,
			);
			return disposePromise;
		},
	};
}

function normalizeCapacity(value: number | undefined): number {
	if (value === undefined) return DEFAULT_MAX_BUFFERED;
	if (!Number.isFinite(value) || value < 0) return DEFAULT_MAX_BUFFERED;
	return Math.floor(value);
}
