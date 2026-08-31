import assert from "node:assert/strict";
import test from "node:test";
import { isProjectConversationUrl } from "./chatgpt-page.js";

const project = "https://chatgpt.com/g/g-p-6a94/project";

test("指定Project配下のconversation URLだけを受理する", () => {
  assert.equal(
    isProjectConversationUrl(project, "https://chatgpt.com/g/g-p-6a94/c/conversation-id"),
    true,
  );
  assert.equal(isProjectConversationUrl(project, "https://chatgpt.com/c/conversation-id"), false);
  assert.equal(
    isProjectConversationUrl(project, "https://chatgpt.com/g/g-p-other/c/conversation-id"),
    false,
  );
  assert.equal(
    isProjectConversationUrl(project, "https://example.com/g/g-p-6a94/c/conversation-id"),
    false,
  );
});
