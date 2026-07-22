export {
	DEFAULT_PENDING_CEILING_BYTES,
	MIN_PENDING_CEILING_BYTES,
	REQUEST_FRAME_BYTES,
} from "./relay";
export { startSocketServe } from "./socket";
export { startStdioServe } from "./stdio";

export type ServeOptions = {
	url: string;
	token: string;
	pendingCeilingBytes: number;
};

export type ServeHandle = {
	close(): Promise<void>;
	readonly done: Promise<void>;
};
