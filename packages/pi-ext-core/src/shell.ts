/** The shell a Bash tool runs when settings name no explicit path. */
export function defaultShellPath(): string {
	return process.platform === "win32"
		? (process.env.ComSpec ?? "cmd.exe")
		: (process.env.SHELL ?? "/bin/sh");
}
