import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export function getDataDir(): string {
    return process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
}

export function getMagicContextTempDir(): string {
    return path.join(os.tmpdir(), "pi", "magic-context");
}

export function getMagicContextLogPath(): string {
    const envPath = process.env.MAGIC_CONTEXT_LOG_PATH?.trim();
    if (envPath) return envPath;
    return path.join(getMagicContextTempDir(), "magic-context.log");
}

export function getMagicContextHistorianDir(): string {
    return path.join(getMagicContextTempDir(), "historian");
}

/** Project-local transient artifacts, readable by Pi's native tools. */
export function getProjectMagicContextDir(directory: string): string {
    return path.join(directory, ".cortexkit", "magic-context");
}

const GITIGNORE_GUARD_OPEN = "# >>> cortexkit:magic-context";
const GITIGNORE_GUARD_CLOSE = "# <<< cortexkit:magic-context";

/** Keep transient artifacts out of version control without touching other entries. */
export function ensureCortexKitArtifactGitignore(directory: string): void {
    try {
        const cortexKitDir = path.join(directory, ".cortexkit");
        const gitignorePath = path.join(cortexKitDir, ".gitignore");
        let existing = "";
        if (existsSync(gitignorePath)) {
            existing = readFileSync(gitignorePath, "utf8");
            if (existing.includes(GITIGNORE_GUARD_OPEN)) return;
        }
        const block = `${GITIGNORE_GUARD_OPEN}\nmagic-context/\n${GITIGNORE_GUARD_CLOSE}\n`;
        const needsLeadingNewline = existing.length > 0 && !existing.endsWith("\n");
        mkdirSync(cortexKitDir, { recursive: true });
        writeFileSync(gitignorePath, existing + (needsLeadingNewline ? "\n" : "") + block, "utf8");
    } catch {
        // Artifact writes retain their own failure handling.
    }
}

export function getMagicContextStorageDir(): string {
    return path.join(getDataDir(), "cortexkit", "magic-context");
}
