import type { DesktopSession } from "@gajae-code/desktop-host/protocol";
import { useEffect, useRef, useState } from "react";
import { request } from "./bridge";
import { Button, ErrorBanner, Modal } from "./components";
import { t } from "./i18n";

/** The request owner of one open dialog; closing the dialog retires it. */
interface ToolsDialogOwner {
	sessionId: string;
	active: boolean;
	busy: boolean;
}

export interface ToolCatalogDialogProps {
	/** The conversation whose tools are listed. App mounts one dialog per open. */
	session: DesktopSession;
	connected: boolean;
	onClose(): void;
}

/** The Active tools dialog: lists `tools.list` once per open and saves the checked names with `tools.set`. */
export function ToolCatalogDialog({ session, connected, onClose }: ToolCatalogDialogProps) {
	const sessionId = session.id;
	const [toolNames, setToolNames] = useState<string[]>([]);
	const [activeTools, setActiveTools] = useState<string[]>([]);
	// The read and the save share one pending state and one error, as one request scope.
	const [pending, setPending] = useState(true);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const ownerRef = useRef<ToolsDialogOwner | null>(null);
	const current = (owner: ToolsDialogOwner) => owner.active && ownerRef.current === owner;
	const run = async (owner: ToolsDialogOwner, action: () => Promise<void>) => {
		if (!current(owner) || owner.busy) return;
		owner.busy = true;
		setPending(true);
		setError("");
		try {
			await action();
		} catch (failure) {
			if (current(owner)) setError(failure instanceof Error ? failure.message : t("shell.requestFailed"));
		} finally {
			owner.busy = false;
			if (current(owner)) setPending(false);
		}
	};
	useEffect(() => {
		// A development StrictMode remount of the same open resumes its read instead of sending another.
		const resumed = ownerRef.current?.sessionId === sessionId ? ownerRef.current : null;
		const owner: ToolsDialogOwner = resumed ?? { sessionId, active: true, busy: false };
		owner.active = true;
		ownerRef.current = owner;
		if (!resumed)
			void run(owner, async () => {
				const value = await request<unknown>("tools.list", { sessionId });
				if (!current(owner)) return;
				if (
					!value ||
					typeof value !== "object" ||
					!("available" in value) ||
					!("active" in value) ||
					!Array.isArray(value.available) ||
					!Array.isArray(value.active) ||
					!value.available.every(item => typeof item === "string") ||
					!value.active.every(item => typeof item === "string")
				)
					throw new Error(t("shell.toolListInvalid"));
				setToolNames(value.available);
				setActiveTools(value.active);
			});
		return () => {
			owner.active = false;
		};
	}, [sessionId]);
	const saveTools = () => {
		const owner = ownerRef.current;
		if (!owner) return;
		void run(owner, async () => {
			await request("tools.set", { sessionId, names: activeTools });
			if (current(owner)) setNotice(t("shell.toolsSaved"));
		});
	};
	return (
		<Modal title={t("shell.dialogTools")} onClose={onClose}>
			{error && <ErrorBanner>{error}</ErrorBanner>}
			{notice && <p role="status">{notice}</p>}
			{pending ? (
				<p>{t("shell.loadingTools")}</p>
			) : toolNames.length === 0 ? (
				<p>{t("shell.noTools")}</p>
			) : (
				toolNames.map(name => (
					<label className="checkbox-label" key={name}>
						<input
							type="checkbox"
							checked={activeTools.includes(name)}
							onChange={event =>
								setActiveTools(previous =>
									event.target.checked ? [...previous, name] : previous.filter(item => item !== name),
								)
							}
						/>
						{name}
					</label>
				))
			)}
			<Button disabled={!connected || pending || !!error} onClick={saveTools}>
				{t("shell.saveTools")}
			</Button>
		</Modal>
	);
}
