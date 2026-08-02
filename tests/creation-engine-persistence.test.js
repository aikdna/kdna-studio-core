"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Ajv2020 = require("ajv/dist/2020");
const addFormats = require("ajv-formats");

const creationEngine = require("../src/creation-engine");
const { exportRuntimeAsset } = require("../src/export-runtime");
const {
  createPromotedWorkspace,
  acceptWorkspace,
  passingBuildReceipt,
  exactBuildFixture,
  recordExactBuildReceipt,
} = require("./creation-engine-helpers");

const schema = require("../schemas/creation-workspace.schema.json");

function rewriteArtifact(target, name, mutate) {
  const artifactPath = path.join(target, name);
  const envelope = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  mutate(envelope);
  fs.writeFileSync(artifactPath, `${JSON.stringify(envelope, null, 2)}\n`);
}

function rewriteEnvelopeDigest(target, semanticDigest) {
  for (const name of creationEngine.ARTIFACT_FILES) {
    rewriteArtifact(target, name, (envelope) => {
      envelope.semantic_digest = semanticDigest;
    });
  }
}

test("workspace schema validates a complete accepted workspace", () => {
  const workspace = acceptWorkspace(createPromotedWorkspace("human-confirmed"));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  assert.equal(
    validate(workspace),
    true,
    JSON.stringify(validate.errors, null, 2),
  );
});

test("save/load keeps confirmation private when the restored workspace is exported", () => {
  const parent = fs.mkdtempSync(
    path.join(os.tmpdir(), "creation-private-confirmation-"),
  );
  const target = path.join(parent, "workspace");
  const saved = creationEngine.saveWorkspace(
    target,
    acceptWorkspace(createPromotedWorkspace("human-confirmed")),
  );
  const loaded = creationEngine.loadWorkspace(target);
  assert.deepEqual(loaded.confirmationReceipts, saved.confirmationReceipts);

  const { project } = creationEngine.compileProject(loaded);
  assert.ok(project.cards.every((card) => card.human_lock === null));
  const exported = exportRuntimeAsset(project, {
    asset_id: "kdna:fixture:restored-private-confirmation",
    timestamp: "2026-07-28T00:00:00.000Z",
  });
  assert.equal(exported.manifest.authoring.human_lock_count, 0);
  assert.equal(exported.manifest.authoring.human_confirmed, false);
  const runtimeText = [
    exported.files["kdna.json"],
    JSON.stringify(exported.payload),
  ].join("\n");
  assert.ok(!runtimeText.includes(loaded.purposeBrief.represented_subject.id));
  for (const receipt of loaded.confirmationReceipts) {
    assert.ok(!runtimeText.includes(receipt.id));
  }
});

test("public validation and direct loads enforce schema paths before digest acceptance", () => {
  const workspace = acceptWorkspace(createPromotedWorkspace());
  const hostile = JSON.parse(JSON.stringify(workspace));
  hostile.exportPlan.access = "secret";

  const result = creationEngine.validateWorkspace(hostile);
  assert.equal(result.valid, false);
  assert.ok(
    result.issues.some(
      (issue) =>
        issue.includes("/exportPlan/access") &&
        issue.includes("public, licensed, remote"),
    ),
    result.issues.join("\n"),
  );
  assert.throws(
    () => creationEngine.loadWorkspace(hostile),
    /\/exportPlan\/access/,
  );
  assert.throws(
    () => creationEngine.loadWorkspace(JSON.stringify(hostile)),
    /\/exportPlan\/access/,
  );
});

test("older private Creation workspace schemas require an explicit migration", () => {
  const legacy = acceptWorkspace(createPromotedWorkspace());
  legacy.state.schema_version = "0.1.0";
  assert.throws(
    () => creationEngine.loadWorkspace(legacy),
    (error) =>
      error.code === "CREATION_WORKSPACE_SCHEMA_UNSUPPORTED" &&
      /workspace_schema_unsupported.*migration_required/.test(error.message),
  );
  assert.equal(creationEngine.SCHEMA_VERSION, "0.2.0");
});

test("artifact load rejects invalid access even when the semantic digest remains valid", () => {
  const parent = fs.mkdtempSync(
    path.join(os.tmpdir(), "creation-hostile-access-"),
  );
  const target = path.join(parent, "workspace");
  creationEngine.saveWorkspace(
    target,
    acceptWorkspace(createPromotedWorkspace()),
  );
  rewriteArtifact(target, "export-plan.json", (envelope) => {
    envelope.data.export_plan.access = "secret";
  });

  assert.throws(
    () => creationEngine.loadWorkspace(target),
    /\/exportPlan\/access/,
  );
});

