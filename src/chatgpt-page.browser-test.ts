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
