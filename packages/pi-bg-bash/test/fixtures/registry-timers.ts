/**
 * Scheduling primitives the Bash registry uses for its own delays: the stop escalation, the stdio
 * drain, the shutdown grace and the job timeout.
 *
 * A suite that drives a process double fakes exactly these, so registry delays cost no wall clock
 * while the real event loop the double reports on is untouched. Suites that drive real processes
 * keep real timers: their wait is the production grace period, and faking it would race the
 * operating system's own process teardown.
 */
export const REGISTRY_TIMERS = [
	"setTimeout",
	"clearTimeout",
	"setInterval",
	"clearInterval",
] as const;
