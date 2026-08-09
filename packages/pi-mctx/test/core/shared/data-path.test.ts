import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
    ensureCortexKitArtifactGitignore,
    getDataDir,
    getMagicContextHistorianDir,
    getMagicContextLogPath,
    getMagicContextStorageDir,
    getMagicContextTempDir,
    getProjectMagicContextDir,
    getProjectMagicContextHistorianDir,
} from "../../../src/core/shared/data-path";

const savedEnv = {
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    MAGIC_CONTEXT_LOG_PATH: process.env.MAGIC_CONTEXT_LOG_PATH,
};
const tempDirs: string[] = [];

afterEach(() => {
    if (savedEnv.XDG_DATA_HOME === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = savedEnv.XDG_DATA_HOME;
    if (savedEnv.MAGIC_CONTEXT_LOG_PATH === undefined) delete process.env.MAGIC_CONTEXT_LOG_PATH;
    else process.env.MAGIC_CONTEXT_LOG_PATH = savedEnv.MAGIC_CONTEXT_LOG_PATH;
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    tempDirs.length = 0;
});

describe("data-path", () => {
    test("resolves Pi data and storage paths", () => {
        delete process.env.XDG_DATA_HOME;
        expect(getDataDir()).toBe(path.join(os.homedir(), ".local", "share"));
        expect(getMagicContextStorageDir()).toBe(
            path.join(os.homedir(), ".local", "share", "cortexkit", "magic-context"),
        );
    });

    test("honors XDG_DATA_HOME for storage", () => {
        process.env.XDG_DATA_HOME = "/tmp/mctx-data";
        expect(getDataDir()).toBe("/tmp/mctx-data");
        expect(getMagicContextStorageDir()).toBe("/tmp/mctx-data/cortexkit/magic-context");
    });

    test("resolves Pi temp, log, and historian paths", () => {
        delete process.env.MAGIC_CONTEXT_LOG_PATH;
        expect(getMagicContextTempDir()).toBe(path.join(os.tmpdir(), "pi", "magic-context"));
        expect(getMagicContextLogPath()).toBe(
            path.join(os.tmpdir(), "pi", "magic-context", "magic-context.log"),
        );
        expect(getMagicContextHistorianDir()).toBe(
            path.join(os.tmpdir(), "pi", "magic-context", "historian"),
        );
    });

    test("honors explicit log path", () => {
        process.env.MAGIC_CONTEXT_LOG_PATH = "/tmp/mctx.log";
        expect(getMagicContextLogPath()).toBe("/tmp/mctx.log");
    });

    test("keeps project artifacts under .cortexkit", () => {
        expect(getProjectMagicContextDir("/work/project")).toBe(
            "/work/project/.cortexkit/magic-context",
        );
        expect(getProjectMagicContextHistorianDir("/work/project")).toBe(
            "/work/project/.cortexkit/magic-context/historian",
        );
    });

    test("adds artifact gitignore guard once without overwriting entries", () => {
        const directory = mkdtempSync(path.join(os.tmpdir(), "mctx-path-"));
        tempDirs.push(directory);
        const cortexKitDir = path.join(directory, ".cortexkit");
        const gitignore = path.join(cortexKitDir, ".gitignore");
        ensureCortexKitArtifactGitignore(directory);
        expect(existsSync(gitignore)).toBe(true);
        expect(readFileSync(gitignore, "utf8")).toContain("magic-context/");
        ensureCortexKitArtifactGitignore(directory);
        expect(readFileSync(gitignore, "utf8").match(/cortexkit:magic-context/g)?.length).toBe(2);
    });

    test("preserves existing artifact gitignore entries", () => {
        const directory = mkdtempSync(path.join(os.tmpdir(), "mctx-path-"));
        tempDirs.push(directory);
        const cortexKitDir = path.join(directory, ".cortexkit");
        const gitignore = path.join(cortexKitDir, ".gitignore");
        mkdirSync(cortexKitDir, { recursive: true });
        writeFileSync(gitignore, "other/\n", "utf8");
        ensureCortexKitArtifactGitignore(directory);
        expect(readFileSync(gitignore, "utf8")).toContain("other/\n");
    });
});
