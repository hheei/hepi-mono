export interface MctxToolOutput {
	readonly body: string;
	readonly isError?: boolean;
}

/** Adds Magic Context provenance without imposing unrelated status fields on tool payloads. */
export function renderMctxToolOutput(input: MctxToolOutput): {
	content: [{ type: "text"; text: string }];
	readonly details: undefined;
	readonly isError?: true;
} {
	return {
		content: [
			{
				type: "text",
				text: `[magic context]\n${input.body}`,
			},
		],
		details: undefined,
		...(input.isError === true ? { isError: true as const } : {}),
	};
}
