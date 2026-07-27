export type HepiRegistrationKind = "module" | "settings" | "lifecycle";

export interface HepiIdentified {
	readonly id: string;
}

export interface HepiLifecycleRegistration {
	readonly id: string;
	readonly cleanup: () => void | Promise<void>;
}

export interface HepiCleanupFailure {
	readonly id: string;
	readonly error: unknown;
}

export class HepiRegistry {
	private readonly modules = new Map<string, HepiIdentified>();
	private readonly settings = new Map<string, HepiIdentified>();
	private readonly lifecycle = new Map<string, HepiLifecycleRegistration>();

	registerModule<T extends HepiIdentified>(module: T): () => void {
		return this.register(this.modules, "module", module);
	}

	registerSettings<T extends HepiIdentified>(provider: T): () => void {
		return this.register(this.settings, "settings", provider);
	}

	registerLifecycle(registration: HepiLifecycleRegistration): () => void {
		if (this.lifecycle.has(registration.id)) {
			throw new Error(`HePi ${registration.id} lifecycle registration already exists`);
		}
		this.lifecycle.set(registration.id, registration);
		return () => {
			if (this.lifecycle.get(registration.id) === registration)
				this.lifecycle.delete(registration.id);
		};
	}

	getModule(id: string): HepiIdentified | undefined {
		return this.modules.get(id);
	}

	getSettings(id: string): HepiIdentified | undefined {
		return this.settings.get(id);
	}

	listModules(): readonly HepiIdentified[] {
		return this.sorted(this.modules);
	}

	listSettings(): readonly HepiIdentified[] {
		return this.sorted(this.settings);
	}

	findModuleForCommand(
		command: string,
	): (HepiIdentified & { readonly commands: readonly string[] }) | undefined {
		return this.sorted(this.modules).find(
			(module): module is HepiIdentified & { readonly commands: readonly string[] } =>
				"commands" in module &&
				Array.isArray(module.commands) &&
				module.commands.every((value) => typeof value === "string") &&
				module.commands.includes(command),
		);
	}
	async cleanup(): Promise<readonly HepiCleanupFailure[]> {
		const failures: HepiCleanupFailure[] = [];
		const entries = [...this.lifecycle.values()].reverse();
		this.lifecycle.clear();
		for (const registration of entries) {
			try {
				await registration.cleanup();
			} catch (error) {
				failures.push({ id: registration.id, error });
			}
		}
		return failures;
	}

	private register<T extends HepiIdentified>(
		store: Map<string, T>,
		kind: HepiRegistrationKind,
		value: T,
	): () => void {
		if (!value.id.trim()) throw new Error(`HePi ${kind} id must not be empty`);
		if (store.has(value.id)) throw new Error(`HePi ${kind} id collision: ${value.id}`);
		store.set(value.id, value);
		return () => {
			if (store.get(value.id) === value) store.delete(value.id);
		};
	}

	private sorted<T extends HepiIdentified>(store: Map<string, T>): T[] {
		return [...store.values()].sort((left, right) => left.id.localeCompare(right.id));
	}
}
