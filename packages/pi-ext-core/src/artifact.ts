import { closeSync, mkdtempSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
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
	readonly uri: ArtifactUri;
	append(data: Uint8Array): void;
	finalize(): ArtifactUri;
}

interface ProcessArtifacts {
	readonly directory: string;
	readonly values: Map<number, { readonly path: string; fd?: number }>;
	next: number;
}

const processArtifacts = getGlobalState(
	"artifacts",
	(): ProcessArtifacts => ({
		directory: mkdtempSync(join(tmpdir(), "pi-artifacts-")),
		values: new Map(),
		next: 1,
	}),
);

/** Process-shared, readonly text resources. URLs never expose host paths. */
export function createArtifactRegistry(): ArtifactRegistry {
	const parse = (uri: string): number => {
		const match = ARTIFACT_PATTERN.exec(uri);
		if (match === null) throw new Error(`Invalid artifact URL: ${uri}`);
		const id = Number(match[1]);
		if (!Number.isSafeInteger(id) || id < 1 || !processArtifacts.values.has(id))
			throw new Error(`Unknown artifact URL: ${uri}`);
		return id;
	};
	const createAppend = (): ArtifactAppendHandle => {
		const id = processArtifacts.next++;
		const path = join(processArtifacts.directory, String(id));
		const fd = openSync(path, "w");
		processArtifacts.values.set(id, { path, fd });
		let finalized = false;
		return {
			uri: `artifact://${id}`,
			append(data) {
				if (finalized) throw new Error("Artifact is finalized");
				writeSync(fd, data);
			},
			finalize() {
				if (finalized) throw new Error("Artifact is finalized");
				finalized = true;
				closeSync(fd);
				const value = processArtifacts.values.get(id);
				if (value === undefined) throw new Error("Unknown artifact URL");
				delete value.fd;
				return `artifact://${id}`;
			},
		};
	};
	return {
		create(text) {
			const id = processArtifacts.next++;
			const path = join(processArtifacts.directory, String(id));
			writeFileSync(path, text, "utf8");
			processArtifacts.values.set(id, { path });
			return `artifact://${id}`;
		},
		createAppend,
		read(uri) {
			const value = processArtifacts.values.get(parse(uri));
			if (value === undefined) throw new Error(`Unknown artifact URL: ${uri}`);
			return readFileSync(value.path, "utf8");
		},
		isArtifact(uri) {
			return ARTIFACT_PATTERN.test(uri);
		},
		dispose() {
			// Artifacts outlive individual extension sessions; process exit owns cleanup.
		},
	};
}
