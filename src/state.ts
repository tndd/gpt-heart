import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ConversationProgress,
  ConversationState,
  CreateConversationJob,
} from "./types.js";

type StateFile = Record<string, ConversationState>;
type ProgressFile = Record<string, ConversationProgress>;

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

export function normalizeConversationUrl(raw: string): string {
  const url = new URL(raw);
  url.hash = "";
  url.search = "";
  return url.toString();
}

export class StateStore {
  readonly #stateFile: string;
  readonly #progressFile: string;
  readonly #queueFile: string;
  #state: StateFile = {};
  #progress: ProgressFile = {};
  #queue: CreateConversationJob[] = [];
  #writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly directory: string) {
    this.#stateFile = path.join(directory, "state.json");
    this.#progressFile = path.join(directory, "progress.json");
    this.#queueFile = path.join(directory, "queue.json");
  }

  async load(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    this.#state = await readJson<StateFile>(this.#stateFile, {});
    this.#progress = await readJson<ProgressFile>(this.#progressFile, {});
    this.#queue = await readJson<CreateConversationJob[]>(this.#queueFile, []);
  }

  activeUrls(): string[] {
    return Object.entries(this.#state)
      .filter(([, value]) => value.status === "active")
      .map(([url]) => url);
  }

  getState(url: string): ConversationState | undefined {
    return this.#state[normalizeConversationUrl(url)];
  }

  getProgress(url: string): ConversationProgress {
    return (
      this.#progress[normalizeConversationUrl(url)] ?? {
        lastProcessedAssistantHash: null,
        pendingSend: null,
      }
    );
  }

  async setConversation(url: string, value: ConversationState): Promise<string> {
    const key = normalizeConversationUrl(url);
    this.#state[key] = value;
    await this.#persist(this.#stateFile, this.#state);
    return key;
  }

  async endConversation(url: string): Promise<void> {
    const key = normalizeConversationUrl(url);
    const current = this.#state[key];
    if (!current) throw new Error(`Unknown conversation: ${key}`);
    this.#state[key] = { ...current, status: "ended" };
    await this.#persist(this.#stateFile, this.#state);
  }

  async setProgress(url: string, value: ConversationProgress): Promise<void> {
    this.#progress[normalizeConversationUrl(url)] = value;
    await this.#persist(this.#progressFile, this.#progress);
  }

  jobs(): readonly CreateConversationJob[] {
    return this.#queue;
  }

  async enqueue(jobs: CreateConversationJob[]): Promise<void> {
    const existing = new Set(this.#queue.map((job) => job.id));
    this.#queue.push(...jobs.filter((job) => !existing.has(job.id)));
    await this.#persist(this.#queueFile, this.#queue);
  }

  async removeJob(id: string): Promise<void> {
    this.#queue = this.#queue.filter((job) => job.id !== id);
    await this.#persist(this.#queueFile, this.#queue);
  }

  async #persist(file: string, value: unknown): Promise<void> {
    const snapshot = structuredClone(value);
    const operation = this.#writeChain.then(() => writeJsonAtomic(file, snapshot));
    this.#writeChain = operation.catch(() => undefined);
    await operation;
  }
}
