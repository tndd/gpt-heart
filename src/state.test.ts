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
    };
    await store.enqueue([job]);
    await store.enqueue([job]);
    assert.equal(store.jobs().length, 1);
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
