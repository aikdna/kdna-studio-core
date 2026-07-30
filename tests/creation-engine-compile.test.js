'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const creationEngine = require('../src/creation-engine');
const { compileDomain } = require('../src/compile');
const { buildPayload, exportRuntimeAsset } = require('../src/export-runtime');
const {
  candidateFor,
  createPromotedWorkspace,
  acceptWorkspace,
  addPassingCase,
} = require('./creation-engine-helpers');

const allTypesFixture = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'fixtures', 'creation-engine', 'all-card-types.json'),
  'utf8',
));

function collectIds(value, result = new Set()) {
  if (!value || typeof value !== 'object') return result;
  if (!Array.isArray(value) && typeof value.id === 'string') result.add(value.id);
  for (const child of Object.values(value)) collectIds(child, result);
  return result;
}

function collectLeafStrings(value, result = []) {
  if (typeof value === 'string') {
    result.push(value);
    return result;
  }
  if (!value || typeof value !== 'object') return result;
  for (const child of Object.values(value)) collectLeafStrings(child, result);
  return result;
}

test('compileProject preserves judgment core, relations, load condition, and honest authorship', () => {
  let workspace = createPromotedWorkspace('interpretive');
  workspace = creationEngine.addCandidate(workspace, candidateFor({
    id: 'candidate_exception',
    sourceRefs: ['source_primary'],
    agentInference: false,
    cardType: 'boundary',
  }));
  workspace = creationEngine.promoteCandidate(workspace, 'candidate_exception');
  const [first, second] = workspace.judgmentModel.units;
  workspace = creationEngine.analyzeRelations(workspace, {
    relations: [{
      id: 'relation_exception',
      type: 'exception',
      from: second.id,
      to: first.id,
      rationale: 'The boundary is an explicit exception to the axiom.',
      status: 'accepted',
    }],
  });
  workspace = acceptWorkspace(workspace);

  const { project } = creationEngine.compileProject(workspace);
  assert.deepEqual(project.judgment_core, workspace.judgmentModel.judgment_core);
  assert.equal(project.distillation_target.load_condition, workspace.purposeBrief.loading_condition);
  assert.deepEqual(
    project.distillation_target.exclude_areas,
    [...new Set([
      ...workspace.purposeBrief.non_goals,
      ...workspace.judgmentModel.global_boundaries.map(
        (boundary) => boundary.statement,
      ),
    ])],
  );
  assert.deepEqual(project.source_core_structure, [{
    from: second.id,
    to: first.id,
    via: 'exception',
  }]);
  assert.equal(project.author.id, workspace.state.created_by.id);
  assert.ok(project.cards.every((card) => card.locked === true));
  assert.ok(project.cards.every((card) => card.human_lock === null));

  const compiled = compileDomain(project, { strictAuthority: false });
  const payload = buildPayload(compiled);
  assert.equal(
    Object.hasOwn(payload.core, 'load_condition'),
    false,
    'private Creation loading conditions do not expand the public Runtime payload',
  );
  assert.equal(
    payload.core.highest_question,
    workspace.purposeBrief.highest_question,
  );
  assert.deepEqual(payload.core.core_structure, project.source_core_structure);
  assert.equal(
    collectLeafStrings(payload).includes(
      'The boundary is an explicit exception to the axiom.',
    ),
    false,
    'private relation rationale must not enter the Runtime payload',
  );
  const exported = exportRuntimeAsset(project, {
    asset_id: 'kdna:fixture:creation-mode-round-trip',
    timestamp: '2026-07-28T00:00:00.000Z',
  });
  assert.equal(
    collectLeafStrings(exported).includes(
      'The boundary is an explicit exception to the axiom.',
    ),
    false,
    'private relation rationale must not enter exported Runtime files',
  );
  assert.equal(
    Object.hasOwn(exported.manifest.authoring, 'creation_mode'),
    false,
    'Creation source mode stays in private creation evidence',
  );
});

