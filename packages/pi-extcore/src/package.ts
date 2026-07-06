export function formatExtensionLabel(name: string): string {
	const trimmed = name.trim();
	if (trimmed.length === 0) {
		return "HEPI Extension";
	}

	return `HEPI ${trimmed}`;
}

export function normalizePackageSlug(input: string): string {
	const slug = input
		.trim()
		.toLowerCase()
		.replace(/^@[^/]+\//, "")
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-{2,}/g, "-");

	if (!slug || slug.startsWith("pi-")) {
		return slug;
	}

	return `pi-${slug}`;
}
