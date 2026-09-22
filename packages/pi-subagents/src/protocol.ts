import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { PROTOCOL_VERSION } from "./domain.js";

export const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;
export const DEFAULT_MAX_PENDING_REQUESTS = 128;
export const DEFAULT_MAX_BUFFERED_EVENTS = 256;

export const RUNNER_OPERATIONS = [
	"prompt",
	"steer",
	"follow_up",
	"abort",
	"get_state",
	"get_entries",
	"get_session_stats",
	"shutdown",
	"contact_parent",
	"report_lifecycle",
	"report_paused",
	"pause",
	"cancel_pause",
	"close_writer",
	"start_rpc",
] as const;

export type RunnerOperation = (typeof RUNNER_OPERATIONS)[number];

/** Runner-local event emitted when the Pi child process exits. */
export const RUNNER_EXIT_EVENT = "runner_exit" as const;

/** Runner-local event emitted when only the RPC writer exited and the runner stayed up. */
export const WRITER_EXIT_EVENT = "writer_exit" as const;

/** Runner-local event emitted when buffered events had to be dropped. */
export const RUNNER_EVENTS_DROPPED_EVENT = "runner_events_dropped" as const;

/** Child-branch event: the TUI left the bound session, quit, or was interrupted. */
export const CHILD_LIFECYCLE_EVENT = "child_lifecycle" as const;

/** Runner-to-bridge event: hold the current turn_end until close_writer or cancel. */
export const PAUSE_EVENT = "pause" as const;

/** Runner-to-bridge event: release a previous pause generation. */
export const CANCEL_PAUSE_EVENT = "cancel_pause" as const;

const nonEmptyString = Type.String({ minLength: 1 });

const operationSchema = Type.Union(RUNNER_OPERATIONS.map((operation) => Type.Literal(operation)));

const identityProperties = {
	parentSessionId: nonEmptyString,
	subagentId: nonEmptyString,
	runtimeIdentity: nonEmptyString,
	endpoint: nonEmptyString,
	token: nonEmptyString,
} as const;

export const HelloFrameSchema = Type.Object(
	{
		version: Type.Literal(PROTOCOL_VERSION),
		type: Type.Literal("hello"),
		role: Type.Optional(
			Type.Union([
				Type.Literal("controller"),
				Type.Literal("reporter"),
				Type.Literal("recovery"),
				Type.Literal("bridge"),
			]),
		),
		claimId: Type.Optional(nonEmptyString),
		...identityProperties,
	},
	{ additionalProperties: false },
);

export const HelloAckFrameSchema = Type.Object(
	{ version: Type.Literal(PROTOCOL_VERSION), type: Type.Literal("hello_ack") },
	{ additionalProperties: false },
);

export const RequestFrameSchema = Type.Object(
	{
		version: Type.Literal(PROTOCOL_VERSION),
		type: Type.Literal("request"),
		id: nonEmptyString,
		operation: operationSchema,
		payload: Type.Optional(Type.Unknown()),
	},
	{ additionalProperties: false },
);

export const RunnerErrorSchema = Type.Object(
	{ code: nonEmptyString, message: nonEmptyString },
	{ additionalProperties: false },
);

export const ResponseFrameSchema = Type.Union([
	Type.Object(
		{
			version: Type.Literal(PROTOCOL_VERSION),
			type: Type.Literal("response"),
			id: nonEmptyString,
			ok: Type.Literal(true),
			data: Type.Optional(Type.Unknown()),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			version: Type.Literal(PROTOCOL_VERSION),
			type: Type.Literal("response"),
			id: nonEmptyString,
			ok: Type.Literal(false),
			error: RunnerErrorSchema,
		},
		{ additionalProperties: false },
	),
]);

export const EventFrameSchema = Type.Object(
	{ version: Type.Literal(PROTOCOL_VERSION), type: Type.Literal("event"), event: Type.Unknown() },
	{ additionalProperties: false },
);

export const ServerFrameSchema = Type.Union([
	HelloAckFrameSchema,
	ResponseFrameSchema,
	EventFrameSchema,
]);

