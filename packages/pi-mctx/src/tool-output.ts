export interface MctxToolOutput {
	readonly body: string;
	readonly dropped?: readonly number[];
	readonly pending?: readonly number[];
	readonly isError?: boolean;
}

function renderTagNumbers(tagNumbers: readonly number[] | undefined): string {
	return tagNumbers === undefined || tagNumbers.length === 0
		? "none"
		: [...new Set(tagNumbers)]
				.sort((left, right) => left - right)
				.map((tag) => `#${tag}`)
				.join(", ");
}

/** Keeps every active MCTX tool transcript entry structurally scannable. */
export function renderMctxToolOutput(input: MctxToolOutput): {
	content: [{ type: "text"; text: string }];
	readonly details: undefined;
	readonly isError?: true;
} {
	return {
		content: [
			{
				type: "text",
				text: `[magic context]\ndropped: ${renderTagNumbers(input.dropped)}\npending: ${renderTagNumbers(input.pending)}\n\n${input.body}`,
			},
		],
		details: undefined,
		...(input.isError === true ? { isError: true as const } : {}),
	};
}
