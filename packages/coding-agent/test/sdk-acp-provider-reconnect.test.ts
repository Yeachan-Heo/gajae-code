import { expect, spyOn, test } from "bun:test";
import { AcpSdkAdapter } from "../src/sdk/acp";
import { PROVIDER_ACTIVATION_BUDGET_MS, PROVIDER_ACTIVATION_MAX_ATTEMPTS } from "../src/sdk/acp/adapter";
import { SdkClientError } from "../src/sdk/client";
import type { SessionAttachment } from "../src/sdk/router";
import { SessionRouter } from "../src/sdk/router/session-router";

const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(5);
	}
	throw new Error(`Timed out waiting for ${label}`);
};

test("SessionRouter rejects request preparation when reconciliation outlives its deadline", async () => {
	let refreshes = 0;
	let reconciliationFinished = false;
	let dispatches = 0;
	const reconciliationGate = Promise.withResolvers<void>();
	const index = {
		indexSeq: 0,
		open: async () => index,
		refresh: async () => {
			refreshes += 1;
			if (refreshes > 1) {
				reconciliationFinished = false;
				await reconciliationGate.promise;
			}
			reconciliationFinished = true;
			return index;
		},
		refreshIfChanged: async () => false,
		listSessions: () => ({ sessions: [], warnings: [] }),
	};
	const router = new SessionRouter({
		agentDir: "/tmp/sdk-router-deadline-repro",
		deps: {
			createIndex: () => index as never,
			setInterval: (() => 0) as never,
			clearInterval: (() => {}) as never,
		},
	});
	await router.start();
	try {
		await expect(
			router.request("missing", { type: "command" }, undefined, undefined, {
				deadline: Date.now() + 5,
				beforeDispatch: () => {
					dispatches += 1;
				},
			}),
		).rejects.toMatchObject({
			phase: "pre_send",
			message: "SDK session request deadline elapsed during router preparation.",
		});
		expect(reconciliationFinished).toBe(false);
		expect(dispatches).toBe(0);
	} finally {
		reconciliationGate.resolve();
		await router.stop();
	}
});

test("SessionRouter preserves reconciliation throws without dispatching", async () => {
	let refreshes = 0;
	const index = {
		indexSeq: 0,
		open: async () => index,
		refresh: async () => {
			refreshes += 1;
			if (refreshes > 1) throw new Error("reconcile failed");
			return index;
		},
		refreshIfChanged: async () => false,
		listSessions: () => ({ sessions: [], warnings: [] }),
	};
	let dispatches = 0;
	const router = new SessionRouter({
		agentDir: "/tmp/sdk-router-reconcile-throw",
		deps: {
			createIndex: () => index as never,
			createClient: async () => {
				dispatches += 1;
				throw new Error("unexpected dispatch");
			},
		},
	});
	await router.start();
	try {
		await expect(
			router.request("missing", { type: "command" }, undefined, undefined, { deadline: Date.now() + 500 }),
		).rejects.toThrow("reconcile failed");
		expect(dispatches).toBe(0);
	} finally {
		await expect(router.stop()).rejects.toThrow("SessionRouter shutdown failed.");
	}
});

test("SessionRouter does not reconcile an already expired request", async () => {
	let refreshes = 0;
	const index = {
		indexSeq: 0,
		open: async () => index,
		refresh: async () => {
			refreshes += 1;
			return index;
		},
		refreshIfChanged: async () => false,
		listSessions: () => ({ sessions: [], warnings: [] }),
	};
	const router = new SessionRouter({
		agentDir: "/tmp/sdk-router-expired",
		deps: { createIndex: () => index as never },
	});
	await router.start();
	const before = refreshes;
	try {
		await expect(
			router.request("missing", { type: "command" }, undefined, undefined, { deadline: Date.now() - 1 }),
		).rejects.toMatchObject({
			phase: "pre_send",
			message: "SDK session request deadline elapsed during router preparation.",
		});
		expect(refreshes).toBe(before);
	} finally {
		await router.stop();
	}
});