export const PromptPayloadSchema = Type.Object(
	{ message: nonEmptyString },
	{ additionalProperties: false },
);

export const GetEntriesPayloadSchema = Type.Object(
	{ since: nonEmptyString },
	{ additionalProperties: false },
);

export const ContactReportPayloadSchema = Type.Object(
	{
		type: Type.Literal("pi_subagent_report"),
		parentSessionId: nonEmptyString,
		childId: nonEmptyString,
		runtimeIdentity: nonEmptyString,
		reason: Type.Union([
			Type.Literal("progress_update"),
			Type.Literal("important_finding"),
			Type.Literal("need_decision"),
			Type.Literal("blocked"),
		]),
		message: nonEmptyString,
		sessionId: Type.Optional(nonEmptyString),
	},
	{ additionalProperties: false },
);

export const ChildLifecyclePayloadSchema = Type.Object(
	{
		type: Type.Literal("child_lifecycle"),
		parentSessionId: nonEmptyString,
		childId: nonEmptyString,
		runtimeIdentity: nonEmptyString,
		kind: Type.Union([
			Type.Literal("left_session"),
			Type.Literal("tui_quit"),
			Type.Literal("user_interrupt"),
		]),
		sessionId: nonEmptyString,
		message: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

export const PauseReportPayloadSchema = Type.Object(
	{
		type: Type.Literal("report_paused"),
		parentSessionId: nonEmptyString,
		childId: nonEmptyString,
		runtimeIdentity: nonEmptyString,
		generation: Type.Integer({ minimum: 1 }),
	},
	{ additionalProperties: false },
);

export type HelloFrame = Static<typeof HelloFrameSchema>;
export type HelloAckFrame = Static<typeof HelloAckFrameSchema>;
export type RequestFrame = Static<typeof RequestFrameSchema>;
export type ResponseFrame = Static<typeof ResponseFrameSchema>;
export type EventFrame = Static<typeof EventFrameSchema>;
export type ServerFrame = Static<typeof ServerFrameSchema>;
export type ContactReportPayload = Static<typeof ContactReportPayloadSchema>;
export type ChildLifecyclePayload = Static<typeof ChildLifecyclePayloadSchema>;
export type PauseReportPayload = Static<typeof PauseReportPayloadSchema>;

export function isRunnerOperation(value: unknown): value is RunnerOperation {
	return typeof value === "string" && (RUNNER_OPERATIONS as readonly string[]).includes(value);
}

export function isHelloFrame(value: unknown): value is HelloFrame {
	return Value.Check(HelloFrameSchema, value);
}

export function isHelloAckFrame(value: unknown): value is HelloAckFrame {
	return Value.Check(HelloAckFrameSchema, value);
}

export function isRequestFrame(value: unknown): value is RequestFrame {
	return Value.Check(RequestFrameSchema, value);
}

export function isContactReportPayload(value: unknown): value is ContactReportPayload {
	return Value.Check(ContactReportPayloadSchema, value);
}

export function isChildLifecyclePayload(value: unknown): value is ChildLifecyclePayload {
	return Value.Check(ChildLifecyclePayloadSchema, value);
}

export function isPauseReportPayload(value: unknown): value is PauseReportPayload {
	return Value.Check(PauseReportPayloadSchema, value);
}

export function isResponseFrame(value: unknown): value is ResponseFrame {
	return Value.Check(ResponseFrameSchema, value);
}

export function isEventFrame(value: unknown): value is EventFrame {
	return Value.Check(EventFrameSchema, value);
}

export function isServerFrame(value: unknown): value is ServerFrame {
	return Value.Check(ServerFrameSchema, value);
}

export function successResponse(id: string, data?: unknown): ResponseFrame {
	return {
		version: PROTOCOL_VERSION,
		type: "response",
		id,
		ok: true,
		...(data === undefined ? {} : { data }),
	};
}

export function failureResponse(id: string, code: string, message: string): ResponseFrame {
	return { version: PROTOCOL_VERSION, type: "response", id, ok: false, error: { code, message } };
}

export function eventFrame(event: unknown): EventFrame {
	return { version: PROTOCOL_VERSION, type: "event", event };
}
