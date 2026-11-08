export function productEnv(name: string, env?: Record<string, string | undefined>): string | undefined;
export function productHome(kind?: 'workspace' | 'control' | 'releases', env?: Record<string, string | undefined>, root?: string): string;