test("SessionRouter cancels pending reconciliation during teardown without dispatch", async () => {
	let refreshes = 0;
	const gate = Promise.withResolvers<void>();
	const index = {
		indexSeq: 0,
		open: async () => index,
		refresh: async () => {
			refreshes += 1;
			if (refreshes > 1) await gate.promise;
			return index;
		},
		refreshIfChanged: async () => false,
		listSessions: () => ({ sessions: [], warnings: [] }),
	};
	let dispatches = 0;
	const router = new SessionRouter({
		agentDir: "/tmp/sdk-router-teardown",
		deps: {
			createIndex: () => index as never,
			createClient: async () => {
				dispatches += 1;
				throw new Error("unexpected dispatch");
			},
		},
	});
	await router.start();
	const request = router.request("missing", { type: "command" }, undefined, undefined, { deadline: Date.now() + 500 });
	await Bun.sleep(5);
	const stopping = router.stop();
	gate.resolve();
	await stopping;
	await expect(request).rejects.toMatchObject({ phase: "pre_send" });
	expect(dispatches).toBe(0);
});

test("ACP provider activation retries the current Router attachment after rotation during registration", async () => {
	let currentGeneration = 1;
	const firstRegistration = Promise.withResolvers<Record<string, unknown>>();
	const registrations: Array<{
		frame: Record<string, unknown>;
		generation: number | undefined;
		attachment: SessionAttachment | undefined;
		options: Record<string, unknown> | undefined;
	}> = [];
	const router = {
		request: async (
			_sessionId: string,
			frame: Record<string, unknown>,
			generation?: number,
			attachment?: SessionAttachment,
			options?: Record<string, unknown>,
		) => {
			registrations.push({ frame, generation, attachment, options });
			if (registrations.length === 1) return await firstRegistration.promise;
			return {
				ok: true,
				result: { leaseId: typeof frame.expectedLeaseId === "string" ? frame.expectedLeaseId : "lease-1" },
			};
		},
	};
	const attachment = (generation: number): SessionAttachment => ({
		authorityId: `session-1:${generation}`,
		sessionId: "session-1",
		generation,
		isCurrent: () => currentGeneration === generation,
		send: async () => {},
		sendMaintenance: () => {},
	});
	const firstAttachment = attachment(1);
	const secondAttachment = attachment(2);
	const adapter = new AcpSdkAdapter({
		router: router as never,
		attachment: firstAttachment,
		sessionId: firstAttachment.sessionId,
		providers: [{ capability: "ui", definitions: [{ name: "select" }] }],
	});
	const start = adapter.start();
	try {
		await waitFor(() => registrations.length === 1, "initial provider registration");
		currentGeneration = 2;
		adapter.acceptAttachment(secondAttachment);
		firstRegistration.resolve({ ok: true, result: { leaseId: "lease-1" } });
		await start;
		await waitFor(() => registrations.length === 2, "provider registration on rotated attachment");
		expect(registrations[0]).toMatchObject({ generation: 1, attachment: firstAttachment });
		expect(registrations[0]?.options?.timeoutMs).toBeGreaterThan(0);
		expect(registrations[1]).toMatchObject({
			generation: 2,
			attachment: secondAttachment,
			frame: { type: "register_provider", capability: "ui" },
		});
	} finally {
		await adapter.close();
	}
});

test("ACP provider activation preserves registration uncertainty at the deadline", async () => {
	const startedAt = 1_000;
	let now = startedAt;
	const clock = spyOn(Date, "now").mockImplementation(() => now);
	const uncertainty = new SdkClientError(
		"uncertain_after_send",
		"Provider registration response was lost after dispatch.",
		{ operation: "register_provider", idempotencyKey: "registration-1" },
	);
	let registrations = 0;
	const attachment: SessionAttachment = {
		authorityId: "session-1:stable",
		sessionId: "session-1",
		generation: 1,
		isCurrent: () => true,
		send: async () => {},
		sendMaintenance: () => {},
	};
	const adapter = new AcpSdkAdapter({
		router: {
			request: async () => {
				registrations += 1;
				now = startedAt + PROVIDER_ACTIVATION_BUDGET_MS;
				throw uncertainty;
			},
		} as never,
		attachment,
		sessionId: attachment.sessionId,
		providers: [{ capability: "ui", definitions: [{ name: "select" }] }],
	});
	try {
		await expect(adapter.start()).rejects.toBe(uncertainty);
		expect(registrations).toBe(1);
		expect(adapter.leaseIds.size).toBe(0);
	} finally {
		clock.mockRestore();
		await adapter.close();
	}
});

