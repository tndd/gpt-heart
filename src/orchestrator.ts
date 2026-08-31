import { createHash } from "node:crypto";
import type { BrowserContext, Page } from "playwright";
import { ChatGptPage } from "./chatgpt-page.js";
import type { Config } from "./config.js";
import { decideResponse } from "./control.js";
import { log } from "./log.js";
import { normalizeConversationUrl, StateStore } from "./state.js";
import type { CreateConversationJob } from "./types.js";

function jobId(parent: string, sourceHash: string, index: number): string {
  return createHash("sha256").update(`${parent}\n${sourceHash}\n${index}`).digest("hex");
}

export function roundRobinAfter(items: string[], previous: string | null): string[] {
  if (items.length < 2 || previous === null) return [...items];
  const index = items.indexOf(previous);
  if (index < 0) return [...items];
  return [...items.slice(index + 1), ...items.slice(0, index + 1)];
}

export class RoundRobinScheduler {
  #previous: string | null = null;

  pick(active: string[], running: ReadonlySet<string>, limit: number): string[] {
    if (limit <= 0) return [];
    const selected = roundRobinAfter(active, this.#previous)
      .filter((url) => !running.has(url))
      .slice(0, limit);
    for (const url of selected) this.#previous = url;
    return selected;
  }
}

export type ScheduledWork =
  | { kind: "job"; job: CreateConversationJob }
  | { kind: "conversation"; url: string };

export class FairWorkScheduler {
  #preferConversation = false;
  readonly #conversationScheduler = new RoundRobinScheduler();

  pick(
    active: string[],
    pendingJobs: readonly CreateConversationJob[],
    running: ReadonlySet<string>,
    limit: number,
  ): ScheduledWork[] {
    const selected: ScheduledWork[] = [];
    const reserved = new Set(running);
    let jobIndex = 0;

    const takeJob = (): ScheduledWork | null => {
      while (jobIndex < pendingJobs.length) {
        const job = pendingJobs[jobIndex++];
        if (!job || reserved.has(`job:${job.id}`)) continue;
        reserved.add(`job:${job.id}`);
        return { kind: "job", job };
      }
      return null;
    };

    const takeConversation = (): ScheduledWork | null => {
      const [url] = this.#conversationScheduler.pick(active, reserved, 1);
      if (!url) return null;
      reserved.add(url);
      return { kind: "conversation", url };
    };

    while (selected.length < limit) {
      const work = this.#preferConversation
        ? takeConversation() ?? takeJob()
        : takeJob() ?? takeConversation();
      if (!work) break;
      selected.push(work);
      this.#preferConversation = work.kind === "job";
    }
    return selected;
  }
}

export class BrowserContextUnavailableError extends Error {
  constructor(message = "Browser context is unavailable") {
    super(message);
    this.name = "BrowserContextUnavailableError";
  }
}

export class Orchestrator {
  readonly #running = new Set<string>();
  #bootstrapRunning = false;
  #stopping = false;
  readonly #workScheduler = new FairWorkScheduler();
  #fatalError: BrowserContextUnavailableError | null = null;

  constructor(
    private readonly context: BrowserContext,
    private readonly store: StateStore,
    private readonly config: Config,
  ) {
    this.context.once("close", () => {
      if (!this.#stopping) {
        this.#fatalError = new BrowserContextUnavailableError("Browser context closed unexpectedly");
      }
    });
  }

  stop(): void {
    this.#stopping = true;
  }

