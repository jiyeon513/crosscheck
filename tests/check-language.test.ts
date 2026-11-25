// The agreement check's "not sure" option is in the language of the other options.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { useFixtureGenerator } from "../agents/llm";
import { detectDecision } from "../agents/moderator";
import { enableFixtureModels } from "./mocks";

test("a Korean check never shows an English 'Not sure yet'", async () => {
  useFixtureGenerator(() => ({
    is_decision: true, decision: "혼잡도 예측으로 간다.", ambiguity: "범위", question: "어느 장소를 예측하나요?",
    options: ["캠퍼스 전체", "학생식당과 도서관", "Not sure yet"], challenged: 0, reason: "",
  }));
  try {
    const d = await detectDecision({ goal: "앱 아이디어", trigger: "new_message", group: [{ author: "민수", text: "좋아, 혼잡도 예측으로 가자." }] });
    assert.deepEqual(d.options, ["캠퍼스 전체", "학생식당과 도서관", "아직 잘 모르겠어요"]);
  } finally {
    enableFixtureModels();
  }
});
