export interface HepiContribution {
	readonly id: string;
	readonly priority?: number;
}

export interface HepiEditorContribution extends HepiContribution {
	readonly kind: "editor";
}

export interface HepiFooterContribution extends HepiContribution {
	readonly kind: "footer";
}

export interface HepiStatusContribution extends HepiContribution {
	readonly kind: "status";
}
