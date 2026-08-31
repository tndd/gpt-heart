import { chromium } from "playwright";
import { loadConfig } from "./config.js";
import { log } from "./log.js";
import { Orchestrator } from "./orchestrator.js";
import { StateStore } from "./state.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const context = await chromium.launchPersistentContext(config.browserProfileDir, {
    headless: false,
    args: ["--password-store=basic"],
    viewport: { width: 1440, height: 900 },
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
  });
  const store = new StateStore(config.stateDir);
  const orchestrator = new Orchestrator(context, store, config);

  const shutdown = (signal: string): void => {
    log.info("shutdown requested", { signal });
    orchestrator.stop();
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  log.info("raspi ChatGPT loop started", {
    projectUrl: config.projectUrl,
    maxConcurrency: config.maxConcurrency,
  });
  try {
    await orchestrator.run();
  } finally {
    await context.close();
  }
}

main().catch((error: unknown) => {
  log.error("fatal error", { error: String(error) });
  process.exitCode = 1;
});
