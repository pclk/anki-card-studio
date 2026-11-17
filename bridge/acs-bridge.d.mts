// Types for acs-bridge.mjs (a plain Node script with no build step), so the TypeScript tests can import it.
export const VERSION: string;
export const INSTRUCTION: string;
export type BridgeConfig = { server?: string; token?: string; agents: string[]; claudeTools: string[]; maxMinutes: number; keepJobs: boolean };
export type BridgeEvent = { type: string; text: string; final?: boolean };
export type RunResult = { ok: boolean; cancelled?: boolean; status?: string; error?: string; dir?: string };
export function loadConfig(): BridgeConfig;
export function checkServer(s: string): string;
export function client(server: string, token: string): unknown;
export function agentCommand(agent: string): string;
export function installedAgents(cfg: BridgeConfig): string[];
export function agentArgs(agent: string, cfg: BridgeConfig, dir: string): string[];
export function toEvents(agent: string, line: string): BridgeEvent[];
export function runJob(api: unknown, job: unknown, cfg: BridgeConfig, log?: (s: string) => void): Promise<RunResult>;
export function serve(cfg: BridgeConfig, opts?: { once?: boolean; log?: (s: string) => void }): Promise<RunResult | null>;
