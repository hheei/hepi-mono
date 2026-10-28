export function createControllerSocket(options: {
	readonly locate: () => string;
	readonly ready: (socketPath: string) => Promise<boolean>;
	readonly start: () => Promise<string>;
}): () => Promise<string> {
	let opening: Promise<string> | undefined;
	return () => {
		if (opening !== undefined) return opening;
		const attempt = openControllerSocket(options).finally(() => {
			if (opening === attempt) opening = undefined;
		});
		opening = attempt;
		return attempt;
	};
}

export function retryableControllerStart(error: Error): boolean {
	const message = error.message;
	return (
		message.startsWith("busy ") ||
		message.includes("already running") ||
		message.includes("not accepting connections")
	);
}

async function openControllerSocket(options: {
	readonly locate: () => string;
	readonly ready: (socketPath: string) => Promise<boolean>;
	readonly start: () => Promise<string>;
}): Promise<string> {
	const socketPath = options.locate();
	let lastError: Error | undefined;
	for (let attempt = 0; attempt < 20; attempt += 1) {
		if (await options.ready(socketPath)) return socketPath;
		try {
			const started = await options.start();
			if (await options.ready(started)) return started;
			throw new Error("Controller announced a socket that is not accepting connections");
		} catch (error) {
			const wrapped = error instanceof Error ? error : new Error(String(error));
			if (await options.ready(socketPath)) return socketPath;
			if (!retryableControllerStart(wrapped)) throw wrapped;
			lastError = wrapped;
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw lastError ?? new Error("Controller socket did not become ready");
}
