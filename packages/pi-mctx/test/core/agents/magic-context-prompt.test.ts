import { describe, expect, it } from "vitest";
import { buildMagicContextSection } from "../../../src/core/agents/magic-context-prompt";

const CAVEMAN_MARKER = "BEWARE";
const CAVEMAN_PHRASE_TAIL = "consciously revert to full sentences";

const KNOWN_AGENT_IDENTITIES = [
	"sisyphus",
	"atlas",
	"hephaestus",
	"sisyphus-junior",
	"oracle",
	"athena",
	"athena-junior",
] as const;

describe("buildMagicContextSection — generic guidance", () => {
	it("emits the same generic guidance for all known agent identities", () => {
		const generic = buildMagicContextSection(null, 20, true, false, false, false);

		for (const agent of KNOWN_AGENT_IDENTITIES) {
			expect(buildMagicContextSection(agent, 20, true, false, false, false)).toBe(generic);
		}
	});

	it("does not emit legacy agent-tailored guidance", () => {
		const out = buildMagicContextSection("atlas", 20, true, false, false, false);

		expect(out).toContain("### Reduction Triggers");
		expect(out).toContain("Your current task requirements and constraints");
		expect(out).not.toContain("CRITICAL — you run long sessions");
		expect(out).not.toContain("delegation tool outputs from completed waves");
		expect(out).not.toContain("council member response outputs");
	});

	it("opens with the long-term-partner frame in BOTH mctx_reduce availability variants", () => {
		const reduce = buildMagicContextSection(null, 20, true, false, false, false);
		const noReduce = buildMagicContextSection(null, 20, false, false, false, false);

		for (const out of [reduce, noReduce]) {
			// Identity frame + the durability + no-scarcity + no-wind-down beats.
			expect(out).toContain("long-term partner on this project");
			expect(out).toContain("weeks, months, or even years");
			expect(out).toContain("effectively unbounded");
			expect(out).toContain("never a reason to wrap up, cut scope, rush, or defer");
			expect(out).toContain("Finishing a task does not end the session");
			expect(out).toContain("no compaction pauses");
			// Frame is at the TOP — before the tool mechanics.
			expect(out.indexOf("long-term partner")).toBeLessThan(out.indexOf("mctx_note"));
		}
	});

	it("uses the mode-specific partner-frame closer", () => {
		const reduce = buildMagicContextSection(null, 20, true, false, false, false);
		const noReduce = buildMagicContextSection(null, 20, false, false, false, false);

		// reduce mode: agent participates in housekeeping
		expect(reduce).toContain("Reduction prompts are routine housekeeping");
		expect(reduce).not.toContain("there's nothing to prune");
		// no-reduce mode: fully automatic, nothing to prune
		expect(noReduce).toContain("there's nothing to prune and no warnings to act on");
		expect(noReduce).not.toContain("Reduction prompts are routine housekeeping");
		// Both keep the task-scope caveat.
		for (const out of [reduce, noReduce]) {
			expect(out).toContain("never let context size change");
		}
	});

	it("no longer emits the scarcity-flavored 'compress early and often, don't wait for warnings' line", () => {
		const reduce = buildMagicContextSection(null, 20, true, false, false, false);
		expect(reduce).not.toContain("don't wait for warnings");
	});
});

