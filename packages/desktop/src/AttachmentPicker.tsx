import { Paperclip, X } from "lucide-react";
import { useRef } from "react";
import {
	DESKTOP_ATTACHMENT_MAX_COUNT,
	DESKTOP_ATTACHMENT_REQUEST_BYTES,
	type DesktopAttachment,
	desktopAttachmentJsonBytes,
	isDesktopAttachmentImageMime,
	validateDesktopAttachmentName,
	validateDesktopAttachmentText,
} from "../../desktop-host/src/attachment-protocol";
import { Button } from "./components";

type DraftIdentity = { id: string; name: string; size: number };
export type DesktopAttachmentDraft = DraftIdentity &
	(
		| { status: "reading"; attachment?: never; error?: never }
		| { status: "ready"; attachment: DesktopAttachment; error?: never }
		| { status: "error"; attachment?: never; error: string }
	);

export interface AttachmentPickerProps {
	sessionId: string;
	attachments: DesktopAttachmentDraft[];
	supportsImageInput: boolean;
	imagesBlocked?: boolean;
	disabled?: boolean;
	/** Apply to the named session, not whichever session happens to be selected on completion. */
	onChange: (sessionId: string, update: (current: DesktopAttachmentDraft[]) => DesktopAttachmentDraft[]) => void;
}

const TEXT_APPLICATION_MIMES = new Set([
	"application/json",
	"application/ld+json",
	"application/javascript",
	"application/typescript",
	"application/xml",
	"application/xhtml+xml",
	"application/yaml",
	"application/x-yaml",
	"application/toml",
	"application/sql",
	"application/x-sh",
	"application/x-httpd-php",
]);
const IMAGE_EXTENSIONS: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
};

function encodeBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += 32_768)
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
	return btoa(binary);
}

/** File is supplied by an operator's picker/paste event; no path strings or host filesystem access. */
export async function readDesktopAttachmentFile(
	file: File,
	options: { supportsImageInput: boolean; imagesBlocked?: boolean },
): Promise<DesktopAttachment> {
	validateDesktopAttachmentName(file.name);
	if (file.size > DESKTOP_ATTACHMENT_REQUEST_BYTES) throw new Error("파일이 8 MiB 요청 한도를 초과합니다.");
	const declaredMime = file.type.toLowerCase();
	const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
	const mimeType =
		!declaredMime || declaredMime === "application/octet-stream"
			? (IMAGE_EXTENSIONS[extension] ?? declaredMime)
			: declaredMime;
	const image = mimeType.startsWith("image/");
	if (image) {
		if (!file.size) throw new Error("빈 이미지는 첨부할 수 없습니다.");
		if (!isDesktopAttachmentImageMime(mimeType)) throw new Error("PNG, JPEG, GIF, WebP 이미지만 지원합니다.");
		if (!options.supportsImageInput) throw new Error("선택한 모델은 이미지 입력을 지원하지 않습니다.");
		if (options.imagesBlocked) throw new Error("SDK 설정에서 이미지 입력이 차단되어 있습니다.");
		if (Math.ceil(file.size / 3) * 4 > DESKTOP_ATTACHMENT_REQUEST_BYTES)
			throw new Error("이미지의 base64 데이터가 8 MiB 요청 한도를 초과합니다.");
	} else if (
		mimeType &&
		mimeType !== "application/octet-stream" &&
		!mimeType.startsWith("text/") &&
		!TEXT_APPLICATION_MIMES.has(mimeType)
	) {
		throw new Error("UTF-8 텍스트·코드 파일과 지원되는 이미지만 첨부할 수 있습니다.");
	}
	const bytes = new Uint8Array(await file.arrayBuffer());
	if (bytes.byteLength !== file.size) throw new Error("파일 읽기를 완료하지 못했습니다. 다시 선택하세요.");
	if (image && isDesktopAttachmentImageMime(mimeType))
		return { kind: "image", name: file.name, mimeType, data: encodeBase64(bytes) };
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch {
		throw new Error("올바른 UTF-8 텍스트 파일이 아닙니다.");
	}
	validateDesktopAttachmentText(text);
	return { kind: "text", name: file.name, text };
}

