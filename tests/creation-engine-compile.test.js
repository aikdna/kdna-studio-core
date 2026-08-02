"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const creationEngine = require("../src/creation-engine");
const { compileDomain } = require("../src/compile");
const { buildPayload, exportRuntimeAsset } = require("../src/export-runtime");
const {
  candidateFor,
  createPromotedWorkspace,
  acceptWorkspace,
  addPassingCase,
  freezeSemanticCases,
} = require("./creation-engine-helpers");

const allTypesFixture = JSON.parse(
  fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "fixtures",
      "creation-engine",
      "all-card-types.json",
    ),
    "utf8",
  ),
);

function collectIds(value, result = new Set()) {
  if (!value || typeof value !== "object") return result;
  if (!Array.isArray(value) && typeof value.id === "string")
    result.add(value.id);
  for (const child of Object.values(value)) collectIds(child, result);
  return result;
}

function collectLeafStrings(value, result = []) {
  if (typeof value === "string") {
    result.push(value);
    return result;
  }
  if (!value || typeof value !== "object") return result;
  for (const child of Object.values(value)) collectLeafStrings(child, result);
  return result;
}

test("compileProject preserves judgment core, relations, load condition, and honest authorship", () => {
  let workspace = createPromotedWorkspace("interpretive");
  workspace = creationEngine.addCandidate(
    workspace,
    candidateFor({
      id: "candidate_exception",
      sourceRefs: ["source_primary"],
      agentInference: false,
      cardType: "boundary",
    }),
  );
  workspace = creationEngine.promoteCandidate(workspace, "candidate_exception");
  const [first, second] = workspace.judgmentModel.units;
  workspace = creationEngine.analyzeRelations(workspace, {
    relations: [
      {
        id: "relation_exception",
        type: "exception",
        from: second.id,
        to: first.id,
        rationale: "The boundary is an explicit exception to the axiom.",
        status: "accepted",
      },
    ],
  });
  workspace = acceptWorkspace(workspace);

  const { project } = creationEngine.compileProject(workspace);
  assert.deepEqual(
    project.judgment_core,
    workspace.judgmentModel.judgment_core,
  );
  assert.equal(
    project.distillation_target.load_condition,
    workspace.purposeBrief.loading_condition,
  );
  assert.deepEqual(project.distillation_target.exclude_areas, [
    ...new Set([
      ...workspace.purposeBrief.non_goals,
      ...workspace.judgmentModel.global_boundaries.map(
        (boundary) => boundary.statement,
      ),
    ]),
  ]);
  assert.deepEqual(project.source_core_structure, [
    {
      from: second.id,
      to: first.id,
      via: "exception",
    },
  ]);
  assert.equal(project.author.id, workspace.state.created_by.id);
  assert.ok(project.cards.every((card) => card.locked === true));
  assert.ok(project.cards.every((card) => card.human_lock === null));

  const compiled = compileDomain(project, { strictAuthority: false });
  const payload = buildPayload(compiled);
  assert.equal(
    Object.hasOwn(payload.core, "load_condition"),
    false,
    "private Creation loading conditions do not expand the public Runtime payload",
  );
  assert.equal(
    payload.core.highest_question,
    workspace.purposeBrief.highest_question,
  );
  assert.deepEqual(payload.core.core_structure, project.source_core_structure);
  assert.equal(
    collectLeafStrings(payload).includes(
      "The boundary is an explicit exception to the axiom.",
    ),
    false,
    "private relation rationale must not enter the Runtime payload",
  );
  const exported = exportRuntimeAsset(project, {
    asset_id: "kdna:fixture:creation-mode-round-trip",
    timestamp: "2026-07-28T00:00:00.000Z",
  });
  assert.equal(
    collectLeafStrings(exported).includes(
      "The boundary is an explicit exception to the axiom.",
    ),
    false,
    "private relation rationale must not enter exported Runtime files",
  );
  assert.equal(
    Object.hasOwn(exported.manifest.authoring, "creation_mode"),
    false,
    "Creation source mode stays in private creation evidence",
  );
});

