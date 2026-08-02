export type HepiMaybePromise<T> = T | Promise<T>;

export interface HepiPanel {
	readonly id: string;
	readonly label?: string;
	render(width: number): readonly string[];
	handleInput?(input: string): HepiMaybePromise<boolean | undefined>;
	invalidate?(): void;
}

export type HepiSettingsSubpanel = HepiPanel;
