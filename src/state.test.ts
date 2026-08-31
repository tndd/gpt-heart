import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { StateStore } from "./state.js";

test("state.jsonはconversation URLをキーにstatusとparentだけを保存する", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "raspi-loop-"));
  try {
    const store = new StateStore(directory);
    await store.load();
    const parent = "https://chatgpt.com/c/parent";
    const child = "https://chatgpt.com/c/child?temporary-chat=true#x";
    await store.setConversation(parent, { status: "ended", parent: null });
    await store.setConversation(child, { status: "active", parent });

    const persisted = JSON.parse(await readFile(path.join(directory, "state.json"), "utf8"));
    assert.deepEqual(persisted, {
      "https://chatgpt.com/c/parent": { status: "ended", parent: null },
      "https://chatgpt.com/c/child": { status: "active", parent },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("同じidのchild作成jobを重複登録しない", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "raspi-loop-"));
  try {
    const store = new StateStore(directory);
    await store.load();
    const job = {
      id: "same",
      kind: "create-conversation" as const,
      parent: "https://chatgpt.com/c/parent",
      body: "方向A",
      sourceHash: "hash",
      status: "pending" as const,
    };
    await store.enqueue([job]);
    await store.enqueue([job]);
    assert.equal(store.jobs().length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("送信直前へ進んだchild jobは再起動後も自動retry対象にしない", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "raspi-loop-"));
  try {
    const store = new StateStore(directory);
    await store.load();
    const job = {
      id: "uncertain",
      kind: "create-conversation" as const,
      parent: "https://chatgpt.com/g/project/c/parent",
      body: "方向A",
      sourceHash: "hash",
      status: "pending" as const,
    };
    await store.enqueue([job]);
    await store.markJobSendUncertain(job.id);

    const reloaded = new StateStore(directory);
    await reloaded.load();
    assert.equal(reloaded.pendingJobs().length, 0);
    assert.deepEqual(reloaded.uncertainJobs().map(({ id, status }) => ({ id, status })), [
      { id: "uncertain", status: "send-uncertain" },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("永続化済み終端決定を先に回収して親をendedにする", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "raspi-loop-"));
  try {
    const store = new StateStore(directory);
    await store.load();
    const parent = "https://chatgpt.com/g/project/c/parent";
    const job = {
      id: "child",
      kind: "create-conversation" as const,
      parent,
      body: "方向A",
      sourceHash: "hash",
      status: "pending" as const,
    };
    await store.setConversation(parent, { status: "active", parent: null });
    await store.setProgress(parent, {
      lastProcessedAssistantHash: "hash",
      pendingSend: null,
      terminalDecision: { sourceHash: "hash", jobs: [job] },
    });

    const reloaded = new StateStore(directory);
    await reloaded.load();
    assert.equal(await reloaded.finalizeTerminalDecision(parent), true);
    assert.equal(reloaded.getState(parent)?.status, "ended");
    assert.deepEqual(reloaded.pendingJobs().map(({ id }) => id), ["child"]);
    assert.equal(reloaded.getProgress(parent).terminalDecision, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("複数conversationの同時更新を欠落させない", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "raspi-loop-"));
  try {
    const store = new StateStore(directory);
    await store.load();
    await Promise.all([
      store.setConversation("https://chatgpt.com/c/a", { status: "active", parent: null }),
      store.setConversation("https://chatgpt.com/c/b", { status: "active", parent: null }),
    ]);
    const persisted = JSON.parse(await readFile(path.join(directory, "state.json"), "utf8"));
    assert.deepEqual(Object.keys(persisted).sort(), [
      "https://chatgpt.com/c/a",
      "https://chatgpt.com/c/b",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