test("a narrow one-unit asset compiles without invented worldview or global core fields", () => {
  let workspace = creationEngine.createWorkspace(null, {
    mode: "agent-authored",
    workflowMode: "autonomous",
    access: "public",
    createdBy: {
      type: "agent",
      id: "agent:narrow-fixture",
    },
  });
  workspace = creationEngine.setPurpose(workspace, {
    title: "short-title-boundary",
    objective: "Keep a title at eight characters or fewer.",
    scope: "Draft title length",
    loading_condition: "Before finalizing a draft title.",
  });
  workspace = creationEngine.addCandidate(workspace, {
    ...candidateFor({
      id: "candidate-short-title",
      agentInference: true,
    }),
    statement: "Keep the final title at eight characters or fewer.",
    rationale: "The declared format needs a compact title.",
    applies_when: ["A final title is being selected."],
    does_not_apply_when: ["Body copy or metadata is being written."],
    misuse_risk: "Applying the limit to body copy would truncate meaning.",
  });
  workspace = creationEngine.promoteCandidate(
    workspace,
    "candidate-short-title",
  );
  workspace = acceptWorkspace(workspace);

  const readiness = creationEngine.assessReadiness(workspace);
  assert.equal(readiness.judgment_accepted, true);
  assert.deepEqual(workspace.judgmentModel.judgment_core, {});
  assert.deepEqual(workspace.judgmentModel.global_boundaries, []);
  const { project } = creationEngine.compileProject(workspace);
  const payload = buildPayload(
    compileDomain(project, { strictAuthority: false }),
  );
  assert.equal(Object.hasOwn(payload.core, "highest_question"), false);
  assert.equal(Object.hasOwn(payload.core, "worldview"), false);
  assert.equal(Object.hasOwn(payload.core, "value_order"), false);
  assert.equal(Object.hasOwn(payload.core, "judgment_role"), false);
  assert.equal(payload.core.axioms.length, 1);
  assert.deepEqual(payload.core.axioms[0].does_not_apply_when, [
    "Body copy or metadata is being written.",
  ]);

  let hollow = creationEngine.createWorkspace(null, {
    mode: "agent-authored",
    workflowMode: "autonomous",
    access: "public",
    createdBy: { type: "agent", id: "agent:hollow-fixture" },
  });
  hollow = creationEngine.setPurpose(hollow, {
    objective: "Sound comprehensive without a judgment.",
    scope: "Empty demonstration",
    loading_condition: "Always",
    highest_question: "What is everything?",
    worldview: ["Everything matters."],
    value_order: ["importance"],
    judgment_role: { acts_as: "a grand worldview" },
    global_boundaries: ["Do nothing outside everything."],
  });
  assert.ok(
    creationEngine
      .assessReadiness(hollow)
      .blocking.some((item) => item.code === "NO_JUDGMENTS"),
  );
});

test("compileDomain rejects unknown, private, and malformed Runtime relations", () => {
  const workspace = acceptWorkspace(createPromotedWorkspace("interpretive"));
  const { project } = creationEngine.compileProject(workspace);
  const invalidRelations = [
    [{ from: "judgment-a", to: "judgment-b", via: "support" }],
    [
      {
        from: "judgment-a",
        to: "judgment-b",
        via: "priority",
        rationale: "Private Creation evidence must stay private.",
      },
    ],
    [{ from: "", to: "judgment-b", via: "priority" }],
    [
      {
        from: "judgment-a",
        to: "judgment-b",
        via: "exception",
        applies_when: [""],
      },
    ],
    ["priority"],
  ];

  for (const coreStructure of invalidRelations) {
    const hostileProject = structuredClone(project);
    hostileProject.source_core_structure = coreStructure;
    assert.throws(
      () => compileDomain(hostileProject, { strictAuthority: false }),
      (error) => error.code === "INVALID_RUNTIME_RELATION",
    );
  }
});

test("declared human and organization confirmation cannot become Runtime identity evidence", () => {
  for (const mode of ["human-confirmed", "organization-confirmed"]) {
    const unconfirmed = createPromotedWorkspace(mode);
    assert.equal(
      creationEngine.assessReadiness(unconfirmed).judgment_accepted,
      false,
    );
    assert.throws(
      () => creationEngine.compileProject(unconfirmed),
      (error) => error.code === "CREATION_NOT_ACCEPTED",
    );

    const workspace = acceptWorkspace(unconfirmed);
    const confirmationIds = workspace.confirmationReceipts.map(
      (receipt) => receipt.id,
    );
    assert.ok(confirmationIds.length > 0);
    const { project } = creationEngine.compileProject(workspace);
    assert.equal(project.status, "ready_for_test");
    assert.notEqual(project.status, "ready_for_release");
    assert.equal(project.author.id, workspace.state.created_by.id);
    assert.notEqual(
      project.author.id,
      workspace.purposeBrief.represented_subject.id,
    );
    assert.ok(project.cards.every((card) => card.human_lock === null));

    const exported = exportRuntimeAsset(project, {
      asset_id: `kdna:fixture:declared-${mode}-is-not-runtime-proof`,
      timestamp: "2026-07-28T00:00:00.000Z",
    });
    assert.deepEqual(exported.manifest.creator, {
      name: workspace.state.created_by.name,
      id: workspace.state.created_by.id,
    });
    assert.equal(exported.manifest.authoring.human_lock_count, 0);
    assert.equal(exported.manifest.authoring.human_confirmed, false);

    const runtimeText = [
      exported.files["kdna.json"],
      JSON.stringify(exported.payload),
    ].join("\n");
    const receiptMarkers = workspace.confirmationReceipts
      .flatMap((receipt) => [
        receipt.id,
        receipt.actor.id,
        receipt.actor.authority,
      ])
      .filter(Boolean);
    for (const forbidden of [
      workspace.purposeBrief.represented_subject.id,
      ...confirmationIds,
      ...receiptMarkers,
      "confirmation_receipt_ids",
      "creation_acceptance",
      "creation_mode",
      "semantic_revision",
      "represented_subject",
    ]) {
      assert.ok(
        !runtimeText.includes(forbidden),
        `${mode} Runtime leaked private marker: ${forbidden}`,
      );
    }
  }
});

