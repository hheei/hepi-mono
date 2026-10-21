import { describe, expect, it } from "vitest";

import { foldLedger } from "../src/session-ledger/index.js";
import {
	branchSummary,
	observation,
	observationsDroppedEntry,
	observationsRecordedEntry,
	oldV2ObservationEntry,
	reflection,
	reflectionsDroppedEntry,
	reflectionsRecordedEntry,
	textCustomMessage,
} from "./fixtures/session.js";

describe("session-ledger V3 folding", () => {
	it("folds observations and reflections from branch root through the target entry", () => {
		const obs1 = observation("aaaaaaaaaaaa", { sourceEntryIds: ["raw-1"] });
		const obs2 = observation("bbbbbbbbbbbb", { sourceEntryIds: ["raw-2"] });
		const ref1 = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]);
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-aaaaaaaaaaaa", { observations: [obs1], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbb"),
			reflectionsRecordedEntry("om-eeeeeeeeeeee", { reflections: [ref1], coversUpToId: "raw-2" }),
			observationsRecordedEntry("om-bbbbbbbbbbbb", { observations: [obs2], coversUpToId: "raw-2" }),
		];

		const folded = foldLedger(entries, { upToEntryId: "om-eeeeeeeeeeee" });

		expect(folded.observations.map((obs) => obs.id)).toEqual(["aaaaaaaaaaaa"]);
		expect(folded.activeObservations.map((obs) => obs.id)).toEqual(["aaaaaaaaaaaa"]);
		expect(folded.reflections.map((ref) => ref.id)).toEqual(["eeeeeeeeeeee"]);
		expect(folded.observationsById.get("bbbbbbbbbbbb")).toBeUndefined();
	});

	it("applies drops as tombstones while preserving observation history", () => {
		const obs1 = observation("aaaaaaaaaaaa");
		const obs2 = observation("bbbbbbbbbbbb");
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-aaaaaaaaaaaa", {
				observations: [obs1, obs2],
				coversUpToId: "raw-1",
			}),
			observationsDroppedEntry("om-drop-1", {
				observationIds: ["aaaaaaaaaaaa"],
				coversUpToId: "raw-1",
			}),
		];

		const folded = foldLedger(entries);

		expect(folded.observations.map((obs) => obs.id)).toEqual(["aaaaaaaaaaaa", "bbbbbbbbbbbb"]);
		expect(folded.activeObservations.map((obs) => obs.id)).toEqual(["bbbbbbbbbbbb"]);
		expect(folded.droppedObservationIds.has("aaaaaaaaaaaa")).toBe(true);
		expect(folded.observationsById.get("aaaaaaaaaaaa")).toEqual(obs1);
	});

	it("keeps first valid observation and reflection when duplicate ids appear", () => {
		const firstObs = observation("aaaaaaaaaaaa", { content: "first observation" });
		const duplicateObs = observation("aaaaaaaaaaaa", { content: "duplicate observation" });
		const firstRef = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"], { content: "first reflection" });
		const duplicateRef = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"], {
			content: "duplicate reflection",
		});
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-aaaaaaaaaaaa", {
				observations: [firstObs],
				coversUpToId: "raw-1",
			}),
			observationsRecordedEntry("om-bbbbbbbbbbbb", {
				observations: [duplicateObs],
				coversUpToId: "raw-1",
			}),
			reflectionsRecordedEntry("om-eeeeeeeeeeee", {
				reflections: [firstRef],
				coversUpToId: "raw-1",
			}),
			reflectionsRecordedEntry("om-ffffffffffff", {
				reflections: [duplicateRef],
				coversUpToId: "raw-1",
			}),
		];

		const folded = foldLedger(entries);

		expect(folded.observationsById.get("aaaaaaaaaaaa")?.content).toBe("first observation");
		expect(folded.reflectionsById.get("eeeeeeeeeeee")?.content).toBe("first reflection");
		expect(folded.observations).toHaveLength(1);
		expect(folded.reflections).toHaveLength(1);
	});

	it("retains tombstones for unknown drop ids without throwing", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsDroppedEntry("om-drop-1", {
				observationIds: ["deadbeef0000"],
				coversUpToId: "raw-1",
			}),
		];

		const folded = foldLedger(entries);

		expect(folded.droppedObservationIds.has("deadbeef0000")).toBe(true);
		expect(folded.activeObservations).toEqual([]);
	});

	it("retires superseded reflections while keeping their records", () => {
		const refA = reflection("aaaaaaaaaaaa", ["dddddddddddd"]);
		const refB = reflection("bbbbbbbbbbbb", ["dddddddddddd"]);
		const merged = reflection("cccccccccccc", ["dddddddddddd"]);
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			reflectionsRecordedEntry("om-ref-1", { reflections: [refA, refB], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-ref-2", { reflections: [merged], coversUpToId: "raw-1" }),
			reflectionsDroppedEntry("om-ref-drop", {
				reflectionIds: ["aaaaaaaaaaaa", "bbbbbbbbbbbb"],
				coversUpToId: "raw-1",
			}),
		];

		const folded = foldLedger(entries);

		expect(folded.reflections.map((ref) => ref.id)).toEqual([
			"aaaaaaaaaaaa",
			"bbbbbbbbbbbb",
			"cccccccccccc",
		]);
		expect(folded.activeReflections.map((ref) => ref.id)).toEqual(["cccccccccccc"]);
		expect(folded.droppedReflectionIds.size).toBe(2);
		expect(folded.reflectionsById.get("aaaaaaaaaaaa")?.id).toBe("aaaaaaaaaaaa");
	});

	it("retains reflection tombstones for unknown ids without throwing", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			reflectionsDroppedEntry("om-ref-drop", {
				reflectionIds: ["deadbeef0000"],
				coversUpToId: "raw-1",
			}),
		];

		const folded = foldLedger(entries);

		expect(folded.droppedReflectionIds.has("deadbeef0000")).toBe(true);
		expect(folded.activeReflections).toEqual([]);
	});

	it("ignores old V2 entries and unknown custom entries", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			oldV2ObservationEntry("v2-obs"),
			{
				type: "custom",
				id: "unknown",
				parentId: null,
				timestamp: "2026-05-02T10:00:00.000Z",
				customType: "other.memory",
				data: { any: true },
			},
		];

		const folded = foldLedger(entries);

		expect(folded.observations).toEqual([]);
		expect(folded.reflections).toEqual([]);
		expect(folded.activeObservations).toEqual([]);
	});

	it("folds only the branch path supplied by the caller", () => {
		const mainObs = observation("aaaa00000000", { sourceEntryIds: ["raw-main"] });
		const forkObs = observation("bbbb00000000", { sourceEntryIds: ["raw-fork"] });
		const mainBranch = [
			branchSummary("root", "root summary"),
			textCustomMessage("raw-main", "main"),
			observationsRecordedEntry("main-ledger", {
				observations: [mainObs],
				coversUpToId: "raw-main",
			}),
		];
		const forkBranch = [
			branchSummary("root", "root summary"),
			textCustomMessage("raw-fork", "fork"),
			observationsRecordedEntry("fork-ledger", {
				observations: [forkObs],
				coversUpToId: "raw-fork",
			}),
		];

		expect(foldLedger(mainBranch).observations.map((obs) => obs.id)).toEqual(["aaaa00000000"]);
		expect(foldLedger(forkBranch).observations.map((obs) => obs.id)).toEqual(["bbbb00000000"]);
	});

	it("folds incrementally from a base snapshot", () => {
		const obs1 = observation("aaaaaaaaaaaa", { sourceEntryIds: ["raw-1"] });
		const obs2 = observation("bbbbbbbbbbbb", { sourceEntryIds: ["raw-2"] });
		const ref1 = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]);
		const entriesPart1 = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-aaaaaaaaaaaa", { observations: [obs1], coversUpToId: "raw-1" }),
		];
		const baseSnapshot = foldLedger(entriesPart1);

		const allEntries = [
			...entriesPart1,
			textCustomMessage("raw-2", "bbbb"),
			reflectionsRecordedEntry("om-eeeeeeeeeeee", { reflections: [ref1], coversUpToId: "raw-2" }),
			observationsRecordedEntry("om-bbbbbbbbbbbb", { observations: [obs2], coversUpToId: "raw-2" }),
		];

		const incrementalFold = foldLedger(allEntries, {
			base: { snapshot: baseSnapshot, fromEntryId: "om-aaaaaaaaaaaa" },
		});
		const fullFold = foldLedger(allEntries);

		expect(incrementalFold.observations.map((o) => o.id)).toEqual(
			fullFold.observations.map((o) => o.id),
		);
		expect(incrementalFold.reflections.map((r) => r.id)).toEqual(
			fullFold.reflections.map((r) => r.id),
		);
		expect(incrementalFold.activeObservations.map((o) => o.id)).toEqual(
			fullFold.activeObservations.map((o) => o.id),
		);
		expect(incrementalFold.activeReflections.map((r) => r.id)).toEqual(
			fullFold.activeReflections.map((r) => r.id),
		);
	});

	it("discards snapshot and folds from scratch when base entry is from a sibling branch", () => {
		const siblingObs = observation("ssssssssssss", { sourceEntryIds: ["raw-sibling"] });
		const branchObs = observation("bbbbbbbbbbbb", { sourceEntryIds: ["raw-branch"] });

		const siblingEntries = [
			textCustomMessage("raw-sibling", "sibling"),
			observationsRecordedEntry("sibling-ledger", {
				observations: [siblingObs],
				coversUpToId: "raw-sibling",
			}),
		];
		const siblingSnapshot = foldLedger(siblingEntries);

		const currentBranch = [
			textCustomMessage("raw-branch", "branch"),
			observationsRecordedEntry("branch-ledger", {
				observations: [branchObs],
				coversUpToId: "raw-branch",
			}),
		];

		// Provide sibling snapshot whose fromEntryId ("sibling-ledger") is NOT in currentBranch
		const folded = foldLedger(currentBranch, {
			base: { snapshot: siblingSnapshot, fromEntryId: "sibling-ledger" },
		});

		// Must NOT contain sibling observations!
		expect(folded.observations.map((o) => o.id)).toEqual(["bbbbbbbbbbbb"]);
		expect(folded.observationsById.get("ssssssssssss")).toBeUndefined();
	});

	it("discards snapshot and folds from scratch when requested upToEntryId is before base entry", () => {
		const obs1 = observation("aaaaaaaaaaaa", { sourceEntryIds: ["raw-1"] });
		const obs2 = observation("bbbbbbbbbbbb", { sourceEntryIds: ["raw-2"] });

		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-1", { observations: [obs1], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbb"),
			observationsRecordedEntry("om-2", { observations: [obs2], coversUpToId: "raw-2" }),
		];
		const snapshotAtOm2 = foldLedger(entries);

		// Asking to fold only up to "om-1", which is BEFORE snapshotAtOm2 ("om-2")
		const folded = foldLedger(entries, {
			upToEntryId: "om-1",
			base: { snapshot: snapshotAtOm2, fromEntryId: "om-2" },
		});

		// Must only contain obs1, not obs2!
		expect(folded.observations.map((o) => o.id)).toEqual(["aaaaaaaaaaaa"]);
		expect(folded.observationsById.get("bbbbbbbbbbbb")).toBeUndefined();
	});
});