test('compileDomain rejects unknown, private, and malformed Runtime relations', () => {
  const workspace = acceptWorkspace(createPromotedWorkspace('interpretive'));
  const { project } = creationEngine.compileProject(workspace);
  const invalidRelations = [
    [{ from: 'judgment-a', to: 'judgment-b', via: 'support' }],
    [{
      from: 'judgment-a',
      to: 'judgment-b',
      via: 'priority',
      rationale: 'Private Creation evidence must stay private.',
    }],
    [{ from: '', to: 'judgment-b', via: 'priority' }],
    [{ from: 'judgment-a', to: 'judgment-b', via: 'exception', applies_when: [''] }],
    ['priority'],
  ];

  for (const coreStructure of invalidRelations) {
    const hostileProject = structuredClone(project);
    hostileProject.source_core_structure = coreStructure;
    assert.throws(
      () => compileDomain(hostileProject, { strictAuthority: false }),
      (error) => error.code === 'INVALID_RUNTIME_RELATION',
    );
  }
});

test('declared human and organization confirmation cannot become Runtime identity evidence', () => {
  for (const mode of ['human-confirmed', 'organization-confirmed']) {
    const unconfirmed = createPromotedWorkspace(mode);
    assert.equal(creationEngine.assessReadiness(unconfirmed).creation_accepted, false);
    assert.throws(
      () => creationEngine.compileProject(unconfirmed),
      (error) => error.code === 'CREATION_NOT_ACCEPTED',
    );

    const workspace = acceptWorkspace(unconfirmed);
    const confirmationIds = workspace.confirmationReceipts.map((receipt) => receipt.id);
    assert.ok(confirmationIds.length > 0);
    const { project } = creationEngine.compileProject(workspace);
    assert.equal(project.author.id, workspace.state.created_by.id);
    assert.notEqual(project.author.id, workspace.purposeBrief.represented_subject.id);
    assert.ok(project.cards.every((card) => card.human_lock === null));

    const exported = exportRuntimeAsset(project, {
      asset_id: `kdna:fixture:declared-${mode}-is-not-runtime-proof`,
      timestamp: '2026-07-28T00:00:00.000Z',
    });
    assert.deepEqual(exported.manifest.creator, {
      name: workspace.state.created_by.name,
      id: workspace.state.created_by.id,
    });
    assert.equal(exported.manifest.authoring.human_lock_count, 0);
    assert.equal(exported.manifest.authoring.human_confirmed, false);

    const runtimeText = [
      exported.files['kdna.json'],
      JSON.stringify(exported.payload),
    ].join('\n');
    const receiptMarkers = workspace.confirmationReceipts.flatMap((receipt) => [
      receipt.id,
      receipt.actor.id,
      receipt.actor.authority,
    ]).filter(Boolean);
    for (const forbidden of [
      workspace.purposeBrief.represented_subject.id,
      ...confirmationIds,
      ...receiptMarkers,
      'confirmation_receipt_ids',
      'creation_acceptance',
      'creation_mode',
      'semantic_revision',
      'represented_subject',
    ]) {
      assert.ok(
        !runtimeText.includes(forbidden),
        `${mode} Runtime leaked private marker: ${forbidden}`,
      );
    }
  }
});

test('non-Agent createdBy declarations are omitted from Runtime creator provenance', () => {
  for (const type of ['human', 'organization']) {
    const workspace = acceptWorkspace(createPromotedWorkspace('interpretive', {
      createdBy: {
        type,
        id: `declared-${type}-creator`,
        name: `Declared ${type} creator`,
      },
    }));
    const { project } = creationEngine.compileProject(workspace);
    assert.deepEqual(project.author, { name: '', id: '' });
    const exported = exportRuntimeAsset(project, {
      asset_id: `kdna:fixture:private-${type}-creator`,
      timestamp: '2026-07-28T00:00:00.000Z',
    });
    assert.equal(Object.hasOwn(exported.manifest, 'creator'), false);
    assert.ok(!exported.files['kdna.json'].includes(`declared-${type}-creator`));
  }
});

test('support, limit, and resolved conflict stay in creation evidence instead of Runtime relations', () => {
  let workspace = createPromotedWorkspace();
  workspace = creationEngine.addCandidate(workspace, candidateFor({
    id: 'candidate_evidence_relation',
    cardType: 'risk',
    agentInference: true,
  }));
  workspace = creationEngine.promoteCandidate(
    workspace,
    'candidate_evidence_relation',
  );
  const [first, second] = workspace.judgmentModel.units;
  workspace = creationEngine.analyzeRelations(workspace, {
    relations: [
      {
        id: 'relation_support_evidence',
        type: 'support',
        from: first.id,
        to: second.id,
        rationale: 'This is explanatory evidence, not Runtime precedence.',
        status: 'accepted',
      },
      {
        id: 'relation_limit_evidence',
        type: 'limit',
        from: second.id,
        to: first.id,
        rationale: 'This remains an authoring note until a real case admits it.',
        status: 'accepted',
      },
      {
        id: 'relation_resolved_conflict',
        type: 'conflict',
        from: first.id,
        to: second.id,
        rationale: 'The authoring conflict was resolved outside Runtime.',
        status: 'resolved',
        resolution: 'The judgments were rewritten so the conflict no longer applies.',
      },
    ],
  });
  workspace = acceptWorkspace(workspace);

  const { project } = creationEngine.compileProject(workspace);
  assert.deepEqual(project.source_core_structure, []);
  assert.equal(workspace.judgmentModel.relations.length, 3);
});

