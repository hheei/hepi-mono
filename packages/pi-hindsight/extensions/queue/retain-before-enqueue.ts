import { spawn } from "node:child_process";
import type { ResolvedConfig, RetainJob } from "../types.js";

export class RetainBeforeEnqueueError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RetainBeforeEnqueueError";
	}
}

function compareCodePoints(left: string, right: string): number {
	const leftPoints = Array.from(left);
	const rightPoints = Array.from(right);
	const length = Math.min(leftPoints.length, rightPoints.length);
	for (let index = 0; index < length; index += 1) {
		const leftCharacter = leftPoints[index];
		const rightCharacter = rightPoints[index];
		if (leftCharacter === undefined || rightCharacter === undefined) break;
		const leftPoint = leftCharacter.codePointAt(0);
		const rightPoint = rightCharacter.codePointAt(0);
		if (leftPoint === undefined || rightPoint === undefined) continue;
		if (leftPoint !== rightPoint) return leftPoint - rightPoint;
	}
	return leftPoints.length - rightPoints.length;
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => compareCodePoints(left, right))
			.map(([key, item]) => [key, canonicalize(item)]),
	);
}

export function canonicalRetainJobJson(job: RetainJob): string {
	return `${JSON.stringify(canonicalize(job), null, 2)}\n`;
}

export async function runRetainBeforeEnqueueCheck(
	config: ResolvedConfig,
	job: RetainJob,
): Promise<void> {
	const check = config.retain.beforeEnqueue;
	if (!check) return;
	const [executable, ...args] = check.command;
	if (check.malformed || executable === undefined) {
		throw new RetainBeforeEnqueueError(
			"retain.beforeEnqueue is malformed; blocked retain job before queue admission",
		);
	}

	await new Promise<void>((resolve, reject) => {
		const child = spawn(executable, args, {
			shell: false,
			stdio: ["pipe", "ignore", "ignore"],
			windowsHide: true,
		});
		let settled = false;
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (error) reject(error);
			else resolve();
		};
		const timer = setTimeout(() => {
			child.kill();
			finish(new RetainBeforeEnqueueError("retain.beforeEnqueue timed out"));
		}, check.timeoutMs);

		child.on("error", () => {
			finish(new RetainBeforeEnqueueError("retain.beforeEnqueue could not start"));
		});
		child.on("exit", (code, signal) => {
			if (code === 0) {
				finish();
				return;
			}
			const reason = signal ? `signal ${signal}` : `exit ${code ?? "unknown"}`;
			finish(
				new RetainBeforeEnqueueError(
					`retain.beforeEnqueue blocked retain job before queue admission (${reason})`,
				),
			);
		});
		child.stdin?.on("error", () => {});
		child.stdin?.end(canonicalRetainJobJson(job), "utf8");
	});
}
