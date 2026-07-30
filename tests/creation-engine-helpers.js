'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const kdnaCore = require('@aikdna/kdna-core');
const creationEngine = require('../src/creation-engine');
const { exportRuntimeAsset } = require('../src/export-runtime');

const MODE_SUBJECTS = Object.freeze({
  'agent-authored': { type: 'agent', id: 'fixture-agent', name: 'Fixture Agent' },
  'human-assisted': { type: 'human', id: 'participant-001', name: 'Participant' },
  'human-confirmed': { type: 'human', id: 'expert-001', name: 'Named Expert' },
  'organization-confirmed': {
    type: 'organization',
    id: 'organization-001',
    name: 'Named Organization',
  },
  interpretive: { type: 'work', id: 'source-work-001', name: 'Named Source Work' },
});

function purposeFor(mode) {
  return {
    title: `${mode}-incident-triage`,
    objective: 'Prioritize reversible incident actions before speculative repair.',
    scope: 'service incident triage',
    non_goals: ['Never reveal credentials or private source content.'],
    loading_condition: 'Load when choosing the next action in a service incident.',
    represented_subject: MODE_SUBJECTS[mode],
    highest_question: 'Which action reduces irreversible harm while preserving diagnosis?',
    worldview: ['Observed system state remains authoritative.'],
    value_order: ['prevent irreversible harm', 'preserve diagnostic evidence'],
    judgment_role: {
      acts_as: 'a scoped incident-triage judgment authority',
      does_not_act_as: ['a monitoring data source'],
      responsibility: 'Order qualitative tradeoffs inside incident triage.',
    },
    global_boundaries: [{
      id: 'boundary_no_secrets',
      statement: 'Never reveal credentials or private source content.',
      source_refs: [],
    }],
  };
}

function candidateFor({
  id = 'candidate_reversible_first',
  cardType = 'axiom',
  sourceRefs,
  agentInference,
}) {
  return {
    id,
    statement: `${cardType}: prefer a bounded judgment inside the declared scope`,
    rationale: 'The bounded choice preserves evidence, reversibility, and declared authority.',
    applies_when: ['The declared incident-triage domain is active.'],
    does_not_apply_when: ['The task is outside incident triage.'],
    misuse_risk: 'May be applied outside the declared loading condition.',
    source_refs: sourceRefs,
    contrary_evidence: [
      'Immediate safety intervention may outweigh reversibility and requires explicit boundary review.',
    ],
    confidence: {
      status: 'high',
      score: 0.95,
      reason: 'The rule, rationale, and exception are explicit.',
    },
    agent_inference: agentInference,
    card_type: cardType,
    fields: {},
  };
}

function createPromotedWorkspace(mode = 'agent-authored', options = {}) {
  let workspace = creationEngine.createWorkspace(null, {
    mode,
    createdBy: options.createdBy ||
      { type: 'agent', id: 'fixture-agent', name: 'Fixture Agent' },
    version: options.version || '1.0.0',
    judgmentVersion: options.judgmentVersion || '1.0.0',
    access: options.access || 'public',
  });
  workspace = creationEngine.setPurpose(workspace, purposeFor(mode));

  const sourceRequired = mode !== 'agent-authored' || options.withMaterial;
  if (sourceRequired) {
    workspace = creationEngine.ingestMaterial(workspace, {
      id: 'source_primary',
      kind: 'interview',
      title: 'Primary source',
      content: 'Preserve evidence and reversibility while the failure mode remains uncertain.',
      authority: 'current-highest',
      currentness: 'current',
      sensitivity: 'private',
      source_subject_id: MODE_SUBJECTS[mode].id,
      belongs_to_subject: true,
      represents_current_judgment: true,
      in_scope: true,
    });
  }

  workspace = creationEngine.addCandidate(workspace, candidateFor({
    sourceRefs: sourceRequired ? ['source_primary'] : undefined,
    agentInference: !sourceRequired,
  }));
  workspace = creationEngine.promoteCandidate(workspace, 'candidate_reversible_first');
  return workspace;
}

function addModeConfirmation(workspace) {
  if (workspace.state.mode === 'human-assisted') {
    return creationEngine.recordConfirmation(workspace, {
      claim: 'participation',
      actor: { type: 'human', id: 'participant-001' },
      subject: { type: 'human', id: 'participant-001' },
      scope: 'model',
      statement: 'I participated in reviewing this semantic revision.',
    });
  }
  if (workspace.state.mode === 'human-confirmed') {
    return creationEngine.recordConfirmation(workspace, {
      claim: 'representation',
      actor: { type: 'human', id: 'expert-001' },
      subject: { type: 'human', id: 'expert-001' },
      scope: 'model',
      statement: 'I confirm this semantic revision represents my judgment.',
    });
  }
  if (workspace.state.mode === 'organization-confirmed') {
    return creationEngine.recordConfirmation(workspace, {
      claim: 'representation',
      actor: {
        type: 'organization-authority',
        id: 'approver-001',
        authority: 'Incident Review Board delegate',
      },
      subject: { type: 'organization', id: 'organization-001' },
      scope: 'model',
      statement: 'I am authorized to confirm this semantic revision for the organization.',
    });
  }
  return workspace;
}

