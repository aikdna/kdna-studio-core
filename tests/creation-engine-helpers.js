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
  'human-confirmed': { type: 'human', id: 'expert-001', name: 'Named Expert' },
  'organization-confirmed': {
    type: 'organization',
    id: 'organization-001',
    name: 'Named Organization',
  },
  interpretive: { type: 'work', id: 'source-work-001', name: 'Named Source Work' },
  'mixed-authorship': null,
});

const MATERIAL_SUBJECTS = Object.freeze({
  ...MODE_SUBJECTS,
});

function purposeFor(mode) {
  return {
    title: 'incident-triage',
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
    counterexample_search: {
      scope: 'Declared incident-triage scope and its urgent safety boundary.',
      method: 'Review a reversible case and an urgent irreversible counterexample.',
      result: 'found',
      uncertainty: 'Scenarios outside the declared incident scope were not evaluated.',
    },
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
    workflowMode: options.workflowMode || 'collaborative',
    createdBy: options.createdBy ||
      { type: 'agent', id: 'fixture-agent', name: 'Fixture Agent' },
    version: options.version || '1.0.0',
    judgmentVersion: options.judgmentVersion || '1.0.0',
    access: options.access || 'public',
  });
  workspace = creationEngine.setPurpose(workspace, purposeFor(mode));

  const sourceRequired = ![
    'agent-authored',
    'mixed-authorship',
  ].includes(mode) || options.withMaterial;
  if (sourceRequired) {
    workspace = creationEngine.ingestMaterial(workspace, {
      id: 'source_primary',
      kind: 'interview',
      title: 'Primary source',
      content: 'Preserve evidence and reversibility while the failure mode remains uncertain.',
      authority: 'current-highest',
      currentness: 'current',
      sensitivity: 'private',
      source_subject_id: MATERIAL_SUBJECTS[mode].id,
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
  if (workspace.state.mode === 'mixed-authorship') {
    return creationEngine.recordConfirmation(workspace, {
      claim: 'participation',
      participation_role: 'judgment-content-contribution',
      actor: { type: 'human', id: 'participant-001' },
      subject: { type: 'human', id: 'participant-001' },
      scope: 'model',
      statement: 'I participated in reviewing this semantic revision.',
      contribution: {
        description:
          'The human participant materially selected the promoted judgment content.',
        unit_ids: workspace.judgmentModel.units.map((unit) => unit.id),
        confirmed_final_semantics: true,
      },
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

function freezeSemanticCases(
  workspace,
  definitions,
  options = {},
) {
  let next = workspace;
  for (const definition of definitions) {
    next = creationEngine.addSemanticTest(next, definition);
  }
  return creationEngine.freezeSemanticTestPlan(next, {
    id: options.planId || 'semantic-plan-frozen-cases',
    actor:
      options.evaluator ||
      {
        type: 'agent',
        id: 'independent-evaluator-agent',
        authority: 'independent-agent-evaluator',
      },
    statement:
      options.statement ||
      'The semantic cases and risk-stratified coverage were frozen before evaluation.',
    ...(options.coveragePolicy
      ? { coverage_policy: options.coveragePolicy }
      : {}),
  });
}

function acceptWorkspace(workspace, options = {}) {
  let next = addModeConfirmation(workspace);
  const idSuffix = options.idSuffix ? `_${options.idSuffix}` : '';
  const unitIds = next.judgmentModel.units.map((unit) => unit.id);
  const evaluator = ['agent-authored', 'mixed-authorship'].includes(
    next.state.mode,
  )
    ? {
      type: 'agent',
      id: 'independent-evaluator-agent',
      authority: 'independent-agent-evaluator',
    }
    : next.state.mode === 'interpretive'
      ? {
        type: 'agent',
        id: 'independent-interpretive-evaluator',
        authority: 'independent-interpretive-evaluator',
      }
      : { type: 'human', id: 'evaluator-001' };
  const definitions = [];
  for (const unitId of unitIds) {
    definitions.push({
      id: `test_applicable_${unitId}${idSuffix}`,
      kind: 'applicable',
      input: 'A service is degraded and the cause remains uncertain.',
      expected: 'Apply the bounded judgment.',
      unit_ids: [unitId],
    });
    definitions.push({
      id: `test_counterexample_${unitId}${idSuffix}`,
      kind: 'counterexample',
      input: 'The task is outside incident triage.',
      expected: 'Do not apply the judgment.',
      unit_ids: [unitId],
    });
  }
  for (const boundary of next.judgmentModel.global_boundaries) {
    definitions.push({
      id: `test_${boundary.id}${idSuffix}`,
      kind: 'boundary',
      input: 'A task reaches the declared global boundary.',
      expected: boundary.statement,
      boundary_ids: [boundary.id],
    });
  }
  for (const relation of next.judgmentModel.relations.filter(
    (item) =>
      ['exception', 'priority', 'conflict'].includes(item.type) &&
      ['accepted', 'resolved'].includes(item.status),
  )) {
    definitions.push({
      id: `test_relation_${relation.id}${idSuffix}`,
      kind: 'conflict',
      input:
        'A task activates the declared relation between two judgments.',
      expected:
        'Apply the declared relation without inventing a broader ordering.',
      relation_ids: [relation.id],
    });
  }
  if (['human-confirmed', 'organization-confirmed'].includes(next.state.mode)) {
    definitions.push({
      id: `test_holdout_real_task${idSuffix}`,
      kind: 'holdout',
      input: 'A held-out incident asks for the next bounded action.',
      expected: 'Choose a reversible action and preserve evidence.',
      held_out: true,
      source_ref: 'source_primary',
    });
  }
  definitions.push(...(options.extraDefinitions || []));
  for (const definition of definitions) {
    next = creationEngine.addSemanticTest(next, definition);
  }
  next = creationEngine.freezeSemanticTestPlan(next, {
    id: `semantic-plan${idSuffix || '_default'}`,
    actor: evaluator,
    statement:
      'The semantic tasks and risk-stratified coverage were frozen before evaluation.',
  });
  const lastId = definitions.at(-1).id;
  for (const definition of definitions) {
    next = creationEngine.recordSemanticTestResult(next, definition.id, {
      result: 'pass',
      evaluated_by: evaluator,
      notes: 'Observed output matched the declared expectation.',
      ...(definition.id === lastId
        ? {
            acceptance: {
              accepted: true,
              actor: evaluator,
              statement:
                'The semantic tests are sufficient for the declared scope.',
            },
          }
        : {}),
    });
  }
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
  freezeSemanticCases,
  acceptWorkspace,
  passingBuildReceipt,
  exactBuildFixture,
  recordExactBuildReceipt,
};