/** Parent must call before sending: pending/error chips cannot become silent attachment drops. */
export function readyDesktopAttachments(drafts: DesktopAttachmentDraft[]): DesktopAttachment[] {
	if (drafts.some(draft => draft.status === "reading")) throw new Error("첨부 파일 읽기가 끝날 때까지 기다리세요.");
	if (drafts.some(draft => draft.status === "error"))
		throw new Error("오류가 있는 첨부 파일을 제거하고 다시 선택하세요.");
	if (drafts.length > DESKTOP_ATTACHMENT_MAX_COUNT) throw new Error("첨부 파일은 최대 16개까지 선택할 수 있습니다.");
	const attachments = drafts.flatMap(draft => (draft.status === "ready" ? [draft.attachment] : []));
	if (desktopAttachmentJsonBytes(attachments) > DESKTOP_ATTACHMENT_REQUEST_BYTES)
		throw new Error("첨부 파일 데이터가 8 MiB 요청 한도를 초과합니다.");
	return attachments;
}

/** Replaces only a still-owned draft: removing/resetting a pending read cannot resurrect it. */
export function settleDesktopAttachmentDraft(
	current: DesktopAttachmentDraft[],
	result: DesktopAttachmentDraft,
): DesktopAttachmentDraft[] {
	if (!current.some(draft => draft.id === result.id && draft.status === "reading")) return current;
	const next = current.map(draft => (draft.id === result.id ? result : draft));
	if (result.status === "ready") {
		const ready = next.flatMap(draft => (draft.status === "ready" ? [draft.attachment] : []));
		if (desktopAttachmentJsonBytes(ready) > DESKTOP_ATTACHMENT_REQUEST_BYTES)
			return next.map(draft =>
				draft.id === result.id
					? {
							id: draft.id,
							name: draft.name,
							size: draft.size,
							status: "error",
							error: "첨부 파일의 합계가 8 MiB 요청 한도를 초과합니다.",
						}
					: draft,
			);
	}
	return next;
}

/** Only clipboard-authorized image File objects are returned; text paste is left to the composer. */
export function desktopClipboardImageFiles(clipboard: {
	items: Iterable<Pick<DataTransferItem, "kind" | "type" | "getAsFile">>;
}): File[] {
	return [...clipboard.items]
		.filter(item => item.kind === "file" && item.type.startsWith("image/"))
		.flatMap(item => {
			const file = item.getAsFile();
			return file ? [file] : [];
		});
}

function formatSize(size: number): string {
	return size < 1024
		? `${size} B`
		: size < 1024 * 1024
			? `${(size / 1024).toFixed(1)} KiB`
			: `${(size / (1024 * 1024)).toFixed(1)} MiB`;
}

