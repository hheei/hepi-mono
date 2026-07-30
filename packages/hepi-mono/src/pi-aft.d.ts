import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

declare module "@cortexkit/aft-pi" {
	export type AftApplyPatchDetails = {
		readonly phase: "preview" | "applied";
		readonly paths: readonly string[];
		readonly text?: string | undefined;
	};

	type ApplyPatchRenderContext = {
		readonly isError: boolean;
		readonly argsComplete?: boolean | undefined;
		readonly cwd?: string | undefined;
		readonly expanded?: boolean | undefined;
		readonly state?: object | undefined;
		readonly toolCallId?: string | undefined;
	};

	export function startAftApplyPatchRender(
		toolCallId: string,
		patchText: string,
		cwd: string,
	): void;
	export function markAftApplyPatchFailure(
		toolCallId: string,
		patchText: string,
		cwd: string,
		response: unknown,
		partial: boolean,
	): void;
	export function renderAftApplyPatchCall(
		args: { readonly patchText?: unknown } | undefined,
		theme: Theme,
		context: ApplyPatchRenderContext,
	): Component;
	export function renderAftApplyPatchResult(
		result: AgentToolResult<unknown>,
		options: { readonly isPartial?: boolean | undefined },
		theme: Theme,
		context: ApplyPatchRenderContext,
	): Component;
}