  async run(): Promise<void> {
    await this.store.load();
    if (this.store.uncertainJobs().length > 0) {
      log.error("conversation creation jobs require manual review", {
        count: this.store.uncertainJobs().length,
      });
    }
    while (!this.#stopping) {
      if (this.#fatalError) throw this.#fatalError;
      const slots = this.config.maxConcurrency - this.#running.size;
      if (slots > 0) {
        const work = this.#workScheduler.pick(
          this.store.activeUrls(),
          this.store.pendingJobs(),
          this.#running,
          slots,
        );
        for (const item of work) {
          if (item.kind === "job") this.#startJob(item.job);
          else this.#startConversation(item.url);
        }
      }

      if (
        this.#running.size === 0 &&
        this.store.jobs().length === 0 &&
        this.store.activeUrls().length === 0 &&
        !this.#bootstrapRunning
      ) {
        this.#startBootstrap();
      }
      await new Promise((resolve) => setTimeout(resolve, this.config.pollIntervalMs));
    }
  }

  #startConversation(url: string): void {
    this.#running.add(url);
    void this.#runConversation(url)
      .catch(async (error: unknown) => {
        if (this.#recordFatalContextError(error)) return;
        log.error("conversation worker failed; it will retry", { url, error: String(error) });
        await this.#retryBackoff();
      })
      .finally(() => this.#running.delete(url));
  }

  #startJob(job: CreateConversationJob): void {
    const key = `job:${job.id}`;
    if (this.#running.has(key)) return;
    this.#running.add(key);
    void this.#createConversation(job)
      .catch(async (error: unknown) => {
        if (this.#recordFatalContextError(error)) return;
        const current = this.store.getJob(job.id);
        if (current?.status === "send-uncertain") {
          log.error("conversation creation outcome is uncertain; automatic retry is disabled", {
            jobId: job.id,
            error: String(error),
          });
          return;
        }
        log.error("conversation creation failed before send; it will retry", {
          jobId: job.id,
          error: String(error),
        });
        await this.#retryBackoff();
      })
      .finally(() => this.#running.delete(key));
  }

  #startBootstrap(): void {
    this.#bootstrapRunning = true;
    void this.#bootstrap()
      .catch(async (error: unknown) => {
        if (this.#recordFatalContextError(error)) return;
        log.error("bootstrap failed; it will retry", { error: String(error) });
        await this.#retryBackoff();
      })
      .finally(() => {
        this.#bootstrapRunning = false;
      });
  }

  async #retryBackoff(): Promise<void> {
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(this.config.pollIntervalMs * 5, 5_000)),
    );
  }

  #recordFatalContextError(error: unknown): boolean {
    const message = String(error);
    if (
      error instanceof BrowserContextUnavailableError ||
      /target page, context or browser has been closed|browser context closed/i.test(message)
    ) {
      this.#fatalError =
        error instanceof BrowserContextUnavailableError
          ? error
          : new BrowserContextUnavailableError(message);
      return true;
    }
    return false;
  }

  async #newDriver(): Promise<{ page: Page; driver: ChatGptPage }> {
    if (this.#fatalError) throw this.#fatalError;
    let page: Page;
    try {
      page = await this.context.newPage();
    } catch (error) {
      if (this.#recordFatalContextError(error)) throw this.#fatalError;
      throw error;
    }
    return {
      page,
      driver: new ChatGptPage(page, this.config.pollIntervalMs, this.config.completionTimeoutMs),
    };
  }

  async #bootstrap(): Promise<void> {
    const { page, driver } = await this.#newDriver();
    try {
      await driver.goto(this.config.projectUrl);
      await driver.waitForComposer(() =>
        log.warn("ChatGPT login or verification is required; open the noVNC screen"),
      );
      if (this.config.initialBody) {
        await driver.send(this.config.initialBody);
      } else {
        log.info("waiting for the first message to be sent manually in noVNC");
      }
      const url = normalizeConversationUrl(await driver.waitForConversationUrl(this.config.projectUrl));
      await this.store.setConversation(url, { status: "active", parent: null });
      log.info("initial conversation registered", { url });
    } finally {
      await page.close();
    }
  }

