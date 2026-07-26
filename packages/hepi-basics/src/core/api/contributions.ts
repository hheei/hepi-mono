export interface HePiContribution {
	readonly id: string;
	readonly priority?: number;
}

export interface HePiEditorContribution extends HePiContribution {
	readonly kind: "editor";
}

export interface HePiFooterContribution extends HePiContribution {
	readonly kind: "footer";
}

export interface HePiStatusContribution extends HePiContribution {
	readonly kind: "status";
}
