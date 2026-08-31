import { createHash } from "node:crypto";
import type { Locator, Page } from "playwright";

const COMPOSER_SELECTORS = [
  "#prompt-textarea",
  '[data-testid="composer-text-input"]',
  '[contenteditable="true"][data-lexical-editor="true"]',
  'textarea[placeholder*="Message"]',
  'textarea[placeholder*="メッセージ"]',
];
const SEND_SELECTORS = [
  '[data-testid="send-button"]',
  'button[aria-label*="Send"]',
  'button[aria-label*="送信"]',
];
const STOP_SELECTORS = [
  '[data-testid="stop-button"]',
];
const MESSAGE_SELECTOR = '[data-message-author-role="user"], [data-message-author-role="assistant"]';
const ASSISTANT_SELECTOR = '[data-message-author-role="assistant"]';

export function fingerprint(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function firstVisible(page: Page, selectors: string[]): Promise<Locator | null> {
  for (const selector of selectors) {
    const locator = page.locator(selector).last();
    if ((await locator.count()) > 0 && (await locator.isVisible().catch(() => false))) return locator;
  }
  return null;
}

export class ChatGptPage {
  constructor(
    private readonly page: Page,
    private readonly pollIntervalMs: number,
    private readonly completionTimeoutMs: number,
  ) {}

  url(): string {
    return this.page.url();
  }

  async goto(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  }

  async waitForComposer(onWaiting?: () => void): Promise<Locator> {
    let announced = false;
    for (;;) {
      const composer = await firstVisible(this.page, COMPOSER_SELECTORS);
      if (composer) return composer;
      if (!announced) {
        onWaiting?.();
        announced = true;
      }
      await this.page.waitForTimeout(this.pollIntervalMs);
    }
  }

  async send(
    text: string,
    onWaiting?: () => void,
    onBeforeClick?: () => Promise<void>,
  ): Promise<void> {
    const composer = await this.waitForComposer(onWaiting);
    await composer.fill(text);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const button = await firstVisible(this.page, SEND_SELECTORS);
      if (button && (await button.isEnabled().catch(() => false))) {
        await onBeforeClick?.();
        await button.click();
        return;
      }
      await this.page.waitForTimeout(200);
    }
    throw new Error("ChatGPT send button was not available");
  }

  async lastMessageRole(): Promise<"user" | "assistant" | null> {
    const messages = this.page.locator(MESSAGE_SELECTOR);
    if ((await messages.count()) === 0) return null;
    const role = await messages.last().getAttribute("data-message-author-role");
    return role === "user" || role === "assistant" ? role : null;
  }

  async assistantCount(): Promise<number> {
    return this.page.locator(ASSISTANT_SELECTOR).count();
  }

  async latestAssistant(): Promise<{ text: string; hash: string } | null> {
    const assistants = this.page.locator(ASSISTANT_SELECTOR);
    if ((await assistants.count()) === 0) return null;
    const text = (await assistants.last().innerText()).trim();
    return { text, hash: fingerprint(text) };
  }

  async waitForGenerationComplete(minimumAssistantCount: number): Promise<void> {
    const deadline = Date.now() + this.completionTimeoutMs;
    let stableText = "";
    let stablePolls = 0;
    let sawGenerationUi = false;

    while (Date.now() < deadline) {
      const stop = await firstVisible(this.page, STOP_SELECTORS);
      if (stop) sawGenerationUi = true;

      const count = await this.assistantCount();
      const latest = count >= minimumAssistantCount ? await this.latestAssistant() : null;
      const composer = await firstVisible(this.page, COMPOSER_SELECTORS);
      const uiComplete = !stop && latest !== null && composer !== null;

      if (uiComplete) {
        if (latest.text === stableText) stablePolls += 1;
        else {
          stableText = latest.text;
          stablePolls = 1;
        }
        if (stablePolls >= 2 && (sawGenerationUi || count >= minimumAssistantCount)) return;
      } else {
        stablePolls = 0;
      }
      await this.page.waitForTimeout(this.pollIntervalMs);
    }
    throw new Error("Timed out waiting for ChatGPT generation to complete");
  }

  async waitForConversationUrl(projectUrl: string): Promise<string> {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const current = this.page.url();
      if (isProjectConversationUrl(projectUrl, current)) {
        return current;
      }
      await this.page.waitForTimeout(250);
    }
    throw new Error("ChatGPT did not navigate to a conversation URL after sending");
  }
}

export function isProjectConversationUrl(projectUrl: string, candidateUrl: string): boolean {
  const project = new URL(projectUrl);
  const candidate = new URL(candidateUrl);
  if (candidate.origin !== project.origin) return false;

  const projectParts = project.pathname.split("/").filter(Boolean);
  const candidateParts = candidate.pathname.split("/").filter(Boolean);
  if (projectParts.at(-1) !== "project") return false;

  const expectedPrefix = [...projectParts.slice(0, -1), "c"];
  return (
    candidateParts.length === expectedPrefix.length + 1 &&
    expectedPrefix.every((part, index) => candidateParts[index] === part) &&
    (candidateParts.at(-1)?.length ?? 0) > 0
  );
}