test("ACP provider activation preserves registration uncertainty when the attachment rotates at the deadline", async () => {
	const startedAt = 1_000;
	let now = startedAt;
	const clock = spyOn(Date, "now").mockImplementation(() => now);
	const uncertainty = new SdkClientError(
		"uncertain_after_send",
		"Provider registration response was lost after dispatch.",
		{ operation: "register_provider", idempotencyKey: "registration-rotated" },
	);
	let adapter!: AcpSdkAdapter;
	const attachment = (generation: number, isCurrent: () => boolean): SessionAttachment => ({
		authorityId: `session-1:${generation}`,
		sessionId: "session-1",
		generation,
		isCurrent,
		send: async () => {},
		sendMaintenance: () => {},
	});
	const firstAttachment = attachment(1, () => true);
	const rotatedAttachment = attachment(2, () => false);
	adapter = new AcpSdkAdapter({
		router: {
			request: async () => {
				adapter.acceptAttachment(rotatedAttachment);
				now = startedAt + PROVIDER_ACTIVATION_BUDGET_MS;
				throw uncertainty;
			},
		} as never,
		attachment: firstAttachment,
		sessionId: firstAttachment.sessionId,
		providers: [{ capability: "ui", definitions: [{ name: "select" }] }],
	});
	try {
		await expect(adapter.start()).rejects.toBe(uncertainty);
		expect(adapter.leaseIds.size).toBe(0);
	} finally {
		clock.mockRestore();
		await adapter.close();
	}
});

test("ACP provider activation gives up with an attributable error when the attachment rotates on every attempt", async () => {
	let currentGeneration = 1;
	let registrations = 0;
	let adapter!: AcpSdkAdapter;
	const attachment = (generation: number): SessionAttachment => ({
		authorityId: `session-1:${generation}`,
		sessionId: "session-1",
		generation,
		isCurrent: () => currentGeneration === generation,
		send: async () => {},
		sendMaintenance: () => {},
	});
	adapter = new AcpSdkAdapter({
		router: {
			request: async (_sessionId: string, frame: Record<string, unknown>) => {
				registrations += 1;
				// The Router hands the session to a fresh attachment before every registration
				// is answered, so each round takes a lease on a connection that is already gone
				// and the retry can never converge. The successor is accepted while it is still
				// not current, because acceptAttachment starts its own background activation
				// for a current attachment and this test is about one loop, not a fan-out.
				adapter.acceptAttachment(attachment(currentGeneration + 1));
				currentGeneration += 1;
				return { ok: true, result: { leaseId: `lease-${String(frame.capability)}-${registrations}` } };
			},
		} as never,
		attachment: attachment(1),
		sessionId: "session-1",
		providers: [{ capability: "ui", definitions: [{ name: "select" }] }],
	});
	try {
		await expect(adapter.start()).rejects.toMatchObject({ code: "provider_activation_exhausted" });
		// The budget is spent in attempts, not wall clock, so the loop terminates promptly.
		expect(registrations).toBe(PROVIDER_ACTIVATION_MAX_ATTEMPTS);
	} finally {
		await adapter.close();
	}
});

