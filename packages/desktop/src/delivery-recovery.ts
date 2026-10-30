import type { DesktopDeliveryReceipt } from "../../desktop-host/src/protocol";
import type { DesktopAttachmentDraft } from "./AttachmentPicker";

export interface DeliveryRecovery {
	id: string;
	sessionId: string;
	text: string;
	attachments: DesktopAttachmentDraft[];
	disposition: DesktopDeliveryReceipt["disposition"];
	error?: string;
	restored?: boolean;
	finalizing?: boolean;
	prepared?: boolean;
}

export interface DurableDraft {
	sessionId: string;
	text: string;
	attachments: DesktopAttachmentDraft[];
}

let database: Promise<IDBDatabase> | undefined;
function openDatabase(): Promise<IDBDatabase> {
	if (database) return database;
	const { promise, resolve, reject } = Promise.withResolvers<IDBDatabase>();
	database = promise;
	let rejected = false;
	const fail = (error: Error) => {
		if (rejected) return;
		rejected = true;
		if (database === promise) database = undefined;
		reject(error);
	};
	let open: IDBOpenDBRequest;
	try {
		open = indexedDB.open("gjc.desktop.delivery-recovery", 2);
	} catch (error) {
		fail(error instanceof Error ? error : new Error(String(error)));
		return promise;
	}
	open.onupgradeneeded = () => {
		if (!open.result.objectStoreNames.contains("deliveries"))
			open.result.createObjectStore("deliveries", { keyPath: "id" });
		if (!open.result.objectStoreNames.contains("drafts"))
			open.result.createObjectStore("drafts", { keyPath: "sessionId" });
	};
	open.onsuccess = () => {
		const db = open.result;
		if (rejected) {
			db.close();
			return;
		}
		db.onversionchange = () => {
			db.close();
			if (database === promise) database = undefined;
		};
		db.onclose = () => {
			if (database === promise) database = undefined;
		};
		resolve(db);
	};
	open.onerror = () => fail(open.error ?? new Error("복구 저장소를 열지 못했습니다."));
	open.onblocked = () => fail(new Error("복구 저장소가 차단되었습니다."));
	return promise;
}

function transactionResult<T>(tx: IDBTransaction, result: () => T): Promise<T> {
	const { promise, resolve, reject } = Promise.withResolvers<T>();
	tx.oncomplete = () => resolve(result());
	tx.onabort = () => reject(tx.error ?? new Error("복구 저장에 실패했습니다."));
	return promise;
}

async function transact<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
	const db = await openDatabase();
	const tx = db.transaction("deliveries", mode);
	const operation = action(tx.objectStore("deliveries"));
	return transactionResult(tx, () => operation.result);
}

export const loadDeliveries = () => transact<DeliveryRecovery[]>("readonly", store => store.getAll());
export const saveDelivery = (entry: DeliveryRecovery) => transact<IDBValidKey>("readwrite", store => store.put(entry));
export const deleteDelivery = (id: string) => transact<undefined>("readwrite", store => store.delete(id));

export async function loadDrafts(): Promise<DurableDraft[]> {
	const db = await openDatabase();
	const tx = db.transaction("drafts", "readonly");
	const result = tx.objectStore("drafts").getAll();
	return transactionResult(tx, () => result.result);
}

export async function saveDrafts(drafts: DurableDraft[]): Promise<void> {
	const db = await openDatabase();
	const tx = db.transaction("drafts", "readwrite");
	try {
		for (const draft of drafts) tx.objectStore("drafts").put(draft);
	} catch (error) {
		tx.abort();
		throw error;
	}
	return transactionResult(tx, () => undefined);
}

/** The draft and delivery marker become durable together, or neither does. */
export async function commitDraftAndDelivery(entry: DeliveryRecovery, draft: DurableDraft): Promise<void> {
	const db = await openDatabase();
	const tx = db.transaction(["deliveries", "drafts"], "readwrite");
	try {
		tx.objectStore("drafts").put(draft);
		tx.objectStore("deliveries").put(entry);
	} catch (error) {
		tx.abort();
		throw error;
	}
	return transactionResult(tx, () => undefined);
}
