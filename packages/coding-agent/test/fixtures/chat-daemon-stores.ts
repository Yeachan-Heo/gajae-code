import type { ConversationStoreFileHandle, ConversationStoreFs } from "../../src/sdk/bus/conversation-store";

export class MemoryConversationStoreFs implements ConversationStoreFs {
	readonly files = new Map<string, string>();
	readonly modes = new Map<string, number>();
	readonly calls: string[] = [];
	failWrite = false;
	failRename = false;
	failFileSync = false;
	failDirectorySync = false;

	async mkdir(directory: string, options: { recursive: true; mode: number }): Promise<void> {
		this.calls.push(`mkdir:${directory}`);
		this.modes.set(directory, options.mode);
	}

	async chmod(target: string, mode: number): Promise<void> {
		this.calls.push(`chmod:${target}`);
		this.modes.set(target, mode);
	}

	async readFile(file: string, _encoding: "utf8"): Promise<string> {
		const value = this.files.get(file);
		if (value === undefined) {
			const error = Object.assign(new Error(`ENOENT: ${file}`), { code: "ENOENT" });
			throw error;
		}
		return value;
	}

	async writeFile(file: string, data: string, options: { mode: number }): Promise<void> {
		this.calls.push(`write:${file}`);
		if (this.failWrite) throw new Error("write failed");
		this.files.set(file, data);
		this.modes.set(file, options.mode);
	}

	async rename(from: string, to: string): Promise<void> {
		this.calls.push(`rename:${from}:${to}`);
		if (this.failRename) throw new Error("rename failed");
		const data = this.files.get(from);
		if (data === undefined) throw new Error(`missing temporary file: ${from}`);
		this.files.set(to, data);
		this.files.delete(from);
		const mode = this.modes.get(from);
		if (mode !== undefined) this.modes.set(to, mode);
		this.modes.delete(from);
	}

	async unlink(file: string): Promise<void> {
		this.calls.push(`unlink:${file}`);
		this.files.delete(file);
	}

	async open(file: string, flags: string): Promise<ConversationStoreFileHandle> {
		if (flags === "wx") {
			if (this.files.has(file)) {
				throw Object.assign(new Error(`EEXIST: ${file}`), { code: "EEXIST" });
			}
			this.files.set(file, "");
		}
		const isDirectory = !this.files.has(file);
		const writeFile = async (data: string, _encoding: "utf8"): Promise<void> => {
			this.files.set(file, data);
		};

		return {
			sync: async () => {
				this.calls.push(`sync:${file}`);
				if ((isDirectory && this.failDirectorySync) || (!isDirectory && this.failFileSync)) {
					throw new Error("sync failed");
				}
			},
			writeFile,
			close: async () => {
				this.calls.push(`close:${file}`);
			},
		};
	}
}