test("artifact load rejects an invalid mode with a correctly recomputed canonical digest", () => {
  const parent = fs.mkdtempSync(
    path.join(os.tmpdir(), "creation-hostile-mode-"),
  );
  const target = path.join(parent, "workspace");
  creationEngine.saveWorkspace(
    target,
    acceptWorkspace(createPromotedWorkspace()),
  );
  const hostile = creationEngine.loadWorkspace(target);
  hostile.state.mode = "impersonated-human";
  hostile.state.semantic_digest =
    creationEngine.canonicalSemanticDigest(hostile);
  rewriteEnvelopeDigest(target, hostile.state.semantic_digest);
  rewriteArtifact(target, "creation-state.json", (envelope) => {
    envelope.data.state.mode = hostile.state.mode;
    envelope.data.state.semantic_digest = hostile.state.semantic_digest;
  });

  assert.throws(() => creationEngine.loadWorkspace(target), /\/state\/mode/);
});

test("artifact load rejects malformed confirmation actors outside the semantic digest", () => {
  const parent = fs.mkdtempSync(
    path.join(os.tmpdir(), "creation-hostile-receipt-"),
  );
  const target = path.join(parent, "workspace");
  creationEngine.saveWorkspace(
    target,
    acceptWorkspace(createPromotedWorkspace("human-confirmed")),
  );
  rewriteArtifact(target, "confirmation-receipts.json", (envelope) => {
    envelope.data.confirmation_receipts[0].actor.type =
      "agent-pretending-to-be-human";
  });

  assert.throws(
    () => creationEngine.loadWorkspace(target),
    /\/confirmationReceipts\/0\/actor\/type/,
  );
});

test("save/load persists exactly eleven digest-bound artifacts", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "creation-workspace-"));
  const target = path.join(parent, "workspace");
  let workspace = acceptWorkspace(createPromotedWorkspace());
  workspace = creationEngine.completeOperation(workspace, {
    operation_id: "operation:persistence",
    command: "review",
    request_digest: creationEngine.canonicalOperationRequestDigest({
      command: "review",
      payload: { accepted: true },
    }),
    before: creationEngine.operationCoordinate(workspace),
  });
  const saved = creationEngine.saveWorkspace(target, workspace);
  assert.deepEqual(
    fs.readdirSync(target).sort(),
    [...creationEngine.ARTIFACT_FILES].sort(),
  );
  const loaded = creationEngine.loadWorkspace(target);
  assert.deepEqual(loaded, saved);

  const envelope = JSON.parse(
    fs.readFileSync(path.join(target, "judgment-model.json"), "utf8"),
  );
  assert.equal(envelope.semantic_revision, saved.state.semantic_revision);
  assert.equal(envelope.semantic_digest, saved.state.semantic_digest);
  const stateEnvelope = JSON.parse(
    fs.readFileSync(path.join(target, "creation-state.json"), "utf8"),
  );
  assert.equal(stateEnvelope.data.operations.length, 1);
  assert.equal(
    stateEnvelope.data.operations[0].operation_id,
    "operation:persistence",
  );
});

test("managed candidate bytes are atomic, digest-bound, and invalidated by revision", () => {
  const parent = fs.mkdtempSync(
    path.join(os.tmpdir(), "creation-managed-candidate-"),
  );
  const target = path.join(parent, "workspace");
  let workspace = acceptWorkspace(createPromotedWorkspace());
  const fixture = exactBuildFixture(workspace);
  fixture.receipt.output.filename = creationEngine.MANAGED_CANDIDATE_FILE;
  workspace = creationEngine.recordBuildReceipt(
    workspace,
    fixture.receipt,
    fixture.verification,
  );
  workspace = creationEngine.saveWorkspace(target, workspace, {
    managedCandidateBytes: fixture.verification.asset_bytes,
  });

  const managed = creationEngine.readManagedCandidate(target, workspace);
  assert.equal(managed.asset_digest, workspace.buildReceipt.asset_digest);
  assert.deepEqual(managed.bytes, fixture.verification.asset_bytes);
  assert.equal(
    managed.path,
    path.join(
      target,
      creationEngine.MANAGED_CANDIDATE_DIRECTORY,
      creationEngine.MANAGED_CANDIDATE_FILE,
    ),
  );
  assert.deepEqual(creationEngine.loadWorkspace(target), workspace);

  const originalBytes = Buffer.from(managed.bytes);
  fs.writeFileSync(
    managed.path,
    Buffer.concat([originalBytes, Buffer.from([0])]),
  );
  assert.throws(
    () => creationEngine.readManagedCandidate(target, workspace),
    /do not match the current build receipt/,
  );
  assert.throws(
    () => creationEngine.loadWorkspace(target),
    /do not match the current build receipt/,
  );
  fs.writeFileSync(managed.path, originalBytes);

  const next = creationEngine.updateExportPlan(workspace, {
    version: "1.0.1",
  });
  const saved = creationEngine.saveWorkspace(target, next);
  assert.notEqual(saved.buildReceipt.version, saved.exportPlan.version);
  assert.equal(fs.existsSync(managed.path), false);
  assert.throws(
    () => creationEngine.readManagedCandidate(target, saved),
    /no managed candidate bytes/,
  );
});