test("ACP sequential provider registrations share one activation deadline", async () => {
	const startedAt = 1_000;
	let now = startedAt;
	const clock = spyOn(Date, "now").mockImplementation(() => now);
	const registrations: Array<{ capability: unknown; timeoutMs?: number; deadline?: number }> = [];
	const attachment: SessionAttachment = {
		authorityId: "session-1:stable",
		sessionId: "session-1",
		generation: 1,
		isCurrent: () => true,
		send: async () => {},
		sendMaintenance: () => {},
	};
	const adapter = new AcpSdkAdapter({
		router: {
			request: async (
				_sessionId: string,
				frame: Record<string, unknown>,
				_generation?: number,
				_attachment?: SessionAttachment,
				options?: { timeoutMs: number; deadline?: number },
			) => {
				registrations.push({ capability: frame.capability, ...options });
				if (registrations.length === 1) now += PROVIDER_ACTIVATION_BUDGET_MS - 1;
				if (registrations.length === 2) now += 2;
				return { ok: true, result: { leaseId: `lease-${String(frame.capability)}` } };
			},
		} as never,
		attachment,
		sessionId: attachment.sessionId,
		providers: [
			{ capability: "fs", definitions: [] },
			{ capability: "permission", definitions: [] },
		],
	});
	try {
		await expect(adapter.start()).rejects.toMatchObject({ code: "provider_activation_exhausted" });
		expect(registrations).toEqual([
			{
				capability: "fs",
				timeoutMs: PROVIDER_ACTIVATION_BUDGET_MS,
				deadline: startedAt + PROVIDER_ACTIVATION_BUDGET_MS,
			},
			{ capability: "permission", timeoutMs: 1, deadline: startedAt + PROVIDER_ACTIVATION_BUDGET_MS },
		]);
		expect(adapter.leaseIds.get("fs")).toBe("lease-fs");
		expect(adapter.leaseIds.get("permission")).toBeUndefined();
		await adapter.start();
		expect(registrations.map(registration => registration.capability)).toEqual([
			"fs",
			"permission",
			"fs",
			"permission",
		]);
		expect(adapter.leaseIds.get("permission")).toBe("lease-permission");
	} finally {
		clock.mockRestore();
		await adapter.close();
	}
});

test("ACP provider activation includes delayed Router transport preparation in its deadline", async () => {
	const startedAt = 1_000;
	let now = startedAt;
	const clock = spyOn(Date, "now").mockImplementation(() => now);
	let registrationOptions: { timeoutMs: number; deadline?: number } | undefined;
	let registrations = 0;
	const attachment: SessionAttachment = {
		authorityId: "session-1:stable",
		sessionId: "session-1",
		generation: 1,
		isCurrent: () => true,
		send: async () => {},
		sendMaintenance: () => {},
	};
	const adapter = new AcpSdkAdapter({
		router: {
			request: async (
				_sessionId: string,
				_frame: Record<string, unknown>,
				_generation?: number,
				_attachment?: SessionAttachment,
				options?: { timeoutMs: number; deadline?: number },
			) => {
				registrations += 1;
				registrationOptions = options;
				if (registrations === 1) now += PROVIDER_ACTIVATION_BUDGET_MS + 1;
				return { ok: true, result: { leaseId: "lease-1" } };
			},
		} as never,
		attachment,
		sessionId: attachment.sessionId,
		providers: [{ capability: "permission", definitions: [] }],
	});
	try {
		await expect(adapter.start()).rejects.toMatchObject({ code: "provider_activation_exhausted" });
		expect(registrationOptions).toEqual({
			timeoutMs: PROVIDER_ACTIVATION_BUDGET_MS,
			deadline: startedAt + PROVIDER_ACTIVATION_BUDGET_MS,
		});
		expect(adapter.leaseIds.size).toBe(0);
		now = startedAt + PROVIDER_ACTIVATION_BUDGET_MS + 1;
		await adapter.start();
		expect(registrations).toBe(2);
		expect(adapter.leaseIds.get("permission")).toBe("lease-1");
	} finally {
		clock.mockRestore();
		await adapter.close();
	}
});

test("ACP rejects a successful final provider registration at the activation deadline without caching activation", async () => {
	let now = 1_000;
	const clock = spyOn(Date, "now").mockImplementation(() => now);
	let registrations = 0;
	const attachment: SessionAttachment = {
		authorityId: "session-1:stable",
		sessionId: "session-1",
		generation: 1,
		isCurrent: () => true,
		send: async () => {},
		sendMaintenance: () => {},
	};
	const adapter = new AcpSdkAdapter({
		router: {
			request: async () => {
				registrations += 1;
				if (registrations === 1) now += PROVIDER_ACTIVATION_BUDGET_MS;
				return { ok: true, result: { leaseId: "lease-1" } };
			},
		} as never,
		attachment,
		sessionId: attachment.sessionId,
		providers: [{ capability: "ui", definitions: [{ name: "select" }] }],
	});
	try {
		await expect(adapter.start()).rejects.toMatchObject({ code: "provider_activation_exhausted" });
		expect(adapter.leaseIds.size).toBe(0);
		await adapter.start();
		expect(registrations).toBe(2);
		expect(adapter.leaseIds.get("ui")).toBe("lease-1");
	} finally {
		clock.mockRestore();
		await adapter.close();
	}
});

