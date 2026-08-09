export interface DreamTimerModuleClientTransport {
    call(args: { method: string; body: unknown }): Promise<unknown>;
    authorityStatus?(args: {
        context_store_uuid: string;
        project: string;
        projectRoot?: string;
        domain: "memories" | "notes";
    }): Promise<{ authority: { state?: string; generation?: number } | null }>;
}

export function createDreamTimerModuleClient(
    transport: DreamTimerModuleClientTransport,
): DreamTimerModuleClientTransport {
    return {
        call: transport.call.bind(transport),
        authorityStatus: transport.authorityStatus?.bind(transport),
    };
}