test("load rejects mixed snapshots and recovers a complete interrupted backup", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "creation-recovery-"));
  const target = path.join(parent, "workspace");
  let workspace = createPromotedWorkspace();
  workspace = creationEngine.saveWorkspace(target, workspace);

  const mismatch = JSON.parse(
    fs.readFileSync(path.join(target, "purpose-brief.json"), "utf8"),
  );
  mismatch.semantic_revision += 1;
  fs.writeFileSync(
    path.join(target, "purpose-brief.json"),
    `${JSON.stringify(mismatch, null, 2)}\n`,
  );
  assert.throws(
    () => creationEngine.loadWorkspace(target),
    /snapshot mismatch/,
  );

  mismatch.semantic_revision -= 1;
  fs.writeFileSync(
    path.join(target, "purpose-brief.json"),
    `${JSON.stringify(mismatch, null, 2)}\n`,
  );
  creationEngine.saveWorkspace(target, workspace);
  const backup = path.join(parent, ".workspace.backup-interrupted");
  fs.renameSync(target, backup);
  const recovered = creationEngine.loadWorkspace(target);
  assert.equal(recovered.root, target);
  assert.equal(
    recovered.state.semantic_digest,
    workspace.state.semantic_digest,
  );
});

test("optimistic save concurrency rejects stale and divergent Agent snapshots", () => {
  const parent = fs.mkdtempSync(
    path.join(os.tmpdir(), "creation-concurrency-"),
  );
  const target = path.join(parent, "workspace");
  const base = creationEngine.saveWorkspace(target, createPromotedWorkspace());
  let agentA = creationEngine.loadWorkspace(target);
  let agentB = creationEngine.loadWorkspace(target);

  agentA = creationEngine.recordInterviewAnswer(agentA, {
    operation_id: "interview:agent-a",
    recorded_against_semantic_revision: agentA.state.semantic_revision,
    recorded_against_semantic_digest: agentA.state.semantic_digest,
    subject: { type: "agent", id: "agent-a" },
    question: "Which evidence was checked by Agent A?",
    answer: "The primary source digest and declared currentness.",
    actor: { type: "agent", id: "agent-a" },
  });
  agentA = creationEngine.saveWorkspace(target, agentA);
  assert.doesNotThrow(() => creationEngine.saveWorkspace(target, agentA));

  agentB = creationEngine.recordInterviewAnswer(agentB, {
    operation_id: "interview:agent-b",
    recorded_against_semantic_revision: agentB.state.semantic_revision,
    recorded_against_semantic_digest: agentB.state.semantic_digest,
    subject: { type: "agent", id: "agent-b" },
    question: "Which evidence was checked by Agent B?",
    answer: "The represented-subject declaration.",
    actor: { type: "agent", id: "agent-b" },
  });
  assert.throws(
    () => creationEngine.saveWorkspace(target, agentB),
    (error) =>
      error.code === "CREATION_WORKSPACE_CONFLICT" &&
      /stale or diverges/.test(error.message),
  );

  let agentC = creationEngine.loadWorkspace(target);
  agentC = creationEngine.recordInterviewAnswer(agentC, {
    operation_id: "interview:agent-c",
    recorded_against_semantic_revision: agentC.state.semantic_revision,
    recorded_against_semantic_digest: agentC.state.semantic_digest,
    subject: { type: "agent", id: "agent-c" },
    question: "Can the current snapshot be extended?",
    answer: "Yes, because it retains the exact persisted history prefix.",
    actor: { type: "agent", id: "agent-c" },
  });
  const saved = creationEngine.saveWorkspace(target, agentC);
  assert.equal(saved.history.length, base.history.length + 2);
});

test("caller-supplied results never decide verified build state", () => {
  let workspace = acceptWorkspace(createPromotedWorkspace());
  const fixture = exactBuildFixture(workspace);
  fixture.receipt.results.semantic_round_trip = "fail";
  workspace = creationEngine.recordBuildReceipt(
    workspace,
    fixture.receipt,
    fixture.verification,
  );
  assert.equal(workspace.buildReceipt.status, "verified");
  assert.deepEqual(workspace.buildReceipt.results.semantic_round_trip, {
    status: "pass",
  });
  assert.equal(
    workspace.exportPlan.last_built_semantic_digest,
    workspace.state.semantic_digest,
  );
});

