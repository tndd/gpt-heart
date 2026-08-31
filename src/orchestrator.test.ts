import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { BrowserContext } from "playwright";
import type { Config } from "./config.js";
import {
  BrowserContextUnavailableError,
  FairWorkScheduler,
  Orchestrator,
  RoundRobinScheduler,
  roundRobinAfter,
} from "./orchestrator.js";
import { StateStore } from "./state.js";

test("前回処理URLの次からround-robin順にする", () => {
  const active = ["a", "b", "c"];
  assert.deepEqual(roundRobinAfter(active, null), ["a", "b", "c"]);
  assert.deepEqual(roundRobinAfter(active, "a"), ["b", "c", "a"]);
  assert.deepEqual(roundRobinAfter(active, "c"), ["a", "b", "c"]);
});

test("同時実行数1でも全active conversationを巡回する", () => {
  const scheduler = new RoundRobinScheduler();
  const active = ["a", "b", "c"];
  const running = new Set<string>();
  assert.deepEqual(scheduler.pick(active, running, 1), ["a"]);
  assert.deepEqual(scheduler.pick(active, running, 1), ["b"]);
  assert.deepEqual(scheduler.pick(active, running, 1), ["c"]);
  assert.deepEqual(scheduler.pick(active, running, 1), ["a"]);
});

test("送信前に失敗し続けるjobがあってもactive conversationへslotを譲る", () => {
  const scheduler = new FairWorkScheduler();
  const active = ["a", "b", "c"];
  const pendingJobs = [
    {
      id: "retrying",
      kind: "create-conversation" as const,
      parent: "parent",
      body: "child",
      sourceHash: "hash",
      status: "pending" as const,
    },
  ];
  const running = new Set<string>();

  assert.deepEqual(scheduler.pick(active, pendingJobs, running, 1), [
    { kind: "job", job: pendingJobs[0] },
  ]);
  assert.deepEqual(scheduler.pick(active, pendingJobs, running, 1), [
    { kind: "conversation", url: "a" },
  ]);
  assert.deepEqual(scheduler.pick(active, pendingJobs, running, 1), [
    { kind: "job", job: pendingJobs[0] },
  ]);
  assert.deepEqual(scheduler.pick(active, pendingJobs, running, 1), [
    { kind: "conversation", url: "b" },
  ]);
});

test("browser context死亡後はnewPageをretryせず異常終了する", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "raspi-loop-"));
  try {
    let newPageCalls = 0;
    const emitter = new EventEmitter() as EventEmitter & {
      newPage: () => Promise<never>;
    };
    emitter.newPage = async () => {
      newPageCalls += 1;
      throw new Error("must not be called");
    };
    const context = emitter as unknown as BrowserContext;
    const store = new StateStore(directory);
    const config: Config = {
      projectUrl: "https://chatgpt.com/g/g-p-project/project",
      initialBody: "",
      maxConcurrency: 1,
      actionDelayMs: 1,
      completionTimeoutMs: 100,
      pollIntervalMs: 1,
      browserProfileDir: path.join(directory, "browser"),
      stateDir: directory,
    };
    const orchestrator = new Orchestrator(context, store, config);
    emitter.emit("close");

    await assert.rejects(orchestrator.run(), BrowserContextUnavailableError);
    assert.equal(newPageCalls, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