test('private source bodies and source paths never enter project or Runtime payload', () => {
  let workspace = createPromotedWorkspace('interpretive');
  const privateBody = 'PRIVATE-BODY-MUST-NOT-ENTER-RUNTIME';
  workspace = creationEngine.ingestMaterial(workspace, {
    id: 'source_private_second',
    kind: 'document',
    title: 'Private second source',
    content: privateBody,
    reference: '/private/source/path.md',
    authority: 'supporting',
    currentness: 'current',
    sensitivity: 'sensitive',
    in_scope: true,
  });
  const sensitiveQuestion = workspace.unresolvedQuestions.find(
    (item) => item.kind === 'source_safety_sensitive_public',
  );
  workspace = creationEngine.recordInterviewAnswer(workspace, {
    question_id: sensitiveQuestion.id,
    question: sensitiveQuestion.reason,
    answer: 'Use only the abstract judgment and exclude all source detail.',
    by: 'reviewer-001',
    source_disposition: {
      source_id: 'source_private_second',
      decision: 'public-safe-abstraction',
      reviewer: 'reviewer-001',
      rationale: 'The compiled unit contains no source body, quote, or private reference.',
    },
  });
  workspace = acceptWorkspace(workspace);
  const { project } = creationEngine.compileProject(workspace);
  const projectBytes = JSON.stringify(project);
  assert.ok(!projectBytes.includes(privateBody));
  assert.ok(!projectBytes.includes('/private/source/path.md'));
  const exported = exportRuntimeAsset(project, {
    asset_id: 'kdna:fixture:creation-private-isolation',
    timestamp: '2026-07-28T00:00:00.000Z',
  });
  const payloadBytes = JSON.stringify(exported.payload);
  assert.ok(!payloadBytes.includes(privateBody));
  assert.ok(!payloadBytes.includes('/private/source/path.md'));
});

test('all sixteen card types preserve identities and type-specific fields through Runtime projection', () => {
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

  const evaluator = { type: 'agent', id: workspace.state.created_by.id };
  for (const unit of workspace.judgmentModel.units) {
    workspace = addPassingCase(workspace, {
      id: `test_applicable_${unit.id}`,
      kind: 'applicable',
      input: `Applicable input for ${unit.card_type}.`,
      expected: 'Apply the unit.',
      unit_ids: [unit.id],
    }, { evaluator });
    workspace = addPassingCase(workspace, {
      id: `test_counterexample_${unit.id}`,
      kind: 'counterexample',
      input: `Counterexample for ${unit.card_type}.`,
      expected: 'Do not apply the unit.',
      unit_ids: [unit.id],
    }, { evaluator });
  }
  workspace = addPassingCase(workspace, {
    id: 'test_boundary_no_secrets',
    kind: 'boundary',
    input: 'A secret is present.',
    expected: 'Do not reveal it.',
    boundary_ids: ['boundary_no_secrets'],
  }, { evaluator });
  workspace = creationEngine.recordSemanticTestResult(
    workspace,
    'test_boundary_no_secrets',
    {
      result: 'pass',
      evaluated_by: evaluator,
      acceptance: {
        accepted: true,
        actor: evaluator,
        statement: 'All sixteen card-type projections passed.',
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
    assert.ok(projectedIds.has(unit.id), `${unit.card_type} lost id ${unit.id}`);
  }
  const payloadText = JSON.stringify(payload);
  for (const marker of collectLeafStrings(allTypesFixture.fields_by_type)) {
    assert.ok(
      payloadText.includes(JSON.stringify(marker).slice(1, -1)),
      `Runtime payload lost type-specific field value ${marker}`,
    );
  }
});
