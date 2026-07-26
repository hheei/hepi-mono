export interface OutputMetricRecord {
	timestamp: string;
	tool: string;
	techniques: string;
	originalChars: number;
	filteredChars: number;
	savingsPercent: number;
}

export interface OutputMetrics {
	track(
		original: string,
		filtered: string,
		tool: string,
		techniques: readonly string[],
	): OutputMetricRecord;
	clear(): void;
	summary(): string;
}

export function createOutputMetrics(): OutputMetrics {
	const records: OutputMetricRecord[] = [];
	return {
		track(original, filtered, tool, techniques) {
			const originalChars = original.length;
			const filteredChars = filtered.length;
			const savingsPercent =
				originalChars > 0
					? Math.round(((originalChars - filteredChars) / originalChars) * 100 * 100) / 100
					: 0;
			const record: OutputMetricRecord = {
				timestamp: new Date().toISOString(),
				tool,
				techniques: techniques.join(",") || "none",
				originalChars,
				filteredChars,
				savingsPercent,
			};
			records.push(record);
			return record;
		},
		clear() {
			records.length = 0;
		},
		summary() {
			if (records.length === 0) return "RTK output compaction metrics: no data yet.";

			const totalOriginal = records.reduce((sum, metric) => sum + metric.originalChars, 0);
			const totalFiltered = records.reduce((sum, metric) => sum + metric.filteredChars, 0);
			const totalSaved = totalOriginal - totalFiltered;
			const savingsPercent = totalOriginal > 0 ? (totalSaved / totalOriginal) * 100 : 0;
			const byTool = new Map<
				string,
				{ count: number; originalChars: number; filteredChars: number }
			>();
			for (const metric of records) {
				const existing = byTool.get(metric.tool) ?? {
					count: 0,
					originalChars: 0,
					filteredChars: 0,
				};
				existing.count += 1;
				existing.originalChars += metric.originalChars;
				existing.filteredChars += metric.filteredChars;
				byTool.set(metric.tool, existing);
			}

			let result = "RTK output compaction metrics\n";
			result += `calls=${records.length}, saved=${totalSaved.toLocaleString()} chars (${savingsPercent.toFixed(1)}%)\n`;
			for (const [tool, stats] of byTool) {
				const toolSaved = stats.originalChars - stats.filteredChars;
				const toolSavingsPercent =
					stats.originalChars > 0 ? (toolSaved / stats.originalChars) * 100 : 0;
				result += `- ${tool}: ${stats.count} calls, saved ${toolSaved.toLocaleString()} chars (${toolSavingsPercent.toFixed(1)}%)\n`;
			}
			return result.trimEnd();
		},
	};
}

const defaultOutputMetrics = createOutputMetrics();

export function trackOutputSavings(
	original: string,
	filtered: string,
	tool: string,
	techniques: string[],
): OutputMetricRecord {
	return defaultOutputMetrics.track(original, filtered, tool, techniques);
}

export function clearOutputMetrics(): void {
	defaultOutputMetrics.clear();
}

export function getOutputMetricsSummary(): string {
	return defaultOutputMetrics.summary();
}
