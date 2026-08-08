import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getProjectEmbeddingSnapshot } from "#core/features/magic-context/memory/embedding";
import {
	getProjectEmbeddings,
	peekProjectEmbeddings,
	resetEmbeddingCacheForTests,
} from "#core/features/magic-context/memory/embedding-cache";
import { resolveProjectIdentity } from "#core/features/magic-context/memory/project-identity";
import { closeQuietly } from "#core/shared/sqlite-helpers";
import { ensureProjectRegisteredFromPiDirectory } from "../src/embedding-bootstrap";
import { createTestDb } from "./test-utils.test";

describe("ensureProjectRegisteredFromPiDirectory", () => {
	it("preserves the embedding cache across consecutive identical registrations", async () => {
		const db = createTestDb();
		const oldHome = process.env.HOME;
		const directory = mkdtempSync(join(tmpdir(), "pi-embedding-bootstrap-"));
		const fakeHome = mkdtempSync(join(tmpdir(), "pi-embedding-home-"));
		process.env.HOME = fakeHome;
		resetEmbeddingCacheForTests();
		try {
			const projectIdentity = resolveProjectIdentity(directory);

			await ensureProjectRegisteredFromPiDirectory(directory, db);
			const modelId =
				getProjectEmbeddingSnapshot(projectIdentity)?.modelId ?? "off";
			const cached = getProjectEmbeddings(db, projectIdentity, modelId);
			cached.set(42, { embedding: new Float32Array([1, 2, 3]), modelId });

			await ensureProjectRegisteredFromPiDirectory(directory, db);

			expect(peekProjectEmbeddings(projectIdentity, modelId)).toBe(cached);
			expect(peekProjectEmbeddings(projectIdentity, modelId)?.get(42)).toEqual({
				embedding: new Float32Array([1, 2, 3]),
				modelId,
			});
		} finally {
			resetEmbeddingCacheForTests();
			if (oldHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = oldHome;
			}
			closeQuietly(db);
		}
	});
});
