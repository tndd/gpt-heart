import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { ChatGptPage } from "./chatgpt-page.js";

test("停止ボタン消失まで生成完了にしない", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <div id="messages"></div>
      <div id="prompt-textarea" contenteditable="true"></div>
      <button data-testid="send-button">Send</button>
      <script>
        document.querySelector('[data-testid="send-button"]').addEventListener('click', () => {
          const send = document.querySelector('[data-testid="send-button"]');
          const composer = document.querySelector('#prompt-textarea');
          document.querySelector('#messages').insertAdjacentHTML(
            'beforeend',
            '<div data-message-author-role="user">' + composer.textContent + '</div>' +
            '<div data-message-author-role="assistant">考え</div>'
          );
          composer.textContent = '';
          send.hidden = true;
          send.insertAdjacentHTML('afterend', '<button data-testid="stop-button">Stop</button>');
          setTimeout(() => {
            document.querySelector('[data-message-author-role="assistant"]').textContent = '考え終わりました';
            document.querySelector('[data-testid="stop-button"]').remove();
          }, 250);
        });
      </script>
    `);

    const driver = new ChatGptPage(page, 50, 2_000);
    await driver.send(".");
    const startedAt = Date.now();
    await driver.waitForGenerationComplete(1);
    assert.ok(Date.now() - startedAt >= 200);
    assert.equal((await driver.latestAssistant())?.text, "考え終わりました");
  } finally {
    await page.close();
    await browser.close();
  }
});

test("無関係なStop aria-labelを生成中と誤認しない", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <div data-message-author-role="assistant">完了済み</div>
      <div id="prompt-textarea" contenteditable="true"></div>
      <button aria-label="Stop sharing screen">共有停止</button>
    `);
    const driver = new ChatGptPage(page, 25, 500);
    await driver.waitForGenerationComplete(1);
    assert.equal((await driver.latestAssistant())?.text, "完了済み");
  } finally {
    await page.close();
    await browser.close();
  }
});

test("送信直前callbackが失敗した場合はbuttonをclickしない", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <div id="prompt-textarea" contenteditable="true"></div>
      <button data-testid="send-button" onclick="window.clicked = true">Send</button>
    `);
    const driver = new ChatGptPage(page, 25, 500);
    await assert.rejects(
      driver.send("方向A", undefined, async () => {
        throw new Error("queue persistence failed");
      }),
      /queue persistence failed/,
    );
    assert.equal(await page.evaluate(() => (window as unknown as { clicked?: boolean }).clicked), undefined);
  } finally {
    await page.close();
    await browser.close();
  }
});

test("送信したuserメッセージがDOMに現れるまで成功扱いにしない", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <div id="messages"></div>
      <div id="prompt-textarea" contenteditable="true"></div>
      <button data-testid="send-button">Send</button>
      <script>
        document.querySelector('[data-testid="send-button"]').addEventListener('click', () => {
          const text = document.querySelector('#prompt-textarea').textContent;
          setTimeout(() => {
            document.querySelector('#messages').insertAdjacentHTML(
              'beforeend',
              '<div data-message-author-role="user">' + text + '</div>'
            );
          }, 250);
        });
      </script>
    `);
    const driver = new ChatGptPage(page, 25, 500);
    const startedAt = Date.now();
    await driver.send(".");
    assert.ok(Date.now() - startedAt >= 200);
    assert.equal(await driver.userCount(), 1);
  } finally {
    await page.close();
    await browser.close();
  }
});

test("userメッセージ属性がなくても生成開始を送信成功として確認する", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <div id="prompt-textarea" contenteditable="true"></div>
      <button data-testid="send-button">Send</button>
      <script>
        document.querySelector('[data-testid="send-button"]').addEventListener('click', () => {
          setTimeout(() => {
            document.querySelector('[data-testid="send-button"]').insertAdjacentHTML(
              'afterend',
              '<button data-testid="stop-button">Stop</button>'
            );
          }, 100);
        });
      </script>
    `);
    const driver = new ChatGptPage(page, 25, 500);
    await driver.send(".");
  } finally {
    await page.close();
    await browser.close();
  }
});

test("短いcomposer描画遅延ではwarning callbackを呼ばない", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <div id="root"></div>
      <script>
        setTimeout(() => {
          document.querySelector('#root').insertAdjacentHTML(
            'beforeend',
            '<div id="prompt-textarea" contenteditable="true"></div>'
          );
        }, 75);
      </script>
    `);
    let warnings = 0;
    const driver = new ChatGptPage(page, 25, 500);
    await driver.waitForComposer(() => {
      warnings += 1;
    }, 250);
    assert.equal(warnings, 0);
  } finally {
    await page.close();
    await browser.close();
  }
});

