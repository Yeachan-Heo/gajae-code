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

export function recoveryNotice(entry: DeliveryRecovery, unsentRepair: boolean): string | null {
	if (unsentRepair) return "전송 복구: 보내지 못한 입력의 저장 복구가 필요합니다. 저장 복구를 다시 시도하세요.";
	if (entry.finalizing) return null;
	if (entry.disposition === "unknown")
		return "전송 복구: 전송 결과를 확인할 수 없습니다. 이미 실행되었을 수 있습니다. 초안을 복원해도 자동으로 다시 보내지 않습니다.";
	if (entry.disposition === "failed")
		return "전송 복구: 전송 처리에 실패했습니다. 일부 작업이 이미 실행되었을 수 있습니다. 내용을 확인한 뒤 초안을 복원하거나 기록을 버릴 수 있습니다.";
	return null;
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
