import assert from "node:assert/strict";
import test from "node:test";
import { decideResponse, parseTrailingControls } from "./control.js";

test("末尾のnextを複数、出現順で返す", () => {
  const parsed = parseTrailingControls(`本文\n@@RASPI@@ {"action":"next","body":"方向A"}\n@@RASPI@@ {"action":"next","body":"方向B"}\n`);
  assert.deepEqual(parsed, {
    commands: [
      { action: "next", body: "方向A" },
      { action: "next", body: "方向B" },
    ],
    invalidLines: [],
  });
});

test("本文中のシグナル風行は無視する", () => {
  const parsed = parseTrailingControls(`@@RASPI@@ {"action":"end"}\nこれは本文です`);
  assert.deepEqual(parsed.commands, []);
});

test("末尾のendを認識する", () => {
  const parsed = parseTrailingControls(`完了\n@@RASPI@@ {"action":"end"}`);
  assert.deepEqual(parsed.commands, [{ action: "end" }]);
});

test("bodyのないnextを不正として扱う", () => {
  const line = '@@RASPI@@ {"action":"next"}';
  const parsed = parseTrailingControls(line);
  assert.deepEqual(parsed.commands, []);
  assert.deepEqual(parsed.invalidLines, [line]);
});

test("シグナルなしはdot継続になる", () => {
  assert.deepEqual(decideResponse("まだ検討を続けます"), {
    sendDot: true,
    endCurrent: false,
    nextBodies: [],
    invalidLines: [],
  });
});

test("nextとendの併存は子を作って現在を終了する", () => {
  assert.deepEqual(
    decideResponse(
      '完了\n@@RASPI@@ {"action":"next","body":"方向A"}\n@@RASPI@@ {"action":"end"}',
    ),
    {
      sendDot: false,
      endCurrent: true,
      nextBodies: ["方向A"],
      invalidLines: [],
    },
  );
});
