const PATCH_MARKER: unique symbol = Symbol("@luxusai/pi-hindsight.fetch-request-compat");

type FetchWithMarker = typeof fetch & { [PATCH_MARKER]?: true };
type RequestInitWithDuplex = RequestInit & { duplex?: "half" };
type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

function isRequest(value: unknown): value is Request {
	return typeof Request !== "undefined" && value instanceof Request;
}

function requestToInit(request: Request): RequestInitWithDuplex {
	return {
		method: request.method,
		headers: request.headers,
		body: request.body,
		signal: request.signal,
		redirect: request.redirect,
		credentials: request.credentials,
		cache: request.cache,
		mode: request.mode,
		referrer: request.referrer,
		referrerPolicy: request.referrerPolicy,
		integrity: request.integrity,
		keepalive: request.keepalive,
		...(request.body ? { duplex: "half" as const } : {}),
	} as RequestInitWithDuplex;
}

export function installFetchRequestCompat(): void {
	const currentFetch = globalThis.fetch as FetchWithMarker | undefined;
	if (!currentFetch || currentFetch[PATCH_MARKER]) return;

	const originalFetch = currentFetch.bind(globalThis) as typeof fetch;
	const patchedFetch: FetchWithMarker = ((input: FetchInput, init?: FetchInit) => {
		if (!isRequest(input)) return originalFetch(input, init);
		return originalFetch(input.url, { ...requestToInit(input), ...init });
	}) as FetchWithMarker;
	patchedFetch[PATCH_MARKER] = true;
	globalThis.fetch = patchedFetch;
}