test("all authority and workflow coordinates stay outside Runtime bytes", () => {
  let fixtureIndex = 0;
  for (const mode of creationEngine.CREATION_MODES) {
    for (const workflowMode of creationEngine.WORKFLOW_MODES) {
      const workspace = acceptWorkspace(
        createPromotedWorkspace(mode, {
          workflowMode,
        }),
      );
      const { project } = creationEngine.compileProject(workspace);
      const exported = exportRuntimeAsset(project, {
        asset_id: `kdna:fixture:private-coordinate-${fixtureIndex++}`,
        timestamp: "2026-07-31T00:00:00.000Z",
      });
      const runtimeText = [
        exported.files["kdna.json"],
        JSON.stringify(exported.payload),
      ].join("\n");
      for (const forbidden of [
        mode,
        workflowMode,
        "participation_role",
        "confirmationReceipts",
        "confirmation_receipt_ids",
        "represented_subject",
        ...workspace.confirmationReceipts.flatMap((receipt) => [
          receipt.id,
          receipt.actor.id,
          receipt.subject.id,
        ]),
      ]) {
        assert.ok(
          !runtimeText.includes(forbidden),
          `${mode}/${workflowMode} leaked private Creation coordinate: ${forbidden}`,
        );
      }
    }
  }
});

test("non-Agent createdBy declarations are omitted from Runtime creator provenance", () => {
  for (const type of ["human", "organization"]) {
    const workspace = acceptWorkspace(
      createPromotedWorkspace("interpretive", {
        createdBy: {
          type,
          id: `declared-${type}-creator`,
          name: `Declared ${type} creator`,
        },
      }),
    );
    const { project } = creationEngine.compileProject(workspace);
    assert.deepEqual(project.author, { name: "", id: "" });
    const exported = exportRuntimeAsset(project, {
      asset_id: `kdna:fixture:private-${type}-creator`,
      timestamp: "2026-07-28T00:00:00.000Z",
    });
    assert.equal(Object.hasOwn(exported.manifest, "creator"), false);
    assert.ok(
      !exported.files["kdna.json"].includes(`declared-${type}-creator`),
    );
  }
});

test("support, limit, and resolved conflict stay in creation evidence instead of Runtime relations", () => {
  let workspace = createPromotedWorkspace();
  workspace = creationEngine.addCandidate(
    workspace,
    candidateFor({
      id: "candidate_evidence_relation",
      cardType: "risk",
      agentInference: true,
    }),
  );
  workspace = creationEngine.promoteCandidate(
    workspace,
    "candidate_evidence_relation",
  );
  const [first, second] = workspace.judgmentModel.units;
  workspace = creationEngine.analyzeRelations(workspace, {
    relations: [
      {
        id: "relation_support_evidence",
        type: "support",
        from: first.id,
        to: second.id,
        rationale: "This is explanatory evidence, not Runtime precedence.",
        status: "accepted",
      },
      {
        id: "relation_limit_evidence",
        type: "limit",
        from: second.id,
        to: first.id,
        rationale:
          "This remains an authoring note until a real case admits it.",
        status: "accepted",
      },
      {
        id: "relation_resolved_conflict",
        type: "conflict",
        from: first.id,
        to: second.id,
        rationale: "The authoring conflict was resolved outside Runtime.",
        status: "resolved",
        resolution:
          "The judgments were rewritten so the conflict no longer applies.",
      },
    ],
  });
  workspace = acceptWorkspace(workspace);

  const { project } = creationEngine.compileProject(workspace);
  assert.deepEqual(project.source_core_structure, []);
  assert.equal(workspace.judgmentModel.relations.length, 3);
});