test("FORMAT_VALID fails closed without exact current Core-verified asset bytes", () => {
  const workspace = acceptWorkspace(createPromotedWorkspace());
  const fixture = exactBuildFixture(workspace);

  assert.throws(
    () => creationEngine.recordBuildReceipt(workspace, fixture.receipt),
    /requires the exact final \.kdna bytes/,
  );

  const replacedDigest = structuredClone(fixture.receipt);
  replacedDigest.asset_digest = `sha256:${"f".repeat(64)}`;
  replacedDigest.output.artifact_sha256 = replacedDigest.asset_digest;
  assert.throws(
    () =>
      creationEngine.recordBuildReceipt(
        workspace,
        replacedDigest,
        fixture.verification,
      ),
    /does not match the exact final \.kdna bytes/,
  );

  const plaintextShadow = Buffer.from(
    JSON.stringify(creationEngine.compileProject(workspace).project),
  );
  const plaintextDigest = `sha256:${crypto
    .createHash("sha256")
    .update(plaintextShadow)
    .digest("hex")}`;
  const callerPassedShadow = passingBuildReceipt(workspace, {
    semantic_revision: workspace.state.semantic_revision,
    asset_digest: plaintextDigest,
    output: {
      filename: "plaintext-shadow.kdna",
      artifact_sha256: plaintextDigest,
    },
  });
  assert.ok(
    creationEngine.VERIFICATION_STEPS.every(
      (step) => callerPassedShadow.results[step] === "pass",
    ),
  );
  assert.throws(
    () =>
      creationEngine.recordBuildReceipt(workspace, callerPassedShadow, {
        asset_bytes: plaintextShadow,
      }),
    (error) =>
      error.code === "CREATION_FORMAT_INVALID" &&
      /Core verification\/readback/.test(error.message),
  );

  let foreignWorkspace = creationEngine.createWorkspace(null, {
    mode: "agent-authored",
    workflowMode: "collaborative",
    createdBy: {
      type: "agent",
      id: "foreign-fixture-agent",
      name: "Foreign Fixture Agent",
    },
    version: "1.0.0",
    judgmentVersion: "1.0.0",
    access: "public",
  });
  foreignWorkspace = creationEngine.setPurpose(foreignWorkspace, {
    ...workspace.purposeBrief,
    title: "foreign-judgment",
    objective: "A different semantic objective that must not substitute.",
    represented_subject: {
      type: "agent",
      id: "foreign-fixture-agent",
      name: "Foreign Fixture Agent",
    },
  });
  foreignWorkspace = creationEngine.addCandidate(foreignWorkspace, {
    id: "candidate_foreign",
    statement: "Prefer an unrelated foreign judgment.",
    rationale: "This intentionally differs from the target workspace.",
    applies_when: ["A foreign scope is active."],
    does_not_apply_when: ["The target incident scope is active."],
    misuse_risk: "It could be confused with the target semantics.",
    source_refs: [],
    contrary_evidence: ["The target workspace declares another rule."],
    counterexample_search: {
      scope: "The hostile foreign workspace and target workspace.",
      method: "Compare their declared judgments.",
      result: "found",
      uncertainty: "No other workspaces were examined.",
    },
    confidence: {
      status: "high",
      score: 0.9,
      reason: "The hostile fixture is explicit.",
    },
    agent_inference: true,
    card_type: "axiom",
    fields: {},
  });
  const acceptedForeign = acceptWorkspace(
    creationEngine.promoteCandidate(foreignWorkspace, "candidate_foreign"),
  );
  const foreignFixture = exactBuildFixture(acceptedForeign);
  const crossWiredReceipt = {
    ...fixture.receipt,
    asset_digest: foreignFixture.receipt.asset_digest,
    output: {
      filename: "foreign-bytes.kdna",
      artifact_sha256: foreignFixture.receipt.asset_digest,
    },
  };
  assert.throws(
    () =>
      creationEngine.recordBuildReceipt(
        workspace,
        crossWiredReceipt,
        foreignFixture.verification,
      ),
    /semantic payload does not match/,
  );

  const recorded = creationEngine.recordBuildReceipt(
    workspace,
    fixture.receipt,
    fixture.verification,
  );
  assert.throws(
    () =>
      creationEngine.recordBuildReceipt(
        recorded,
        fixture.receipt,
        fixture.verification,
      ),
    /new distributed build must use a higher version/,
  );
});