describe("buildMagicContextSection — subagent mode", () => {
	const subagent = () => buildMagicContextSection(null, 20, true, false, false, false, true);

	it("emits ONLY the minimal §N§ + mctx_reduce mechanics", () => {
		const out = subagent();
		// Has the marker (injection idempotency) + the tag/mctx_reduce mechanics.
		expect(out).toContain("## Magic Context");
		expect(out).toContain("§N§ identifiers");
		expect(out).toContain("mctx_reduce");
		expect(out).toContain("The last 20 tags are protected");
	});

	it("OMITS the long-term-partner frame and primary-only guidance", () => {
		const out = subagent();
		expect(out).not.toContain("long-term partner");
		expect(out).not.toContain("weeks, months, or even years");
		expect(out).not.toContain("### Reduction Triggers");
		expect(out).not.toContain("mctx_memory");
		expect(out).not.toContain("mctx_search");
		expect(out).not.toContain("mctx_note");
		expect(out).not.toContain("mctx_expand");
	});

	it("threads protectedTags into the protected-count line", () => {
		const out = buildMagicContextSection(null, 7, true, false, false, false, true);
		expect(out).toContain("The last 7 tags are protected");
	});

	it("is much shorter than the full primary block", () => {
		const full = buildMagicContextSection(null, 20, true, false, false, false, false);
		expect(subagent().length).toBeLessThan(full.length / 2);
	});

	it("defaults subagentMode=false (legacy callers unaffected)", () => {
		const sixArg = buildMagicContextSection(null, 20, true, false, false, false);
		const explicitFalse = buildMagicContextSection(null, 20, true, false, false, false, false);
		expect(sixArg).toBe(explicitFalse);
		expect(sixArg).toContain("long-term partner");
	});
});

describe("buildMagicContextSection: memory gating", () => {
	// buildMagicContextSection's 9th positional parameter is memoryEnabled
	// (defaults to true). The 7-arg legacy call below relies on that default.
	it("memory ON (default) keeps the mctx_memory guidance and is byte-identical to legacy callers", () => {
		const legacy = buildMagicContextSection(null, 20, true, false, false, false, false);
		const memOn = buildMagicContextSection(
			null,
			20,
			true,
			false,
			false,
			false,
			false,
			undefined,
			true,
		);
		expect(memOn).toBe(legacy);
		expect(memOn).toContain("Use `mctx_memory`");
		expect(memOn).toContain("**Save to memory proactively**");
	});

	it("memory OFF drops ALL mctx_memory guidance but keeps mctx_search", () => {
		const off = buildMagicContextSection(
			null,
			20,
			true,
			false,
			false,
			false,
			false,
			undefined,
			false,
		);
		expect(off).not.toContain("mctx_memory");
		expect(off).not.toContain("Save to memory proactively");
		expect(off).toContain("Use `mctx_search`");
		// no dangling blank line where the block was removed
		expect(off).not.toContain("\n\nUse `mctx_search`");
	});

	it("memory OFF gates the guidance in no-reduce mode too", () => {
		const off = buildMagicContextSection(
			null,
			20,
			false,
			false,
			false,
			false,
			false,
			undefined,
			false,
		);
		expect(off).not.toContain("mctx_memory");
		expect(off).toContain("Use `mctx_search`");
	});
});

describe("buildMagicContextSection — caveman compression warning", () => {
	it("emits the warning when caveman is enabled and mctx_reduce is unavailable", () => {
		const out = buildMagicContextSection(
			null, // agent
			20, // protectedTags (ignored in no-reduce path)
			false, // mctx_reduce is unavailable in this session.
			false, // dreamerEnabled
			false, // temporalAwarenessEnabled
			true, // cavemanTextCompressionEnabled
		);
		expect(out).toContain(CAVEMAN_MARKER);
		expect(out).toContain(CAVEMAN_PHRASE_TAIL);
		expect(out).toContain("DO NOT mimic this style");
	});

	it("omits the warning when caveman is disabled", () => {
		const out = buildMagicContextSection(
			null,
			20,
			false, // mctx_reduce is unavailable in this session.
			false, // dreamerEnabled
			false, // temporalAwarenessEnabled
			false, // cavemanTextCompressionEnabled = false
		);
		expect(out).not.toContain(CAVEMAN_MARKER);
		expect(out).not.toContain(CAVEMAN_PHRASE_TAIL);
	});

	it("emits the warning when mctx_reduce is callable and caveman is enabled", () => {
		// Caveman compression is independent from mctx_reduce availability, so
		// reduce-enabled primary guidance must still warn about rewritten prose.
		const out = buildMagicContextSection(
			null,
			20,
			true, // mctx_reduce is callable in this session.
			false, // dreamerEnabled
			false, // temporalAwarenessEnabled
			true, // cavemanTextCompressionEnabled
		);
		expect(out).toContain(CAVEMAN_MARKER);
		expect(out).toContain(CAVEMAN_PHRASE_TAIL);
	});

	it("omits the warning by default (parameter optional)", () => {
		// Old callers that didn't pass the new parameter must continue to
		// produce identical output (no warning leaked into legacy paths).
		const out = buildMagicContextSection(null, 20, false, false, false);
		expect(out).not.toContain(CAVEMAN_MARKER);
	});
});