function addPassingCase(workspace, input, options = {}) {
  let next = creationEngine.addSemanticTest(workspace, input);
  next = creationEngine.recordSemanticTestResult(next, input.id, {
    result: 'pass',
    ...(input.expected_creator_label
      ? { observed_creator_label: input.expected_creator_label }
      : {}),
    evaluated_by: options.evaluator || { type: 'human', id: 'evaluator-001' },
    notes: 'Observed output matched the declared expectation.',
  });
  return next;
}

function acceptWorkspace(workspace) {
  let next = addModeConfirmation(workspace);
  const unitIds = next.judgmentModel.units.map((unit) => unit.id);
  const evaluator = next.state.mode === 'agent-authored'
    ? { type: 'agent', id: next.state.created_by.id }
    : { type: 'human', id: 'evaluator-001' };
  for (const unitId of unitIds) {
    next = addPassingCase(next, {
      id: `test_applicable_${unitId}`,
      kind: 'applicable',
      input: 'A service is degraded and the cause remains uncertain.',
      expected: 'Apply the bounded judgment.',
      unit_ids: [unitId],
    }, { evaluator });
    next = addPassingCase(next, {
      id: `test_counterexample_${unitId}`,
      kind: 'counterexample',
      input: 'The task is outside incident triage.',
      expected: 'Do not apply the judgment.',
      unit_ids: [unitId],
    }, { evaluator });
  }
  next = addPassingCase(next, {
    id: 'test_boundary_no_secrets',
    kind: 'boundary',
    input: 'A diagnostic note contains a credential.',
    expected: 'Do not reveal the credential.',
    boundary_ids: ['boundary_no_secrets'],
  }, { evaluator });
  if (['human-confirmed', 'organization-confirmed'].includes(next.state.mode)) {
    next = addPassingCase(next, {
      id: 'test_holdout_real_task',
      kind: 'holdout',
      input: 'A held-out incident asks for the next bounded action.',
      expected: 'Choose a reversible action and preserve evidence.',
      held_out: true,
      source_ref: 'source_primary',
    }, { evaluator });
  }
  const lastId = ['human-confirmed', 'organization-confirmed'].includes(next.state.mode)
    ? 'test_holdout_real_task'
    : 'test_boundary_no_secrets';
  next = creationEngine.recordSemanticTestResult(next, lastId, {
    result: 'pass',
    evaluated_by: evaluator,
    notes: 'Acceptance was recorded after the complete test set passed.',
    acceptance: {
      accepted: true,
      actor: evaluator,
      statement: 'The semantic tests are sufficient for the declared scope.',
    },
  });
  return next;
}

function passingBuildReceipt(workspace, overrides = {}) {
  return {
    semantic_digest: workspace.state.semantic_digest,
    asset_digest: `sha256:${'a'.repeat(64)}`,
    version: workspace.exportPlan.version,
    judgment_version: workspace.exportPlan.judgment_version,
    tool_coordinates: {
      studio_core: '@aikdna/kdna-studio-core@3.0.0',
      core: '@aikdna/kdna-core@0.21.0',
    },
    results: {
      validate: 'pass',
      inspect: 'pass',
      plan_load: 'pass',
      load_compact: 'pass',
      load_full: 'pass',
      reimport: 'pass',
      semantic_round_trip: 'pass',
    },
    ...overrides,
  };
}

function exactBuildFixture(workspace, overrides = {}, options = {}) {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'creation-build-fixture-'),
  );
  try {
    const source = path.join(temporary, 'source');
    const output = path.join(temporary, 'fixture.kdna');
    fs.mkdirSync(source, { recursive: true });
    const exported = exportRuntimeAsset(
      creationEngine.compileProject(workspace).project,
      options.password ? { password: options.password } : {},
    );
    for (const [name, content] of Object.entries(exported.files)) {
      fs.writeFileSync(path.join(source, name), content);
    }
    kdnaCore.pack(source, output);
    const assetBytes = fs.readFileSync(output);
    const assetDigest = `sha256:${crypto
      .createHash('sha256')
      .update(assetBytes)
      .digest('hex')}`;
    return {
      receipt: passingBuildReceipt(workspace, {
        semantic_revision: workspace.state.semantic_revision,
        asset_digest: assetDigest,
        output: {
          filename: 'fixture.kdna',
          artifact_sha256: assetDigest,
        },
        ...overrides,
      }),
      verification: {
        asset_bytes: assetBytes,
        ...(options.password ? { password: options.password } : {}),
      },
    };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function recordExactBuildReceipt(workspace, overrides = {}, options = {}) {
  const fixture = exactBuildFixture(workspace, overrides, options);
  return creationEngine.recordBuildReceipt(
    workspace,
    fixture.receipt,
    fixture.verification,
  );
}

module.exports = {
  MODE_SUBJECTS,
  purposeFor,
  candidateFor,
  createPromotedWorkspace,
  addModeConfirmation,
  addPassingCase,
  acceptWorkspace,
  passingBuildReceipt,
  exactBuildFixture,
  recordExactBuildReceipt,
};
