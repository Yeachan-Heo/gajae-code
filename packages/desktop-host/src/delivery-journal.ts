import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { DesktopDeliveryReceipt } from "./protocol";

const active = new Set<DesktopDeliveryReceipt["disposition"]>(["pending", "accepted", "queued"]);
const dispositions = new Set<DesktopDeliveryReceipt["disposition"]>([
	"pending",
	"accepted",
	"queued",
	"completed",
	"failed",
	"removed",
	"cancelled",
	"refused",
	"unknown",
]);

/** Durable metadata only: no prompt contents or attachments enter this file. */
export class DeliveryJournal {
	#receipts = new Map<string, DesktopDeliveryReceipt>();
	#acknowledged = new Set<string>();
	#uncertainAdmissions = new Set<string>();
	#tail: Promise<void> = Promise.resolve();
	constructor(private readonly directory: string) {}

	async initialize(): Promise<void> {
		const file = Bun.file(path.join(this.directory, "deliveries.json"));
		if (!(await file.exists())) return;
		const value: unknown = await file.json();
		if (
			!value ||
			typeof value !== "object" ||
			!("version" in value) ||
			value.version !== 1 ||
			!("receipts" in value) ||
			!Array.isArray(value.receipts) ||
			!("acknowledged" in value) ||
			!Array.isArray(value.acknowledged)
		)
			throw new Error("Invalid delivery journal");
		for (const id of value.acknowledged) {
			if (typeof id !== "string" || !id || id.length > 128 || this.#acknowledged.has(id))
				throw new Error("Invalid delivery journal");
			this.#acknowledged.add(id);
		}
		for (const item of value.receipts) {
			if (
				!item ||
				typeof item !== "object" ||
				typeof item.id !== "string" ||
				!item.id ||
				item.id.length > 128 ||
				typeof item.sessionId !== "string" ||
				!item.sessionId ||
				!dispositions.has(item.disposition) ||
				(item.sdkSubmissionId !== undefined && typeof item.sdkSubmissionId !== "string") ||
				(item.error !== undefined && (typeof item.error !== "string" || item.error.length > 1000)) ||
				this.#receipts.has(item.id) ||
				this.#acknowledged.has(item.id)
			)
				throw new Error("Invalid delivery journal");
			const receipt: DesktopDeliveryReceipt = {
				id: item.id,
				sessionId: item.sessionId,
				disposition: active.has(item.disposition) ? "unknown" : item.disposition,
				...(item.sdkSubmissionId !== undefined ? { sdkSubmissionId: item.sdkSubmissionId } : {}),
				...(item.error !== undefined ? { error: item.error } : {}),
			};
			this.#receipts.set(receipt.id, receipt);
		}
		await this.#save(this.#receipts);
	}

	list(): DesktopDeliveryReceipt[] {
		return [...this.#receipts.values()].map(receipt => ({ ...receipt }));
	}
	hasAcknowledged(id: string): boolean {
		return this.#acknowledged.has(id);
	}

	#createChange(
		change: (receipts: Map<string, DesktopDeliveryReceipt>, acknowledged: Set<string>) => void,
		uncertainId?: string,
		admissionId?: string,
	): Promise<void> {
		const task = this.#tail
			.catch(() => {})
			.then(async () => {
				const receipts = new Map(this.#receipts);
				const acknowledged = new Set(this.#acknowledged);
				change(receipts, acknowledged);
				try {
					await this.#save(receipts, acknowledged);
				} catch (error) {
					if (admissionId) this.#uncertainAdmissions.add(admissionId);
					const previous = uncertainId && this.#receipts.get(uncertainId);
					if (previous && active.has(previous.disposition))
						this.#receipts.set(previous.id, {
							...previous,
							disposition: "unknown",
							error: "Delivery journal unavailable",
						});
					throw error;
				}
				this.#receipts = receipts;
				this.#acknowledged = acknowledged;
			});
		this.#tail = task;
		return task;
	}

	begin(id: string, sessionId: string): Promise<void> {
		return this.#createChange(
			(receipts, acknowledged) => {
				if (receipts.has(id) || acknowledged.has(id) || this.#uncertainAdmissions.has(id))
					throw new Error("Duplicate delivery id");
				receipts.set(id, { id, sessionId, disposition: "pending" });
			},
			undefined,
			id,
		);
	}

	update(
		id: string,
		changes: Partial<Pick<DesktopDeliveryReceipt, "disposition" | "sdkSubmissionId" | "error">>,
	): Promise<void> {
		return this.#createChange(receipts => {
			const receipt = receipts.get(id);
			if (!receipt || !active.has(receipt.disposition)) return;
			receipts.set(id, { ...receipt, ...changes });
		}, id);
	}

	ack(id: string): Promise<void> {
		return this.#createChange((receipts, acknowledged) => {
			const receipt = receipts.get(id);
			if (!receipt) {
				acknowledged.add(id);
				return;
			}
			if (active.has(receipt.disposition)) throw new Error("Delivery is not final");
			receipts.delete(id);
			acknowledged.add(id);
		});
	}

	async #save(receipts: Map<string, DesktopDeliveryReceipt>, acknowledged = this.#acknowledged): Promise<void> {
		const temporary = path.join(this.directory, `deliveries.${crypto.randomUUID()}.tmp`);
		try {
			const file = await fs.open(temporary, "wx", 0o600);
			try {
				await file.writeFile(
					JSON.stringify({ version: 1, receipts: [...receipts.values()], acknowledged: [...acknowledged] }),
				);
				await file.sync();
			} finally {
				await file.close();
			}
			await fs.rename(temporary, path.join(this.directory, "deliveries.json"));
			const directory = await fs.open(this.directory, "r");
			try {
				await directory.sync();
			} finally {
				await directory.close();
			}
		} finally {
			await fs.rm(temporary, { force: true });
		}
	}
}
