export type SelectListTheme = {
	description?: (text: string) => string;
	scrollInfo?: (text: string) => string;
	selectedText?: (text: string) => string;
};

export type DollarTheme = {
	fg?: (key: string, text: string) => string;
	selectList?: SelectListTheme;
	description?: (text: string) => string;
	scrollInfo?: (text: string) => string;
	selectedText?: (text: string) => string;
};

export type SkillSourceInfo = {
	path?: string;
	baseDir?: string;
	source?: string;
	origin?: string;
	scope?: string;
};

export type SkillCommand = {
	name: string;
	description?: string;
	source?: string;
	sourceInfo?: SkillSourceInfo;
};

export type SkillEntry = {
	index: number;
	name: string;
	normalizedName: string;
	source: string;
	description: string;
	value: string;
};

export type SkillSuggestion = {
	value: string;
	label: string;
	description: string;
};

export type DollarSkillToken = {
	query: string;
	prefix: string;
};

export type EditorCursor = { line: number; col: number };

export type EditorLike = {
	getLines(): string[];
	getCursor(): EditorCursor;
	handleInput(data: string): void;
	render(width: number): string[];
	insertTextAtCursor?: (text: string) => void;
};

export type SymbolMetadata = Record<symbol, unknown>;

export type TuiLike = {
	height?: number;
	rows?: number;
	terminal?: { height?: number; rows?: number };
	requestRender?: () => void;
};

export type KeybindingsLike = {
	matches?: (data: string, action: string) => boolean;
};

export type CustomEditorConstructor = new (
	tui: TuiLike,
	theme: DollarTheme,
	keybindings: KeybindingsLike | undefined,
) => EditorLike;

export type PickerState = {
	token: DollarSkillToken;
	items: SkillSuggestion[];
};