test("semantic and metadata-only builds follow the release-pair rules", () => {
  let workspace = acceptWorkspace(createPromotedWorkspace());
  const acceptedRevision = workspace.state.semantic_revision;
  workspace = recordExactBuildReceipt(workspace);
  assert.equal(workspace.state.semantic_revision, acceptedRevision);
  assert.equal(workspace.exportPlan.version, "1.0.0");
  assert.equal(workspace.exportPlan.judgment_version, "1.0.0");

  workspace = creationEngine.updateExportPlan(workspace, {
    version: "1.0.1",
  });
  assert.equal(workspace.state.semantic_revision, acceptedRevision);
  assert.throws(
    () =>
      creationEngine.recordBuildReceipt(
        workspace,
        passingBuildReceipt(workspace, {
          version: "1.0.2",
          asset_digest: `sha256:${"c".repeat(64)}`,
        }),
      ),
    /does not match the current export plan/,
  );
  workspace = recordExactBuildReceipt(workspace);
  assert.equal(workspace.exportPlan.version, "1.0.1");
  assert.equal(workspace.exportPlan.judgment_version, "1.0.0");

  for (const version of ["1.0.0", "0.99.99", "1.0.1+rebuilt"]) {
    assert.throws(
      () => creationEngine.updateExportPlan(workspace, { version }),
      /requires a higher distributed version/,
    );
  }
  assert.equal(
    creationEngine.updateExportPlan(workspace, {
      version: "1.0.2-rc.1",
    }).exportPlan.version,
    "1.0.2-rc.1",
  );
  const farFuturePlan = creationEngine.updateExportPlan(workspace, {
    version: "9.0.0",
  });
  assert.throws(
    () =>
      creationEngine.updateExportPlan(farFuturePlan, {
        version: "8.0.0",
      }),
    /requires a higher distributed version/,
  );

  workspace = creationEngine.buildRepairPlan(workspace, {
    items: [
      {
        id: "repair_after_build",
        kind: "semantic_clarity",
        target: { type: "unit", id: workspace.judgmentModel.units[0].id },
        problem: "Clarify the semantic rule.",
        recommended_change: "Make evidence preservation explicit.",
      },
    ],
  });
  workspace = creationEngine.applyRepair(workspace, "repair_after_build", {
    resolution: "The semantic rule now names evidence preservation.",
    target: { type: "unit", id: workspace.judgmentModel.units[0].id },
    changes: {
      statement:
        "Prefer reversible containment that preserves diagnostic evidence.",
    },
  });
  assert.equal(workspace.exportPlan.version, "1.0.2");
  assert.equal(workspace.exportPlan.judgment_version, "1.0.1");
  assert.equal(workspace.exportPlan.pending_judgment_change, true);
  assert.throws(
    () =>
      creationEngine.updateExportPlan(workspace, {
        version: workspace.exportPlan.last_built_version,
      }),
    /requires a higher distributed version/,
  );
});

test("build receipts reject raw private material and secret-shaped fields", () => {
  const workspace = acceptWorkspace(createPromotedWorkspace());
  assert.throws(
    () =>
      creationEngine.recordBuildReceipt(
        workspace,
        passingBuildReceipt(workspace, {
          raw_content: "private source text",
        }),
      ),
    /forbidden secret\/private content/,
  );
  assert.throws(
    () =>
      creationEngine.recordBuildReceipt(
        workspace,
        passingBuildReceipt(workspace, {
          tool_coordinates: { password: "not-allowed" },
        }),
      ),
    /forbidden secret\/private content/,
  );
  assert.throws(
    () =>
      creationEngine.recordBuildReceipt(
        workspace,
        passingBuildReceipt(workspace, {
          note: "an arbitrary value has no place in the canonical receipt",
        }),
      ),
    /unsupported fields: note/,
  );
  const nestedNote = passingBuildReceipt(workspace);
  nestedNote.results.validate = {
    status: "pass",
    note: "arbitrary result text is not persisted",
  };
  assert.throws(
    () => creationEngine.recordBuildReceipt(workspace, nestedNote),
    /receipt\.results\.validate contains unsupported fields: note/,
  );
  const coordinateNote = passingBuildReceipt(workspace);
  coordinateNote.tool_coordinates.studio_core = {
    package: "@aikdna/kdna-studio-core",
    version: "3.0.0",
    distribution: "installed-package",
    note: "not part of a package coordinate",
  };
  assert.throws(
    () => creationEngine.recordBuildReceipt(workspace, coordinateNote),
    /tool_coordinates\.studio_core contains unsupported fields: note/,
  );
});
