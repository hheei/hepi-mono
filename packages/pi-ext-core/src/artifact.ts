import {
	closeSync,
	existsSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getGlobalState } from "./global-state.js";

const ARTIFACT_PATTERN = /^artifact:\/\/([1-9]\d*)$/;

export type ArtifactUri = `artifact://${number}`;

export interface ArtifactRegistry {
	create(text: string): ArtifactUri;
	readonly createAppend: () => ArtifactAppendHandle;
	read(uri: string): string;
	isArtifact(uri: string): boolean;
	dispose(): void;
}

export interface ArtifactAppendHandle {
	append(data: Uint8Array): void;
	finalize(): ArtifactUri;
}

/** Session-local, readonly text resources. URLs never expose a host path. */
export function createArtifactRegistry(): ArtifactRegistry {
	const directory = mkdtempSync(join(tmpdir(), "pi-artifacts-"));
	const values = new Map<number, { readonly path: string; fd?: number }>();
	let disposed = false;
	const allocator = getGlobalState("artifact-url-allocator", (): { next: number } => ({ next: 1 }));
	const parse = (uri: string): number => {
		const match = ARTIFACT_PATTERN.exec(uri);
		if (match === null) throw new Error(`Invalid artifact URL: ${uri}`);
		const id = Number(match[1]);
		if (!Number.isSafeInteger(id) || id < 1 || !values.has(id))
			throw new Error(`Unknown artifact URL: ${uri}`);
		return id;
	};
	const createAppend = (): ArtifactAppendHandle => {
		if (disposed) throw new Error("Artifact registry is disposed");
		const id = allocator.next++;
		const path = join(directory, String(id));
		const fd = openSync(path, "w");
		values.set(id, { path, fd });
		let finalized = false;
		return {
			append(data) {
				if (disposed) throw new Error("Artifact registry is disposed");
				if (finalized) throw new Error("Artifact is finalized");
				writeSync(fd, data);
			},
			finalize() {
				if (disposed) throw new Error("Artifact registry is disposed");
				if (finalized) throw new Error("Artifact is finalized");
				finalized = true;
				closeSync(fd);
				const value = values.get(id);
				if (value === undefined) throw new Error("Unknown artifact URL");
				delete value.fd;
				return `artifact://${id}`;
			},
		};
	};
	return {
		create(text) {
			if (disposed) throw new Error("Artifact registry is disposed");
			const id = allocator.next++;
			const path = join(directory, String(id));
			writeFileSync(path, text, "utf8");
			values.set(id, { path });
			return `artifact://${id}`;
		},
		createAppend,
		read(uri) {
			const value = values.get(parse(uri));
			if (value === undefined) throw new Error(`Unknown artifact URL: ${uri}`);
			return readFileSync(value.path, "utf8");
		},
		isArtifact(uri) {
			return ARTIFACT_PATTERN.test(uri);
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			for (const value of values.values()) {
				if (value.fd !== undefined) closeSync(value.fd);
				if (existsSync(value.path)) unlinkSync(value.path);
			}
			values.clear();
			rmSync(directory, { recursive: true, force: true });
		},
	};
}
