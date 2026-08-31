import path from "node:path";

export interface Config {
  projectUrl: string;
  initialBody: string;
  maxConcurrency: number;
  actionDelayMs: number;
  completionTimeoutMs: number;
  pollIntervalMs: number;
  browserProfileDir: string;
  stateDir: string;
}

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export function loadConfig(): Config {
  const projectUrl =
    process.env.PROJECT_URL ??
    "https://chatgpt.com/g/g-p-6a94c14fffb48191a369bb25418da7f7/project";
  const url = new URL(projectUrl);
  if (url.origin !== "https://chatgpt.com" || !url.pathname.endsWith("/project")) {
    throw new Error("PROJECT_URL must be a https://chatgpt.com project URL");
  }

  return {
    projectUrl: url.toString(),
    initialBody: process.env.INITIAL_BODY ?? "",
    maxConcurrency: positiveInteger("MAX_CONCURRENCY", 1),
    actionDelayMs: positiveInteger("ACTION_DELAY_MS", 1_500),
    completionTimeoutMs: positiveInteger("COMPLETION_TIMEOUT_MS", 30 * 60_000),
    pollIntervalMs: positiveInteger("POLL_INTERVAL_MS", 1_000),
    browserProfileDir: path.resolve(process.env.BROWSER_PROFILE_DIR ?? "data/browser"),
    stateDir: path.resolve(process.env.STATE_DIR ?? "data/state"),
  };
}