test("composerより遅れてmessage DOMが表示されてもroleを待つ", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <div id="messages"></div>
      <div id="prompt-textarea" contenteditable="true"></div>
      <script>
        setTimeout(() => {
          document.querySelector('#messages').insertAdjacentHTML(
            'beforeend',
            '<div data-message-author-role="assistant">準備完了</div>'
          );
        }, 100);
      </script>
    `);
    const driver = new ChatGptPage(page, 25, 500);
    const startedAt = Date.now();
    assert.equal(await driver.waitForMessageRole(500), "assistant");
    assert.ok(Date.now() - startedAt >= 75);
  } finally {
    await page.close();
    await browser.close();
  }
});

test("message DOMが表示されない場合はtimeoutする", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent('<div id="prompt-textarea" contenteditable="true"></div>');
    const driver = new ChatGptPage(page, 25, 500);
    await assert.rejects(driver.waitForMessageRole(125), /messages to become ready/);
  } finally {
    await page.close();
    await browser.close();
  }
});

test("Unarchive UIがあるconversationをarchivedとして検出する", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <div data-message-author-role="assistant">過去の応答</div>
      <button>Unarchive to continue</button>
    `);
    const driver = new ChatGptPage(page, 25, 500);
    assert.deepEqual(await driver.waitForConversationReady(undefined, 250), { kind: "archived" });
  } finally {
    await page.close();
    await browser.close();
  }
});

test("日本語のアーカイブ解除UIもarchivedとして検出する", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent('<button aria-label="アーカイブを解除">アーカイブ解除</button>');
    const driver = new ChatGptPage(page, 25, 500);
    assert.deepEqual(await driver.waitForConversationReady(undefined, 250), { kind: "archived" });
  } finally {
    await page.close();
    await browser.close();
  }
});

test("disabled composerを通常conversationと誤認せず後から出るarchive UIを待つ", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <textarea id="prompt-textarea" disabled></textarea>
      <div id="status"></div>
      <script>
        setTimeout(() => {
          document.querySelector('#status').insertAdjacentHTML(
            'beforeend',
            '<button>アーカイブを解除する</button>'
          );
        }, 100);
      </script>
    `);
    const driver = new ChatGptPage(page, 25, 500);
    assert.deepEqual(await driver.waitForConversationReady(undefined, 250), { kind: "archived" });
  } finally {
    await page.close();
    await browser.close();
  }
});

test("Conversation not foundをunavailableとして検出する", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent('<main><div>Conversation not found</div></main>');
    const driver = new ChatGptPage(page, 25, 500);
    assert.deepEqual(await driver.waitForConversationReady(undefined, 250), { kind: "unavailable" });
  } finally {
    await page.close();
    await browser.close();
  }
});

test("Unable to load conversationもunavailableとして検出する", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent('<main><div>Unable to load conversation</div></main>');
    const driver = new ChatGptPage(page, 25, 500);
    assert.deepEqual(await driver.waitForConversationReady(undefined, 250), { kind: "unavailable" });
  } finally {
    await page.close();
    await browser.close();
  }
});

test("This conversation has been deletedもunavailableとして検出する", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent('<main><div>This conversation has been deleted</div></main>');
    const driver = new ChatGptPage(page, 25, 500);
    assert.deepEqual(await driver.waitForConversationReady(undefined, 250), { kind: "unavailable" });
  } finally {
    await page.close();
    await browser.close();
  }
});

test("削除エラー文言が会話内にあってもcomposerがあれば通常conversationを優先する", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <div data-message-author-role="assistant">Conversation not found</div>
      <div id="prompt-textarea" contenteditable="true"></div>
    `);
    const driver = new ChatGptPage(page, 25, 500);
    const ready = await driver.waitForConversationReady(undefined, 250);
    assert.equal(ready.kind, "composer");
  } finally {
    await page.close();
    await browser.close();
  }
});