test("ACP provider readiness renews leases on the same attachment after transport reconnect", async () => {
	const registrations: Record<string, unknown>[] = [];
	const attachment: SessionAttachment = {
		authorityId: "session-1:stable",
		sessionId: "session-1",
		generation: 1,
		isCurrent: () => true,
		send: async () => {},
		sendMaintenance: () => {},
	};
	const adapter = new AcpSdkAdapter({
		router: {
			request: async (_sessionId: string, frame: Record<string, unknown>) => {
				registrations.push(frame);
				return { ok: true, result: { leaseId: "lease-1" } };
			},
		} as never,
		attachment,
		sessionId: attachment.sessionId,
		providers: [{ capability: "ui", definitions: [{ name: "select" }] }],
	});
	try {
		await adapter.start();
		expect(registrations).toHaveLength(1);
		await adapter.attachmentReady(attachment);
		expect(registrations).toHaveLength(2);
		expect(registrations[1]).toMatchObject({
			type: "register_provider",
			capability: "ui",
			expectedLeaseId: "lease-1",
		});
	} finally {
		await adapter.close();
	}
});

test("Broker lifecycle client cannot activate per-session providers", async () => {
	const client = {
		connectionId: "broker-connection",
		onFrame: () => () => {},
		onReconnect: () => () => {},
		onReconnectFailed: () => () => {},
		connect: async () => {},
		global: async () => ({ ok: true }),
		close: async () => {},
	};
	const adapter = new AcpSdkAdapter({
		client: client as never,
		providers: [{ capability: "ui", definitions: [] }],
	});
	await expect(adapter.start()).rejects.toMatchObject({ code: "operation_prohibited" });
	await adapter.close();
});

test("ACP provider readiness rebinds expired reverse leases on the live attachment (#4909)", async () => {
	const registrations: Record<string, unknown>[] = [];
	const attachment: SessionAttachment = {
		authorityId: "session-1:stable",
		sessionId: "session-1",
		connectionId: "router-connection-1",
		generation: 1,
		isCurrent: () => true,
		send: async () => {},
		sendMaintenance: () => {},
	};

	const adapter = new AcpSdkAdapter({
		router: {
			request: async (_sessionId: string, frame: Record<string, unknown>) => {
				registrations.push(frame);
				return {
					ok: true,
					result: { leaseId: typeof frame.expectedLeaseId === "string" ? frame.expectedLeaseId : "lease-1" },
				};
			},
		} as never,
		attachment,
		sessionId: attachment.sessionId,
		providers: [{ capability: "permission", definitions: [] }],
	});
	try {
		await adapter.start();
		expect(registrations).toHaveLength(1);
		expect(adapter.leaseIds.get("permission")).toBe("lease-1");
		await adapter.ensureProviders();
		expect(registrations).toHaveLength(2);
		expect(registrations[1]).toMatchObject({
			type: "register_provider",
			capability: "permission",
			expectedLeaseId: "lease-1",
		});
		adapter.acceptFrame({
			type: "reverse_response",
			id: "",
			connectionId: "router-connection-1",
			leaseId: "lease-1",
			ok: false,
			error: { code: "lease_expired", message: "Lease expired." },
		});
		await waitFor(() => registrations.length === 3, "permission rebind after lease_expired");
		expect(registrations[2]).toMatchObject({
			type: "register_provider",
			capability: "permission",
			expectedLeaseId: "lease-1",
		});
	} finally {
		await adapter.close();
	}
});

test("ACP provider rebind ignores lease errors from a foreign connection (#4909)", async () => {
	const registrations: Record<string, unknown>[] = [];
	const attachment: SessionAttachment = {
		authorityId: "session-1:stable",
		sessionId: "session-1",
		connectionId: "router-connection-1",
		generation: 1,
		isCurrent: () => true,
		send: async () => {},
		sendMaintenance: () => {},
	};
	const adapter = new AcpSdkAdapter({
		router: {
			request: async (_sessionId: string, frame: Record<string, unknown>) => {
				registrations.push(frame);
				return { ok: true, result: { leaseId: "lease-1" } };
			},
		} as never,
		attachment,
		sessionId: attachment.sessionId,
		providers: [{ capability: "permission", definitions: [] }],
	});
	try {
		await adapter.start();
		expect(registrations).toHaveLength(1);
		adapter.acceptFrame({
			type: "reverse_response",
			id: "",
			connectionId: "other-connection",
			leaseId: "lease-1",
			ok: false,
			error: { code: "lease_expired", message: "Lease expired." },
		});
		await Bun.sleep(30);
		expect(registrations).toHaveLength(1);
	} finally {
		await adapter.close();
	}
});

