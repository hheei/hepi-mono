import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

const CONFIG_FILE_BASENAME = "magic-context";

function configHome(): string {
    const value = process.env.XDG_CONFIG_HOME;
    return value && isAbsolute(value) ? value : join(process.env.HOME ?? homedir(), ".config");
}

export function cortexKitUserConfigBasePath(): string {
    return join(configHome(), "cortexkit", CONFIG_FILE_BASENAME);
}

export function cortexKitProjectConfigBasePath(directory: string): string {
    return join(directory, ".cortexkit", CONFIG_FILE_BASENAME);
}
