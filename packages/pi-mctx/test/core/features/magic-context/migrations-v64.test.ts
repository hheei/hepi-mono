/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";

import { Database } from "../../../../src/core/shared/sqlite";
import { closeQuietly } from "../../../../src/core/shared/sqlite-helpers";
import { LATEST_MIGRATION_VERSION, runMigrations } from "../../../../src/core/features/magic-context/migrations";
import { initializeDatabase, LATEST_SUPPORTED_VERSION } from "../../../../src/core/features/magic-context/storage-db";

describe("migration v64: mural manifest", () => {
    test("creates the project-scoped image manifest and keeps the schema fence aligned", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);
            expect(LATEST_SUPPORTED_VERSION).toBe(LATEST_MIGRATION_VERSION);
            const columns = db.prepare("PRAGMA table_info(mural_manifest)").all() as Array<{
                name: string;
            }>;
            expect(columns.map((column) => column.name)).toEqual([
                "project_path",
                "image",
                "content_hash",
                "rendered_at",
                "model",
                "memory_ids_json",
                "width",
                "height",
            ]);
        } finally {
            closeQuietly(db);
        }
    });
});
