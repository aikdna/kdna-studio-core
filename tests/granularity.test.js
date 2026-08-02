"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  diagnoseGranularity,
  evaluateOpeningQuestion,
} = require("../src/granularity");

test("legacy granularity diagnostics never split an asset from conjunctions alone", () => {
  const result = diagnoseGranularity({
    cards: [
      {
        id: "axiom-connected-system",
        type: "axiom",
        status: "locked",
        fields: {
          one_sentence: "同时保留核心边界，此外在授权范围内应用相关判断。",
          applies_when: "The related judgments share one scope and lifecycle.",
          does_not_apply_when:
            "They require different authorization or an independent lifecycle.",
        },
      },
    ],
  });
  assert.notEqual(result.level, "mixed");
  assert.equal(result.passed, true);
  assert.doesNotMatch(
    result.recommended_action,
    /STOP|one judgment dimension/i,
  );
});

test("opening-question text length is not an asset-count rule", () => {
  const answer =
    `When one connected system is reviewed, should its related judgments ` +
    `${"remain within the same declared scope ".repeat(45)}?`;
  assert.ok(answer.trim().split(/\s+/).length > 200);
  const result = evaluateOpeningQuestion(answer);
  assert.equal(result.scoped, true);
  assert.deepEqual(result.issues, []);
});
