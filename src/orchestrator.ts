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

export class Orchestrator {
  readonly #running = new Set<string>();
  #bootstrapRunning = false;
  #stopping = false;

  constructor(
    private readonly context: BrowserContext,
    private readonly store: StateStore,
    private readonly config: Config,
  ) {}

  stop(): void {
    this.#stopping = true;
  }

  async run(): Promise<void> {
    await this.store.load();
    while (!this.#stopping) {
      const slots = this.config.maxConcurrency - this.#running.size;
      if (slots > 0) {
        const jobs = this.store.jobs().slice(0, slots);
        for (const job of jobs) this.#startJob(job);
      }

      const remainingSlots = this.config.maxConcurrency - this.#running.size;
      if (remainingSlots > 0) {
        const candidates = this.store
          .activeUrls()
          .filter((url) => !this.#running.has(url))
          .slice(0, remainingSlots);
        for (const url of candidates) this.#startConversation(url);
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
        log.error("conversation creation failed; it will retry", { jobId: job.id, error: String(error) });
        await this.#retryBackoff();
      })
      .finally(() => this.#running.delete(key));
  }

  #startBootstrap(): void {
    this.#bootstrapRunning = true;
    void this.#bootstrap()
      .catch(async (error: unknown) => {
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

  async #newDriver(): Promise<{ page: Page; driver: ChatGptPage }> {
    const page = await this.context.newPage();
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
    const { page, driver } = await this.#newDriver();
    try {
      await driver.goto(url);
      await driver.waitForComposer(() =>
        log.warn("ChatGPT login or verification is required; open the noVNC screen", { url }),
      );

      while (!this.#stopping && this.store.getState(url)?.status === "active") {
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
            await this.store.setProgress(url, { ...progress, pendingSend: null });
            log.info("recovered pending send", { url });
            continue;
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
          };
          await this.store.setProgress(url, recovered);
          await page.waitForTimeout(this.config.actionDelayMs);
          await driver.send(".");
          await this.store.setProgress(url, { ...recovered, pendingSend: null });
          log.info("recovered missing dot", { url });
          continue;
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
          }));
          await this.store.enqueue(jobs);
          await this.store.setProgress(url, {
            lastProcessedAssistantHash: assistant.hash,
            pendingSend: null,
          });
          await this.store.endConversation(url);
          log.info("conversation ended by control signal", { url, children: jobs.length });
          return;
        }

        const staged = {
          lastProcessedAssistantHash: assistant.hash,
          pendingSend: { text: ".", sourceHash: assistant.hash },
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
