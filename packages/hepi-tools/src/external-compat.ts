export function hasConfiguredPackage(settings: unknown, candidates: readonly string[]): boolean {
	if (typeof settings !== "object" || settings === null || Array.isArray(settings)) return false;
	if (!("packages" in settings) || !Array.isArray(settings.packages)) return false;

	return settings.packages.some(
		(packageName): boolean =>
			typeof packageName === "string" &&
			candidates.some((candidate) => {
				const normalized = packageName.startsWith("npm:")
					? packageName.slice("npm:".length)
					: packageName;
				return normalized === candidate || normalized.startsWith(`${candidate}@`);
			}),
	);
}