test("ACP provider rebind reports non-conflict adapter failures as provider_rebind_failed (#4909)", async () => {
	const attachment: SessionAttachment = {
		authorityId: "session-1:stable",
		sessionId: "session-1",
		connectionId: "router-connection-1",
		generation: 1,
		isCurrent: () => true,
		send: async () => {},
		sendMaintenance: () => {},
	};
	let registrations = 0;
	const adapter = new AcpSdkAdapter({
		router: {
			request: async (_sessionId: string, _frame: Record<string, unknown>) => {
				registrations++;
				if (registrations === 1) return { ok: true, result: { leaseId: "lease-1" } };
				return { ok: true, result: {} };
			},
		} as never,
		attachment,
		sessionId: attachment.sessionId,
		providers: [{ capability: "permission", definitions: [] }],
	});
	try {
		const failures: SdkClientError[] = [];
		adapter.onReconnectFailed(error => failures.push(error));
		await adapter.start();
		adapter.acceptFrame({
			type: "reverse_response",
			id: "",
			connectionId: "router-connection-1",
			leaseId: "lease-1",
			ok: false,
			error: { code: "lease_expired", message: "Lease expired." },
		});
		await waitFor(
			() => failures.some(error => error.code === "provider_rebind_failed"),
			"provider_rebind_failed after omitted leaseId",
		);
		expect(failures.some(error => error.code === "reconnect_exhausted")).toBe(false);
	} finally {
		await adapter.close();
	}
});

test("ACP provider rebind observes lease_expired through the Router event wrapper (#4909)", async () => {
	const registrations: Record<string, unknown>[] = [];
	const attachment: SessionAttachment = {
		authorityId: "session-1:stable",
		sessionId: "session-1",
		connectionId: "router-connection-1",
		generation: 1,
		isCurrent: () => true,
		send: async () => {},
		sendMaintenance: () => {},
	};
	const adapter = new AcpSdkAdapter({
		router: {
			request: async (_sessionId: string, frame: Record<string, unknown>) => {
				registrations.push(frame);
				return {
					ok: true,
					result: { leaseId: typeof frame.expectedLeaseId === "string" ? frame.expectedLeaseId : "lease-1" },
				};
			},
		} as never,
		attachment,
		sessionId: attachment.sessionId,
		providers: [{ capability: "permission", definitions: [] }],
	});
	try {
		await adapter.start();
		expect(registrations).toHaveLength(1);
		adapter.acceptFrame({
			type: "event",
			payload: {
				type: "reverse_response",
				id: "",
				connectionId: "router-connection-1",
				leaseId: "lease-1",
				ok: false,
				error: { code: "lease_expired", message: "Lease expired." },
			},
		});
		await waitFor(() => registrations.length === 2, "permission rebind after wrapped lease_expired");
		expect(registrations[1]).toMatchObject({
			type: "register_provider",
			capability: "permission",
			expectedLeaseId: "lease-1",
		});
	} finally {
		await adapter.close();
	}
});