export function addDesktopAttachmentFiles(
	{ sessionId, attachments, supportsImageInput, imagesBlocked, disabled, onChange }: AttachmentPickerProps,
	files: File[],
): void {
	if (disabled || !files.length) return;
	const owner = sessionId;
	// A bounded batch is inserted before starting reads; functional updates preserve concurrent selection/removal.
	const selected = files.slice(0, DESKTOP_ATTACHMENT_MAX_COUNT);
	const drafts: Extract<DesktopAttachmentDraft, { status: "reading" }>[] = selected.map(file => ({
		id: crypto.randomUUID(),
		name: file.name,
		size: file.size,
		status: "reading",
	}));
	const exceedsSelectionLimit = (current: DesktopAttachmentDraft[]) =>
		files.length > DESKTOP_ATTACHMENT_MAX_COUNT ||
		current.length + drafts.length > DESKTOP_ATTACHMENT_MAX_COUNT ||
		current.reduce((bytes, draft) => bytes + draft.size, 0) + selected.reduce((bytes, file) => bytes + file.size, 0) >
			DESKTOP_ATTACHMENT_REQUEST_BYTES;
	const selectionError: DesktopAttachmentDraft = {
		id: `selection-error-${crypto.randomUUID()}`,
		name: "첨부 선택",
		size: 0,
		status: "error",
		error: "최대 16개 파일, 합계 8 MiB 미만으로 선택하세요. base64·요청 정보도 한도에 포함됩니다.",
	};
	const showSelectionError = (current: DesktopAttachmentDraft[]) => [
		...current.filter(draft => !draft.id.startsWith("selection-error-")),
		selectionError,
	];
	if (exceedsSelectionLimit(attachments)) {
		onChange(owner, showSelectionError);
		return;
	}
	onChange(owner, current => (exceedsSelectionLimit(current) ? showSelectionError(current) : [...current, ...drafts]));
	// Keep each callback tied to its original session and ID. Parent state is the ownership authority.
	void (async () => {
		for (const [index, file] of selected.entries()) {
			const draft = drafts[index];
			let result: DesktopAttachmentDraft;
			try {
				const attachment = await readDesktopAttachmentFile(file, { supportsImageInput, imagesBlocked });
				result = { id: draft.id, name: draft.name, size: draft.size, status: "ready", attachment };
			} catch (error) {
				result = {
					id: draft.id,
					name: draft.name,
					size: draft.size,
					status: "error",
					error: error instanceof Error ? error.message : "파일을 읽지 못했습니다. 다시 선택하세요.",
				};
			}
			onChange(owner, current => settleDesktopAttachmentDraft(current, result));
		}
	})();
}

export function AttachmentPicker({
	sessionId,
	attachments,
	supportsImageInput,
	imagesBlocked,
	disabled,
	onChange,
}: AttachmentPickerProps) {
	const input = useRef<HTMLInputElement>(null);
	const pending = attachments.some(draft => draft.status === "reading");
	const imagesAvailable = supportsImageInput && !imagesBlocked;
	const addFiles = (files: File[]) =>
		addDesktopAttachmentFiles(
			{ sessionId, attachments, supportsImageInput, imagesBlocked, disabled, onChange },
			files,
		);
	return (
		<div className="attachment-picker" role="group" aria-label="첨부 파일" aria-busy={pending}>
			<input
				ref={input}
				type="file"
				multiple
				hidden
				tabIndex={-1}
				aria-label="UTF-8 텍스트·코드 또는 이미지 파일 선택"
				disabled={disabled}
				onChange={event => {
					addFiles([...(event.currentTarget.files ?? [])]);
					event.currentTarget.value = "";
				}}
			/>
			<Button
				className="attachment-trigger"
				disabled={disabled}
				aria-label="파일 첨부"
				onClick={() => input.current?.click()}
			>
				<Paperclip size={15} aria-hidden="true" />
			</Button>
			{!imagesAvailable && (
				<small className="attachment-hint">
					{imagesBlocked ? "SDK 설정에서 이미지 입력 차단됨" : "선택한 모델은 이미지 입력 미지원"}
				</small>
			)}
			{pending && <small role="status">첨부 파일 읽는 중… 완료 전에는 보낼 수 없습니다.</small>}
			{attachments.length > 0 && (
				<ul className="attachment-list" aria-label="선택한 첨부 파일">
					{attachments.map(draft => {
						const unavailable = draft.status === "ready" && draft.attachment.kind === "image" && !imagesAvailable;
						return (
							<li
								key={draft.id}
								className={`attachment-chip attachment-${unavailable ? "error" : draft.status}`}
							>
								<span className="attachment-name">{draft.name}</span>
								<small>{formatSize(draft.size)}</small>
								{draft.status === "reading" && <small>읽는 중…</small>}
								{draft.status === "error" && <small role="alert">{draft.error}</small>}
								{unavailable && (
									<small role="alert">
										이미지 입력을 사용할 수 없습니다. 이미지를 제거하거나 모델·설정을 변경하세요.
									</small>
								)}
								<Button
									aria-label={`${draft.name} 첨부 제거`}
									disabled={disabled}
									onClick={() => onChange(sessionId, current => current.filter(item => item.id !== draft.id))}
								>
									<X size={13} aria-hidden="true" />
									제거
								</Button>
							</li>
						);
					})}
				</ul>
			)}
		</div>
	);
}
