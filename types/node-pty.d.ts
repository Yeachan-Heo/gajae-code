declare module "node-pty" {
	export interface IEvent {
		exitCode: number;
		signal?: string;
	}

	export interface ISpawnOptions {
		name?: string;
		cols?: number;
		rows?: number;
		cwd?: string;
		env?: Record<string, string>;
		[key: string]: unknown;
	}

	export interface IPty {
		onData(callback: (data: string) => void): void;
		onExit(callback: (event: IEvent) => void): void;
		kill(signal?: string): void;
		write(data: string): void;
		[key: string]: unknown;
	}

	export function spawn(file: string, args?: string[], options?: ISpawnOptions): IPty;
}