test("ACP lease rebind does not abort in-flight reverse permission requests (#4909)", async () => {
	const registrations: Record<string, unknown>[] = [];
	const { promise: permissionStarted, resolve: resolvePermissionStarted } = Promise.withResolvers<
		AbortSignal | undefined
	>();
	const { promise: permissionGate, resolve: resolvePermissionGate } = Promise.withResolvers<void>();
	const sent: Record<string, unknown>[] = [];

	const attachment: SessionAttachment = {
		authorityId: "session-1:stable",
		sessionId: "session-1",
		connectionId: "router-connection-1",
		generation: 1,
		isCurrent: () => true,
		send: async frame => {
			sent.push(frame);
		},

		sendMaintenance: () => {},
	};
	const adapter = new AcpSdkAdapter({
		router: {
			request: async (_sessionId: string, frame: Record<string, unknown>) => {
				registrations.push(frame);
				return { ok: true, result: { leaseId: "lease-1" } };
			},
		} as never,
		attachment,
		sessionId: attachment.sessionId,
		connection: {
			request: async (
				_method: string,
				_params: Record<string, unknown>,
				options?: { cancellationSignal?: AbortSignal },
			) => {
				resolvePermissionStarted(options?.cancellationSignal);
				await permissionGate;
				return { outcome: "selected", optionId: "allow_once" };
			},
		},
		providers: [{ capability: "permission", definitions: [] }],
	});
	try {
		await adapter.start();
		adapter.acceptFrame({
			type: "reverse_request",
			id: "perm-1",
			connectionId: "router-connection-1",
			capability: "permission",
			leaseId: "lease-1",
			payload: { method: "request", payload: { toolCall: { toolName: "bash" } } },
		});
		const signal = await permissionStarted;
		expect(signal?.aborted).toBe(false);
		await adapter.ensureProviders();
		expect(registrations.length).toBeGreaterThanOrEqual(2);
		expect(signal?.aborted).toBe(false);
		resolvePermissionGate();
		await waitFor(
			() =>
				sent.some(
					frame => frame.type === "reverse_response" && frame.id === "perm-1" && frame.leaseId === "lease-1",
				),
			"admitted reverse response on original lease",
		);
	} finally {
		resolvePermissionGate();
		await adapter.close();
	}
});

test("ACP still answers an admitted reverse request after a later lease conflict (#4909)", async () => {
	const registrations: Record<string, unknown>[] = [];
	const sent: Record<string, unknown>[] = [];
	const { promise: permissionStarted, resolve: resolvePermissionStarted } = Promise.withResolvers<
		AbortSignal | undefined
	>();
	const { promise: permissionGate, resolve: resolvePermissionGate } = Promise.withResolvers<void>();
	const attachment: SessionAttachment = {
		authorityId: "session-1:stable",
		sessionId: "session-1",
		connectionId: "router-connection-1",
		generation: 1,
		isCurrent: () => true,
		send: async frame => {
			sent.push(frame);
		},
		sendMaintenance: () => {},
	};
	const adapter = new AcpSdkAdapter({
		router: {
			request: async (_sessionId: string, frame: Record<string, unknown>) => {
				registrations.push(frame);
				if (registrations.length === 1) return { ok: true, result: { leaseId: "lease-1" } };
				throw new SdkClientError("provider_lease_conflict", "provider_lease_conflict");
			},
		} as never,
		attachment,
		sessionId: attachment.sessionId,
		connection: {
			request: async (
				_method: string,
				_params: Record<string, unknown>,
				options?: { cancellationSignal?: AbortSignal },
			) => {
				resolvePermissionStarted(options?.cancellationSignal);
				await permissionGate;
				return { outcome: "selected", optionId: "allow_once" };
			},
		},
		providers: [{ capability: "permission", definitions: [] }],
	});
	try {
		await adapter.start();
		adapter.acceptFrame({
			type: "reverse_request",
			id: "perm-1",
			connectionId: "router-connection-1",
			capability: "permission",
			leaseId: "lease-1",
			payload: { method: "request", payload: { toolCall: { toolName: "bash" } } },
		});
		const signal = await permissionStarted;
		await expect(adapter.ensureProviders()).rejects.toMatchObject({ code: "provider_lease_conflict" });
		expect(adapter.leaseIds.get("permission")).toBeUndefined();
		expect(signal?.aborted).toBe(true);
		await waitFor(
			() =>
				sent.some(
					frame =>
						frame.type === "reverse_response" &&
						frame.id === "perm-1" &&
						frame.ok === false &&
						(frame.error as { code?: string } | undefined)?.code === "provider_disconnected",
				),
			"host reverse settlement after foreign quarantine",
		);
	} finally {
		resolvePermissionGate();
		await adapter.close();
	}
});

