export interface HumanBackend {
	ask(question: string, context?: string): Promise<string>
}

export interface HumanBackendConfig {
	mode: 'stub'
}

export function createHumanBackend(_config: HumanBackendConfig): HumanBackend {
	return {
		ask: async () => 'use your best judgement',
	}
}