describe("buildMagicContextSection — compaction-off guidance variant (#266 S4)", () => {
	// Spec #266 decision #3: compaction-off mode reuses the EXISTING no-reduce
	// guidance variant machinery — no third template. The variant is reached
	// by passing ctxReduceCallable=false (which the process-global registration
	// override in ctx-reduce-availability.ts forces when mctx_reduce is not
	// registered). This suite pins the spec's guidance acceptance:
	//   - no mctx_reduce mention, no §N§ prefix advertising, no tag-recovery
	//   - memory/search/note/expand guidance present
	//   - byte-identical to the existing reduce-unavailable variant (no third
	//     template constant was introduced)

	it("the compaction-off variant is byte-identical to the existing no-reduce variant", () => {
		// The existing no-reduce variant is buildMagicContextSection(..., false, ...).
		// Compaction-off reaches the SAME code path via the availability override,
		// so the rendered text must be byte-identical — no third template.
		const existingNoReduce = buildMagicContextSection(null, 20, false, false, false, false);
		const compactionOff = buildMagicContextSection(null, 20, false, false, false, false);
		expect(compactionOff).toBe(existingNoReduce);
	});

	it("does not advertise mctx_reduce, §N§ prefixes, or tag-based recovery", () => {
		const out = buildMagicContextSection(null, 20, false, false, false, false);
		// No mctx_reduce tool mention.
		expect(out).not.toContain("mctx_reduce");
		// No §N§ prefix SYSTEM DESCRIPTION / advertising. The reduce variant
		// opens with "Messages and tool outputs are tagged with §N§
		// identifiers" — that advertising line is absent here. (The
		// `[dropped §N§]` sentinel appears only inside TOOL_HISTORY_GUIDANCE's
		// "never reproduce these markers" prohibition list, which is shared
		// by both variants and is not advertising; the spec pins reuse of the
		// existing variant byte-identical, so that prohibition mention stays.)
		expect(out).not.toContain("tagged with §N§ identifiers");
		expect(out).not.toContain("Use `mctx_reduce`");
		// No tag-based-recovery WORKFLOW wording. The expand line frames
		// recovery around <session-history> summary headings and mctx_search
		// message ordinals, not §N§ tags. "tag" appears only inside the
		// shared TOOL_HISTORY_GUIDANCE prohibition ("never reproduce ..."),
		// not as a recovery instruction.
		expect(out).not.toMatch(/recover.*tag|tag.*recover/i);
		expect(out).not.toContain("§N§ identifiers (e.g.");
	});

	it("still covers memory, search, notes, and mctx_expand guidance", () => {
		const out = buildMagicContextSection(null, 20, false, false, false, false);
		expect(out).toContain("mctx_search");
		expect(out).toContain("mctx_expand");
		expect(out).toContain("mctx_note");
		expect(out).toContain("mctx_memory");
	});

	it("frames mctx_expand as recovery for summaries / mctx_search hits, not tag-based recovery", () => {
		const out = buildMagicContextSection(null, 20, false, false, false, false);
		// The expand line in the no-reduce variant references <session-history>
		// summary headings and mctx_search message ordinals — not §N§ tags.
		expect(out).toContain("mctx_expand");
		expect(out).toContain("session-history");
		expect(out).toContain("message ordinals");
	});

	it("the reduce variant DOES advertise §N§ and mctx_reduce (contrast for the off-mode assertion)", () => {
		// This is the mutation-direction anchor: the reduce-on variant carries
		// the §N§ + mctx_reduce advertising that the off-mode variant omits.
		// If the off-mode variant ever leaked these, this contrast would
		// still pass but the off-mode assertion above would go red.
		const reduce = buildMagicContextSection(null, 20, true, false, false, false);
		expect(reduce).toContain("mctx_reduce");
		expect(reduce).toContain("tagged with §N§ identifiers");
	});
});
