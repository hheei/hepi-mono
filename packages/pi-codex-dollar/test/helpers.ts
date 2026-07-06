export const commands = [
	{
		name: "skill:librarian",
		description:
			"Research open-source libraries with evidence-backed answers and GitHub permalinks.",
		source: "skill",
		sourceInfo: {
			path: "/Users/me/.pi/agent/skills/librarian/SKILL.md",
			scope: "user",
		},
	},
	{
		name: "skill:pi-subagents",
		description: "(User) - Delegate work to subagents",
		source: "skill",
		sourceInfo: {
			path: "/Users/me/.pi/agent/npm/node_modules/pi-subagents/skills/pi-subagents/SKILL.md",
		},
	},
	{
		name: "skill:deploy-plan",
		description: "Prepare deployment plans",
		source: "skill",
		sourceInfo: {
			path: "/Users/me/.pi/agent/skills/deploy-plan/SKILL.md",
			origin: "package",
		},
	},
	{
		name: "model",
		description: "Switch model",
		source: "extension",
		sourceInfo: { path: "<builtin>" },
	},
];

export class FakeEditor {
	[key: symbol]: unknown;
	text: string;
	cursor: number;

	constructor() {
		this.text = "";
		this.cursor = 0;
	}

	handleInput(data: string): void {
		if (data === "\x7f") {
			if (this.cursor === 0) return;
			this.text = this.text.slice(0, this.cursor - 1) + this.text.slice(this.cursor);
			this.cursor -= 1;
			return;
		}

		this.text = this.text.slice(0, this.cursor) + data + this.text.slice(this.cursor);
		this.cursor += data.length;
	}

	insertTextAtCursor(text: string): void {
		this.text = this.text.slice(0, this.cursor) + text + this.text.slice(this.cursor);
		this.cursor += text.length;
	}

	render(): string[] {
		return [this.text];
	}

	getLines(): string[] {
		return [this.text];
	}

	getCursor(): { line: number; col: number } {
		return { line: 0, col: this.cursor };
	}
}

export function noopTheme(): { fg: (_name: string, text: string) => string } {
	return { fg: (_name: string, text: string) => text };
}