  async #createConversation(job: CreateConversationJob): Promise<void> {
    const { page, driver } = await this.#newDriver();
    try {
      await driver.goto(this.config.projectUrl);
      await driver.send(job.body, () =>
        log.warn("ChatGPT login or verification is required; open the noVNC screen"),
        async () => this.store.markJobSendUncertain(job.id),
      );
      const url = normalizeConversationUrl(await driver.waitForConversationUrl(this.config.projectUrl));
      await this.store.setConversation(url, { status: "active", parent: job.parent });
      await this.store.removeJob(job.id);
      log.info("child conversation created", { url, parent: job.parent });
    } finally {
      await page.close();
    }
  }

  async #runConversation(url: string): Promise<void> {
    const initialProgress = this.store.getProgress(url);
    if (initialProgress.terminalDecision) {
      await this.store.finalizeTerminalDecision(url);
      return;
    }

    const { page, driver } = await this.#newDriver();
    try {
      await driver.goto(url);
      await driver.waitForComposer(() =>
        log.warn("ChatGPT login or verification is required; open the noVNC screen", { url }),
      );

      if (!this.#stopping && this.store.getState(url)?.status === "active") {
        const role = await driver.lastMessageRole();
        const assistantCount = await driver.assistantCount();
        if (role === "user") {
          await driver.waitForGenerationComplete(assistantCount + 1);
        } else if (role === "assistant") {
          await driver.waitForGenerationComplete(Math.max(assistantCount, 1));
        } else {
          throw new Error("Conversation has no recognizable messages");
        }

        const progress = this.store.getProgress(url);
        const latest = await driver.latestAssistant();
        if (progress.pendingSend) {
          if (role === "assistant" && latest?.hash === progress.pendingSend.sourceHash) {
            await driver.send(progress.pendingSend.text);
            await this.store.setProgress(url, {
              ...progress,
              pendingSend: null,
              terminalDecision: null,
            });
            log.info("recovered pending send", { url });
            return;
          } else {
            await this.store.setProgress(url, { ...progress, pendingSend: null });
          }
        }

        const assistant = await driver.latestAssistant();
        if (!assistant) throw new Error("No assistant response found after generation completed");
        const currentProgress = this.store.getProgress(url);
        if (assistant.hash === currentProgress.lastProcessedAssistantHash) {
          const recovered = {
            lastProcessedAssistantHash: assistant.hash,
            pendingSend: { text: ".", sourceHash: assistant.hash },
            terminalDecision: null,
          };
          await this.store.setProgress(url, recovered);
          await page.waitForTimeout(this.config.actionDelayMs);
          await driver.send(".");
          await this.store.setProgress(url, { ...recovered, pendingSend: null });
          log.info("recovered missing dot", { url });
          return;
        }

        const decision = decideResponse(assistant.text);
        if (decision.invalidLines.length > 0) {
          log.warn("ignored malformed trailing control lines", {
            url,
            count: decision.invalidLines.length,
          });
        }

        if (decision.endCurrent) {
          const jobs = decision.nextBodies.map((body, index) => ({
            id: jobId(url, assistant.hash, index),
            kind: "create-conversation" as const,
            parent: url,
            body,
            sourceHash: assistant.hash,
            status: "pending" as const,
          }));
          const terminalProgress = {
            lastProcessedAssistantHash: assistant.hash,
            pendingSend: null,
            terminalDecision: { sourceHash: assistant.hash, jobs },
          };
          await this.store.setProgress(url, terminalProgress);
          await this.store.finalizeTerminalDecision(url);
          log.info("conversation ended by control signal", { url, children: jobs.length });
          return;
        }

        const staged = {
          lastProcessedAssistantHash: assistant.hash,
          pendingSend: { text: ".", sourceHash: assistant.hash },
          terminalDecision: null,
        };
        await this.store.setProgress(url, staged);
        await page.waitForTimeout(this.config.actionDelayMs);
        await driver.send(".");
        await this.store.setProgress(url, { ...staged, pendingSend: null });
        log.info("dot sent", { url });
      }
    } finally {
      await page.close();
    }
  }
}