test("ACP provider rebind leaves a live foreign permission lease in place (#4909)", async () => {
	const registrations: Record<string, unknown>[] = [];
	const attachment: SessionAttachment = {
		authorityId: "session-1:stable",
		sessionId: "session-1",
		generation: 1,
		isCurrent: () => true,
		send: async () => {},
		sendMaintenance: () => {},
	};
	const adapter = new AcpSdkAdapter({
		router: {
			request: async (_sessionId: string, frame: Record<string, unknown>) => {
				registrations.push(frame);
				if (registrations.length === 1) return { ok: true, result: { leaseId: "lease-1" } };
				throw new SdkClientError("provider_lease_conflict", "provider_lease_conflict");
			},
		} as never,
		attachment,
		sessionId: attachment.sessionId,
		providers: [{ capability: "permission", definitions: [] }],
	});
	try {
		const reconnectFailures: Error[] = [];
		adapter.onReconnectFailed(error => reconnectFailures.push(error));
		await adapter.start();
		expect(adapter.leaseIds.get("permission")).toBe("lease-1");
		await expect(adapter.ensureProviders()).rejects.toMatchObject({ code: "provider_lease_conflict" });

		expect(registrations.length).toBeGreaterThanOrEqual(2);
		expect(adapter.leaseIds.get("permission")).toBeUndefined();

		expect(reconnectFailures).toEqual([]);
	} finally {
		await adapter.close();
	}
});

test("ACP provider refresh coalesces concurrent ensureProviders calls (#4909)", async () => {
	const registrations: Record<string, unknown>[] = [];
	const { promise: secondRegistration, resolve: resolveSecondRegistration } = Promise.withResolvers<void>();
	const attachment: SessionAttachment = {
		authorityId: "session-1:stable",
		sessionId: "session-1",
		generation: 1,
		isCurrent: () => true,
		send: async () => {},
		sendMaintenance: () => {},
	};
	const adapter = new AcpSdkAdapter({
		router: {
			request: async (_sessionId: string, frame: Record<string, unknown>) => {
				registrations.push(frame);
				if (registrations.length === 2) await secondRegistration;
				return { ok: true, result: { leaseId: "lease-1" } };
			},
		} as never,
		attachment,
		sessionId: attachment.sessionId,
		providers: [{ capability: "permission", definitions: [] }],
	});
	try {
		await adapter.start();
		expect(registrations).toHaveLength(1);
		const first = adapter.ensureProviders();
		await waitFor(() => registrations.length === 2, "forced refresh registration");
		const second = adapter.ensureProviders();
		resolveSecondRegistration();
		await Promise.all([first, second]);
		expect(registrations).toHaveLength(2);
	} finally {
		resolveSecondRegistration();
		await adapter.close();
	}
});

test("ACP provider rebind keeps successfully registered capabilities after a later conflict (#4909)", async () => {
	const sent: Record<string, unknown>[] = [];
	const attachment: SessionAttachment = {
		authorityId: "session-1:stable",
		sessionId: "session-1",
		connectionId: "router-connection-1",
		generation: 1,
		isCurrent: () => true,
		send: async frame => {
			sent.push(frame);
		},
		sendMaintenance: () => {},
	};
	const adapter = new AcpSdkAdapter({
		router: {
			request: async (_sessionId: string, frame: Record<string, unknown>) => {
				if (frame.capability === "permission")
					throw new SdkClientError("provider_lease_conflict", "provider_lease_conflict");
				return { ok: true, result: { leaseId: "lease-fs" } };
			},
		} as never,
		attachment,
		sessionId: attachment.sessionId,
		providers: [
			{ capability: "fs", definitions: [] },
			{ capability: "permission", definitions: [] },
		],
	});
	try {
		await expect(adapter.start()).rejects.toMatchObject({ code: "provider_lease_conflict" });
		expect(adapter.leaseIds.get("fs")).toBe("lease-fs");
		expect(adapter.leaseIds.get("permission")).toBeUndefined();
		adapter.acceptFrame({
			type: "reverse_request",
			id: "fs-1",
			connectionId: "router-connection-1",
			capability: "fs",
			leaseId: "lease-fs",
			payload: { method: "fs.readTextFile", payload: { path: "/tmp/x" } },
		});
		await waitFor(
			() => sent.some(frame => frame.type === "reverse_response" && frame.id === "fs-1"),
			"fs reverse still owned after permission conflict",
		);
	} finally {
		await adapter.close();
	}
});
