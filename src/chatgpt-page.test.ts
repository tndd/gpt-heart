import assert from "node:assert/strict";
import test from "node:test";
import { isProjectConversationUrl } from "./chatgpt-page.js";

const projectId = "6a94c14fffb48191a369bb25418da7f7";
const otherProjectId = "7b94c14fffb48191a369bb25418da7f7";

test("指定Project配下のconversation URLだけを受理する", () => {
  const project = `https://chatgpt.com/g/g-p-${projectId}/project`;
  assert.equal(
    isProjectConversationUrl(project, `https://chatgpt.com/g/g-p-${projectId}/c/conversation-id`),
    true,
  );
  assert.equal(isProjectConversationUrl(project, "https://chatgpt.com/c/conversation-id"), false);
  assert.equal(
    isProjectConversationUrl(
      project,
      `https://chatgpt.com/g/g-p-${otherProjectId}/c/conversation-id`,
    ),
    false,
  );
  assert.equal(
    isProjectConversationUrl(
      project,
      `https://example.com/g/g-p-${projectId}/c/conversation-id`,
    ),
    false,
  );
});

test("同一Project IDならslug差分を許容する", () => {
  const bareProject = `https://chatgpt.com/g/g-p-${projectId}/project`;
  const slugProject = `https://chatgpt.com/g/g-p-${projectId}-think/project`;

  assert.equal(
    isProjectConversationUrl(
      bareProject,
      `https://chatgpt.com/g/g-p-${projectId}-think/c/conversation-id`,
    ),
    true,
  );
  assert.equal(
    isProjectConversationUrl(
      slugProject,
      `https://chatgpt.com/g/g-p-${projectId}/c/conversation-id`,
    ),
    true,
  );
  assert.equal(
    isProjectConversationUrl(
      slugProject,
      `https://chatgpt.com/g/g-p-${projectId}-renamed/c/conversation-id`,
    ),
    true,
  );
  assert.equal(
    isProjectConversationUrl(
      slugProject,
      `https://chatgpt.com/g/g-p-${otherProjectId}-think/c/conversation-id`,
    ),
    false,
  );
});
