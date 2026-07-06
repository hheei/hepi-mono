import {
	renderTwoColumnListWithSidePanel,
	renderWrappedTableRows,
} from "../../packages/pi-extcore/src/index.js";

export function wrappedThreeColumnTableExample(width = 56): string[] {
	return renderWrappedTableRows({
		width,
		firstColumnWidth: 14,
		secondColumnWidth: 10,
		rows: [
			{
				columns: [
					"ssh_exec",
					"enabled",
					"Run a non-interactive command on a remote OpenSSH host.",
				],
			},
			{
				columns: ["ssh_mount", "disabled", "Mount a remote host locally through sshfs."],
			},
		],
	});
}

export function twoColumnListWithSidePanelExample(width = 72): string[] {
	return renderTwoColumnListWithSidePanel({
		width,
		firstColumnWidth: 18,
		secondColumnWidth: 10,
		rows: [
			{ prefix: "> ", first: "pi-loadout", second: "enabled" },
			{ prefix: "  ", first: "pi-ssh", second: "disabled" },
			{ prefix: "  ", first: "pi-codex-dollar", second: "enabled" },
		],
		title: "Details",
		content:
			"Use the side panel for selected-row details, descriptions, or low-frequency metadata.",
		theme: { title: (text) => `[${text}]` },
	});
}

if (import.meta.main) {
	console.log("Wrapped three-column table");
	console.log(wrappedThreeColumnTableExample().join("\n"));
	console.log("\nTwo-column list with side panel");
	console.log(twoColumnListWithSidePanelExample().join("\n"));
}