import { closeSync, mkdtempSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getGlobalState } from "./global-state.js";

const OUTPUT_PATTERN = /^output:\/\/([1-9]\d*)$/;

export type OutputUri = `output://${number}`;

export interface OutputRegistry {
	create(text: string): OutputUri;
	readonly createAppend: () => OutputAppendHandle;
	read(uri: string, options?: { readonly offset?: number; readonly limit?: number }): string;
	isOutput(uri: string): boolean;
	dispose(): void;
}

export interface OutputAppendHandle {
	readonly uri: OutputUri;
	append(data: Uint8Array): void;
	finalize(): OutputUri;
}

interface ProcessOutputs {
	readonly directory: string;
	readonly values: Map<number, { readonly path: string; fd?: number }>;
	next: number;
}

const processOutputs = getGlobalState(
	"outputs",
	(): ProcessOutputs => ({
		directory: mkdtempSync(join(tmpdir(), "pi-outputs-")),
		values: new Map(),
		next: 1,
	}),
);

/** Process-shared, readonly text resources. URLs never expose host paths. */
export function createOutputRegistry(): OutputRegistry {
	const parse = (uri: string): number => {
		const match = OUTPUT_PATTERN.exec(uri);
		if (match === null) throw new Error(`Invalid output URL: ${uri}`);
		const id = Number(match[1]);
		if (!Number.isSafeInteger(id) || id < 1 || !processOutputs.values.has(id))
			throw new Error(`Unknown output URL: ${uri}`);
		return id;
	};
	const createAppend = (): OutputAppendHandle => {
		const id = processOutputs.next++;
		const path = join(processOutputs.directory, String(id));
		const fd = openSync(path, "w");
		processOutputs.values.set(id, { path, fd });
		let finalized = false;
		return {
			uri: `output://${id}`,
			append(data) {
				if (finalized) throw new Error("Output is finalized");
				writeSync(fd, data);
			},
			finalize() {
				if (finalized) throw new Error("Output is finalized");
				finalized = true;
				closeSync(fd);
				const value = processOutputs.values.get(id);
				if (value === undefined) throw new Error("Unknown output URL");
				delete value.fd;
				return `output://${id}`;
			},
		};
	};
	return {
		create(text) {
			const id = processOutputs.next++;
			const path = join(processOutputs.directory, String(id));
			writeFileSync(path, text, "utf8");
			processOutputs.values.set(id, { path });
			return `output://${id}`;
		},
		createAppend,
		read(uri, options) {
			const value = processOutputs.values.get(parse(uri));
			if (value === undefined) throw new Error(`Unknown output URL: ${uri}`);
			const lines = readFileSync(value.path, "utf8").split("\n");
			const start = options?.offset === undefined ? 0 : Math.max(0, options.offset - 1);
			if (start >= lines.length)
				throw new Error(
					`Offset ${options?.offset} is beyond end of output (${lines.length} lines total)`,
				);
			const end = options?.limit === undefined ? lines.length : start + Math.max(0, options.limit);
			return lines.slice(start, end).join("\n");
		},
		isOutput(uri) {
			return OUTPUT_PATTERN.test(uri);
		},
		dispose() {
			// Outputs outlive individual extension sessions; process exit owns cleanup.
		},
	};
}