test("private source bodies and source paths never enter project or Runtime payload", () => {
  let workspace = createPromotedWorkspace("interpretive");
  const privateBody = "PRIVATE-BODY-MUST-NOT-ENTER-RUNTIME";
  workspace = creationEngine.ingestMaterial(workspace, {
    id: "source_private_second",
    kind: "document",
    title: "Private second source",
    content: privateBody,
    reference: "/private/source/path.md",
    authority: "supporting",
    currentness: "current",
    sensitivity: "sensitive",
    in_scope: true,
  });
  const sensitiveQuestion = workspace.unresolvedQuestions.find(
    (item) => item.kind === "source_safety_output_disclosure",
  );
  workspace = creationEngine.recordInterviewAnswer(workspace, {
    operation_id: "interview:private-source-review",
    recorded_against_semantic_revision: workspace.state.semantic_revision,
    recorded_against_semantic_digest: workspace.state.semantic_digest,
    question_id: sensitiveQuestion.id,
    question: sensitiveQuestion.reason,
    answer: "Use only the abstract judgment and exclude all source detail.",
    actor: { type: "agent", id: "reviewer-001" },
    subject: { type: "agent", id: "reviewer-001" },
    source_disposition: {
      source_id: "source_private_second",
      decision: "non-leaking-abstraction",
      semantic_revision: workspace.state.semantic_revision,
      reviewer: "reviewer-001",
      rationale:
        "The compiled unit contains no source body, quote, or private reference.",
    },
  });
  workspace = acceptWorkspace(workspace);
  const { project } = creationEngine.compileProject(workspace);
  const projectBytes = JSON.stringify(project);
  assert.ok(!projectBytes.includes(privateBody));
  assert.ok(!projectBytes.includes("/private/source/path.md"));
  const exported = exportRuntimeAsset(project, {
    asset_id: "kdna:fixture:creation-private-isolation",
    timestamp: "2026-07-28T00:00:00.000Z",
  });
  const payloadBytes = JSON.stringify(exported.payload);
  assert.ok(!payloadBytes.includes(privateBody));
  assert.ok(!payloadBytes.includes("/private/source/path.md"));
});

test("all sixteen card types preserve identities and type-specific fields through Runtime projection", () => {
  let workspace = createPromotedWorkspace();

  for (const cardType of allTypesFixture.card_types) {
    const candidateId = `candidate_fixture_${cardType}`;
    workspace = creationEngine.addCandidate(workspace, {
      ...candidateFor({
        id: candidateId,
        cardType,
        agentInference: true,
      }),
      fields: allTypesFixture.fields_by_type[cardType],
    });
    workspace = creationEngine.promoteCandidate(workspace, candidateId, {
      unit_id: `unit_fixture_${cardType}`,
    });
  }

  const evaluator = {
    type: "agent",
    id: "independent-card-type-evaluator",
    authority: "independent-agent-evaluator",
  };
  const definitions = [];
  for (const unit of workspace.judgmentModel.units) {
    definitions.push({
      id: `test_applicable_${unit.id}`,
      kind: "applicable",
      input: `Applicable input for ${unit.card_type}.`,
      expected: "Apply the unit.",
      unit_ids: [unit.id],
    });
    definitions.push({
      id: `test_counterexample_${unit.id}`,
      kind: "counterexample",
      input: `Counterexample for ${unit.card_type}.`,
      expected: "Do not apply the unit.",
      unit_ids: [unit.id],
    });
  }
  definitions.push({
    id: "test_boundary_no_secrets",
    kind: "boundary",
    input: "A secret is present.",
    expected: "Do not reveal it.",
    boundary_ids: ["boundary_no_secrets"],
  });
  workspace = freezeSemanticCases(workspace, definitions, {
    planId: "semantic-plan-all-card-types",
    evaluator,
  });
  for (const definition of definitions.slice(0, -1)) {
    workspace = creationEngine.recordSemanticTestResult(
      workspace,
      definition.id,
      {
        result: "pass",
        evaluated_by: evaluator,
        notes: "The frozen card-type semantic case passed.",
      },
    );
  }
  workspace = creationEngine.recordSemanticTestResult(
    workspace,
    "test_boundary_no_secrets",
    {
      result: "pass",
      evaluated_by: evaluator,
      acceptance: {
        accepted: true,
        actor: evaluator,
        statement: "All sixteen card-type projections passed.",
      },
    },
  );

  const { project } = creationEngine.compileProject(workspace);
  assert.deepEqual(
    new Set(project.cards.map((card) => card.type)),
    new Set(allTypesFixture.card_types),
  );
  const compiled = compileDomain(project, { strictAuthority: false });
  const payload = buildPayload(compiled);
  const projectedIds = collectIds(payload);
  for (const unit of workspace.judgmentModel.units) {
    assert.ok(
      projectedIds.has(unit.id),
      `${unit.card_type} lost id ${unit.id}`,
    );
  }
  const payloadText = JSON.stringify(payload);
  for (const marker of collectLeafStrings(allTypesFixture.fields_by_type)) {
    assert.ok(
      payloadText.includes(JSON.stringify(marker).slice(1, -1)),
      `Runtime payload lost type-specific field value ${marker}`,
    );
  }
});
