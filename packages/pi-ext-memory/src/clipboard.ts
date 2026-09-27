import { runCommand } from "@hheei/pi-ext-core";

export interface ClipboardCommand {
	command: string;
	args: string[];
}

export type ClipboardCommandRunner = (command: ClipboardCommand, text: string) => Promise<boolean>;

export function getClipboardCommands(
	platform: NodeJS.Platform = process.platform,
): ClipboardCommand[] {
	switch (platform) {
		case "darwin":
			return [{ command: "pbcopy", args: [] }];
		case "win32":
			return [{ command: "clip", args: [] }];
		default:
			return [
				{ command: "wl-copy", args: [] },
				{ command: "xclip", args: ["-selection", "clipboard"] },
				{ command: "xsel", args: ["--clipboard", "--input"] },
				{ command: "termux-clipboard-set", args: [] },
			];
	}
}

export async function copyTextToClipboard(
	text: string,
	runner: ClipboardCommandRunner = runClipboardCommand,
	commands: ClipboardCommand[] = getClipboardCommands(),
): Promise<boolean> {
	for (const command of commands) {
		if (await runner(command, text)) return true;
	}
	return false;
}

export async function runClipboardCommand(
	command: ClipboardCommand,
	text: string,
): Promise<boolean> {
	try {
		const result = await runCommand(command.command, command.args, {
			input: text,
			timeoutMs: 2_000,
		});
		return !result.timedOut && result.code === 0;
	} catch {
		return false;
	}
}
