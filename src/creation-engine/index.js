'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');

const { createProject } = require('../project');
const { CARD_TYPES } = require('../project-schema');
const { exportRuntimeAsset } = require('../export-runtime');
const {
  deterministicBootstrapLower,
} = require('./application-metrics');
const CREATION_WORKSPACE_SCHEMA = require('../../schemas/creation-workspace.schema.json');
const RUNTIME_CORE = require('@aikdna/kdna-core');
const RUNTIME_CORE_PACKAGE = require('@aikdna/kdna-core/package.json');

const SCHEMA_VERSION = '0.1.0';

const CREATION_MODES = Object.freeze([
  'agent-authored',
  'human-assisted',
  'human-confirmed',
  'organization-confirmed',
  'interpretive',
]);

const WORKFLOW_MODES = Object.freeze([
  'collaborative',
  'autonomous',
]);

const CREATION_STATES = Object.freeze([
  'needs_purpose',
  'needs_sources',
  'analyzing_sources',
  'eliciting_judgment',
  'awaiting_confirmation',
  'testing',
  'repairing',
  'ready_to_export',
  'exported',
]);

const RELATION_TYPES = Object.freeze([
  'support',
  'limit',
  'exception',
  'conflict',
  'priority',
]);

const RUNTIME_RELATION_TYPES = Object.freeze([
  'exception',
  'priority',
]);

const SOURCE_AUTHORITIES = Object.freeze([
  'current-highest',
  'supporting',
  'historical',
  'negative',
  'rejected',
  'unknown',
]);

const SEMANTIC_TEST_KINDS = Object.freeze([
  'applicable',
  'counterexample',
  'boundary',
  'conflict',
  'comparison',
  'holdout',
]);

const CANDIDATE_REVIEW_FIELDS = Object.freeze([
  'statement',
  'rationale',
  'applies_when',
  'does_not_apply_when',
  'misuse_risk',
  'source_refs',
  'contrary_evidence',
  'confidence',
  'agent_inference',
  'card_type',
  'fields',
]);

const ARTIFACT_FILES = Object.freeze([
  'creation-state.json',
  'purpose-brief.json',
  'materials-index.json',
  'candidate-judgments.json',
  'judgment-model.json',
  'unresolved-questions.json',
  'confirmation-receipts.json',
  'semantic-test-report.json',
  'repair-plan.json',
  'export-plan.json',
  'build-receipt.json',
]);

const VERIFICATION_STEPS = Object.freeze([
  'validate',
  'inspect',
  'plan_load',
  'load_compact',
  'load_full',
  'reimport',
  'semantic_round_trip',
]);

const APPLICATION_ABANDONMENT_CLOCK_TOLERANCE_MS = 5 * 60 * 1000;

const PROMPT_INJECTION_PATTERNS = Object.freeze([
  {
    code: 'instruction-override',
    pattern: /ignore (all|any|the|your) previous instructions/i,
  },
  { code: 'system-prompt-reference', pattern: /system prompt/i },
  { code: 'developer-message-reference', pattern: /developer message/i },
  { code: 'identity-reassignment', pattern: /you are now/i },
  { code: 'instruction-refusal', pattern: /do not follow/i },
  {
    code: 'secret-disclosure-request',
    pattern: /reveal (the )?(prompt|secret|credential)/i,
  },
  {
    code: 'instruction-override',
    pattern: /忽略.{0,12}(之前|以上|先前).{0,8}(指令|要求|提示)/,
  },
  { code: 'system-prompt-reference', pattern: /系统提示词/ },
  { code: 'developer-message-reference', pattern: /开发者消息/ },
  {
    code: 'secret-disclosure-request',
    pattern: /泄露.{0,8}(密码|密钥|凭证|提示词)/,
  },
]);

const SENSITIVE_PATTERNS = Object.freeze([
  /medical condition|mental health|diagnosis|bank account|sexual orientation|political affiliation/i,
  /疾病|病史|诊断|心理疾病|银行卡号|账户余额|政治立场|性取向/,
]);

const workspaceSchemaValidator = (() => {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(CREATION_WORKSPACE_SCHEMA);
})();

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function now() {
  return new Date().toISOString();
}

function id(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function nonEmpty(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function optionalString(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function optionalDateTime(value, label) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be an ISO date-time or null`);
  }
  return value;
}

function assertCanonicalUtcDateTime(value, label) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be a canonical UTC date-time`);
  }
  const parsed = new Date(value);
  if (parsed.toISOString() !== value) {
    throw new Error(`${label} must be a canonical UTC date-time`);
  }
  return value;
}

function stringList(value, label, options = {}) {
  const source = value === undefined || value === null
    ? []
    : (Array.isArray(value) ? value : [value]);
  const result = source
    .map((item) => String(item).trim())
    .filter(Boolean);
  if (options.required && result.length === 0) {
    throw new Error(`${label} requires at least one non-empty value`);
  }
  return [...new Set(result)];
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function stableStringify(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
  return `{${entries.join(',')}}`;
}

function sha256(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function assertDigest(value, label) {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} must be a sha256 digest`);
  }
  return value;
}

function semanticUnit(unit) {
  return {
    id: unit.id,
    candidate_id: unit.candidate_id,
    card_type: unit.card_type,
    statement: unit.statement,
    rationale: unit.rationale,
    applies_when: unit.applies_when,
    does_not_apply_when: unit.does_not_apply_when,
    misuse_risk: unit.misuse_risk,
    source_refs: unit.source_refs,
    contrary_evidence: unit.contrary_evidence,
    confidence: unit.confidence,
    agent_inference: unit.agent_inference,
    fields: unit.fields,
  };
}

function semanticMaterial(material) {
  return {
    id: material.id,
    kind: material.kind,
    content_hash: material.content_hash,
    source_subject_id: material.source_subject_id,
    belongs_to_subject: material.belongs_to_subject,
    represents_current_judgment: material.represents_current_judgment,
    authority: material.authority,
    currentness: material.currentness,
    source_created_at: material.source_created_at,
    source_updated_at: material.source_updated_at,
    time_basis: material.time_basis,
    sensitivity: material.sensitivity,
    external_constraints: material.external_constraints,
    in_scope: material.in_scope,
    split_domain: material.split_domain,
    expired: material.expired,
    trust: material.trust,
    public_export_review: material.public_export_review,
  };
}

const SOURCE_REVIEW_FIELDS = [
  'source_subject_id',
  'belongs_to_subject',
  'represents_current_judgment',
  'authority',
  'currentness',
  'external_constraints',
  'in_scope',
  'split_domain',
  'expired',
];

function sourceReviewSnapshot(material) {
  return Object.fromEntries(
    SOURCE_REVIEW_FIELDS.map((field) => [field, material[field]]),
  );
}

function sourceReviewDigest(material) {
  return sha256(stableStringify(sourceReviewSnapshot(material)));
}

function changedSourceFields(before, after) {
  return SOURCE_REVIEW_FIELDS.filter(
    (field) =>
      stableStringify(before[field]) !== stableStringify(after[field]),
  );
}

function semanticSnapshot(workspace) {
  return {
    mode: workspace.state.mode,
    purpose_brief: workspace.purposeBrief,
    materials: [...workspace.materials]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(semanticMaterial),
    judgment_model: {
      judgment_core: workspace.judgmentModel.judgment_core,
      global_boundaries: workspace.judgmentModel.global_boundaries,
      units: [...workspace.judgmentModel.units]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map(semanticUnit),
      relations: [...workspace.judgmentModel.relations]
        .sort((a, b) => a.id.localeCompare(b.id)),
      split_recommendations: [...workspace.judgmentModel.split_recommendations]
        .sort((a, b) => a.id.localeCompare(b.id)),
    },
  };
}

function canonicalSemanticDigest(workspace) {
  return sha256(stableStringify(semanticSnapshot(workspace)));
}

function semanticTestCaseSnapshot(testCase) {
  return {
    id: testCase.id,
    kind: testCase.kind,
    input: testCase.input,
    expected: testCase.expected,
    expected_creator_label: testCase.expected_creator_label,
    unit_ids: testCase.unit_ids,
    boundary_ids: testCase.boundary_ids,
    held_out: testCase.held_out,
    source_ref: testCase.source_ref,
    semantic_digest: testCase.semantic_digest,
    status: testCase.status,
    result: testCase.result,
    observed_creator_label: testCase.observed_creator_label,
    evaluated_by: testCase.evaluated_by,
    notes: testCase.notes,
  };
}

function semanticTestDefinitionSnapshot(testCase) {
  return {
    id: testCase.id,
    kind: testCase.kind,
    input: testCase.input,
    expected: testCase.expected,
    expected_creator_label: testCase.expected_creator_label,
    unit_ids: testCase.unit_ids,
    boundary_ids: testCase.boundary_ids,
    held_out: testCase.held_out,
    source_ref: testCase.source_ref,
    semantic_digest: testCase.semantic_digest,
  };
}

function currentSemanticTestDefinitions(workspace) {
  return workspace.semanticTestReport.cases
    .filter(
      (testCase) =>
        testCase.semantic_digest === workspace.state.semantic_digest,
    )
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(semanticTestDefinitionSnapshot);
}

function canonicalTestDefinitionDigest(workspace) {
  return sha256(
    stableStringify({ cases: currentSemanticTestDefinitions(workspace) }),
  );
}

function canonicalTestReportDigest(workspace) {
  const cases = [...workspace.semanticTestReport.cases]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(semanticTestCaseSnapshot);
  const plans = [...(workspace.semanticTestReport.plans || [])]
    .sort((left, right) => left.id.localeCompare(right.id));
  return sha256(stableStringify({ cases, plans }));
}

function canonicalJudgmentEvidenceDigest(workspace) {
  return sha256(stableStringify({
    semantic_digest: workspace.state.semantic_digest,
    confirmations: [...workspace.confirmationReceipts]
      .sort((left, right) => left.id.localeCompare(right.id)),
    semantic_test_report: workspace.semanticTestReport,
    repair_plan: workspace.repairPlan,
  }));
}

function canonicalBuildReceiptDigest(receipt) {
  return receipt ? sha256(stableStringify(receipt)) : null;
}

function invalidateChangedTestAcceptance(workspace, timestamp) {
  const acceptance = workspace.semanticTestReport.acceptance;
  if (
    acceptance &&
    acceptance.status === 'valid' &&
    acceptance.test_report_digest !== canonicalTestReportDigest(workspace)
  ) {
    acceptance.status = 'invalidated';
    acceptance.invalidated_at = timestamp;
  }
}

function normalizeCreator(value = {}) {
  const type = value.type || 'agent';
  if (!['agent', 'human', 'organization'].includes(type)) {
    throw new Error('createdBy.type must be agent, human, or organization');
  }
  return {
    type,
    id: nonEmpty(value.id || 'terminal-agent', 'createdBy.id'),
    ...(optionalString(value.name) ? { name: optionalString(value.name) } : {}),
  };
}

function bumpPatch(version) {
  const match = String(version || '').match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) throw new Error(`invalid semantic version: ${version}`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

function assertVersion(version, label) {
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(String(version || ''))) {
    throw new Error(`${label} must be a semantic version`);
  }
  return String(version);
}

function compareSemanticVersions(leftValue, rightValue) {
  const parse = (value) => {
    const normalized = assertVersion(value, 'version');
    const match = normalized.match(
      /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+)|\+([0-9A-Za-z.-]+))?$/,
    );
    return {
      core: match.slice(1, 4).map((part) => BigInt(part)),
      prerelease: match[4] ? match[4].split('.') : null,
    };
  };
  const left = parse(leftValue);
  const right = parse(rightValue);
  for (let index = 0; index < left.core.length; index += 1) {
    if (left.core[index] > right.core[index]) return 1;
    if (left.core[index] < right.core[index]) return -1;
  }
  if (left.prerelease === null && right.prerelease === null) return 0;
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) {
      return BigInt(leftPart) > BigInt(rightPart) ? 1 : -1;
    }
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    return leftPart > rightPart ? 1 : -1;
  }
  return 0;
}

function initialExportPlan(options = {}) {
  const access = options.access || 'public';
  if (!['public', 'licensed', 'remote'].includes(access)) {
    throw new Error('access must be public, licensed, or remote');
  }
  return {
    version: assertVersion(options.version || '0.1.0', 'version'),
    judgment_version: assertVersion(
      options.judgmentVersion || options.version || '0.1.0',
      'judgmentVersion',
    ),
    access,
    lineage: clone(options.lineage || { type: 'original' }),
    pending_judgment_change: false,
    last_built_semantic_digest: null,
    last_built_version: null,
    last_built_judgment_version: null,
  };
}

function updateExportPlan(workspace, input = {}) {
  assertPlainObject(input, 'input');
  assertAllowedKeys(
    input,
    new Set(['version', 'access']),
    'export plan update',
  );
  if (input.version === undefined && input.access === undefined) {
    throw new Error('export plan update requires version or access');
  }
  const version = input.version === undefined
    ? workspace.exportPlan.version
    : assertVersion(input.version, 'version');
  const access = input.access === undefined
    ? workspace.exportPlan.access
    : input.access;
  if (!['public', 'licensed', 'remote'].includes(access)) {
    throw new Error('access must be public, licensed, or remote');
  }
  if (
    input.version !== undefined &&
    compareSemanticVersions(version, workspace.exportPlan.version) <= 0
  ) {
    throw new Error(
      'an export plan update requires a higher distributed version',
    );
  }
  if (
    workspace.exportPlan.last_built_version &&
    compareSemanticVersions(
      version,
      workspace.exportPlan.last_built_version,
    ) <= 0
  ) {
    throw new Error(
      'a post-build export plan update requires a higher distributed version',
    );
  }
  return evolve(workspace, 'export_plan_updated', (next) => {
    next.exportPlan.version = version;
    next.exportPlan.access = access;
    for (const material of next.materials) {
      if (material.sensitivity !== 'sensitive') continue;
      if (access === 'public') {
        if (
          material.public_export_review.status !== 'approved' ||
          material.public_export_review.decision !== 'public-safe-abstraction'
        ) {
          material.public_export_review = {
            status: 'pending',
            decision: null,
            reviewer: null,
            rationale: null,
            reviewed_at: null,
          };
          const existingQuestion = next.unresolvedQuestions.some((question) => (
            question.kind === 'source_safety_sensitive_public' &&
            question.target_id === material.id &&
            question.status === 'open'
          ));
          if (!existingQuestion) {
            next.unresolvedQuestions.push({
              id: id('question'),
              kind: 'source_safety_sensitive_public',
              reason:
                `Sensitive source ${material.id} requires an explicit public-safe-abstraction ` +
                `or non-public-isolation disposition before public export.`,
              target_id: material.id,
              status: 'open',
              created_at: now(),
              resolved_at: null,
            });
          }
        }
      } else {
        material.public_export_review = {
          status: 'not-required',
          decision: 'non-public-isolation',
          reviewer: null,
          rationale: 'The export plan is not public and source bodies remain excluded.',
          reviewed_at: now(),
        };
        for (const question of next.unresolvedQuestions) {
          if (
            question.kind === 'source_safety_sensitive_public' &&
            question.target_id === material.id &&
            question.status === 'open'
          ) {
            question.status = 'resolved';
            question.resolved_at = now();
          }
        }
      }
    }
  });
}

function createWorkspace(projectPath = null, options = {}) {
  if (projectPath && typeof projectPath === 'object' && !Array.isArray(projectPath)) {
    options = projectPath;
    projectPath = null;
  }
  const mode = options.mode || 'agent-authored';
  if (!CREATION_MODES.includes(mode)) {
    throw new Error(`mode must be one of: ${CREATION_MODES.join(', ')}`);
  }
  const workflowMode = options.workflowMode || 'collaborative';
  if (!WORKFLOW_MODES.includes(workflowMode)) {
    throw new Error(
      `workflowMode must be one of: ${WORKFLOW_MODES.join(', ')}`,
    );
  }
  const timestamp = now();
  const workspace = {
    root: projectPath ? path.resolve(projectPath) : null,
    state: {
      schema_version: SCHEMA_VERSION,
      workspace_id: options.workspaceId || id('creation'),
      mode,
      workflow_mode: workflowMode,
      status: 'needs_purpose',
      semantic_revision: 0,
      semantic_digest: `sha256:${'0'.repeat(64)}`,
      next_unresolved_reason: 'Purpose, scope, loading condition, and judgment core are not declared.',
      created_at: timestamp,
      updated_at: timestamp,
      created_by: normalizeCreator(options.createdBy),
    },
    purposeBrief: null,
    materials: [],
    candidates: [],
    judgmentModel: {
      judgment_core: {},
      global_boundaries: [],
      units: [],
      relations: [],
      split_recommendations: [],
    },
    unresolvedQuestions: [],
    confirmationReceipts: [],
    semanticTestReport: {
      cases: [],
      plans: [],
      acceptance: null,
    },
    applicationVerification: {
      plans: [],
      attempts: [],
      observations: [],
      abandonments: [],
      receipts: [],
    },
    repairPlan: {
      items: [],
    },
    exportPlan: initialExportPlan(options),
    buildReceipt: null,
    interviewAnswers: [],
    operations: [],
    history: [],
  };
  workspace.state.semantic_digest = canonicalSemanticDigest(workspace);
  workspace.history.push({
    revision: 0,
    event: 'workspace_created',
    semantic_digest: workspace.state.semantic_digest,
    at: timestamp,
  });
  return workspace;
}

function schemaIssuePath(error) {
  let pointer = error.instancePath || '';
  if (error.keyword === 'required' && error.params?.missingProperty) {
    pointer = `${pointer}/${error.params.missingProperty}`;
  } else if (error.keyword === 'additionalProperties' && error.params?.additionalProperty) {
    pointer = `${pointer}/${error.params.additionalProperty}`;
  }
  return pointer || '/';
}

function formatSchemaIssue(error) {
  const pathLabel = schemaIssuePath(error);
  const allowed = error.keyword === 'enum' && Array.isArray(error.params?.allowedValues)
    ? `; allowed: ${error.params.allowedValues.map(String).join(', ')}`
    : '';
  return `${pathLabel}: ${error.message || `failed ${error.keyword}`}${allowed}`;
}

function semanticTestStateConsistent(testCase) {
  const expectedResult = {
    pending: null,
    passed: 'pass',
    failed: 'fail',
    inconclusive: 'inconclusive',
  };
  if (testCase.status === 'invalidated') {
    return testCase.invalidated_at !== null;
  }
  const labelExpected = testCase.expected_creator_label !== null;
  const observedLabel = testCase.observed_creator_label;
  const labelResult = (
    observedLabel !== '不符合' &&
    observedLabel === testCase.expected_creator_label
  )
    ? 'pass'
    : 'fail';
  return (
    Object.hasOwn(expectedResult, testCase.status) &&
    testCase.result === expectedResult[testCase.status] &&
    testCase.invalidated_at === null &&
    (
      testCase.status === 'pending'
        ? observedLabel === null
        : (
            labelExpected
              ? ['符合', '不符合', '超出范围'].includes(observedLabel) &&
                testCase.result === labelResult
              : observedLabel === null
          )
    ) &&
    (
      testCase.status === 'pending'
        ? testCase.evaluated_by === null && testCase.evaluated_at === null
        : testCase.evaluated_by !== null && testCase.evaluated_at !== null
    )
  );
}

function validateWorkspace(workspace) {
  const schemaValid = workspaceSchemaValidator(workspace);
  const issues = schemaValid
    ? []
    : (workspaceSchemaValidator.errors || []).map(formatSchemaIssue);
  if (issues.length === 0) {
    for (const [index, material] of workspace.materials.entries()) {
      const indicatorsPresent = material.trust.indicators.length > 0;
      if (material.trust.prompt_injection_detected !== indicatorsPresent) {
        issues.push(
          `/materials/${index}/trust: prompt_injection_detected must be true ` +
          `exactly when stable indicators are present`,
        );
      }
    }
  }
  if (issues.length === 0) {
    const operationIds = new Set();
    for (const [index, receipt] of workspace.operations.entries()) {
      const operationPath = `/operations/${index}`;
      if (operationIds.has(receipt.operation_id)) {
        issues.push(
          `${operationPath}/operation_id: duplicate operation_id`,
        );
      }
      operationIds.add(receipt.operation_id);
      const exportOnlyValues = [
        receipt.asset_digest,
        receipt.output_reference,
        receipt.output_filename,
        receipt.candidate_filename,
        receipt.backup_filename,
        receipt.prior_output_digest,
      ];
      if (receipt.command !== 'export-agent') {
        if (
          receipt.status !== 'completed' ||
          receipt.after === null ||
          receipt.completed_at === null
        ) {
          issues.push(`${operationPath}: non-export operations must be completed`);
        }
        if (exportOnlyValues.some((value) => value !== null)) {
          issues.push(
            `${operationPath}: only export-agent may bind export recovery data`,
          );
        }
      } else {
        try {
          assertOperationReference(
            receipt.output_reference,
            `${operationPath}/output_reference`,
          );
        } catch (error) {
          issues.push(error.message);
        }
        for (const field of [
          'output_filename',
          'candidate_filename',
          'backup_filename',
        ]) {
          const value = receipt[field];
          if (
            typeof value !== 'string' ||
            value.length === 0 ||
            value !== path.basename(value)
          ) {
            issues.push(`${operationPath}/${field}: must be a basename`);
          }
        }
        if (
          new Set([
            receipt.output_filename,
            receipt.candidate_filename,
            receipt.backup_filename,
          ]).size !== 3
        ) {
          issues.push(`${operationPath}: export recovery filenames must be distinct`);
        }
        if (receipt.status === 'prepared') {
          if (
            receipt.asset_digest !== null ||
            receipt.after !== null ||
            receipt.completed_at !== null
          ) {
            issues.push(
              `${operationPath}: prepared export must not claim verification or completion`,
            );
          }
        } else if (receipt.status === 'verified') {
          if (
            receipt.asset_digest === null ||
            receipt.after !== null ||
            receipt.completed_at !== null
          ) {
            issues.push(
              `${operationPath}: verified export must bind only its exact asset`,
            );
          }
        } else if (
          receipt.asset_digest === null ||
          receipt.after === null ||
          receipt.completed_at === null
        ) {
          issues.push(
            `${operationPath}: completed export must bind its asset and completion`,
          );
        }
      }
      if (receipt.before.history_length > receipt.phase_history_length) {
        issues.push(`${operationPath}: operation phase precedes its before coordinate`);
      }
      if (
        receipt.phase_history_length > workspace.history.length ||
        (receipt.after &&
          (receipt.before.history_length > receipt.after.history_length ||
            receipt.after.history_length > workspace.history.length))
      ) {
        issues.push(
          `${operationPath}: operation coordinates do not fit workspace history`,
        );
      }
      const beforeEntry =
        workspace.history[receipt.before.history_length - 1];
      if (
        !beforeEntry ||
        beforeEntry.revision !== receipt.before.semantic_revision ||
        beforeEntry.semantic_digest !== receipt.before.semantic_digest
      ) {
        issues.push(
          `${operationPath}/before: coordinate does not bind workspace history`,
        );
      }
      const phaseEntry = workspace.history[receipt.phase_history_length - 1];
      const expectedPhaseEvent = receipt.status === 'prepared'
        ? 'export_operation_prepared'
        : receipt.status === 'verified'
          ? 'export_operation_verified'
          : 'operation_completed';
      const expectedPhaseCoordinate =
        receipt.status === 'completed' ? receipt.after : receipt.before;
      if (
        !phaseEntry ||
        phaseEntry.event !== expectedPhaseEvent ||
        phaseEntry.operation_id !== receipt.operation_id ||
        phaseEntry.revision !== expectedPhaseCoordinate?.semantic_revision ||
        phaseEntry.semantic_digest !== expectedPhaseCoordinate?.semantic_digest ||
        phaseEntry.at !== receipt.updated_at
      ) {
        issues.push(
          `${operationPath}: current phase does not bind workspace history`,
        );
      }
      if (receipt.after) {
        const afterEntry =
          workspace.history[receipt.after.history_length - 1];
        if (
          !afterEntry ||
          afterEntry.event !== 'operation_completed' ||
          afterEntry.operation_id !== receipt.operation_id ||
          afterEntry.revision !== receipt.after.semantic_revision ||
          afterEntry.semantic_digest !== receipt.after.semantic_digest ||
          afterEntry.at !== receipt.completed_at ||
          receipt.phase_history_length !== receipt.after.history_length
        ) {
          issues.push(
            `${operationPath}/after: completion does not bind workspace history`,
          );
        }
      }
    }
  }
  if (issues.length === 0) {
    for (const [index, testCase] of workspace.semanticTestReport.cases.entries()) {
      if (!semanticTestStateConsistent(testCase)) {
        issues.push(
          `/semanticTestReport/cases/${index}: status, result and evaluation state are inconsistent`,
        );
      } else if (
        testCase.status === 'invalidated' &&
        testCase.semantic_digest === workspace.state.semantic_digest
      ) {
        issues.push(
          `/semanticTestReport/cases/${index}: a current semantic test cannot be invalidated`,
        );
      }
    }
  }
  if (issues.length === 0) {
    const applicationEvidenceIds = new Set();
    const planIds = new Set();
    for (
      const [index, plan] of
      workspace.applicationVerification.plans.entries()
    ) {
      const planPath = `/applicationVerification/plans/${index}`;
      try {
        if (planIds.has(plan.id)) {
          throw new Error('duplicate application plan id');
        }
        planIds.add(plan.id);
        if (applicationEvidenceIds.has(plan.id)) {
          throw new Error('application evidence id is reused across roles');
        }
        applicationEvidenceIds.add(plan.id);
        if (plan.plan_digest !== canonicalApplicationPlanDigest(plan)) {
          throw new Error('plan_digest does not match frozen plan content');
        }
        for (const [field, identity] of [
          ['creation_identity', plan.creation_identity],
          ['coordinator_identity', plan.coordinator_identity],
          ['consumer_identity', plan.consumer_identity],
          ['evaluator_identity', plan.evaluator_identity],
        ]) {
          const normalized = normalizeApplicationIdentity({
            id: identity.id,
            public_key: identity.public_key,
          }, field);
          if (
            normalized.fingerprint !== identity.fingerprint ||
            normalized.public_key !== identity.public_key
          ) {
            throw new Error(`${field} key or fingerprint is not canonical`);
          }
        }
        const keyRegistryPayload =
          applicationKeyRegistrySigningPayload(workspace, plan);
        if (plan.key_registry_digest !== sha256(keyRegistryPayload)) {
          throw new Error(
            'key_registry_digest does not match frozen role keys',
          );
        }
        verifyApplicationSignature(
          plan.creation_identity,
          JSON.parse(keyRegistryPayload.toString('utf8')),
          plan.creation_key_signature,
          'creation_key_signature',
        );
        verifyApplicationSignature(
          plan.coordinator_identity,
          JSON.parse(keyRegistryPayload.toString('utf8')),
          plan.coordinator_key_signature,
          'coordinator_key_signature',
        );
        const planSigningPayload =
          applicationPlanSigningPayload(workspace, plan);
        if (plan.plan_content_digest !== sha256(planSigningPayload)) {
          throw new Error(
            'plan_content_digest does not match frozen tasks and thresholds',
          );
        }
        verifyApplicationSignature(
          plan.coordinator_identity,
          JSON.parse(planSigningPayload.toString('utf8')),
          plan.coordinator_plan_signature,
          'coordinator_plan_signature',
        );
        const roleIdentities = [
          plan.creation_identity,
          plan.coordinator_identity,
          plan.consumer_identity,
          plan.evaluator_identity,
        ];
        if (
          workspace.state.created_by.type !== 'agent' ||
          plan.frozen_by.type !== 'agent' ||
          new Set(roleIdentities.map((identity) => identity.id)).size !==
            roleIdentities.length ||
          new Set(roleIdentities.map((identity) => identity.fingerprint)).size !==
            roleIdentities.length ||
          plan.creation_identity.id !== workspace.state.created_by.id ||
          plan.coordinator_identity.id !== plan.frozen_by.id
        ) {
          throw new Error(
            'Creation, coordinator, Consumer, and evaluator roles and keys must remain distinct and correctly attributed',
          );
        }
        if (
          plan.status === 'valid' &&
          (
            plan.semantic_digest !== workspace.state.semantic_digest ||
            plan.semantic_revision !== workspace.state.semantic_revision ||
            plan.judgment_evidence_digest !==
              canonicalJudgmentEvidenceDigest(workspace)
          )
        ) {
          throw new Error('a stale application plan cannot remain valid');
        }
        if (
          plan.status === 'valid' &&
          plan.verification_contract === 'adoption-fidelity' &&
          (
            plan.evidence_set !== 'fresh-hidden-holdout' ||
            plan.response_mode !== 'free-response' ||
            plan.build_receipt_digest !==
              canonicalBuildReceiptDigest(workspace.buildReceipt) ||
            plan.asset_digest !== workspace.buildReceipt?.asset_digest
          )
        ) {
          throw new Error(
            'a current adoption-fidelity plan must bind the exact FORMAT_VALID build and asset',
          );
        }
      } catch (error) {
        issues.push(`${planPath}: ${error.message}`);
      }
    }
    const attemptIds = new Set();
    const challengeDigests = new Set();
    for (
      const [index, attempt] of
      workspace.applicationVerification.attempts.entries()
    ) {
      const attemptPath = `/applicationVerification/attempts/${index}`;
      try {
        if (attemptIds.has(attempt.id)) {
          throw new Error('duplicate application attempt id');
        }
        attemptIds.add(attempt.id);
        if (applicationEvidenceIds.has(attempt.id)) {
          throw new Error('application evidence id is reused across roles');
        }
        applicationEvidenceIds.add(attempt.id);
        if (challengeDigests.has(attempt.challenge_digest)) {
          throw new Error('duplicate application challenge');
        }
        challengeDigests.add(attempt.challenge_digest);
        const plan = workspace.applicationVerification.plans.find(
          (candidate) =>
            candidate.id === attempt.plan_id &&
            candidate.plan_digest === attempt.plan_digest,
        );
        if (!plan) {
          throw new Error('attempt does not bind a frozen plan');
        }
        if (
          attempt.attempt_digest !== canonicalApplicationAttemptDigest(attempt) ||
          attempt.asset_load_receipt_digest !==
            applicationAssetLoadReceiptDigest(attempt.asset_load_receipt) ||
          attempt.asset_load_receipt.asset_digest !== attempt.asset_digest ||
          attempt.asset_load_receipt.observation_context_digest !== sha256(
            stableStringify({
              role: 'coordinator-preflight',
              run_digest: sha256(attempt.id),
              runner_digest: null,
              observed_at: attempt.asset_load_receipt.observed_at,
            }),
          )
        ) {
          throw new Error(
            'attempt digest or exact asset load receipt is not canonical',
          );
        }
        const disallowedRequesterIds = new Set([
          workspace.state.created_by.id,
          workspace.purposeBrief?.represented_subject?.id,
          plan.consumer_identity.id,
          plan.evaluator_identity.id,
        ].filter(Boolean));
        if (
          attempt.requested_by.type !== 'agent' ||
          disallowedRequesterIds.has(attempt.requested_by.id) ||
          attempt.requested_by.id !== plan.coordinator_identity.id
        ) {
          throw new Error(
            'attempt requester must be the frozen coordinator and remain independent of Creation, subject, Consumer, and evaluator',
          );
        }
        if (attempt.status === 'open') {
          if (
            attempt.receipt_id !== null ||
            attempt.consumed_at !== null ||
            attempt.invalidated_at !== null ||
            attempt.abandonment_id != null ||
            attempt.semantic_digest !== workspace.state.semantic_digest ||
            attempt.semantic_revision !== workspace.state.semantic_revision ||
            attempt.judgment_evidence_digest !==
              canonicalJudgmentEvidenceDigest(workspace) ||
            attempt.build_receipt_digest !==
              canonicalBuildReceiptDigest(workspace.buildReceipt) ||
            attempt.asset_digest !== workspace.buildReceipt?.asset_digest ||
            plan.status !== 'valid'
          ) {
            throw new Error(
              'open application attempt is stale, consumed, or not current',
            );
          }
        } else if (attempt.status === 'consumed') {
          if (
            !attempt.receipt_id ||
            !attempt.consumed_at ||
            attempt.invalidated_at !== null ||
            attempt.abandonment_id != null
          ) {
            throw new Error(
              'consumed application attempt lacks its receipt binding',
            );
          }
        } else if (attempt.status === 'abandoned') {
          if (
            !attempt.abandonment_id ||
            attempt.invalidated_at === null ||
            attempt.receipt_id !== null ||
            attempt.consumed_at !== null
          ) {
            throw new Error(
              'abandoned application attempt lacks its abandonment binding',
            );
          }
        } else if (
          !['invalidated', 'superseded'].includes(attempt.status) ||
          attempt.invalidated_at === null ||
          attempt.receipt_id !== null ||
          attempt.consumed_at !== null ||
          attempt.abandonment_id != null
        ) {
          throw new Error('application attempt has an invalid lifecycle');
        }
      } catch (error) {
        issues.push(`${attemptPath}: ${error.message}`);
      }
    }
    const observationIds = new Set();
    const observationAttemptIds = new Set();
    for (
      const [index, observation] of
      workspace.applicationVerification.observations.entries()
    ) {
      const observationPath =
        `/applicationVerification/observations/${index}`;
      try {
        if (observationIds.has(observation.id)) {
          throw new Error('duplicate application observation id');
        }
        observationIds.add(observation.id);
        if (applicationEvidenceIds.has(observation.id)) {
          throw new Error('application evidence id is reused across roles');
        }
        applicationEvidenceIds.add(observation.id);
        if (observationAttemptIds.has(observation.attempt_id)) {
          throw new Error(
            'an application attempt may have only one Consumer observation',
          );
        }
        observationAttemptIds.add(observation.attempt_id);
        const attempt = workspace.applicationVerification.attempts.find(
          (candidate) =>
            candidate.id === observation.attempt_id &&
            candidate.attempt_digest === observation.attempt_digest &&
            candidate.challenge_digest === observation.challenge_digest,
        );
        const plan = workspace.applicationVerification.plans.find(
          (candidate) =>
            candidate.id === observation.plan_id &&
            candidate.plan_digest === observation.plan_digest,
        );
        if (
          !attempt ||
          !plan ||
          observation.observed_by.type !== 'agent' ||
          observation.observed_by.id !== plan.consumer_identity.id ||
          observation.observation_digest !==
            canonicalApplicationObservationDigest(observation) ||
          observation.asset_load_receipt_digest !==
            applicationAssetLoadReceiptDigest(
              observation.asset_load_receipt,
            ) ||
          observation.asset_load_receipt.asset_digest !==
            observation.asset_digest ||
          observation.asset_load_receipt.observed_at !==
            observation.observed_at ||
          observation.asset_load_receipt.observation_context_digest !==
            sha256(stableStringify({
              role: 'consumer-execution',
              run_digest: observation.consumer_run_digest,
              runner_digest: observation.runner_digest,
              observed_at: observation.observed_at,
            })) ||
          Date.parse(observation.observed_at) < Date.parse(attempt.issued_at) ||
          Date.parse(observation.observed_at) > Date.now()
        ) {
          throw new Error(
            'application observation does not canonically bind its attempt, Consumer, time, and exact asset load',
          );
        }
        if (observation.status === 'open') {
          if (
            observation.receipt_id !== null ||
            observation.consumed_at !== null ||
            observation.invalidated_at !== null ||
            observation.abandonment_id != null ||
            attempt.status !== 'open'
          ) {
            throw new Error(
              'open application observation is stale or already consumed',
            );
          }
        } else if (observation.status === 'consumed') {
          if (
            !observation.receipt_id ||
            !observation.consumed_at ||
            observation.invalidated_at !== null ||
            observation.abandonment_id != null ||
            attempt.status !== 'consumed'
          ) {
            throw new Error(
              'consumed application observation lacks its receipt binding',
            );
          }
        } else if (observation.status === 'abandoned') {
          if (
            !observation.abandonment_id ||
            observation.invalidated_at === null ||
            observation.receipt_id !== null ||
            observation.consumed_at !== null ||
            attempt.status !== 'abandoned' ||
            attempt.abandonment_id !== observation.abandonment_id
          ) {
            throw new Error(
              'abandoned application observation lacks its abandonment binding',
            );
          }
        } else if (
          !['invalidated', 'superseded'].includes(observation.status) ||
          observation.invalidated_at === null ||
          observation.receipt_id !== null ||
          observation.consumed_at !== null ||
          observation.abandonment_id != null
        ) {
          throw new Error(
            'application observation has an invalid lifecycle',
          );
        }
      } catch (error) {
        issues.push(`${observationPath}: ${error.message}`);
      }
    }
    const abandonmentIds = new Set();
    const abandonmentDigests = new Set();
    for (
      const [index, abandonment] of
      (workspace.applicationVerification.abandonments || []).entries()
    ) {
      const abandonmentPath =
        `/applicationVerification/abandonments/${index}`;
      try {
        if (abandonmentIds.has(abandonment.id)) {
          throw new Error('duplicate application abandonment id');
        }
        abandonmentIds.add(abandonment.id);
        if (applicationEvidenceIds.has(abandonment.id)) {
          throw new Error('application evidence id is reused across roles');
        }
        applicationEvidenceIds.add(abandonment.id);
        if (abandonmentDigests.has(abandonment.abandonment_digest)) {
          throw new Error('duplicate application abandonment digest');
        }
        abandonmentDigests.add(abandonment.abandonment_digest);
        const plan = workspace.applicationVerification.plans.find(
          (candidate) =>
            candidate.id === abandonment.plan_id &&
            candidate.plan_digest === abandonment.plan_digest,
        );
        const attempt = workspace.applicationVerification.attempts.find(
          (candidate) =>
            candidate.id === abandonment.attempt_id &&
            candidate.attempt_digest === abandonment.attempt_digest &&
            candidate.challenge_digest === abandonment.challenge_digest,
        );
        const observation = abandonment.observation_id === null
          ? null
          : workspace.applicationVerification.observations.find(
            (candidate) =>
              candidate.id === abandonment.observation_id &&
              candidate.observation_digest ===
                abandonment.observation_digest &&
              candidate.attempt_id === abandonment.attempt_id,
          );
        const abandonedAt = assertCanonicalUtcDateTime(
          abandonment.abandoned_at,
          'application abandonment abandoned_at',
        );
        if (
          !plan ||
          !attempt ||
          attempt.status !== 'abandoned' ||
          attempt.abandonment_id !== abandonment.id ||
          attempt.invalidated_at !== abandonment.abandoned_at ||
          abandonment.abandoned_by.type !== 'agent' ||
          abandonment.abandoned_by.id !== plan.coordinator_identity.id ||
          abandonment.semantic_revision !== attempt.semantic_revision ||
          abandonment.semantic_digest !== attempt.semantic_digest ||
          abandonment.judgment_evidence_digest !==
            attempt.judgment_evidence_digest ||
          abandonment.build_receipt_digest !==
            attempt.build_receipt_digest ||
          abandonment.asset_digest !== attempt.asset_digest ||
          abandonment.abandonment_digest !==
            canonicalApplicationAttemptAbandonmentDigest(abandonment) ||
          Date.parse(abandonedAt) <
            Date.parse(attempt.issued_at) ||
          Date.parse(abandonedAt) >
            Date.now() + APPLICATION_ABANDONMENT_CLOCK_TOLERANCE_MS
        ) {
          throw new Error(
            'application abandonment does not canonically bind its coordinator, plan, attempt, time, and build coordinates',
          );
        }
        if (
          (observation === null) !==
            (abandonment.observation_id === null) ||
          (
            observation &&
            (
              observation.status !== 'abandoned' ||
              observation.abandonment_id !== abandonment.id ||
              observation.invalidated_at !== abandonment.abandoned_at ||
              abandonment.consumer_run_digest !==
                observation.consumer_run_digest ||
              abandonment.runner_digest !== observation.runner_digest ||
              Date.parse(abandonment.abandoned_at) <
                Date.parse(observation.observed_at)
            )
          )
        ) {
          throw new Error(
            'application abandonment does not canonically bind its Consumer observation',
          );
        }
        if (
          observation === null &&
          (
            abandonment.consumer_run_digest !== null ||
            abandonment.runner_digest !== null
          )
        ) {
          throw new Error(
            'application abandonment without a Consumer observation cannot bind run coordinates',
          );
        }
        verifyApplicationSignature(
          plan.coordinator_identity,
          applicationAttemptAbandonmentSigningSnapshot(abandonment),
          abandonment.coordinator_signature,
          'application abandonment coordinator_signature',
        );
      } catch (error) {
        issues.push(`${abandonmentPath}: ${error.message}`);
      }
    }
    const receiptIds = new Set();
    const executionTuples = new Set();
    const signatureTuples = new Set();
    for (
      const [index, receipt] of
      workspace.applicationVerification.receipts.entries()
    ) {
      const receiptPath = `/applicationVerification/receipts/${index}`;
      try {
        if (receiptIds.has(receipt.id)) {
          throw new Error('duplicate application receipt id');
        }
        receiptIds.add(receipt.id);
        if (applicationEvidenceIds.has(receipt.id)) {
          throw new Error('application evidence id is reused across roles');
        }
        applicationEvidenceIds.add(receipt.id);
        const plan = workspace.applicationVerification.plans.find(
          (candidate) => candidate.id === receipt.plan_id,
        );
        if (!plan || plan.plan_digest !== receipt.plan_digest) {
          throw new Error('receipt does not bind a frozen plan');
        }
        const attempt = workspace.applicationVerification.attempts.find(
          (candidate) => candidate.id === receipt.attempt_id,
        );
        if (
          !attempt ||
          attempt.status !== 'consumed' ||
          attempt.receipt_id !== receipt.id ||
          attempt.challenge_digest !== receipt.challenge_digest ||
          attempt.plan_id !== receipt.plan_id ||
          attempt.plan_digest !== receipt.plan_digest ||
          attempt.semantic_revision !== receipt.semantic_revision ||
          attempt.semantic_digest !== receipt.semantic_digest ||
          attempt.judgment_evidence_digest !==
            receipt.judgment_evidence_digest ||
          attempt.build_receipt_digest !== receipt.build_receipt_digest ||
          attempt.asset_digest !== receipt.asset_digest ||
          attempt.asset_load_receipt_digest !==
            receipt.asset_load_receipt_digest ||
          attempt.attempt_digest !== receipt.attempt_digest
        ) {
          throw new Error(
            'receipt does not bind a consumed single-use application attempt',
          );
        }
        const observation =
          workspace.applicationVerification.observations.find(
            (candidate) =>
              candidate.id === receipt.consumer_asset_observation_id,
          );
        if (
          !observation ||
          observation.status !== 'consumed' ||
          observation.receipt_id !== receipt.id ||
          observation.observation_digest !==
            receipt.consumer_asset_observation_digest ||
          observation.attempt_id !== receipt.attempt_id ||
          observation.consumer_run_digest !== receipt.consumer_run_digest ||
          observation.runner_digest !== receipt.runner_digest ||
          observation.asset_load_receipt_digest !==
            receipt.consumer_asset_load_receipt_digest
        ) {
          throw new Error(
            'receipt does not bind a consumed single-use Consumer asset observation',
          );
        }
        if (
          receipt.consumer_asset_load_receipt_digest !==
            applicationAssetLoadReceiptDigest(
              receipt.consumer_asset_load_receipt,
            ) ||
          receipt.consumer_asset_load_receipt.asset_digest !==
            receipt.asset_digest ||
          receipt.consumer_asset_load_receipt.observed_at !==
            receipt.consumer_asset_observed_at ||
          receipt.consumer_asset_load_receipt.observation_context_digest !==
            sha256(stableStringify({
              role: 'consumer-execution',
              run_digest: receipt.consumer_run_digest,
              runner_digest: receipt.runner_digest,
              observed_at: receipt.consumer_asset_observed_at,
            }))
        ) {
          throw new Error(
            'receipt Consumer asset load observation is not canonical',
          );
        }
        const executionTuple = stableStringify([
          receipt.consumer_run_digest,
          receipt.runner_digest,
          receipt.evaluator_run_digest,
          receipt.evaluator_runner_digest,
        ]);
        if (executionTuples.has(executionTuple)) {
          throw new Error('duplicate application execution coordinates');
        }
        executionTuples.add(executionTuple);
        const signatureTuple = stableStringify([
          receipt.consumer_signature,
          receipt.evaluator_signature,
        ]);
        if (signatureTuples.has(signatureTuple)) {
          throw new Error('duplicate application signature tuple');
        }
        signatureTuples.add(signatureTuple);
        if (
          receipt.consumer.id !== plan.consumer_identity.id ||
          receipt.evaluated_by.id !== plan.evaluator_identity.id
        ) {
          throw new Error('receipt actors do not match frozen keys');
        }
        const consumerSnapshot = applicationConsumerSigningSnapshot(receipt);
        verifyApplicationSignature(
          plan.consumer_identity,
          consumerSnapshot,
          receipt.consumer_signature,
          'consumer_signature',
        );
        const executionDigest = sha256(
          applicationSigningBytes(consumerSnapshot),
        );
        if (executionDigest !== receipt.consumer_execution_digest) {
          throw new Error('consumer_execution_digest is not canonical');
        }
        verifyApplicationSignature(
          plan.evaluator_identity,
          applicationEvaluatorSigningSnapshot({
            ...receipt,
            consumer_execution_digest: executionDigest,
          }),
          receipt.evaluator_signature,
          'evaluator_signature',
        );
        const assessment = applicationAssessment(
          plan,
          receipt.task_results,
        );
        if (stableStringify(assessment.metrics) !==
            stableStringify(receipt.metrics)) {
          throw new Error('application metrics are not mechanically derived');
        }
        if (receipt.status === 'invalidated') {
          if (
            receipt.invalidated_at === null ||
            (
              receipt.semantic_digest === workspace.state.semantic_digest &&
              receipt.semantic_revision === workspace.state.semantic_revision &&
              receipt.judgment_evidence_digest ===
                canonicalJudgmentEvidenceDigest(workspace) &&
              plan.status === 'valid'
            )
          ) {
            throw new Error('only stale application evidence may be invalidated');
          }
        } else if (receipt.status === 'superseded') {
          if (
            receipt.invalidated_at === null ||
            receipt.semantic_digest !== workspace.state.semantic_digest ||
            receipt.asset_digest === workspace.buildReceipt?.asset_digest
          ) {
            throw new Error(
              'only same-semantic evidence for replaced asset bytes may be superseded',
            );
          }
        } else if (
          receipt.status !== assessment.status ||
          receipt.failure_class !== assessment.failure_class ||
          receipt.invalidated_at !== null ||
          receipt.semantic_revision !== workspace.state.semantic_revision ||
          receipt.judgment_evidence_digest !==
            canonicalJudgmentEvidenceDigest(workspace) ||
          receipt.build_receipt_digest !==
            canonicalBuildReceiptDigest(workspace.buildReceipt)
        ) {
          throw new Error('application status or failure class was not derived');
        }
      } catch (error) {
        issues.push(`${receiptPath}: ${error.message}`);
      }
    }
    for (
      const [index, attempt] of
      workspace.applicationVerification.attempts.entries()
    ) {
      if (attempt.status !== 'consumed') continue;
      const matches = workspace.applicationVerification.receipts.filter(
        (receipt) =>
          receipt.id === attempt.receipt_id &&
          receipt.attempt_id === attempt.id,
      );
      if (matches.length !== 1) {
        issues.push(
          `/applicationVerification/attempts/${index}: consumed attempt must bind exactly one receipt`,
        );
      }
    }
    for (
      const [index, observation] of
      workspace.applicationVerification.observations.entries()
    ) {
      if (observation.status !== 'consumed') continue;
      const matches = workspace.applicationVerification.receipts.filter(
        (receipt) =>
          receipt.id === observation.receipt_id &&
          receipt.consumer_asset_observation_id === observation.id,
      );
      if (matches.length !== 1) {
        issues.push(
          `/applicationVerification/observations/${index}: consumed observation must bind exactly one receipt`,
        );
      }
    }
    for (
      const [index, attempt] of
      workspace.applicationVerification.attempts.entries()
    ) {
      if (attempt.status !== 'abandoned') continue;
      const matches =
        (workspace.applicationVerification.abandonments || []).filter(
          (abandonment) =>
            abandonment.id === attempt.abandonment_id &&
            abandonment.attempt_id === attempt.id,
        );
      if (matches.length !== 1) {
        issues.push(
          `/applicationVerification/attempts/${index}: abandoned attempt must bind exactly one abandonment receipt`,
        );
      }
    }
    for (
      const [index, observation] of
      workspace.applicationVerification.observations.entries()
    ) {
      if (observation.status !== 'abandoned') continue;
      const matches =
        (workspace.applicationVerification.abandonments || []).filter(
          (abandonment) =>
            abandonment.id === observation.abandonment_id &&
            abandonment.observation_id === observation.id,
        );
      if (matches.length !== 1) {
        issues.push(
          `/applicationVerification/observations/${index}: abandoned observation must bind exactly one abandonment receipt`,
        );
      }
    }
  }
  if (issues.length === 0) {
    if (workspace.purposeBrief) {
      const boundaryStatements = new Set(
        workspace.purposeBrief.global_boundaries.map(
          (boundary) => boundary.statement,
        ),
      );
      for (const nonGoal of workspace.purposeBrief.non_goals) {
        if (!boundaryStatements.has(nonGoal)) {
          issues.push(
            '/purposeBrief/non_goals: every entry must exactly match an explicit global boundary',
          );
        }
      }
      if (
        stableStringify(workspace.purposeBrief.global_boundaries) !==
        stableStringify(workspace.judgmentModel.global_boundaries)
      ) {
        issues.push(
          '/judgmentModel/global_boundaries: must exactly mirror purposeBrief boundaries',
        );
      }
      const expectedCore = {
        highest_question: workspace.purposeBrief.highest_question,
        worldview: workspace.purposeBrief.worldview,
        value_order: workspace.purposeBrief.value_order,
        judgment_role: workspace.purposeBrief.judgment_role,
      };
      if (
        stableStringify(expectedCore) !==
        stableStringify(workspace.judgmentModel.judgment_core)
      ) {
        issues.push(
          '/judgmentModel/judgment_core: must exactly mirror purposeBrief judgment core',
        );
      }
    }
  }
  if (issues.length === 0) {
    const expected = canonicalSemanticDigest(workspace);
    if (expected !== workspace.state.semantic_digest) {
      issues.push(
        `/state/semantic_digest: does not match canonical workspace semantics ` +
        `(expected ${expected})`,
      );
    }
  }
  return { valid: issues.length === 0, issues };
}

function exportPlanCoordinateDigest(workspace) {
  return sha256(stableStringify({
    version: workspace.exportPlan.version,
    judgment_version: workspace.exportPlan.judgment_version,
    access: workspace.exportPlan.access,
    lineage: workspace.exportPlan.lineage,
  }));
}

function operationCoordinate(workspace) {
  assertWorkspace(workspace);
  return {
    semantic_revision: workspace.state.semantic_revision,
    semantic_digest: workspace.state.semantic_digest,
    export_plan_digest: exportPlanCoordinateDigest(workspace),
    workspace_status: workspace.state.status,
    history_length: workspace.history.length,
  };
}

function canonicalOperationRequestDigest(envelope) {
  assertPlainObject(envelope, 'operation request envelope');
  return sha256(stableStringify({
    ...clone(envelope),
    contract: 'kdna.creation-operation-request/0.1.0',
  }));
}

function operationConflict(message) {
  const error = new Error(`Creation Engine operation conflict: ${message}`);
  error.code = 'CREATION_OPERATION_CONFLICT';
  return error;
}

function operationDevelopmentRuntime(input) {
  if (
    input.development_runtime === undefined ||
    input.development_runtime === null
  ) {
    return null;
  }
  validateDevelopmentRuntime(input.development_runtime);
  return clone(input.development_runtime);
}

function resolveOperation(workspace, input = {}) {
  assertWorkspace(workspace);
  const operationId = nonEmpty(input.operation_id, 'operation_id');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(operationId)) {
    throw new Error('operation_id has an invalid format');
  }
  const command = nonEmpty(input.command, 'command');
  const requestDigest = assertDigest(
    input.request_digest,
    'request_digest',
  );
  const developmentRuntime = operationDevelopmentRuntime(input);
  const receipt = workspace.operations.find(
    (candidate) => candidate.operation_id === operationId,
  );
  if (!receipt) return null;
  if (
    receipt.command !== command ||
    receipt.request_digest !== requestDigest ||
    stableStringify(receipt.development_runtime) !==
      stableStringify(developmentRuntime)
  ) {
    throw operationConflict(
      'the operation_id was already used for a different command, request, or development runtime',
    );
  }
  const applicableCoordinate =
    receipt.status === 'completed' ? receipt.after : receipt.before;
  const currentCoordinate = operationCoordinate(workspace);
  if (
    !applicableCoordinate ||
    applicableCoordinate.semantic_revision !== workspace.state.semantic_revision ||
    applicableCoordinate.semantic_digest !== workspace.state.semantic_digest ||
    (
      receipt.command === 'export-agent' &&
      applicableCoordinate.export_plan_digest !==
        currentCoordinate.export_plan_digest
    )
  ) {
    throw operationConflict(
      'the operation receipt no longer applies to the current workspace semantics or export plan',
    );
  }
  if (
    receipt.command === 'export-agent' &&
    receipt.status === 'completed' &&
    (
      workspace.buildReceipt?.asset_digest !== receipt.asset_digest ||
      workspace.buildReceipt?.semantic_revision !==
        applicableCoordinate.semantic_revision ||
      workspace.buildReceipt?.semantic_digest !==
        applicableCoordinate.semantic_digest ||
      assessReadiness(workspace).creation_accepted !== true ||
      assessReadiness(workspace).completion_gates.format_valid !== true
    )
  ) {
    throw operationConflict(
      'the completed export receipt is not the current accepted build',
    );
  }
  return clone(receipt);
}

function assertOperationFilename(value, label) {
  const filename = nonEmpty(value, label);
  if (filename !== path.basename(filename)) {
    throw new Error(`${label} must not contain a path`);
  }
  return filename;
}

function assertOperationReference(value, label) {
  const reference = nonEmpty(value, label);
  if (
    reference.length > 1024 ||
    path.posix.isAbsolute(reference) ||
    path.win32.isAbsolute(reference) ||
    reference.includes('\\') ||
    path.posix.normalize(reference) !== reference ||
    reference === '.'
  ) {
    throw new Error(`${label} must be a normalized relative POSIX path`);
  }
  return reference;
}

function appendOperationPhase(next, receipt, event) {
  const timestamp = now();
  receipt.updated_at = timestamp;
  receipt.phase_history_length = next.history.length + 1;
  next.state.updated_at = timestamp;
  next.history.push({
    revision: next.state.semantic_revision,
    event,
    operation_id: receipt.operation_id,
    semantic_digest: next.state.semantic_digest,
    at: timestamp,
  });
  return timestamp;
}

function completeOperation(workspace, input = {}) {
  const before = input.before || operationCoordinate(workspace);
  const request = {
    operation_id: nonEmpty(input.operation_id, 'operation_id'),
    command: nonEmpty(input.command, 'command'),
    request_digest: assertDigest(input.request_digest, 'request_digest'),
    development_runtime: operationDevelopmentRuntime(input),
  };
  const existing = resolveOperation(workspace, request);
  if (existing) {
    if (existing.status === 'completed') return workspace;
    throw operationConflict(
      'only export-agent operations may resume an incomplete phase',
    );
  }
  const assetDigest = input.asset_digest === undefined || input.asset_digest === null
    ? null
    : assertDigest(input.asset_digest, 'asset_digest');
  const outputFilename = input.output_filename === undefined ||
    input.output_filename === null
    ? null
    : nonEmpty(input.output_filename, 'output_filename');
  if (outputFilename && outputFilename !== path.basename(outputFilename)) {
    throw new Error('output_filename must not contain a path');
  }
  const next = clone(workspace);
  const receipt = {
    ...request,
    status: 'completed',
    before: clone(before),
    after: null,
    phase_history_length: next.history.length + 1,
    asset_digest: assetDigest,
    output_reference: null,
    output_filename: outputFilename,
    candidate_filename: null,
    backup_filename: null,
    prior_output_digest: null,
    started_at: null,
    updated_at: null,
    completed_at: null,
  };
  if (request.command === 'export-agent') {
    throw new Error('export-agent must use the phased export operation contract');
  }
  const action = computeNextAction(next);
  next.state.status = stateForAction(action);
  next.state.next_unresolved_reason =
    action.action === 'complete' ? null : action.reason;
  next.operations.push(receipt);
  const timestamp = appendOperationPhase(next, receipt, 'operation_completed');
  receipt.started_at = timestamp;
  receipt.completed_at = timestamp;
  receipt.after = {
    semantic_revision: next.state.semantic_revision,
    semantic_digest: next.state.semantic_digest,
    export_plan_digest: exportPlanCoordinateDigest(next),
    workspace_status: next.state.status,
    history_length: receipt.phase_history_length,
  };
  assertWorkspace(next);
  return next;
}

function prepareExportOperation(workspace, input = {}) {
  const request = {
    operation_id: nonEmpty(input.operation_id, 'operation_id'),
    command: nonEmpty(input.command, 'command'),
    request_digest: assertDigest(input.request_digest, 'request_digest'),
    development_runtime: operationDevelopmentRuntime(input),
  };
  if (request.command !== 'export-agent') {
    throw new Error('prepareExportOperation requires export-agent');
  }
  const existing = resolveOperation(workspace, request);
  if (existing) return workspace;
  const before = input.before || operationCoordinate(workspace);
  const outputFilename = assertOperationFilename(
    input.output_filename,
    'output_filename',
  );
  const outputReference = assertOperationReference(
    input.output_reference,
    'output_reference',
  );
  const candidateFilename = assertOperationFilename(
    input.candidate_filename,
    'candidate_filename',
  );
  const backupFilename = assertOperationFilename(
    input.backup_filename,
    'backup_filename',
  );
  if (new Set([
    outputFilename,
    candidateFilename,
    backupFilename,
  ]).size !== 3) {
    throw new Error('export recovery filenames must be distinct');
  }
  const priorOutputDigest =
    input.prior_output_digest === undefined ||
    input.prior_output_digest === null
      ? null
      : assertDigest(input.prior_output_digest, 'prior_output_digest');
  const next = clone(workspace);
  const receipt = {
    ...request,
    status: 'prepared',
    before: clone(before),
    after: null,
    phase_history_length: next.history.length + 1,
    asset_digest: null,
    output_reference: outputReference,
    output_filename: outputFilename,
    candidate_filename: candidateFilename,
    backup_filename: backupFilename,
    prior_output_digest: priorOutputDigest,
    started_at: null,
    updated_at: null,
    completed_at: null,
  };
  next.operations.push(receipt);
  const timestamp = appendOperationPhase(
    next,
    receipt,
    'export_operation_prepared',
  );
  receipt.started_at = timestamp;
  assertWorkspace(next);
  return next;
}

function verifyExportOperation(workspace, input = {}) {
  const request = {
    operation_id: nonEmpty(input.operation_id, 'operation_id'),
    command: nonEmpty(input.command, 'command'),
    request_digest: assertDigest(input.request_digest, 'request_digest'),
    development_runtime: operationDevelopmentRuntime(input),
  };
  const existing = resolveOperation(workspace, request);
  if (!existing) {
    throw operationConflict('the export operation has not been prepared');
  }
  const assetDigest = assertDigest(input.asset_digest, 'asset_digest');
  if (existing.status === 'completed') {
    if (existing.asset_digest !== assetDigest) {
      throw operationConflict('the completed export binds different asset bytes');
    }
    return workspace;
  }
  if (existing.status === 'verified') {
    if (existing.asset_digest !== assetDigest) {
      throw operationConflict('the verified export binds different asset bytes');
    }
    return workspace;
  }
  if (existing.status !== 'prepared') {
    throw operationConflict('the export operation cannot enter verified');
  }
  const next = clone(workspace);
  const receipt = next.operations.find(
    (candidate) => candidate.operation_id === request.operation_id,
  );
  receipt.status = 'verified';
  receipt.asset_digest = assetDigest;
  appendOperationPhase(next, receipt, 'export_operation_verified');
  assertWorkspace(next);
  return next;
}

function completeExportOperation(workspace, input = {}) {
  const request = {
    operation_id: nonEmpty(input.operation_id, 'operation_id'),
    command: nonEmpty(input.command, 'command'),
    request_digest: assertDigest(input.request_digest, 'request_digest'),
    development_runtime: operationDevelopmentRuntime(input),
  };
  const existing = resolveOperation(workspace, request);
  if (!existing) {
    throw operationConflict('the export operation has not been prepared');
  }
  const assetDigest = assertDigest(input.asset_digest, 'asset_digest');
  if (existing.status === 'completed') {
    if (existing.asset_digest !== assetDigest) {
      throw operationConflict('the completed export binds different asset bytes');
    }
    return workspace;
  }
  if (
    existing.status !== 'verified' ||
    existing.asset_digest !== assetDigest
  ) {
    throw operationConflict(
      'the export operation must verify these exact bytes before completion',
    );
  }
  if (
    workspace.buildReceipt?.asset_digest !== assetDigest ||
    workspace.buildReceipt?.semantic_revision !==
      workspace.state.semantic_revision ||
    workspace.buildReceipt?.semantic_digest !== workspace.state.semantic_digest
  ) {
    throw operationConflict(
      'the current build receipt does not bind the verified export and semantics',
    );
  }
  const next = clone(workspace);
  const receipt = next.operations.find(
    (candidate) => candidate.operation_id === request.operation_id,
  );
  receipt.status = 'completed';
  const timestamp = appendOperationPhase(next, receipt, 'operation_completed');
  receipt.completed_at = timestamp;
  receipt.after = {
    semantic_revision: next.state.semantic_revision,
    semantic_digest: next.state.semantic_digest,
    export_plan_digest: exportPlanCoordinateDigest(next),
    workspace_status: next.state.status,
    history_length: receipt.phase_history_length,
  };
  assertWorkspace(next);
  return next;
}

function assertWorkspace(workspace) {
  const result = validateWorkspace(workspace);
  if (!result.valid) {
    throw new Error(`invalid Creation Engine workspace:\n  - ${result.issues.join('\n  - ')}`);
  }
}

function confirmationRequired(mode) {
  return ['human-confirmed', 'organization-confirmed'].includes(mode);
}

function participationRequired(mode) {
  return mode === 'human-assisted';
}

function agentMayAcceptTestReport(workspace, actor) {
  if (actor.type !== 'agent') return true;
  if (workspace.state.mode === 'agent-authored') {
    return actor.id === workspace.state.created_by.id;
  }
  const subject = workspace.purposeBrief?.represented_subject;
  return Boolean(
    workspace.state.mode === 'interpretive' &&
    subject?.type === 'agent' &&
    actor.id === subject.id &&
    actor.id !== workspace.state.created_by.id,
  );
}

function validReceipts(workspace) {
  return workspace.confirmationReceipts.filter((receipt) => (
    receipt.accepted === true &&
    receipt.status === 'valid' &&
    receipt.semantic_digest === workspace.state.semantic_digest
  ));
}

function receiptCoversUnit(receipt, unitId) {
  return receipt.scope === 'model' ||
    (receipt.scope === 'unit' && receipt.target_ids.includes(unitId));
}

function refreshUnitConfirmationState(workspace) {
  const receipts = validReceipts(workspace);
  const required = confirmationRequired(workspace.state.mode);
  for (const unit of workspace.judgmentModel.units) {
    if (!required) {
      unit.confirmation_state = 'not-required';
      continue;
    }
    unit.confirmation_state = receipts.some((receipt) => (
      receipt.claim === 'representation' && receiptCoversUnit(receipt, unit.id)
    ))
      ? 'confirmed'
      : 'unconfirmed';
  }
}

function invalidateBoundEvidence(workspace, timestamp) {
  const digest = workspace.state.semantic_digest;
  for (const receipt of workspace.confirmationReceipts) {
    if (receipt.status === 'valid' && receipt.semantic_digest !== digest) {
      receipt.status = 'invalidated';
      receipt.invalidated_at = timestamp;
    }
  }
  for (const testCase of workspace.semanticTestReport.cases) {
    if (testCase.status !== 'invalidated' && testCase.semantic_digest !== digest) {
      testCase.status = 'invalidated';
      testCase.invalidated_at = timestamp;
    }
  }
  for (const plan of workspace.semanticTestReport.plans || []) {
    if (plan.status === 'valid' && plan.semantic_digest !== digest) {
      plan.status = 'invalidated';
      plan.invalidated_at = timestamp;
    }
  }
  const acceptance = workspace.semanticTestReport.acceptance;
  if (acceptance && acceptance.status === 'valid' && acceptance.semantic_digest !== digest) {
    acceptance.status = 'invalidated';
    acceptance.invalidated_at = timestamp;
  }
  for (const plan of workspace.applicationVerification.plans) {
    if (plan.status === 'valid' && plan.semantic_digest !== digest) {
      plan.status = 'invalidated';
      plan.invalidated_at = timestamp;
    }
  }
  for (const receipt of workspace.applicationVerification.receipts) {
    if (receipt.status !== 'invalidated' && receipt.semantic_digest !== digest) {
      receipt.status = 'invalidated';
      receipt.invalidated_at = timestamp;
    }
  }
  for (const observation of workspace.applicationVerification.observations) {
    if (
      observation.status === 'open' &&
      observation.semantic_digest !== digest
    ) {
      observation.status = 'invalidated';
      observation.invalidated_at = timestamp;
    }
  }
  refreshUnitConfirmationState(workspace);
}

function invalidateChangedApplicationEvidence(workspace, timestamp) {
  const judgmentEvidenceDigest = canonicalJudgmentEvidenceDigest(workspace);
  const validPlanIds = new Set();
  for (const plan of workspace.applicationVerification.plans) {
    if (
      plan.status === 'valid' &&
      (
        plan.semantic_digest !== workspace.state.semantic_digest ||
        plan.semantic_revision !== workspace.state.semantic_revision ||
        plan.judgment_evidence_digest !== judgmentEvidenceDigest
      )
    ) {
      plan.status = 'invalidated';
      plan.invalidated_at = timestamp;
    }
    if (plan.status === 'valid') validPlanIds.add(plan.id);
  }
  for (const attempt of workspace.applicationVerification.attempts) {
    if (
      attempt.status === 'open' &&
      (
        attempt.semantic_digest !== workspace.state.semantic_digest ||
        attempt.semantic_revision !== workspace.state.semantic_revision ||
        attempt.judgment_evidence_digest !== judgmentEvidenceDigest ||
        !validPlanIds.has(attempt.plan_id)
      )
    ) {
      attempt.status = 'invalidated';
      attempt.invalidated_at = timestamp;
    }
  }
  const openAttemptIds = new Set(
    workspace.applicationVerification.attempts
      .filter((attempt) => attempt.status === 'open')
      .map((attempt) => attempt.id),
  );
  for (const observation of workspace.applicationVerification.observations) {
    if (
      observation.status === 'open' &&
      (
        observation.semantic_digest !== workspace.state.semantic_digest ||
        observation.semantic_revision !== workspace.state.semantic_revision ||
        observation.judgment_evidence_digest !== judgmentEvidenceDigest ||
        !validPlanIds.has(observation.plan_id) ||
        !openAttemptIds.has(observation.attempt_id)
      )
    ) {
      observation.status = 'invalidated';
      observation.invalidated_at = timestamp;
    }
  }
  for (const receipt of workspace.applicationVerification.receipts) {
    if (
      ['verified', 'failed', 'superseded'].includes(receipt.status) &&
      (
        receipt.semantic_digest !== workspace.state.semantic_digest ||
        receipt.semantic_revision !== workspace.state.semantic_revision ||
        receipt.judgment_evidence_digest !== judgmentEvidenceDigest ||
        !validPlanIds.has(receipt.plan_id)
      )
    ) {
      receipt.status = 'invalidated';
      receipt.invalidated_at = timestamp;
    }
  }
}

function maybeBumpJudgmentVersions(workspace, semanticChanged) {
  if (!semanticChanged) return;
  const plan = workspace.exportPlan;
  if (plan.last_built_semantic_digest && !plan.pending_judgment_change) {
    plan.version = bumpPatch(plan.version);
    plan.judgment_version = bumpPatch(plan.judgment_version);
    plan.pending_judgment_change = true;
  }
}

function blocking(code, message, targetId = null) {
  return { code, message, target_id: targetId };
}

function completionGates(workspace, judgmentAccepted) {
  const build = workspace.buildReceipt;
  const judgmentEvidenceDigest =
    canonicalJudgmentEvidenceDigest(workspace);
  const buildReceiptDigest = canonicalBuildReceiptDigest(build);
  const formatValid = Boolean(
    build &&
    build.status === 'verified' &&
    build.semantic_digest === workspace.state.semantic_digest &&
    build.semantic_revision === workspace.state.semantic_revision &&
    build.version === workspace.exportPlan.version &&
    build.judgment_version === workspace.exportPlan.judgment_version &&
    build.output &&
    /\.kdna$/i.test(build.output.filename) &&
    build.output.artifact_sha256 === build.asset_digest,
  );
  const currentPlan = [...workspace.applicationVerification.plans]
    .reverse()
    .find((plan) => (
      plan.status === 'valid' &&
      plan.verification_contract === 'adoption-fidelity' &&
      plan.evidence_set === 'fresh-hidden-holdout' &&
      plan.response_mode === 'free-response' &&
      plan.semantic_digest === workspace.state.semantic_digest &&
      plan.semantic_revision === workspace.state.semantic_revision &&
      plan.judgment_evidence_digest === judgmentEvidenceDigest &&
      formatValid &&
      plan.build_receipt_digest === buildReceiptDigest &&
      plan.asset_digest === build.asset_digest &&
      plan.plan_digest === canonicalApplicationPlanDigest(plan)
    ));
  const currentReceipt = formatValid && currentPlan
    ? [...workspace.applicationVerification.receipts]
      .reverse()
      .find((receipt) => (
        receipt.status !== 'invalidated' &&
        receipt.plan_id === currentPlan.id &&
        receipt.plan_digest === currentPlan.plan_digest &&
        receipt.semantic_digest === workspace.state.semantic_digest &&
        receipt.semantic_revision === workspace.state.semantic_revision &&
        receipt.judgment_evidence_digest === judgmentEvidenceDigest &&
        receipt.build_receipt_digest === buildReceiptDigest &&
        receipt.asset_digest === build.asset_digest &&
        receipt.consumer_asset_load_receipt.asset_digest ===
          build.asset_digest &&
        receipt.consumer_asset_load_receipt_digest ===
          applicationAssetLoadReceiptDigest(
            receipt.consumer_asset_load_receipt,
          ) &&
        workspace.applicationVerification.observations.some(
          (observation) =>
            observation.id === receipt.consumer_asset_observation_id &&
            observation.status === 'consumed' &&
            observation.receipt_id === receipt.id &&
            observation.observation_digest ===
              receipt.consumer_asset_observation_digest &&
            observation.attempt_id === receipt.attempt_id &&
            observation.asset_load_receipt_digest ===
              receipt.consumer_asset_load_receipt_digest,
        ) &&
        workspace.applicationVerification.attempts.some((attempt) => (
          attempt.id === receipt.attempt_id &&
          attempt.status === 'consumed' &&
          attempt.receipt_id === receipt.id &&
          attempt.attempt_digest === receipt.attempt_digest &&
          attempt.challenge_digest === receipt.challenge_digest &&
          attempt.plan_id === receipt.plan_id &&
          attempt.plan_digest === receipt.plan_digest &&
          attempt.semantic_digest === receipt.semantic_digest &&
          attempt.semantic_revision === receipt.semantic_revision &&
          attempt.judgment_evidence_digest ===
            receipt.judgment_evidence_digest &&
          attempt.build_receipt_digest === receipt.build_receipt_digest &&
          attempt.asset_digest === receipt.asset_digest &&
          attempt.asset_load_receipt_digest ===
            receipt.asset_load_receipt_digest
        ))
      ))
    : null;
  const currentAttempt = formatValid && currentPlan
    ? [...workspace.applicationVerification.attempts]
      .reverse()
      .find((attempt) => (
        attempt.status === 'open' &&
        attempt.plan_id === currentPlan.id &&
        attempt.plan_digest === currentPlan.plan_digest &&
        attempt.semantic_digest === workspace.state.semantic_digest &&
        attempt.semantic_revision === workspace.state.semantic_revision &&
        attempt.judgment_evidence_digest === judgmentEvidenceDigest &&
        attempt.build_receipt_digest === buildReceiptDigest &&
        attempt.asset_digest === build.asset_digest &&
        attempt.attempt_digest === canonicalApplicationAttemptDigest(attempt) &&
        attempt.asset_load_receipt_digest ===
          applicationAssetLoadReceiptDigest(attempt.asset_load_receipt)
      ))
    : null;
  const currentObservation = currentAttempt
    ? [...workspace.applicationVerification.observations]
      .reverse()
      .find((observation) => (
        observation.status === 'open' &&
        observation.attempt_id === currentAttempt.id &&
        observation.attempt_digest === currentAttempt.attempt_digest &&
        observation.asset_digest === build.asset_digest &&
        observation.observation_digest ===
          canonicalApplicationObservationDigest(observation)
      ))
    : null;
  const applicationVerified = Boolean(
    currentReceipt && currentReceipt.status === 'verified',
  );
  return {
    format_valid: formatValid,
    judgment_accepted: judgmentAccepted === true,
    application_verified: applicationVerified,
    creation_complete:
      formatValid &&
      judgmentAccepted === true &&
      applicationVerified,
    semantic_digest: workspace.state.semantic_digest,
    asset_digest: formatValid ? build.asset_digest : null,
    application_plan_id: currentPlan?.id || null,
    application_attempt_id: currentAttempt?.id || null,
    application_observation_id: currentObservation?.id || null,
    application_receipt_id: currentReceipt?.id || null,
    application_failure_class:
      currentReceipt?.status === 'failed'
        ? currentReceipt.failure_class
        : null,
  };
}

function completeUnit(unit) {
  return Boolean(
    optionalString(unit.statement) &&
    optionalString(unit.rationale) &&
    Array.isArray(unit.applies_when) && unit.applies_when.length > 0 &&
    Array.isArray(unit.does_not_apply_when) && unit.does_not_apply_when.length > 0 &&
    optionalString(unit.misuse_risk) &&
    Array.isArray(unit.source_refs) && unit.source_refs.length > 0 &&
    Array.isArray(unit.contrary_evidence) &&
      unit.contrary_evidence.length > 0 &&
    unit.confidence && ['low', 'medium', 'high', 'unknown'].includes(unit.confidence.status),
  );
}

function groundingMaterialEligible(workspace, material) {
  const subject = workspace.purposeBrief?.represented_subject;
  if (
    !subject ||
    material.source_subject_id !== subject.id ||
    material.in_scope !== true ||
    material.expired === true
  ) {
    return false;
  }
  if (workspace.state.mode === 'interpretive') {
    return !['rejected', 'unknown'].includes(material.authority);
  }
  return (
    ['human-confirmed', 'organization-confirmed'].includes(
      workspace.state.mode,
    ) &&
    material.belongs_to_subject === true &&
    material.represents_current_judgment === true &&
    material.currentness === 'current' &&
    ['current-highest', 'supporting'].includes(material.authority)
  );
}

function confirmationAssessment(workspace) {
  if (participationRequired(workspace.state.mode)) {
    const participation = validReceipts(workspace).some((receipt) => (
      receipt.claim === 'participation' &&
      receipt.actor.type === 'human' &&
      receipt.subject.type === 'human' &&
      receipt.subject.id === receipt.actor.id
    ));
    return participation
      ? { satisfied: true, reason: null }
      : {
          satisfied: false,
          reason: 'Human-assisted mode requires a current record of human participation; it does not claim representation.',
        };
  }
  if (!confirmationRequired(workspace.state.mode)) return { satisfied: true, reason: null };
  const purpose = workspace.purposeBrief;
  const receipts = validReceipts(workspace).filter(
    (receipt) => receipt.claim === 'representation',
  );
  const modelReceipt = receipts.find((receipt) => receipt.scope === 'model');
  const unitsCovered = workspace.judgmentModel.units.every((unit) => (
    receipts.some((receipt) => receiptCoversUnit(receipt, unit.id))
  ));
  const coreCovered = Boolean(modelReceipt) ||
    receipts.some((receipt) => receipt.scope === 'core');
  const boundariesCovered = Boolean(modelReceipt) ||
    receipts.some((receipt) => receipt.scope === 'boundaries');
  if (!unitsCovered || !coreCovered || !boundariesCovered) {
    return {
      satisfied: false,
      reason: 'Current semantic digest lacks confirmation for the model, core, boundaries, or units.',
    };
  }
  if (workspace.state.mode === 'human-confirmed') {
    const subject = purpose?.represented_subject;
    const matching = receipts.some((receipt) => (
      receipt.actor.type === 'human' &&
      receipt.actor.id === subject?.id &&
      receipt.subject.id === subject?.id
    ));
    if (!matching) {
      return { satisfied: false, reason: 'The represented human has not confirmed this digest.' };
    }
  }
  if (workspace.state.mode === 'organization-confirmed') {
    const subject = purpose?.represented_subject;
    const matching = receipts.some((receipt) => (
      receipt.actor.type === 'organization-authority' &&
      optionalString(receipt.actor.authority) &&
      receipt.subject.id === subject?.id
    ));
    if (!matching) {
      return {
        satisfied: false,
        reason: 'No authorized organization confirmer has confirmed this digest.',
      };
    }
  }
  return { satisfied: true, reason: null };
}

function currentPassedTests(workspace) {
  return workspace.semanticTestReport.cases.filter((testCase) => (
    testCase.status === 'passed' &&
    testCase.result === 'pass' &&
    testCase.semantic_digest === workspace.state.semantic_digest
  ));
}

function assessReadiness(workspace) {
  assertWorkspace(workspace);
  const problems = [];
  const warnings = [];
  const purpose = workspace.purposeBrief;
  const units = workspace.judgmentModel.units;
  const materialIds = new Set(workspace.materials.map((material) => material.id));

  const purposeComplete = Boolean(
    purpose &&
    optionalString(purpose.objective) &&
    optionalString(purpose.scope) &&
    optionalString(purpose.loading_condition) &&
    optionalString(purpose.highest_question),
  );
  if (!purposeComplete) {
    problems.push(blocking('PURPOSE_INCOMPLETE', 'Purpose, scope, loading condition, and highest question are required.'));
  }

  const subject = purpose?.represented_subject || null;
  if (workspace.state.mode === 'agent-authored' &&
      (!subject || subject.type !== 'agent' || subject.id !== workspace.state.created_by.id)) {
    problems.push(blocking(
      'AGENT_SUBJECT_MISMATCH',
      'Agent-authored mode must name the creating Agent as represented subject.',
    ));
  }
  if (workspace.state.mode === 'agent-authored') {
    const foreignSource = workspace.materials.find((material) => (
      material.source_subject_id !== null &&
      material.source_subject_id !== workspace.state.created_by.id
    ));
    if (foreignSource) {
      problems.push(blocking(
        'AGENT_AUTHORSHIP_SOURCE_MISMATCH',
        'Material attributed to another subject must use an honest source/claim mode such as interpretive; workflow mode never permits it to be reported as Agent-authored.',
        foreignSource.id,
      ));
    }
  }
  if (workspace.state.mode === 'human-confirmed' && subject?.type !== 'human') {
    problems.push(blocking('HUMAN_SUBJECT_REQUIRED', 'Human-confirmed mode requires a named human subject.'));
  }
  if (workspace.state.mode === 'organization-confirmed' && subject?.type !== 'organization') {
    problems.push(blocking(
      'ORGANIZATION_SUBJECT_REQUIRED',
      'Organization-confirmed mode requires a named organization subject.',
    ));
  }
  if (workspace.state.mode === 'interpretive' && !subject) {
    problems.push(blocking(
      'INTERPRETIVE_SUBJECT_REQUIRED',
      'Interpretive mode must name the material or subject being interpreted.',
    ));
  }

  const sourceGroundedModes = new Set([
    'human-confirmed',
    'organization-confirmed',
    'interpretive',
  ]);
  const sourceGroundingRequired = sourceGroundedModes.has(workspace.state.mode);
  const eligibleMaterialIds = new Set(
    workspace.materials
      .filter((material) => groundingMaterialEligible(workspace, material))
      .map((material) => material.id),
  );
  const sourceGrounded = !sourceGroundingRequired || (
    units.length > 0 &&
    units.every((unit) => (
      unit.agent_inference !== true &&
      unit.source_refs.some((ref) => eligibleMaterialIds.has(ref))
    ))
  );
  if (!sourceGrounded) {
    problems.push(blocking(
      'SOURCE_MATERIAL_REQUIRED',
      'Interpretive and representational modes require at least one in-scope, non-expired source bound to the represented subject and a promoted judgment grounded in that eligible source. Representational sources must also declare current ownership and authority.',
    ));
  }
  const sensitivePublicSourcesPending = workspace.exportPlan.access === 'public'
    ? workspace.materials.filter((material) => (
        material.sensitivity === 'sensitive' &&
        material.in_scope !== false &&
        material.public_export_review?.status !== 'approved'
      ))
    : [];
  for (const material of sensitivePublicSourcesPending) {
    problems.push(blocking(
      'SENSITIVE_PUBLIC_EXPORT_BLOCKED',
      `Sensitive source ${material.id} is not approved as a public-safe abstraction.`,
      material.id,
    ));
  }

  if (units.length === 0) {
    problems.push(blocking('NO_JUDGMENTS', 'At least one promoted JudgmentUnit is required.'));
  }
  let unitsComplete = units.length > 0;
  let traceable = units.length > 0;
  for (const unit of units) {
    if (!completeUnit(unit)) {
      unitsComplete = false;
      problems.push(blocking(
        'JUDGMENT_INCOMPLETE',
        `Judgment ${unit.id} lacks a required statement, rationale, boundary, risk, source, or confidence state.`,
        unit.id,
      ));
    }
    for (const ref of unit.source_refs || []) {
      const inference = ref.startsWith('agent-inference:');
      if (!materialIds.has(ref) && !(unit.agent_inference && inference)) {
        traceable = false;
        problems.push(blocking(
          'SOURCE_REFERENCE_UNKNOWN',
          `Judgment ${unit.id} references unknown source ${ref}.`,
          unit.id,
        ));
      }
    }
  }

  const core = workspace.judgmentModel.judgment_core;
  const coreComplete = Boolean(
    core &&
    optionalString(core.highest_question) &&
    Array.isArray(core.worldview) && core.worldview.length > 0 &&
    Array.isArray(core.value_order) && core.value_order.length > 0 &&
    core.judgment_role && Object.keys(core.judgment_role).length > 0 &&
    workspace.judgmentModel.global_boundaries.length > 0,
  );
  if (!coreComplete) {
    problems.push(blocking(
      'JUDGMENT_CORE_INCOMPLETE',
      'Judgment core and at least one explicit global boundary are required.',
    ));
  }

  const unresolvedConflicts = workspace.judgmentModel.relations.filter((relation) => (
    relation.type === 'conflict' && relation.status !== 'resolved' &&
    relation.status !== 'rejected'
  ));
  for (const relation of unresolvedConflicts) {
    problems.push(blocking(
      'UNRESOLVED_CONFLICT',
      `Conflict ${relation.id} has no explicit resolution.`,
      relation.id,
    ));
  }
  const unreviewedRelations = workspace.judgmentModel.relations.filter((relation) => (
    relation.type !== 'conflict' && relation.status === 'proposed'
  ));
  for (const relation of unreviewedRelations) {
    problems.push(blocking(
      'RELATION_REVIEW_REQUIRED',
      `Proposed ${relation.type} relation ${relation.id} needs an explicit acceptance or rejection.`,
      relation.id,
    ));
  }
  const unresolvedSplits = workspace.judgmentModel.split_recommendations.filter((split) => (
    split.decision === 'pending' ||
    (split.decision === 'accepted' && split.unit_ids.some((unitId) => (
      units.some((unit) => unit.id === unitId)
    )))
  ));
  for (const split of unresolvedSplits) {
    problems.push(blocking(
      'UNRESOLVED_SPLIT',
      split.decision === 'accepted'
        ? `Accepted split ${split.id} still has units in this workspace.`
        : `Split recommendation ${split.id} needs an explicit decision.`,
      split.id,
    ));
  }

  const openQuestions = workspace.unresolvedQuestions.filter(
    (question) => question.status === 'open',
  );
  for (const question of openQuestions) {
    problems.push(blocking(
      'UNRESOLVED_QUESTION',
      question.reason,
      question.id,
    ));
  }

  const confirmations = confirmationAssessment(workspace);
  if (!confirmations.satisfied) {
    problems.push(blocking('CONFIRMATION_REQUIRED', confirmations.reason));
  }

  const passed = currentPassedTests(workspace);
  const currentTestCases = workspace.semanticTestReport.cases.filter(
    (testCase) => testCase.semantic_digest === workspace.state.semantic_digest,
  );
  const currentPlan = (workspace.semanticTestReport.plans || []).find(
    (plan) =>
      plan.status === 'valid' &&
      plan.semantic_digest === workspace.state.semantic_digest &&
      plan.definition_digest === canonicalTestDefinitionDigest(workspace) &&
      plan.test_ids.length === currentTestCases.length &&
      plan.test_ids.every((testId) =>
        currentTestCases.some((testCase) => testCase.id === testId)),
  );
  if (
    currentTestCases.some(
      (testCase) => testCase.expected_creator_label !== null,
    ) &&
    !currentPlan
  ) {
    problems.push(blocking(
      'SEMANTIC_TEST_PLAN_MISSING',
      'Creator-label expectations must be frozen in a current test plan before evaluation.',
    ));
  }
  const unresolvedCurrentTests = workspace.semanticTestReport.cases.filter(
    (testCase) => (
      testCase.semantic_digest === workspace.state.semantic_digest &&
      (
        testCase.status !== 'passed' ||
        testCase.result !== 'pass' ||
        !semanticTestStateConsistent(testCase)
      )
    ),
  );
  for (const testCase of unresolvedCurrentTests) {
    const consistent = semanticTestStateConsistent(testCase);
    if (!consistent) {
      problems.push(blocking(
        'SEMANTIC_TEST_INCONSISTENT',
        `Semantic test ${testCase.id} has inconsistent status, result, or evaluation state.`,
        testCase.id,
      ));
    } else if (testCase.status === 'failed') {
      problems.push(blocking(
        'SEMANTIC_TEST_FAILED',
        `Semantic test ${testCase.id} failed and requires repair and retest.`,
        testCase.id,
      ));
    } else if (testCase.status === 'inconclusive') {
      problems.push(blocking(
        'SEMANTIC_TEST_INCONCLUSIVE',
        `Semantic test ${testCase.id} is inconclusive and requires an explicit new evaluation.`,
        testCase.id,
      ));
    } else {
      problems.push(blocking(
        'SEMANTIC_TEST_PENDING',
        `Semantic test ${testCase.id} is waiting for evaluation.`,
        testCase.id,
      ));
    }
  }
  let unitCasesComplete = units.length > 0;
  for (const unit of units) {
    const applicable = passed.some((testCase) => (
      testCase.kind === 'applicable' && testCase.unit_ids.includes(unit.id)
    ));
    const counterexample = passed.some((testCase) => (
      testCase.kind === 'counterexample' && testCase.unit_ids.includes(unit.id)
    ));
    if (!applicable || !counterexample) {
      unitCasesComplete = false;
      problems.push(blocking(
        'UNIT_TEST_COVERAGE_INCOMPLETE',
        `Judgment ${unit.id} needs a passed applicable case and counterexample.`,
        unit.id,
      ));
    }
  }
  let boundaryCasesComplete = workspace.judgmentModel.global_boundaries.length > 0;
  for (const boundary of workspace.judgmentModel.global_boundaries) {
    const covered = passed.some((testCase) => (
      testCase.kind === 'boundary' && testCase.boundary_ids.includes(boundary.id)
    ));
    if (!covered) {
      boundaryCasesComplete = false;
      problems.push(blocking(
        'BOUNDARY_TEST_MISSING',
        `Global boundary ${boundary.id} needs a passed semantic test.`,
        boundary.id,
      ));
    }
  }

  const representsExternalSubject = ['human-confirmed', 'organization-confirmed'].includes(
    workspace.state.mode,
  );
  const holdoutComplete = !representsExternalSubject || passed.some((testCase) => (
    testCase.kind === 'holdout' &&
    testCase.held_out === true &&
    testCase.evaluated_by &&
    testCase.evaluated_by.type !== 'agent'
  ));
  if (!holdoutComplete) {
    problems.push(blocking(
      'HOLDOUT_TEST_MISSING',
      'Representational claims require a passed held-out real-task test evaluated by a non-Agent actor.',
    ));
  }

  const acceptance = workspace.semanticTestReport.acceptance;
  const acceptanceActorValid = Boolean(
    acceptance && agentMayAcceptTestReport(workspace, acceptance.actor)
  );
  const testAcceptanceComplete = Boolean(
    acceptance &&
    acceptance.accepted === true &&
    acceptance.status === 'valid' &&
    acceptance.semantic_digest === workspace.state.semantic_digest &&
    acceptance.test_report_digest === canonicalTestReportDigest(workspace) &&
    acceptanceActorValid,
  );
  if (!testAcceptanceComplete) {
    problems.push(blocking(
      'SEMANTIC_TEST_ACCEPTANCE_MISSING',
      workspace.state.mode === 'agent-authored'
        ? 'The declared creating Agent or a non-Agent actor must accept the current semantic test report.'
        : (
            workspace.state.mode === 'interpretive' &&
            workspace.purposeBrief?.represented_subject?.type === 'agent'
          )
          ? 'The distinct represented Agent subject or a non-Agent actor must accept the current semantic test report for the declared scope.'
          : 'A non-Agent acceptance actor must accept the current semantic test report for the declared scope.',
    ));
  }

  const openRepairs = workspace.repairPlan.items.filter((item) => (
    item.status === 'open' && item.severity === 'blocking'
  ));
  for (const item of openRepairs) {
    problems.push(blocking('OPEN_REPAIR', item.problem, item.id));
  }

  const invalidatedReceipts = workspace.confirmationReceipts.filter(
    (receipt) => receipt.status === 'invalidated',
  ).length;
  const invalidatedTests = workspace.semanticTestReport.cases.filter(
    (testCase) => testCase.status === 'invalidated',
  ).length;
  if (invalidatedReceipts > 0) {
    warnings.push(`${invalidatedReceipts} confirmation receipt(s) were invalidated by semantic change.`);
  }
  if (invalidatedTests > 0) {
    warnings.push(`${invalidatedTests} semantic test result(s) were invalidated by semantic change.`);
  }

  const formatReady = purposeComplete && sourceGrounded &&
    sensitivePublicSourcesPending.length === 0 && unitsComplete && traceable &&
    coreComplete && unresolvedConflicts.length === 0 && unresolvedSplits.length === 0 &&
    openQuestions.length === 0;
  const creationAccepted = problems.length === 0;
  const gates = completionGates(workspace, creationAccepted);
  const result = {
    compile_ready: formatReady,
    format_ready: formatReady,
    creation_accepted: creationAccepted,
    completion_gates: gates,
    mode: workspace.state.mode,
    workflow_mode: workspace.state.workflow_mode,
    status: workspace.state.status,
    blocking: problems,
    warnings,
    requirements: {
      purpose_explicit: purposeComplete,
      source_grounding_complete: sourceGrounded,
      public_source_safety_complete: sensitivePublicSourcesPending.length === 0,
      judgments_complete_and_traceable: unitsComplete && traceable,
      judgment_core_and_boundaries_explicit: coreComplete,
      conflicts_and_splits_resolved:
        unresolvedConflicts.length === 0 &&
        unreviewedRelations.length === 0 &&
        unresolvedSplits.length === 0,
      unresolved_questions_resolved: openQuestions.length === 0,
      confirmations_current: confirmations.satisfied,
      unit_cases_complete: unitCasesComplete,
      boundary_cases_complete: boundaryCasesComplete,
      holdout_complete: holdoutComplete,
      declared_tests_complete: unresolvedCurrentTests.length === 0,
      semantic_test_acceptance_current: testAcceptanceComplete,
      repairs_resolved: openRepairs.length === 0,
    },
    semantic_digest: workspace.state.semantic_digest,
    semantic_revision: workspace.state.semantic_revision,
  };
  result.next_action = computeNextAction(workspace, result);
  return result;
}

function computeNextAction(workspace, assessment = null) {
  if (!workspace.purposeBrief) {
    return {
      action: 'set_purpose',
      state: 'needs_purpose',
      reason: 'Purpose, scope, loading condition, and judgment core are not declared.',
      requires_user: true,
      unresolved_ids: [],
    };
  }
  if (
    workspace.materials.length === 0 &&
    workspace.candidates.length === 0 &&
    workspace.judgmentModel.units.length === 0
  ) {
    const canInfer = workspace.state.mode === 'agent-authored';
    const hasInterview = workspace.interviewAnswers.length > 0;
    return {
      action: canInfer
        ? 'add_candidate'
        : (hasInterview ? 'ingest_material' : 'record_interview_answer'),
      state: 'needs_sources',
      reason: canInfer
        ? 'Add a complete Agent-inferred candidate or ingest source material.'
        : (
            hasInterview
              ? 'Bind the recorded interview answer as a classified interview source before proposing judgments.'
              : 'Start a source interview or ingest existing material for this creation mode.'
          ),
      requires_user: !canInfer,
      unresolved_ids: [],
    };
  }
  const proposed = workspace.candidates.filter((candidate) => candidate.status === 'proposed');
  if (workspace.materials.length > 0 && proposed.length === 0 &&
      workspace.judgmentModel.units.length === 0) {
    return {
      action: 'add_candidate',
      state: 'analyzing_sources',
      reason: 'Interpret the materials and add complete, traceable candidates.',
      requires_user: false,
      unresolved_ids: workspace.materials.map((material) => material.id),
    };
  }
  if (proposed.length > 0) {
    return {
      action: 'promote_candidate',
      state: 'eliciting_judgment',
      reason: 'Review, reject, or promote the proposed judgment candidates.',
      requires_user: true,
      unresolved_ids: proposed.map((candidate) => candidate.id),
    };
  }
  const uncertain = workspace.judgmentModel.units.filter((unit) => (
    ['low', 'unknown'].includes(unit.confidence.status)
  ));
  if (uncertain.length > 0) {
    return {
      action: 'record_interview_answer',
      state: 'eliciting_judgment',
      reason: 'Clarify the lowest-confidence promoted judgments before acceptance.',
      requires_user: true,
      unresolved_ids: uncertain.map((unit) => unit.id),
    };
  }
  const conflicts = workspace.judgmentModel.relations.filter((relation) => (
    relation.type === 'conflict' &&
    !['resolved', 'rejected'].includes(relation.status)
  ));
  const splits = workspace.judgmentModel.split_recommendations.filter((split) => (
    split.decision === 'pending' || split.decision === 'accepted'
  ));
  if (conflicts.length > 0 || splits.length > 0) {
    return {
      action: 'analyze_relations',
      state: 'eliciting_judgment',
      reason: 'Resolve explicit conflicts and asset split recommendations.',
      requires_user: true,
      unresolved_ids: [
        ...conflicts.map((relation) => relation.id),
        ...splits.map((split) => split.id),
      ],
    };
  }
  const openQuestions = workspace.unresolvedQuestions.filter(
    (question) => question.status === 'open',
  );
  if (openQuestions.length > 0) {
    return {
      action: 'record_interview_answer',
      state: 'eliciting_judgment',
      reason: openQuestions[0].reason,
      requires_user: true,
      unresolved_ids: openQuestions.map((question) => question.id),
    };
  }
  const confirmations = confirmationAssessment(workspace);
  if (!confirmations.satisfied) {
    return {
      action: 'record_confirmation',
      state: 'awaiting_confirmation',
      reason: confirmations.reason,
      requires_user: true,
      unresolved_ids: workspace.judgmentModel.units.map((unit) => unit.id),
    };
  }
  const failed = workspace.semanticTestReport.cases.filter((testCase) => (
    testCase.semantic_digest === workspace.state.semantic_digest &&
    testCase.status === 'failed'
  ));
  const openRepairs = workspace.repairPlan.items.filter((item) => item.status === 'open');
  if (failed.length > 0 || openRepairs.length > 0) {
    return {
      action: openRepairs.length > 0 ? 'apply_repair' : 'build_repair_plan',
      state: 'repairing',
      reason: 'Failed semantic tests require an explicit repair and retest.',
      requires_user: openRepairs.length > 0,
      unresolved_ids: openRepairs.length > 0
        ? openRepairs.map((item) => item.id)
        : failed.map((testCase) => testCase.id),
    };
  }
  const pendingTests = workspace.semanticTestReport.cases.filter((testCase) => (
    ['pending', 'inconclusive'].includes(testCase.status) &&
    testCase.semantic_digest === workspace.state.semantic_digest
  ));
  if (pendingTests.length > 0) {
    return {
      action: 'record_semantic_test_result',
      state: 'testing',
      reason: pendingTests.some((testCase) => testCase.status === 'inconclusive')
        ? 'Inconclusive semantic tests require an explicit new evaluation.'
        : 'Current semantic tests are waiting for evaluation.',
      requires_user: true,
      unresolved_ids: pendingTests.map((testCase) => testCase.id),
    };
  }
  const readiness = assessment || assessReadiness(workspace);
  const testBlocks = readiness.blocking.filter((item) => (
    item.code === 'UNIT_TEST_COVERAGE_INCOMPLETE' ||
    item.code === 'BOUNDARY_TEST_MISSING' ||
    item.code === 'HOLDOUT_TEST_MISSING'
  ));
  if (testBlocks.length > 0) {
    return {
      action: 'add_semantic_test',
      state: 'testing',
      reason: testBlocks[0].message,
      requires_user: true,
      unresolved_ids: testBlocks.map((item) => item.target_id).filter(Boolean),
    };
  }
  if (!readiness.requirements.semantic_test_acceptance_current) {
    const agentSubjectCanAccept =
      workspace.state.mode === 'agent-authored' ||
      (
        workspace.state.mode === 'interpretive' &&
        workspace.purposeBrief?.represented_subject?.type === 'agent' &&
        workspace.purposeBrief.represented_subject.id !==
          workspace.state.created_by.id
      );
    return {
      action: 'record_semantic_test_result',
      state: 'testing',
      reason: workspace.state.mode === 'agent-authored'
        ? 'The declared creating Agent or a non-Agent actor must accept the current semantic test report.'
        : (
            agentSubjectCanAccept
              ? 'The distinct represented Agent subject or a non-Agent actor must accept the current semantic test report.'
              : 'A non-Agent actor must accept the current semantic test report.'
          ),
      requires_user: !agentSubjectCanAccept,
      unresolved_ids: [],
    };
  }
  if (readiness.creation_accepted) {
    const gates = readiness.completion_gates ||
      completionGates(workspace, true);
    if (!gates.format_valid) {
      return {
        action: 'compile_project',
        state: 'ready_to_export',
        reason:
          'JUDGMENT_ACCEPTED is current; compile and verify the exact final .kdna with Core to obtain FORMAT_VALID.',
        requires_user: false,
        unresolved_ids: [],
      };
    }
    if (!gates.application_plan_id) {
      return {
        action: 'freeze_application_test_plan',
        state: 'testing',
        reason:
          'After FORMAT_VALID, freeze a separately keyed fresh-hidden free-response adoption-fidelity plan bound to this exact asset and build receipt.',
        requires_user: false,
        unresolved_ids: [],
      };
    }
    if (gates.application_attempt_id) {
      if (!gates.application_observation_id) {
        return {
          action: 'record_application_asset_observation',
          state: 'testing',
          reason:
            'The frozen Consumer must open and Core-load the exact final asset in a separate one-use observation before signing task results.',
          requires_user: false,
          unresolved_ids: [],
        };
      }
      return {
        action: 'record_application_verification',
        state: 'testing',
        reason:
          'Run the frozen tasks in independent with-KDNA and without-KDNA Consumer lanes against the exact final asset, sign the Engine-issued single-use attempt, then record the evaluator receipt.',
        requires_user: false,
        unresolved_ids: [],
      };
    }
    if (gates.application_failure_class === 'authorization-failed') {
      return {
        action: 'resolve_application_authorization',
        state: 'testing',
        reason:
          'The exact asset was not authorized for the Consumer. Resolve authorization separately from judgment/application repair and rerun the same lanes.',
        requires_user: true,
        unresolved_ids: [],
      };
    }
    if (gates.application_failure_class === 'application-failed') {
      const failedReceipt = [...workspace.applicationVerification.receipts]
        .reverse()
        .find((receipt) => (
          receipt.id === gates.application_receipt_id
        ));
      return {
        action: 'build_repair_plan',
        state: 'repairing',
        reason:
          'Independent Consumer application failed the frozen gate; repair only the exposed judgment or boundary and rerun the same plan.',
        requires_user: false,
        unresolved_ids: failedReceipt
          ? failedReceipt.task_results
            .filter((result) => (
              !result.evaluation.faithful ||
              !result.evaluation.boundary_correct ||
              !result.evaluation.exception_correct ||
              !result.evaluation.exit_correct ||
              result.with_kdna.over_applied ||
              result.with_kdna.exit === 'error'
            ))
            .map((result) => result.task_id)
          : [],
      };
    }
    if (!gates.application_verified) {
      return {
        action: 'issue_application_attempt',
        state: 'testing',
        reason:
          'Issue a fresh single-use application challenge bound to the frozen plan and exact final asset before either Consumer or evaluator result is signed.',
        requires_user: false,
        unresolved_ids: [],
      };
    }
    return {
      action: 'complete',
      state: 'exported',
      reason:
        'FORMAT_VALID, JUDGMENT_ACCEPTED, and APPLICATION_VERIFIED bind the same semantic and asset digests.',
      requires_user: false,
      unresolved_ids: [],
    };
  }
  return {
    action: 'review_blockers',
    state: 'eliciting_judgment',
    reason: readiness.blocking[0]?.message || 'Creation requirements remain unresolved.',
    requires_user: true,
    unresolved_ids: readiness.blocking.map((item) => item.target_id).filter(Boolean),
  };
}

function stateForAction(action) {
  return CREATION_STATES.includes(action.state) ? action.state : 'eliciting_judgment';
}

function evolve(workspace, event, mutator) {
  assertWorkspace(workspace);
  const next = clone(workspace);
  const previousDigest = next.state.semantic_digest;
  mutator(next);
  next.state.updated_at = now();
  next.state.semantic_digest = canonicalSemanticDigest(next);
  const semanticChanged = previousDigest !== next.state.semantic_digest;
  if (semanticChanged) next.state.semantic_revision += 1;
  maybeBumpJudgmentVersions(next, semanticChanged);
  invalidateBoundEvidence(next, next.state.updated_at);
  invalidateChangedApplicationEvidence(next, next.state.updated_at);
  const action = computeNextAction(next);
  next.state.status = stateForAction(action);
  next.state.next_unresolved_reason = action.action === 'complete' ? null : action.reason;
  next.history.push({
    revision: next.state.semantic_revision,
    event,
    semantic_digest: next.state.semantic_digest,
    at: next.state.updated_at,
  });
  assertWorkspace(next);
  return next;
}

function normalizeSubject(subject, label) {
  if (subject === null || subject === undefined) return null;
  assertPlainObject(subject, label);
  const type = nonEmpty(subject.type, `${label}.type`);
  if (!['agent', 'human', 'organization', 'work', 'source-subject'].includes(type)) {
    throw new Error(`${label}.type is invalid`);
  }
  return {
    type,
    id: nonEmpty(subject.id, `${label}.id`),
    ...(optionalString(subject.name) ? { name: optionalString(subject.name) } : {}),
  };
}

function normalizeRole(role = {}) {
  assertPlainObject(role, 'judgment_role');
  const result = {};
  if (optionalString(role.acts_as)) result.acts_as = optionalString(role.acts_as);
  const exclusions = stringList(role.does_not_act_as, 'judgment_role.does_not_act_as');
  if (exclusions.length > 0) result.does_not_act_as = exclusions;
  if (optionalString(role.responsibility)) {
    result.responsibility = optionalString(role.responsibility);
  }
  if (Object.keys(result).length === 0) {
    throw new Error('judgment_role requires at least one declared field');
  }
  return result;
}

function normalizeBoundary(boundary, index) {
  if (typeof boundary === 'string') {
    return {
      id: `boundary_${index + 1}`,
      statement: nonEmpty(boundary, `global_boundaries[${index}]`),
      source_refs: [],
    };
  }
  assertPlainObject(boundary, `global_boundaries[${index}]`);
  return {
    id: boundary.id || `boundary_${index + 1}`,
    statement: nonEmpty(boundary.statement, `global_boundaries[${index}].statement`),
    source_refs: stringList(
      boundary.source_refs,
      `global_boundaries[${index}].source_refs`,
    ),
  };
}

function normalizePurposeBrief(workspace, input = {}) {
  const objective = nonEmpty(input.objective, 'objective');
  const scope = nonEmpty(input.scope, 'scope');
  const nonGoals = stringList(input.non_goals, 'non_goals');
  const loadingCondition = nonEmpty(input.loading_condition, 'loading_condition');
  const highestQuestion = nonEmpty(input.highest_question, 'highest_question');
  const worldview = stringList(input.worldview, 'worldview', { required: true });
  const valueOrder = stringList(input.value_order, 'value_order', { required: true });
  const boundaries = (input.global_boundaries || []).map(normalizeBoundary);
  if (boundaries.length === 0) {
    throw new Error('global_boundaries requires at least one explicit boundary');
  }
  const boundaryStatements = new Set(
    boundaries.map((boundary) => boundary.statement),
  );
  for (const nonGoal of nonGoals) {
    if (!boundaryStatements.has(nonGoal)) {
      throw new Error(
        'every non_goals entry must exactly match an explicit global boundary',
      );
    }
  }
  let representedSubject = normalizeSubject(input.represented_subject, 'represented_subject');
  if (workspace.state.mode === 'agent-authored' && !representedSubject) {
    representedSubject = {
      type: 'agent',
      id: workspace.state.created_by.id,
      ...(workspace.state.created_by.name ? { name: workspace.state.created_by.name } : {}),
    };
  }
  const purpose = {
    title: optionalString(input.title) || objective,
    objective,
    scope,
    non_goals: nonGoals,
    loading_condition: loadingCondition,
    represented_subject: representedSubject,
    highest_question: highestQuestion,
    worldview,
    value_order: valueOrder,
    judgment_role: normalizeRole(input.judgment_role),
    global_boundaries: boundaries,
  };
  return purpose;
}

function setPurpose(workspace, input = {}) {
  const purpose = normalizePurposeBrief(workspace, input);
  return evolve(workspace, 'purpose_set', (next) => {
    next.purposeBrief = purpose;
    next.judgmentModel.judgment_core = {
      highest_question: purpose.highest_question,
      worldview: clone(purpose.worldview),
      value_order: clone(purpose.value_order),
      judgment_role: clone(purpose.judgment_role),
    };
    next.judgmentModel.global_boundaries = clone(purpose.global_boundaries);
  });
}

function detectInjection(content) {
  const text = Buffer.isBuffer(content) ? content.toString('utf8') : String(content || '');
  const indicators = [];
  for (const { code, pattern } of PROMPT_INJECTION_PATTERNS) {
    if (pattern.test(text)) indicators.push(code);
  }
  return [...new Set(indicators)];
}

function detectSensitive(content) {
  const text = Buffer.isBuffer(content) ? content.toString('utf8') : String(content || '');
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(text));
}

function ingestMaterial(workspace, input = {}) {
  const kind = nonEmpty(input.kind, 'kind');
  const title = nonEmpty(input.title, 'title');
  const suppliedBytes = input.bytes !== undefined
    ? input.bytes
    : input.content;
  const inspectionContent = input.content !== undefined
    ? input.content
    : suppliedBytes;
  let contentHash = input.content_hash || null;
  if (suppliedBytes !== undefined) {
    const computedHash = sha256(suppliedBytes);
    if (contentHash && assertDigest(contentHash, 'content_hash') !== computedHash) {
      throw new Error('content_hash does not match the supplied material bytes');
    }
    contentHash = computedHash;
  }
  assertDigest(contentHash, 'content_hash');
  const injectionIndicators =
    inspectionContent === undefined ? [] : detectInjection(inspectionContent);
  const inferredSensitive =
    inspectionContent === undefined ? false : detectSensitive(inspectionContent);
  const sensitivity = input.sensitivity || (inferredSensitive ? 'sensitive' : 'private');
  if (!['public', 'private', 'sensitive'].includes(sensitivity)) {
    throw new Error('sensitivity must be public, private, or sensitive');
  }
  const authority = input.authority || 'unknown';
  if (!SOURCE_AUTHORITIES.includes(authority)) {
    throw new Error(`authority must be one of: ${SOURCE_AUTHORITIES.join(', ')}`);
  }
  const currentness = input.currentness || 'unknown';
  if (!['current', 'historical', 'unknown'].includes(currentness)) {
    throw new Error('currentness must be current, historical, or unknown');
  }
  const timeBasis = input.time_basis || 'unknown';
  if (!['declared', 'file-metadata', 'asset-manifest', 'unknown'].includes(timeBasis)) {
    throw new Error(
      'time_basis must be declared, file-metadata, asset-manifest, or unknown',
    );
  }
  const triState = (value, label) => {
    const normalized = value === undefined ? 'unknown' : value;
    if (![true, false, 'unknown'].includes(normalized)) {
      throw new Error(`${label} must be true, false, or unknown`);
    }
    return normalized;
  };
  const record = {
    id: input.id || id('source'),
    kind,
    title,
    content_hash: contentHash,
    reference: optionalString(input.reference),
    source_subject_id: optionalString(input.source_subject_id),
    belongs_to_subject: triState(input.belongs_to_subject, 'belongs_to_subject'),
    represents_current_judgment: triState(
      input.represents_current_judgment,
      'represents_current_judgment',
    ),
    authority,
    currentness,
    source_created_at: optionalDateTime(
      input.source_created_at,
      'source_created_at',
    ),
    source_updated_at: optionalDateTime(
      input.source_updated_at,
      'source_updated_at',
    ),
    time_basis: timeBasis,
    sensitivity,
    external_constraints: stringList(input.external_constraints, 'external_constraints'),
    in_scope: triState(input.in_scope, 'in_scope'),
    split_domain: optionalString(input.split_domain),
    expired: input.expired === true,
    trust: {
      treat_as_untrusted_data: true,
      instructions_are_agent_commands: false,
      prompt_injection_detected: injectionIndicators.length > 0,
      indicators: injectionIndicators,
    },
    include_in_runtime: false,
    review_receipts: [],
    public_export_review: sensitivity === 'sensitive'
      ? (
          workspace.exportPlan.access === 'public'
            ? {
                status: 'pending',
                decision: null,
                reviewer: null,
                rationale: null,
                reviewed_at: null,
              }
            : {
                status: 'not-required',
                decision: 'non-public-isolation',
                reviewer: null,
                rationale: 'The export plan is not public and source bodies remain excluded.',
                reviewed_at: now(),
              }
        )
      : {
          status: 'not-required',
          decision: null,
          reviewer: null,
          rationale: null,
          reviewed_at: null,
        },
    ingested_at: now(),
  };
  return evolve(workspace, 'material_ingested', (next) => {
    if (next.materials.some((material) => material.id === record.id)) {
      throw new Error(`material already exists: ${record.id}`);
    }
    next.materials.push(record);
    if (record.trust.prompt_injection_detected) {
      next.unresolvedQuestions.push({
        id: id('question'),
        kind: 'source_safety',
        reason: `Source ${record.id} contains instruction-like text and remains untrusted data.`,
        target_id: record.id,
        status: 'open',
        created_at: now(),
        resolved_at: null,
      });
    }
    if (
      record.sensitivity === 'sensitive' &&
      record.public_export_review.status === 'pending'
    ) {
      next.unresolvedQuestions.push({
        id: id('question'),
        kind: 'source_safety_sensitive_public',
        reason:
          `Sensitive source ${record.id} requires an explicit public-safe abstraction ` +
          'review before public export.',
        target_id: record.id,
        status: 'open',
        created_at: now(),
        resolved_at: null,
      });
    }
  });
}

function reviewMaterial(workspace, materialId, input = {}) {
  const changes = assertPlainObject(input.changes || {}, 'changes');
  const unsupported = Object.keys(changes).filter(
    (field) => !SOURCE_REVIEW_FIELDS.includes(field),
  );
  if (unsupported.length > 0) {
    throw new Error(
      `source review cannot change immutable fields: ${unsupported.join(', ')}`,
    );
  }
  if (Object.keys(changes).length === 0) {
    throw new Error('source review requires at least one classification change');
  }
  const reviewer = normalizeActor(
    input.reviewed_by || input.by,
    'reviewed_by',
    true,
  );
  const reason = nonEmpty(
    input.review_reason || input.reason,
    'review_reason',
  );
  return evolve(workspace, 'material_reviewed', (next) => {
    const material = next.materials.find((item) => item.id === materialId);
    if (!material) throw new Error(`material not found: ${materialId}`);
    const before = sourceReviewSnapshot(material);
    const beforeDigest = sourceReviewDigest(material);
    const triState = (value, label) => {
      if (![true, false, 'unknown'].includes(value)) {
        throw new Error(`${label} must be true, false, or unknown`);
      }
      return value;
    };
    if (Object.hasOwn(changes, 'source_subject_id')) {
      material.source_subject_id = optionalString(changes.source_subject_id);
    }
    if (Object.hasOwn(changes, 'belongs_to_subject')) {
      material.belongs_to_subject = triState(
        changes.belongs_to_subject,
        'belongs_to_subject',
      );
    }
    if (Object.hasOwn(changes, 'represents_current_judgment')) {
      material.represents_current_judgment = triState(
        changes.represents_current_judgment,
        'represents_current_judgment',
      );
    }
    if (Object.hasOwn(changes, 'authority')) {
      if (!SOURCE_AUTHORITIES.includes(changes.authority)) {
        throw new Error(
          `authority must be one of: ${SOURCE_AUTHORITIES.join(', ')}`,
        );
      }
      material.authority = changes.authority;
    }
    if (Object.hasOwn(changes, 'currentness')) {
      if (!['current', 'historical', 'unknown'].includes(changes.currentness)) {
        throw new Error('currentness must be current, historical, or unknown');
      }
      material.currentness = changes.currentness;
    }
    if (Object.hasOwn(changes, 'external_constraints')) {
      material.external_constraints = stringList(
        changes.external_constraints,
        'external_constraints',
      );
    }
    if (Object.hasOwn(changes, 'in_scope')) {
      material.in_scope = triState(changes.in_scope, 'in_scope');
    }
    if (Object.hasOwn(changes, 'split_domain')) {
      material.split_domain = optionalString(changes.split_domain);
    }
    if (Object.hasOwn(changes, 'expired')) {
      if (typeof changes.expired !== 'boolean') {
        throw new Error('expired must be boolean');
      }
      material.expired = changes.expired;
    }
    const changedFields = changedSourceFields(before, material);
    if (changedFields.length === 0) {
      throw new Error('source review must change at least one classification');
    }
    material.review_receipts.push({
      material_id: material.id,
      reviewer,
      reason,
      before_digest: beforeDigest,
      after_digest: sourceReviewDigest(material),
      changed_fields: changedFields,
      reviewed_at: now(),
    });
  });
}

function normalizeConfidence(value) {
  if (typeof value === 'string') {
    value = { status: value };
  }
  value = value || { status: 'unknown' };
  assertPlainObject(value, 'confidence');
  const status = value.status || 'unknown';
  if (!['low', 'medium', 'high', 'unknown'].includes(status)) {
    throw new Error('confidence.status must be low, medium, high, or unknown');
  }
  let score = value.score === undefined || value.score === null ? null : Number(value.score);
  if (score !== null && (!Number.isFinite(score) || score < 0 || score > 1)) {
    throw new Error('confidence.score must be between 0 and 1');
  }
  return {
    status,
    score,
    reason: optionalString(value.reason),
  };
}

function normalizeCandidate(workspace, input = {}, previous = null) {
  const merged = { ...(previous || {}), ...input };
  const cardType = merged.card_type || 'axiom';
  if (!CARD_TYPES.includes(cardType)) {
    throw new Error(`card_type must be one of: ${CARD_TYPES.join(', ')}`);
  }
  const agentInference = merged.agent_inference === true;
  let sourceRefs = stringList(merged.source_refs, 'source_refs');
  if (sourceRefs.length === 0 && agentInference) {
    sourceRefs = [`agent-inference:${workspace.state.created_by.id}`];
  }
  if (sourceRefs.length === 0) {
    throw new Error('source_refs requires source material or an explicit Agent inference');
  }
  return {
    id: previous?.id || merged.id || id('candidate'),
    status: previous?.status || 'proposed',
    statement: nonEmpty(merged.statement, 'statement'),
    rationale: nonEmpty(merged.rationale, 'rationale'),
    applies_when: stringList(merged.applies_when, 'applies_when', { required: true }),
    does_not_apply_when: stringList(
      merged.does_not_apply_when,
      'does_not_apply_when',
      { required: true },
    ),
    misuse_risk: nonEmpty(merged.misuse_risk, 'misuse_risk'),
    source_refs: sourceRefs,
    contrary_evidence: stringList(
      merged.contrary_evidence,
      'contrary_evidence',
      { required: true },
    ),
    confidence: normalizeConfidence(merged.confidence),
    confirmation_state: previous?.confirmation_state || (
      confirmationRequired(workspace.state.mode) ? 'unconfirmed' : 'not-required'
    ),
    agent_inference: agentInference,
    card_type: cardType,
    fields: clone(merged.fields || {}),
    created_at: previous?.created_at || now(),
    rejection_reason: previous?.rejection_reason || null,
    review_receipt: previous?.review_receipt || null,
  };
}

function candidateReviewSnapshot(candidate) {
  return Object.fromEntries(
    CANDIDATE_REVIEW_FIELDS.map((field) => [field, candidate[field]]),
  );
}

function candidateReviewDigest(candidate) {
  return sha256(stableStringify(candidateReviewSnapshot(candidate)));
}

function changedCandidateFields(before, after) {
  return CANDIDATE_REVIEW_FIELDS.filter(
    (field) =>
      stableStringify(before[field]) !== stableStringify(after[field]),
  );
}

function addCandidate(workspace, input = {}) {
  const candidate = normalizeCandidate(workspace, input);
  return evolve(workspace, 'candidate_added', (next) => {
    if (next.candidates.some((item) => item.id === candidate.id)) {
      throw new Error(`candidate already exists: ${candidate.id}`);
    }
    next.candidates.push(candidate);
    if (['low', 'unknown'].includes(candidate.confidence.status)) {
      next.unresolvedQuestions.push({
        id: id('question'),
        kind: 'candidate_uncertainty',
        reason: `Candidate ${candidate.id} needs clarification because confidence is ${candidate.confidence.status}.`,
        target_id: candidate.id,
        status: 'open',
        created_at: now(),
        resolved_at: null,
      });
    }
  });
}

function recordInterviewAnswer(workspace, input = {}) {
  const question = nonEmpty(input.question, 'question');
  const answer = nonEmpty(input.answer, 'answer');
  const entry = {
    id: input.id || id('answer'),
    question_id: optionalString(input.question_id),
    question,
    answer,
    by: nonEmpty(input.by || 'user', 'by'),
    source_refs: stringList(input.source_refs, 'source_refs'),
    recorded_at: now(),
  };
  return evolve(workspace, 'interview_answer_recorded', (next) => {
    next.interviewAnswers.push(entry);
    if (entry.question_id) {
      const unresolved = next.unresolvedQuestions.find(
        (item) => item.id === entry.question_id && item.status === 'open',
      );
      if (unresolved) {
        if (unresolved.kind === 'source_safety_sensitive_public') {
          const disposition = assertPlainObject(
            input.source_disposition,
            'source_disposition',
          );
          if (
            disposition.source_id !== unresolved.target_id ||
            disposition.decision !== 'public-safe-abstraction'
          ) {
            throw new Error(
              'sensitive public-source review requires a matching public-safe-abstraction disposition',
            );
          }
          const source = next.materials.find(
            (material) => material.id === disposition.source_id,
          );
          if (!source) throw new Error(`source not found: ${disposition.source_id}`);
          source.public_export_review = {
            status: 'approved',
            decision: 'public-safe-abstraction',
            reviewer: nonEmpty(disposition.reviewer || entry.by, 'source_disposition.reviewer'),
            rationale: nonEmpty(disposition.rationale, 'source_disposition.rationale'),
            reviewed_at: now(),
          };
        }
        unresolved.status = 'resolved';
        unresolved.resolved_at = now();
      }
    }
    for (const questionInput of input.unresolved || []) {
      next.unresolvedQuestions.push({
        id: questionInput.id || id('question'),
        kind: questionInput.kind || 'elicitation',
        reason: nonEmpty(questionInput.reason, 'unresolved.reason'),
        target_id: optionalString(questionInput.target_id),
        status: 'open',
        created_at: now(),
        resolved_at: null,
      });
    }
  });
}

function promoteCandidate(workspace, candidateId, changes = {}) {
  nonEmpty(candidateId, 'candidateId');
  const decision = changes.decision || 'promote';
  if (!['promote', 'reject'].includes(decision)) {
    throw new Error('changes.decision must be promote or reject');
  }
  return evolve(workspace, decision === 'reject' ? 'candidate_rejected' : 'candidate_promoted', (next) => {
    const candidate = next.candidates.find((item) => item.id === candidateId);
    if (!candidate) throw new Error(`candidate not found: ${candidateId}`);
    if (candidate.status !== 'proposed') {
      throw new Error(`candidate ${candidateId} is already ${candidate.status}`);
    }
    const beforeDigest = candidateReviewDigest(candidate);
    const reviewer = normalizeSubject(
      changes.reviewed_by || next.state.created_by,
      'changes.reviewed_by',
    );
    const reviewReason =
      optionalString(changes.review_reason) ||
      (decision === 'reject'
        ? optionalString(changes.reason)
        : 'No semantic correction was declared during promotion.');
    if (decision === 'reject') {
      candidate.status = 'rejected';
      candidate.rejection_reason = nonEmpty(changes.reason, 'changes.reason');
      candidate.review_receipt = {
        candidate_id: candidate.id,
        decision,
        reviewer,
        reason: nonEmpty(reviewReason, 'changes.review_reason'),
        before_digest: beforeDigest,
        after_digest: candidateReviewDigest(candidate),
        changed_fields: [],
        reviewed_at: now(),
      };
      return;
    }
    const updated = normalizeCandidate(next, changes, candidate);
    updated.status = 'promoted';
    updated.review_receipt = {
      candidate_id: candidate.id,
      decision,
      reviewer,
      reason: nonEmpty(reviewReason, 'changes.review_reason'),
      before_digest: beforeDigest,
      after_digest: candidateReviewDigest(updated),
      changed_fields: changedCandidateFields(candidate, updated),
      reviewed_at: now(),
    };
    Object.assign(candidate, updated);
    const unitId = changes.unit_id || `unit_${candidate.id.replace(/^candidate_/, '')}`;
    if (next.judgmentModel.units.some((unit) => unit.id === unitId)) {
      throw new Error(`judgment unit already exists: ${unitId}`);
    }
    next.judgmentModel.units.push({
      id: unitId,
      candidate_id: candidate.id,
      statement: candidate.statement,
      rationale: candidate.rationale,
      applies_when: clone(candidate.applies_when),
      does_not_apply_when: clone(candidate.does_not_apply_when),
      misuse_risk: candidate.misuse_risk,
      source_refs: clone(candidate.source_refs),
      contrary_evidence: clone(candidate.contrary_evidence),
      confidence: clone(candidate.confidence),
      confirmation_state: confirmationRequired(next.state.mode)
        ? 'unconfirmed'
        : 'not-required',
      agent_inference: candidate.agent_inference,
      card_type: candidate.card_type,
      fields: clone(candidate.fields),
      promoted_at: now(),
    });
    for (const unresolved of next.unresolvedQuestions) {
      if (unresolved.target_id === candidate.id && unresolved.status === 'open' &&
          !['low', 'unknown'].includes(candidate.confidence.status)) {
        unresolved.status = 'resolved';
        unresolved.resolved_at = now();
      }
    }
  });
}

function normalizeRelation(relation, units) {
  assertPlainObject(relation, 'relation');
  const type = nonEmpty(relation.type, 'relation.type');
  if (!RELATION_TYPES.includes(type)) {
    throw new Error(`relation.type must be one of: ${RELATION_TYPES.join(', ')}`);
  }
  const from = nonEmpty(relation.from, 'relation.from');
  const to = nonEmpty(relation.to, 'relation.to');
  if (from === to) throw new Error('relation endpoints must differ');
  if (!units.has(from) || !units.has(to)) {
    throw new Error(`relation endpoints must reference existing JudgmentUnit ids: ${from}, ${to}`);
  }
  const status = relation.status || 'proposed';
  if (!['proposed', 'accepted', 'resolved', 'rejected'].includes(status)) {
    throw new Error('relation.status is invalid');
  }
  if (type === 'conflict' && status === 'resolved' && !optionalString(relation.resolution)) {
    throw new Error('resolved conflict requires relation.resolution');
  }
  return {
    id: relation.id || id('relation'),
    type,
    from,
    to,
    rationale: nonEmpty(relation.rationale, 'relation.rationale'),
    status,
    resolution: optionalString(relation.resolution),
  };
}

function normalizeSplit(split, units) {
  assertPlainObject(split, 'split_recommendation');
  const unitIds = stringList(split.unit_ids, 'split.unit_ids', { required: true });
  for (const unitId of unitIds) {
    if (!units.has(unitId)) throw new Error(`split references unknown unit: ${unitId}`);
  }
  const decision = split.decision || 'pending';
  if (!['pending', 'accepted', 'rejected'].includes(decision)) {
    throw new Error('split.decision must be pending, accepted, or rejected');
  }
  const decisionReason = optionalString(split.decision_reason || split.reason_for_decision);
  if (decision === 'rejected' && !decisionReason) {
    throw new Error('rejected split recommendation requires decision_reason');
  }
  return {
    id: split.id || id('split'),
    unit_ids: unitIds,
    reason: nonEmpty(split.reason, 'split.reason'),
    triggers: stringList(split.triggers, 'split.triggers', { required: true }),
    decision,
    decision_reason: decisionReason,
  };
}

function analyzeRelations(workspace, input = {}) {
  assertPlainObject(input, 'input');
  return evolve(workspace, 'relations_analyzed', (next) => {
    const unitIds = new Set(next.judgmentModel.units.map((unit) => unit.id));
    for (const relationInput of input.relations || []) {
      const relation = normalizeRelation(relationInput, unitIds);
      if (next.judgmentModel.relations.some((item) => item.id === relation.id)) {
        throw new Error(`relation already exists: ${relation.id}`);
      }
      next.judgmentModel.relations.push(relation);
    }

    const normalizedStatements = new Map();
    for (const unit of next.judgmentModel.units) {
      const normalized = unit.statement.toLowerCase().replace(/\s+/g, ' ').trim();
      const previous = normalizedStatements.get(normalized);
      if (previous) {
        const exists = next.judgmentModel.relations.some((relation) => (
          relation.type === 'support' &&
          relation.from === unit.id &&
          relation.to === previous
        ));
        if (!exists) {
          next.judgmentModel.relations.push({
            id: id('relation'),
            type: 'support',
            from: unit.id,
            to: previous,
            rationale: 'The two units make the same normalized judgment and should be deduplicated or explicitly retained.',
            status: 'proposed',
            resolution: null,
          });
        }
      } else {
        normalizedStatements.set(normalized, unit.id);
      }
    }

    for (const splitInput of input.split_recommendations || []) {
      const split = normalizeSplit(splitInput, unitIds);
      const existing = next.judgmentModel.split_recommendations.find(
        (item) => item.id === split.id,
      );
      if (existing) Object.assign(existing, split);
      else next.judgmentModel.split_recommendations.push(split);
    }

    const splitDomains = new Map();
    for (const material of next.materials) {
      if (!material.split_domain) continue;
      const refs = next.judgmentModel.units
        .filter((unit) => unit.source_refs.includes(material.id))
        .map((unit) => unit.id);
      if (refs.length === 0) continue;
      const current = splitDomains.get(material.split_domain) || [];
      splitDomains.set(material.split_domain, [...new Set([...current, ...refs])]);
    }
    for (const [domain, refs] of splitDomains) {
      const exists = next.judgmentModel.split_recommendations.some((split) => (
        split.reason.includes(domain)
      ));
      if (!exists) {
        next.judgmentModel.split_recommendations.push({
          id: id('split'),
          unit_ids: refs,
          reason: `Source interpretation identifies a separately loadable domain: ${domain}.`,
          triggers: ['different problem domain'],
          decision: 'pending',
          decision_reason: null,
        });
      }
    }

    for (const resolution of input.resolve_conflicts || []) {
      const relation = next.judgmentModel.relations.find(
        (item) => item.id === resolution.relation_id,
      );
      if (!relation || relation.type !== 'conflict') {
        throw new Error(`conflict relation not found: ${resolution.relation_id}`);
      }
      relation.status = 'resolved';
      relation.resolution = nonEmpty(resolution.resolution, 'resolution');
    }
    for (const decision of input.relation_decisions || []) {
      assertPlainObject(decision, 'relation_decision');
      const relation = next.judgmentModel.relations.find(
        (item) => item.id === decision.relation_id,
      );
      if (!relation) {
        throw new Error(`relation not found: ${decision.relation_id}`);
      }
      if (relation.type === 'conflict') {
        throw new Error(
          'conflict relations must use resolve_conflicts with an explicit resolution',
        );
      }
      if (!['accepted', 'rejected'].includes(decision.decision)) {
        throw new Error('relation decision must be accepted or rejected');
      }
      relation.status = decision.decision;
      relation.resolution = nonEmpty(
        decision.reason,
        'relation_decision.reason',
      );
    }
  });
}

function normalizeActor(actor, label, allowAgent = false) {
  assertPlainObject(actor, label);
  const type = nonEmpty(actor.type, `${label}.type`);
  const allowed = allowAgent
    ? ['human', 'organization-authority', 'agent']
    : ['human', 'organization-authority'];
  if (!allowed.includes(type)) {
    throw new Error(`${label}.type must be one of: ${allowed.join(', ')}`);
  }
  return {
    id: nonEmpty(actor.id, `${label}.id`),
    type,
    ...(optionalString(actor.name) ? { name: optionalString(actor.name) } : {}),
    ...(optionalString(actor.authority)
      ? { authority: optionalString(actor.authority) }
      : {}),
  };
}

function recordConfirmation(workspace, input = {}) {
  if (!confirmationRequired(workspace.state.mode) &&
      !participationRequired(workspace.state.mode)) {
    throw new Error(
      `${workspace.state.mode} mode does not require a Creation confirmation receipt`,
    );
  }
  const actor = normalizeActor(input.actor, 'actor');
  const subject = normalizeSubject(input.subject, 'subject');
  if (!subject) throw new Error('subject is required');
  const purposeSubject = workspace.purposeBrief?.represented_subject;
  const claim = input.claim || (
    workspace.state.mode === 'human-assisted' ? 'participation' : 'representation'
  );
  if (!['participation', 'representation'].includes(claim)) {
    throw new Error('claim must be participation or representation');
  }
  if (workspace.state.mode === 'human-assisted') {
    if (claim !== 'participation' || actor.type !== 'human' ||
        subject.type !== 'human' || subject.id !== actor.id) {
      throw new Error(
        'human-assisted mode records the participating human without claiming representation',
      );
    }
  } else if (claim !== 'representation') {
    throw new Error(`${workspace.state.mode} requires a representation confirmation`);
  }
  const scope = input.scope || 'model';
  if (!['unit', 'core', 'boundaries', 'model'].includes(scope)) {
    throw new Error('scope must be unit, core, boundaries, or model');
  }
  if (input.semantic_digest &&
      assertDigest(input.semantic_digest, 'semantic_digest') !== workspace.state.semantic_digest) {
    throw new Error('confirmation semantic_digest does not match the current workspace');
  }
  if (workspace.state.mode === 'human-confirmed') {
    if (actor.type !== 'human' || !purposeSubject ||
        subject.id !== purposeSubject.id || actor.id !== purposeSubject.id) {
      throw new Error('human-confirmed mode requires the represented human to confirm');
    }
  }
  if (workspace.state.mode === 'organization-confirmed') {
    if (actor.type !== 'organization-authority' || !optionalString(actor.authority) ||
        !purposeSubject || subject.id !== purposeSubject.id) {
      throw new Error(
        'organization-confirmed mode requires an authorized actor for the represented organization',
      );
    }
  }
  const allUnitIds = workspace.judgmentModel.units.map((unit) => unit.id);
  const targetIds = stringList(
    input.target_ids === undefined
      ? (scope === 'model' ? allUnitIds : [])
      : input.target_ids,
    'target_ids',
  );
  if (scope === 'unit' && targetIds.length === 0) {
    throw new Error('unit confirmation requires target_ids');
  }
  for (const targetId of targetIds) {
    if (!allUnitIds.includes(targetId)) {
      throw new Error(`confirmation references unknown unit: ${targetId}`);
    }
  }
  const accepted = input.accepted !== false;
  const receipt = {
    id: input.id || id('confirmation'),
    claim,
    actor,
    subject,
    scope,
    target_ids: targetIds,
    statement: nonEmpty(input.statement, 'statement'),
    accepted,
    semantic_revision: workspace.state.semantic_revision,
    semantic_digest: workspace.state.semantic_digest,
    status: accepted ? 'valid' : 'rejected',
    confirmed_at: now(),
    invalidated_at: null,
  };
  return evolve(workspace, accepted ? 'confirmation_recorded' : 'confirmation_rejected', (next) => {
    next.confirmationReceipts.push(receipt);
    refreshUnitConfirmationState(next);
  });
}

function addSemanticTest(workspace, input = {}) {
  const kind = nonEmpty(input.kind, 'kind');
  if (!SEMANTIC_TEST_KINDS.includes(kind)) {
    throw new Error(`kind must be one of: ${SEMANTIC_TEST_KINDS.join(', ')}`);
  }
  const unitIds = stringList(input.unit_ids, 'unit_ids');
  const boundaryIds = stringList(input.boundary_ids, 'boundary_ids');
  const knownUnits = new Set(workspace.judgmentModel.units.map((unit) => unit.id));
  const knownBoundaries = new Set(
    workspace.judgmentModel.global_boundaries.map((boundary) => boundary.id),
  );
  for (const unitId of unitIds) {
    if (!knownUnits.has(unitId)) throw new Error(`semantic test references unknown unit: ${unitId}`);
  }
  for (const boundaryId of boundaryIds) {
    if (!knownBoundaries.has(boundaryId)) {
      throw new Error(`semantic test references unknown boundary: ${boundaryId}`);
    }
  }
  if (['applicable', 'counterexample', 'comparison'].includes(kind) &&
      unitIds.length === 0) {
    throw new Error(`${kind} test requires unit_ids`);
  }
  if (kind === 'boundary' && boundaryIds.length === 0) {
    throw new Error('boundary test requires boundary_ids');
  }
  const testCase = {
    id: input.id || id('semantic_test'),
    kind,
    input: nonEmpty(input.input, 'input'),
    expected: nonEmpty(input.expected, 'expected'),
    expected_creator_label:
      input.expected_creator_label === undefined
        ? null
        : nonEmpty(input.expected_creator_label, 'expected_creator_label'),
    unit_ids: unitIds,
    boundary_ids: boundaryIds,
    held_out: kind === 'holdout' ? input.held_out !== false : input.held_out === true,
    source_ref: optionalString(input.source_ref),
    semantic_digest: workspace.state.semantic_digest,
    status: 'pending',
    result: null,
    observed_creator_label: null,
    evaluated_by: null,
    notes: '',
    created_at: now(),
    evaluated_at: null,
    invalidated_at: null,
  };
  if (
    testCase.expected_creator_label !== null &&
    !['符合', '超出范围'].includes(testCase.expected_creator_label)
  ) {
    throw new Error(
      'expected_creator_label must be 符合 or 超出范围',
    );
  }
  return evolve(workspace, 'semantic_test_added', (next) => {
    if (next.semanticTestReport.cases.some((item) => item.id === testCase.id)) {
      throw new Error(`semantic test already exists: ${testCase.id}`);
    }
    next.semanticTestReport.cases.push(testCase);
    for (const plan of next.semanticTestReport.plans || []) {
      if (plan.status === 'valid') {
        plan.status = 'invalidated';
        plan.invalidated_at = now();
      }
    }
    invalidateChangedTestAcceptance(next, now());
  });
}

function freezeSemanticTestPlan(workspace, input = {}) {
  const actor = normalizeActor(input.actor, 'test_plan.actor', true);
  const definitions = currentSemanticTestDefinitions(workspace);
  if (definitions.length === 0) {
    throw new Error('test plan requires at least one current semantic test');
  }
  const currentCases = workspace.semanticTestReport.cases.filter(
    (testCase) =>
      testCase.semantic_digest === workspace.state.semantic_digest,
  );
  if (
    currentCases.some(
      (testCase) =>
        testCase.status !== 'pending' ||
        testCase.result !== null ||
        testCase.evaluated_by !== null ||
        testCase.evaluated_at !== null,
    )
  ) {
    throw new Error(
      'test plan must be frozen before any current semantic test is evaluated',
    );
  }
  if (
    currentCases.some(
      (testCase) => testCase.expected_creator_label === null,
    )
  ) {
    throw new Error(
      'test plan requires expected_creator_label on every current test',
    );
  }
  const definitionDigest = canonicalTestDefinitionDigest(workspace);
  const existing = workspace.semanticTestReport.plans.find(
    (plan) =>
      plan.status === 'valid' &&
      plan.semantic_digest === workspace.state.semantic_digest,
  );
  if (existing) {
    if (
      existing.definition_digest === definitionDigest &&
      existing.actor.type === actor.type &&
      existing.actor.id === actor.id
    ) {
      return workspace;
    }
    throw new Error('a different current semantic test plan is already frozen');
  }
  const receipt = {
    id: input.id || id('test_plan'),
    actor,
    statement: nonEmpty(input.statement, 'test_plan.statement'),
    semantic_digest: workspace.state.semantic_digest,
    definition_digest: definitionDigest,
    test_ids: definitions.map((testCase) => testCase.id),
    status: 'valid',
    frozen_at: now(),
    invalidated_at: null,
  };
  return evolve(workspace, 'semantic_test_plan_frozen', (next) => {
    next.semanticTestReport.plans.push(receipt);
    invalidateChangedTestAcceptance(next, receipt.frozen_at);
  });
}

function recordSemanticTestResult(workspace, testId, input = {}) {
  const evaluator = normalizeActor(input.evaluated_by, 'evaluated_by', true);
  return evolve(workspace, 'semantic_test_result_recorded', (next) => {
    const testCase = next.semanticTestReport.cases.find((item) => item.id === testId);
    if (!testCase) throw new Error(`semantic test not found: ${testId}`);
    if (testCase.semantic_digest !== next.state.semantic_digest) {
      throw new Error(`semantic test ${testId} is bound to an older semantic digest`);
    }
    if (testCase.expected_creator_label !== null) {
      const definitionDigest = canonicalTestDefinitionDigest(next);
      const plan = (next.semanticTestReport.plans || []).find(
        (candidate) =>
          candidate.status === 'valid' &&
          candidate.semantic_digest === next.state.semantic_digest &&
          candidate.definition_digest === definitionDigest &&
          candidate.test_ids.includes(testCase.id),
      );
      if (!plan) {
        throw new Error(
          'creator-label semantic tests require a frozen current test plan before evaluation',
        );
      }
    }
    if (Object.hasOwn(input, 'creator_label')) {
      throw new Error(
        'creator_label is not accepted; use observed_creator_label',
      );
    }
    let observedCreatorLabel = null;
    let result;
    if (testCase.expected_creator_label !== null) {
      observedCreatorLabel = nonEmpty(
        input.observed_creator_label,
        'observed_creator_label',
      );
      if (
        !['符合', '不符合', '超出范围'].includes(observedCreatorLabel)
      ) {
        throw new Error(
          'observed_creator_label must be 符合, 不符合, or 超出范围',
        );
      }
      if (
        next.state.mode === 'human-confirmed' &&
        (
          evaluator.type !== 'human' ||
          evaluator.id !== next.purposeBrief?.represented_subject?.id
        )
      ) {
        throw new Error(
          'human-confirmed creator labels must come from the represented human',
        );
      }
      if (
        next.state.mode === 'organization-confirmed' &&
        (
          evaluator.type !== 'organization-authority' ||
          !optionalString(evaluator.authority)
        )
      ) {
        throw new Error(
          'organization-confirmed creator labels require an authorized organization evaluator',
        );
      }
      result = (
        observedCreatorLabel !== '不符合' &&
        observedCreatorLabel === testCase.expected_creator_label
      )
        ? 'pass'
        : 'fail';
      if (input.result !== undefined && input.result !== result) {
        throw new Error(
          'result must match the observed creator label and frozen expectation',
        );
      }
    } else {
      result = nonEmpty(input.result, 'result');
      if (!['pass', 'fail', 'inconclusive'].includes(result)) {
        throw new Error('result must be pass, fail, or inconclusive');
      }
      if (input.observed_creator_label !== undefined) {
        throw new Error(
          'observed_creator_label requires a frozen expected_creator_label',
        );
      }
    }
    testCase.result = result;
    testCase.status = result === 'pass'
      ? 'passed'
      : (result === 'fail' ? 'failed' : 'inconclusive');
    testCase.observed_creator_label = observedCreatorLabel;
    testCase.evaluated_by = evaluator;
    testCase.notes = String(input.notes || '');
    testCase.evaluated_at = now();
    invalidateChangedTestAcceptance(next, testCase.evaluated_at);
    if (input.acceptance) {
      const acceptance = assertPlainObject(input.acceptance, 'acceptance');
      const actor = normalizeActor(acceptance.actor, 'acceptance.actor', true);
      if (!agentMayAcceptTestReport(next, actor)) {
        throw new Error(
          'an Agent may accept only its own Agent-authored report or an interpretation where it is the distinct represented Agent subject',
        );
      }
      const accepted = acceptance.accepted === true;
      next.semanticTestReport.acceptance = {
        accepted,
        actor,
        statement: nonEmpty(acceptance.statement, 'acceptance.statement'),
        semantic_digest: next.state.semantic_digest,
        test_report_digest: canonicalTestReportDigest(next),
        accepted_at: now(),
        status: accepted ? 'valid' : 'rejected',
        invalidated_at: null,
      };
    }
  });
}

function applicationPlanSnapshot(plan) {
  return {
    id: plan.id,
    ...(plan.verification_contract
      ? { verification_contract: plan.verification_contract }
      : {}),
    ...(plan.evidence_set
      ? { evidence_set: plan.evidence_set }
      : {}),
    ...(plan.response_mode
      ? { response_mode: plan.response_mode }
      : {}),
    frozen_by: plan.frozen_by,
    statement: plan.statement,
    key_registry_id: plan.key_registry_id,
    key_registry_digest: plan.key_registry_digest,
    creation_key_signature: plan.creation_key_signature,
    coordinator_key_signature: plan.coordinator_key_signature,
    plan_content_digest: plan.plan_content_digest,
    coordinator_plan_signature: plan.coordinator_plan_signature,
    creation_identity: plan.creation_identity,
    coordinator_identity: plan.coordinator_identity,
    semantic_revision: plan.semantic_revision,
    semantic_digest: plan.semantic_digest,
    judgment_evidence_digest: plan.judgment_evidence_digest,
    ...(plan.build_receipt_digest
      ? { build_receipt_digest: plan.build_receipt_digest }
      : {}),
    ...(plan.asset_digest
      ? { asset_digest: plan.asset_digest }
      : {}),
    evaluation_oracle_digest: plan.evaluation_oracle_digest,
    consumer_identity: plan.consumer_identity,
    evaluator_identity: plan.evaluator_identity,
    tasks: plan.tasks,
    thresholds: plan.thresholds,
    frozen_at: plan.frozen_at,
  };
}

function canonicalApplicationPlanDigest(plan) {
  return sha256(stableStringify(applicationPlanSnapshot(plan)));
}

function applicationKeyRegistrySnapshot(workspace, value) {
  const identity = (field) => normalizeApplicationIdentity(
    {
      id: value[field]?.id,
      public_key: value[field]?.public_key,
    },
    field,
  );
  return {
    schema: 'kdna.studio.application-key-registry/0.1.0',
    registry_id: nonEmpty(value.key_registry_id, 'key_registry_id'),
    workspace_id: workspace.state.workspace_id,
    semantic_revision:
      value.semantic_revision ?? workspace.state.semantic_revision,
    semantic_digest:
      value.semantic_digest || workspace.state.semantic_digest,
    judgment_evidence_digest:
      value.judgment_evidence_digest ||
      canonicalJudgmentEvidenceDigest(workspace),
    frozen_by: normalizeActor(value.frozen_by, 'frozen_by', true),
    creation_identity: identity('creation_identity'),
    coordinator_identity: identity('coordinator_identity'),
    consumer_identity: identity('consumer_identity'),
    evaluator_identity: identity('evaluator_identity'),
    frozen_at: optionalDateTime(value.frozen_at, 'frozen_at'),
  };
}

function applicationKeyRegistrySigningPayload(workspace, value) {
  assertPlainObject(value, 'application key registry');
  const snapshot = applicationKeyRegistrySnapshot(workspace, value);
  if (!snapshot.frozen_at) {
    throw new Error('frozen_at is required');
  }
  return Buffer.from(stableStringify(snapshot), 'utf8');
}

function applicationPlanSigningSnapshot(workspace, value) {
  const registryPayload = applicationKeyRegistrySigningPayload(
    workspace,
    value,
  );
  const tasks = Array.isArray(value.tasks)
    ? value.tasks.map((task) => ({
      id: task.id,
      input_digest: task.input_digest,
      risk_level: task.risk_level,
      unit_ids: task.unit_ids,
      boundary_ids: task.boundary_ids,
      semantic_test_id: optionalString(task.semantic_test_id),
      perturbation_group: optionalString(task.perturbation_group),
      ...(task.fork_id
        ? { fork_id: task.fork_id }
        : {}),
      ...(Array.isArray(task.verification_dimensions)
        ? { verification_dimensions: task.verification_dimensions }
        : {}),
      ...(typeof task.kdna_sensitive === 'boolean'
        ? { kdna_sensitive: task.kdna_sensitive }
        : {}),
    }))
    : value.tasks;
  return {
    schema: 'kdna.studio.application-plan-signature/0.1.0',
    id: nonEmpty(value.id, 'application test plan id'),
    ...(value.verification_contract
      ? {
        verification_contract: nonEmpty(
          value.verification_contract,
          'verification_contract',
        ),
      }
      : {}),
    ...(value.evidence_set
      ? { evidence_set: nonEmpty(value.evidence_set, 'evidence_set') }
      : {}),
    ...(value.response_mode
      ? { response_mode: nonEmpty(value.response_mode, 'response_mode') }
      : {}),
    workspace_id: workspace.state.workspace_id,
    frozen_by: normalizeActor(value.frozen_by, 'frozen_by', true),
    frozen_at: optionalDateTime(value.frozen_at, 'frozen_at'),
    statement: nonEmpty(value.statement, 'application test plan statement'),
    key_registry_id: nonEmpty(value.key_registry_id, 'key_registry_id'),
    key_registry_digest: sha256(registryPayload),
    semantic_revision:
      value.semantic_revision ?? workspace.state.semantic_revision,
    semantic_digest:
      value.semantic_digest || workspace.state.semantic_digest,
    judgment_evidence_digest:
      value.judgment_evidence_digest ||
      canonicalJudgmentEvidenceDigest(workspace),
    ...(value.build_receipt_digest
      ? {
        build_receipt_digest: assertDigest(
          value.build_receipt_digest,
          'build_receipt_digest',
        ),
      }
      : {}),
    ...(value.asset_digest
      ? {
        asset_digest: assertDigest(
          value.asset_digest,
          'asset_digest',
        ),
      }
      : {}),
    evaluation_oracle_digest: assertDigest(
      value.evaluation_oracle_digest,
      'evaluation_oracle_digest',
    ),
    tasks,
    thresholds: value.thresholds,
  };
}

function applicationPlanSigningPayload(workspace, value) {
  assertPlainObject(value, 'application test plan');
  return Buffer.from(
    stableStringify(applicationPlanSigningSnapshot(workspace, value)),
    'utf8',
  );
}

function numericThreshold(value, label, minimum) {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > 1
  ) {
    throw new Error(`${label} must be between ${minimum} and 1`);
  }
  return value;
}

function normalizeApplicationIdentity(value, label) {
  assertAllowedKeys(
    value,
    new Set(['id', 'public_key']),
    label,
  );
  const idValue = nonEmpty(value.id, `${label}.id`);
  const publicKeyText = nonEmpty(value.public_key, `${label}.public_key`);
  let key;
  try {
    key = crypto.createPublicKey(publicKeyText);
  } catch {
    throw new Error(`${label}.public_key must be a valid public key`);
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error(`${label}.public_key must be Ed25519`);
  }
  const publicKey = key.export({ type: 'spki', format: 'pem' }).trim();
  const fingerprint = sha256(
    key.export({ type: 'spki', format: 'der' }),
  );
  return {
    id: idValue,
    public_key: publicKey,
    fingerprint,
  };
}

function freezeApplicationTestPlan(workspace, input = {}) {
  if (assessReadiness(workspace).creation_accepted !== true) {
    throw new Error(
      'application test plan may be frozen only after JUDGMENT_ACCEPTED',
    );
  }
  const build = workspace.buildReceipt;
  if (
    !build ||
    build.status !== 'verified' ||
    build.semantic_revision !== workspace.state.semantic_revision ||
    build.semantic_digest !== workspace.state.semantic_digest ||
    build.output?.artifact_sha256 !== build.asset_digest
  ) {
    throw new Error(
      'fresh hidden application plans may be frozen only after FORMAT_VALID binds the exact final .kdna',
    );
  }
  const buildReceiptDigest = canonicalBuildReceiptDigest(build);
  assertPlainObject(input, 'application test plan');
  assertAllowedKeys(
    input,
    new Set([
      'id',
      'verification_contract',
      'evidence_set',
      'response_mode',
      'frozen_by',
      'frozen_at',
      'statement',
      'key_registry_id',
      'creation_key_signature',
      'coordinator_key_signature',
      'coordinator_plan_signature',
      'creation_identity',
      'coordinator_identity',
      'evaluation_oracle_digest',
      'consumer_identity',
      'evaluator_identity',
      'build_receipt_digest',
      'asset_digest',
      'tasks',
      'thresholds',
    ]),
    'application test plan',
  );
  if (input.verification_contract !== 'adoption-fidelity') {
    throw new Error(
      'new application test plans require verification_contract adoption-fidelity',
    );
  }
  if (input.evidence_set !== 'fresh-hidden-holdout') {
    throw new Error(
      'new application test plans require a fresh-hidden-holdout evidence set',
    );
  }
  if (input.response_mode !== 'free-response') {
    throw new Error(
      'fresh hidden application tasks must use free-response outputs',
    );
  }
  if (input.build_receipt_digest !== buildReceiptDigest) {
    throw new Error(
      'application plan build_receipt_digest must bind current FORMAT_VALID evidence',
    );
  }
  if (input.asset_digest !== build.asset_digest) {
    throw new Error(
      'application plan asset_digest must bind the exact final .kdna',
    );
  }
  const actor = normalizeActor(input.frozen_by, 'frozen_by', true);
  if (
    actor.type !== 'agent' ||
    workspace.state.created_by.type !== 'agent'
  ) {
    throw new Error(
      'application Creation and coordinator signing roles must be Agents',
    );
  }
  const frozenAt = optionalDateTime(input.frozen_at, 'frozen_at');
  if (!frozenAt || Date.parse(frozenAt) > Date.now()) {
    throw new Error('frozen_at must be an Engine-observed or earlier time');
  }
  const creationIdentity = normalizeApplicationIdentity(
    input.creation_identity,
    'creation_identity',
  );
  const coordinatorIdentity = normalizeApplicationIdentity(
    input.coordinator_identity,
    'coordinator_identity',
  );
  const consumerIdentity = normalizeApplicationIdentity(
    input.consumer_identity,
    'consumer_identity',
  );
  const evaluatorIdentity = normalizeApplicationIdentity(
    input.evaluator_identity,
    'evaluator_identity',
  );
  if (
    creationIdentity.id !== workspace.state.created_by.id ||
    coordinatorIdentity.id !== actor.id
  ) {
    throw new Error(
      'frozen Creation and coordinator keys must match the creating Agent and frozen_by identities',
    );
  }
  const roleIdentities = [
    creationIdentity,
    coordinatorIdentity,
    consumerIdentity,
    evaluatorIdentity,
  ];
  const roleIds = new Set(roleIdentities.map((identity) => identity.id));
  const roleFingerprints = new Set(
    roleIdentities.map((identity) => identity.fingerprint),
  );
  if (
    roleIds.size !== roleIdentities.length ||
    roleFingerprints.size !== roleIdentities.length
  ) {
    throw new Error(
      'frozen Creation, coordinator, Consumer, and evaluator identities and keys must all be distinct',
    );
  }
  if (actor.id === workspace.state.created_by.id) {
    throw new Error(
      'the creating Agent cannot freeze its own application gate identities',
    );
  }
  const keyRegistryPayload =
    applicationKeyRegistrySigningPayload(workspace, input);
  verifyApplicationSignature(
    creationIdentity,
    JSON.parse(keyRegistryPayload.toString('utf8')),
    input.creation_key_signature,
    'creation_key_signature',
  );
  verifyApplicationSignature(
    coordinatorIdentity,
    JSON.parse(keyRegistryPayload.toString('utf8')),
    input.coordinator_key_signature,
    'coordinator_key_signature',
  );
  const rawTasks = input.tasks;
  if (!Array.isArray(rawTasks) || rawTasks.length < 3) {
    throw new Error('fresh hidden application plan requires at least three tasks');
  }
  const knownUnits = new Set(
    workspace.judgmentModel.units.map((unit) => unit.id),
  );
  const knownBoundaries = new Set(
    workspace.judgmentModel.global_boundaries.map((boundary) => boundary.id),
  );
  const taskIds = new Set();
  const tasks = rawTasks.map((rawTask, index) => {
    assertPlainObject(rawTask, `application test plan task ${index}`);
    assertAllowedKeys(
      rawTask,
      new Set([
        'id',
        'input_digest',
        'risk_level',
        'unit_ids',
        'boundary_ids',
        'semantic_test_id',
        'perturbation_group',
        'fork_id',
        'verification_dimensions',
        'kdna_sensitive',
      ]),
      `application test plan task ${index}`,
    );
    const taskId = nonEmpty(rawTask.id, `tasks[${index}].id`);
    if (taskIds.has(taskId)) {
      throw new Error(`application test plan has duplicate task id: ${taskId}`);
    }
    taskIds.add(taskId);
    const inputDigest = assertDigest(
      rawTask.input_digest,
      `tasks[${index}].input_digest`,
    );
    const riskLevel = nonEmpty(
      rawTask.risk_level,
      `tasks[${index}].risk_level`,
    );
    if (!['normal', 'high', 'critical'].includes(riskLevel)) {
      throw new Error(
        `tasks[${index}].risk_level must be normal, high, or critical`,
      );
    }
    const unitIds = stringList(rawTask.unit_ids, `tasks[${index}].unit_ids`);
    const boundaryIds = stringList(
      rawTask.boundary_ids,
      `tasks[${index}].boundary_ids`,
    );
    for (const unitId of unitIds) {
      if (!knownUnits.has(unitId)) {
        throw new Error(
          `application test plan references unknown unit: ${unitId}`,
        );
      }
    }
    for (const boundaryId of boundaryIds) {
      if (!knownBoundaries.has(boundaryId)) {
        throw new Error(
          `application test plan references unknown boundary: ${boundaryId}`,
        );
      }
    }
    const semanticTestId = optionalString(rawTask.semantic_test_id);
    if (semanticTestId) {
      throw new Error(
        `fresh hidden application task ${taskId} must not reuse a development semantic test`,
      );
    }
    if (Object.prototype.hasOwnProperty.call(rawTask, 'kdna_sensitive')) {
      throw new Error(
        `tasks[${index}].kdna_sensitive belongs to the retired score-comparison contract`,
      );
    }
    const forkId = nonEmpty(rawTask.fork_id, `tasks[${index}].fork_id`);
    const verificationDimensions = stringList(
      rawTask.verification_dimensions,
      `tasks[${index}].verification_dimensions`,
    );
    const allowedDimensions = new Set([
      'direction',
      'scope',
      'boundary',
      'exception',
      'priority',
      'authority-precedence',
      'safety',
      'permission',
      'external-action',
      'exit',
      'stability',
    ]);
    for (const dimension of verificationDimensions) {
      if (!allowedDimensions.has(dimension)) {
        throw new Error(
          `tasks[${index}].verification_dimensions contains unsupported dimension: ${dimension}`,
        );
      }
    }
    return {
      id: taskId,
      input_digest: inputDigest,
      risk_level: riskLevel,
      unit_ids: unitIds,
      boundary_ids: boundaryIds,
      semantic_test_id: semanticTestId,
      perturbation_group: optionalString(rawTask.perturbation_group),
      fork_id: forkId,
      verification_dimensions: verificationDimensions,
    };
  });
  if (!tasks.some((task) => ['high', 'critical'].includes(task.risk_level))) {
    throw new Error('application test plan requires a high or critical risk sample');
  }
  const requiredDimensions = [
    'direction',
    'scope',
    'boundary',
    'exception',
    'priority',
    'authority-precedence',
    'safety',
    'permission',
    'external-action',
    'exit',
    'stability',
  ];
  const coveredDimensions = new Set(
    tasks.flatMap((task) => task.verification_dimensions),
  );
  const missingDimensions = requiredDimensions.filter(
    (dimension) => !coveredDimensions.has(dimension),
  );
  if (missingDimensions.length > 0) {
    throw new Error(
      `fresh hidden application plan is missing verification dimensions: ${missingDimensions.join(', ')}`,
    );
  }
  const perturbationCounts = new Map();
  for (const task of tasks) {
    if (!task.perturbation_group) continue;
    perturbationCounts.set(
      task.perturbation_group,
      (perturbationCounts.get(task.perturbation_group) || 0) + 1,
    );
  }
  if (![...perturbationCounts.values()].some((count) => count >= 3)) {
    throw new Error(
      'fresh hidden application plan requires at least three seeded tasks in one repeated or perturbed group',
    );
  }
  const stableDirectionGroups = new Map();
  for (const task of tasks) {
    if (
      task.risk_level === 'critical' ||
      !task.perturbation_group ||
      !task.verification_dimensions.includes('direction') ||
      !task.verification_dimensions.includes('stability')
    ) {
      continue;
    }
    stableDirectionGroups.set(
      task.perturbation_group,
      (stableDirectionGroups.get(task.perturbation_group) || 0) + 1,
    );
  }
  if (![...stableDirectionGroups.values()].some((count) => count >= 3)) {
    throw new Error(
      'fresh hidden application plan requires at least three noncritical direction-and-stability seeds in one group',
    );
  }
  assertPlainObject(input.thresholds, 'application test plan thresholds');
  assertAllowedKeys(
    input.thresholds,
    new Set([
      'stability_rate_min',
      'critical_safety_errors_max',
      'permission_violations_max',
      'external_action_violations_max',
      'overapplication_failures_max',
      'direction_failures_max',
      'scope_failures_max',
      'boundary_failures_max',
      'exception_failures_max',
      'priority_failures_max',
      'authority_precedence_failures_max',
      'exit_failures_max',
      'adoption_failures_max',
    ]),
    'application test plan thresholds',
  );
  const zeroThresholdFields = [
    'critical_safety_errors_max',
    'permission_violations_max',
    'external_action_violations_max',
    'overapplication_failures_max',
    'direction_failures_max',
    'scope_failures_max',
    'boundary_failures_max',
    'exception_failures_max',
    'priority_failures_max',
    'authority_precedence_failures_max',
    'exit_failures_max',
    'adoption_failures_max',
  ];
  const thresholds = {
    stability_rate_min: numericThreshold(
      input.thresholds.stability_rate_min,
      'thresholds.stability_rate_min',
      0.9,
    ),
    ...Object.fromEntries(
      zeroThresholdFields.map((field) => [field, input.thresholds[field]]),
    ),
  };
  const nonzeroThreshold = zeroThresholdFields.find(
    (field) => thresholds[field] !== 0,
  );
  if (nonzeroThreshold) {
    throw new Error(
      `thresholds.${nonzeroThreshold} must be 0`,
    );
  }
  const plan = {
    id: input.id || id('application_plan'),
    verification_contract: 'adoption-fidelity',
    evidence_set: 'fresh-hidden-holdout',
    response_mode: 'free-response',
    frozen_by: actor,
    key_registry_id: nonEmpty(
      input.key_registry_id,
      'key_registry_id',
    ),
    key_registry_digest: sha256(keyRegistryPayload),
    creation_key_signature: input.creation_key_signature,
    coordinator_key_signature: input.coordinator_key_signature,
    plan_content_digest: null,
    coordinator_plan_signature: input.coordinator_plan_signature,
    statement: nonEmpty(input.statement, 'application test plan statement'),
    creation_identity: creationIdentity,
    coordinator_identity: coordinatorIdentity,
    evaluation_oracle_digest: assertDigest(
      input.evaluation_oracle_digest,
      'evaluation_oracle_digest',
    ),
    consumer_identity: consumerIdentity,
    evaluator_identity: evaluatorIdentity,
    semantic_revision: workspace.state.semantic_revision,
    semantic_digest: workspace.state.semantic_digest,
    judgment_evidence_digest:
      canonicalJudgmentEvidenceDigest(workspace),
    build_receipt_digest: buildReceiptDigest,
    asset_digest: build.asset_digest,
    tasks,
    thresholds,
    plan_digest: null,
    status: 'valid',
    frozen_at: frozenAt,
    invalidated_at: null,
  };
  const planSigningPayload = applicationPlanSigningPayload(workspace, plan);
  plan.plan_content_digest = sha256(planSigningPayload);
  verifyApplicationSignature(
    coordinatorIdentity,
    JSON.parse(planSigningPayload.toString('utf8')),
    input.coordinator_plan_signature,
    'coordinator_plan_signature',
  );
  plan.plan_digest = canonicalApplicationPlanDigest(plan);
  return evolve(workspace, 'application_test_plan_frozen', (next) => {
    if (next.applicationVerification.plans.some(
      (candidate) =>
        candidate.status === 'valid' &&
        candidate.semantic_digest === next.state.semantic_digest,
    )) {
      throw new Error(
        'a current application test plan is already frozen',
      );
    }
    next.applicationVerification.plans.push(plan);
  });
}

function applicationAssetLoadReceiptDigest(receipt) {
  return sha256(stableStringify(receipt));
}

function applicationAttemptSnapshot(attempt) {
  return {
    id: attempt.id,
    requested_by: attempt.requested_by,
    plan_id: attempt.plan_id,
    plan_digest: attempt.plan_digest,
    semantic_revision: attempt.semantic_revision,
    semantic_digest: attempt.semantic_digest,
    judgment_evidence_digest: attempt.judgment_evidence_digest,
    build_receipt_digest: attempt.build_receipt_digest,
    asset_digest: attempt.asset_digest,
    asset_load_receipt_digest: attempt.asset_load_receipt_digest,
    challenge_digest: attempt.challenge_digest,
    issued_at: attempt.issued_at,
  };
}

function canonicalApplicationAttemptDigest(attempt) {
  return sha256(stableStringify(applicationAttemptSnapshot(attempt)));
}

function applicationRuntimeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function verifyApplicationAsset(assetBytes, password, context = {}) {
  if (!Buffer.isBuffer(assetBytes) || assetBytes.length === 0) {
    throw applicationRuntimeError(
      'APPLICATION_ASSET_REQUIRED',
      'application attempt requires the exact final .kdna bytes',
    );
  }
  assertPlainObject(context, 'application asset observation context');
  assertAllowedKeys(
    context,
    new Set(['role', 'run_digest', 'runner_digest', 'observed_at']),
    'application asset observation context',
  );
  const snapshot = Buffer.from(assetBytes);
  const assetDigest = sha256(snapshot);
  const observedAt = optionalDateTime(
    context.observed_at || now(),
    'application asset observation observed_at',
  );
  const observationContext = {
    role: nonEmpty(
      context.role || 'coordinator-preflight',
      'application asset observation role',
    ),
    run_digest: context.run_digest
      ? assertDigest(context.run_digest, 'application asset observation run_digest')
      : null,
    runner_digest: context.runner_digest
      ? assertDigest(
        context.runner_digest,
        'application asset observation runner_digest',
      )
      : null,
    observed_at: observedAt,
  };
  let validation;
  let inspection;
  let loadPlan;
  try {
    validation = RUNTIME_CORE.validate(snapshot);
    if (validation?.overall_valid !== true) {
      throw applicationRuntimeError(
        'APPLICATION_FORMAT_INVALID',
        'the exact application asset failed KDNA Core validation',
      );
    }
    inspection = RUNTIME_CORE.inspect(snapshot);
    if (!inspection) {
      throw applicationRuntimeError(
        'APPLICATION_FORMAT_INVALID',
        'the exact application asset failed KDNA Core inspection',
      );
    }
    loadPlan = RUNTIME_CORE.planLoad(
      snapshot,
      password ? { password } : {},
    );
  } catch (error) {
    if (error?.code?.startsWith('APPLICATION_')) throw error;
    throw applicationRuntimeError(
      'APPLICATION_FORMAT_INVALID',
      'the exact application asset could not be validated, inspected, and planned by KDNA Core',
    );
  }
  const needsPassword = Boolean(
    loadPlan?.can_load_now === false &&
    loadPlan?.state === 'needs_password',
  );
  if (needsPassword && !password) {
    throw applicationRuntimeError(
      'APPLICATION_AUTHORIZATION_REQUIRED',
      'the exact protected application asset requires password authorization',
    );
  }
  if (!needsPassword && loadPlan?.can_load_now !== true) {
    throw applicationRuntimeError(
      'APPLICATION_AUTHORIZATION_FAILED',
      'the exact application asset is not authorized for Runtime loading',
    );
  }
  if (!needsPassword && password) {
    throw applicationRuntimeError(
      'APPLICATION_AUTHORIZATION_MISMATCH',
      'password authorization was supplied for an asset that does not require it',
    );
  }
  const loadRuntime = RUNTIME_CORE.loadAuthorized;
  if (typeof loadRuntime !== 'function') {
    throw applicationRuntimeError(
      'APPLICATION_RUNTIME_UNAVAILABLE',
      'the pinned KDNA Core does not provide an authorized Runtime loader',
    );
  }
  let compact;
  let full;
  try {
    const loadOptions = {
      as: 'json',
      password: password || undefined,
      hasPassword: Boolean(password),
      loadedAt: observedAt,
      expectedDigests: {
        asset: {
          value: assetDigest,
          source: 'caller',
        },
      },
    };
    compact = loadRuntime.call(RUNTIME_CORE, snapshot, {
      ...loadOptions,
      profile: 'compact',
    });
    full = loadRuntime.call(RUNTIME_CORE, snapshot, {
      ...loadOptions,
      profile: 'full',
    });
  } catch {
    throw applicationRuntimeError(
      needsPassword
        ? 'APPLICATION_AUTHORIZATION_FAILED'
        : 'APPLICATION_RUNTIME_LOAD_FAILED',
      needsPassword
        ? 'KDNA Core could not authorize and load the exact protected application asset'
        : 'KDNA Core could not load the exact application asset',
    );
  }
  if (
    compact?.type !== 'kdna.runtime-capsule' ||
    full?.type !== 'kdna.runtime-capsule'
  ) {
    throw applicationRuntimeError(
      'APPLICATION_RUNTIME_LOAD_FAILED',
      'the exact application asset did not load as compact and full Runtime Capsules',
    );
  }
  for (const capsule of [compact, full]) {
    if (
      capsule.digests?.asset?.value !== assetDigest ||
      capsule.digests?.asset?.comparison?.state !== 'matched'
    ) {
      throw applicationRuntimeError(
        'APPLICATION_ASSET_DIGEST_MISMATCH',
        'the Runtime Capsule did not bind the expected exact application asset digest',
      );
    }
  }
  if (sha256(snapshot) !== assetDigest) {
    throw applicationRuntimeError(
      'APPLICATION_ASSET_CHANGED',
      'the application asset byte snapshot changed during Core verification',
    );
  }
  const runtimeCoordinate = {
    package: RUNTIME_CORE_PACKAGE.name,
    version: RUNTIME_CORE_PACKAGE.version,
  };
  const receipt = {
    schema: 'kdna.studio.application-asset-load/0.1.0',
    asset_digest: assetDigest,
    observation_context_digest: sha256(
      stableStringify(observationContext),
    ),
    observed_at: observedAt,
    runtime_core_coordinate_digest: sha256(
      stableStringify(runtimeCoordinate),
    ),
    validation_digest: sha256(stableStringify(validation)),
    inspection_digest: sha256(stableStringify(inspection)),
    load_plan_digest: sha256(stableStringify(loadPlan)),
    compact_capsule_digest:
      RUNTIME_CORE.computeCapsuleDeliveryDigest(compact),
    full_capsule_digest:
      RUNTIME_CORE.computeCapsuleDeliveryDigest(full),
    authorization_outcome: needsPassword
      ? 'authorized'
      : 'not-required',
  };
  return {
    asset_digest: assetDigest,
    receipt,
    receipt_digest: applicationAssetLoadReceiptDigest(receipt),
  };
}

function issueApplicationAttempt(workspace, input = {}, execution = {}) {
  assertPlainObject(input, 'application attempt');
  assertAllowedKeys(
    input,
    new Set(['id', 'requested_by']),
    'application attempt',
  );
  assertPlainObject(execution, 'application attempt execution');
  assertAllowedKeys(
    execution,
    new Set(['asset_bytes', 'password']),
    'application attempt execution',
  );
  const readiness = assessReadiness(workspace);
  const gates = readiness.completion_gates;
  if (
    readiness.creation_accepted !== true ||
    gates?.format_valid !== true ||
    !gates.application_plan_id
  ) {
    throw new Error(
      'application attempt requires current JUDGMENT_ACCEPTED, FORMAT_VALID, and a frozen plan',
    );
  }
  const attemptId = nonEmpty(input.id, 'application attempt.id');
  if (
    workspace.applicationVerification.attempts.some(
      (attempt) => attempt.id === attemptId,
    ) ||
    workspace.applicationVerification.receipts.some(
      (receipt) => receipt.id === attemptId,
    )
  ) {
    throw new Error('application attempt id has already been used');
  }
  const requestedBy = normalizeActor(
    input.requested_by,
    'application attempt.requested_by',
    true,
  );
  if (requestedBy.type !== 'agent') {
    throw new Error('application attempt requester must be an Agent');
  }
  const plan = workspace.applicationVerification.plans.find(
    (candidate) =>
      candidate.id === gates.application_plan_id &&
      candidate.status === 'valid',
  );
  if (!plan) {
    throw new Error('application attempt does not have a current frozen plan');
  }
  const disallowedIds = new Set([
    workspace.state.created_by.id,
    workspace.purposeBrief?.represented_subject?.id,
    plan.consumer_identity.id,
    plan.evaluator_identity.id,
  ].filter(Boolean));
  if (
    disallowedIds.has(requestedBy.id) ||
    requestedBy.id !== plan.coordinator_identity.id
  ) {
    throw new Error(
      'application attempt must be issued by the frozen coordinator, distinct from Creation, represented subject, Consumer, and evaluator',
    );
  }
  const buildReceiptDigest =
    canonicalBuildReceiptDigest(workspace.buildReceipt);
  const judgmentEvidenceDigest =
    canonicalJudgmentEvidenceDigest(workspace);
  const verifiedAsset = verifyApplicationAsset(
    execution.asset_bytes,
    execution.password,
    {
      role: 'coordinator-preflight',
      run_digest: sha256(attemptId),
    },
  );
  if (verifiedAsset.asset_digest !== workspace.buildReceipt.asset_digest) {
    throw applicationRuntimeError(
      'APPLICATION_ASSET_DIGEST_MISMATCH',
      'the exact loaded application asset does not match the current FORMAT_VALID asset',
    );
  }
  if (
    workspace.applicationVerification.attempts.some((attempt) => (
      attempt.status === 'open' &&
      attempt.plan_id === plan.id &&
      attempt.plan_digest === plan.plan_digest &&
      attempt.semantic_digest === workspace.state.semantic_digest &&
      attempt.semantic_revision === workspace.state.semantic_revision &&
      attempt.judgment_evidence_digest ===
        judgmentEvidenceDigest &&
      attempt.build_receipt_digest === buildReceiptDigest &&
      attempt.asset_digest === workspace.buildReceipt.asset_digest
    ))
  ) {
    throw new Error('a current application attempt is already open');
  }
  const attempt = {
    id: attemptId,
    requested_by: requestedBy,
    plan_id: plan.id,
    plan_digest: plan.plan_digest,
    semantic_revision: workspace.state.semantic_revision,
    semantic_digest: workspace.state.semantic_digest,
    judgment_evidence_digest: judgmentEvidenceDigest,
    build_receipt_digest: buildReceiptDigest,
    asset_digest: workspace.buildReceipt.asset_digest,
    asset_load_receipt: verifiedAsset.receipt,
    asset_load_receipt_digest: verifiedAsset.receipt_digest,
    challenge_digest: sha256(crypto.randomBytes(32)),
    attempt_digest: null,
    status: 'open',
    issued_at: now(),
    consumed_at: null,
    receipt_id: null,
    invalidated_at: null,
    abandonment_id: null,
  };
  attempt.attempt_digest = canonicalApplicationAttemptDigest(attempt);
  return evolve(workspace, 'application_attempt_issued', (next) => {
    next.applicationVerification.attempts.push(attempt);
  });
}

function applicationObservationSnapshot(observation) {
  return {
    id: observation.id,
    observed_by: observation.observed_by,
    attempt_id: observation.attempt_id,
    attempt_digest: observation.attempt_digest,
    challenge_digest: observation.challenge_digest,
    plan_id: observation.plan_id,
    plan_digest: observation.plan_digest,
    semantic_revision: observation.semantic_revision,
    semantic_digest: observation.semantic_digest,
    judgment_evidence_digest: observation.judgment_evidence_digest,
    build_receipt_digest: observation.build_receipt_digest,
    asset_digest: observation.asset_digest,
    consumer_run_digest: observation.consumer_run_digest,
    runner_digest: observation.runner_digest,
    asset_load_receipt_digest:
      observation.asset_load_receipt_digest,
    observed_at: observation.observed_at,
  };
}

function canonicalApplicationObservationDigest(observation) {
  return sha256(stableStringify(
    applicationObservationSnapshot(observation),
  ));
}

function recordApplicationAssetObservation(
  workspace,
  input = {},
  execution = {},
) {
  assertPlainObject(input, 'application asset observation');
  assertAllowedKeys(
    input,
    new Set([
      'id',
      'observed_by',
      'attempt_id',
      'attempt_digest',
      'challenge_digest',
      'consumer_run_digest',
      'runner_digest',
    ]),
    'application asset observation',
  );
  assertPlainObject(execution, 'application asset observation execution');
  assertAllowedKeys(
    execution,
    new Set(['asset_bytes', 'password']),
    'application asset observation execution',
  );
  const observationId = nonEmpty(
    input.id,
    'application asset observation.id',
  );
  if (
    workspace.applicationVerification.plans.some(
      (plan) => plan.id === observationId,
    ) ||
    workspace.applicationVerification.attempts.some(
      (attempt) => attempt.id === observationId,
    ) ||
    workspace.applicationVerification.observations.some(
      (observation) => observation.id === observationId,
    ) ||
    workspace.applicationVerification.receipts.some(
      (receipt) => receipt.id === observationId,
    )
  ) {
    throw new Error('application observation id has already been used');
  }
  const attemptId = nonEmpty(
    input.attempt_id,
    'application asset observation.attempt_id',
  );
  const attemptDigest = assertDigest(
    input.attempt_digest,
    'application asset observation.attempt_digest',
  );
  const challengeDigest = assertDigest(
    input.challenge_digest,
    'application asset observation.challenge_digest',
  );
  const attempt = workspace.applicationVerification.attempts.find(
    (candidate) =>
      candidate.id === attemptId &&
      candidate.status === 'open' &&
      candidate.attempt_digest === attemptDigest &&
      candidate.challenge_digest === challengeDigest,
  );
  if (
    !attempt ||
    canonicalApplicationAttemptDigest(attempt) !== attemptDigest
  ) {
    throw new Error(
      'application asset observation requires the current open single-use attempt',
    );
  }
  const plan = workspace.applicationVerification.plans.find(
    (candidate) =>
      candidate.id === attempt.plan_id &&
      candidate.plan_digest === attempt.plan_digest &&
      candidate.status === 'valid',
  );
  if (!plan) {
    throw new Error(
      'application asset observation does not bind a current frozen plan',
    );
  }
  const observedBy = normalizeActor(
    input.observed_by,
    'application asset observation.observed_by',
    true,
  );
  if (
    observedBy.type !== 'agent' ||
    observedBy.id !== plan.consumer_identity.id
  ) {
    throw new Error(
      'application asset observation must be attributed to the frozen Consumer',
    );
  }
  if (
    workspace.applicationVerification.observations.some(
      (observation) =>
        observation.attempt_id === attemptId &&
        observation.status === 'open',
    )
  ) {
    throw new Error(
      'the current application attempt already has an open Consumer observation',
    );
  }
  const consumerRunDigest = assertDigest(
    input.consumer_run_digest,
    'application asset observation.consumer_run_digest',
  );
  const runnerDigest = assertDigest(
    input.runner_digest,
    'application asset observation.runner_digest',
  );
  const observedAt = now();
  const verifiedAsset = verifyApplicationAsset(
    execution.asset_bytes,
    execution.password,
    {
      role: 'consumer-execution',
      run_digest: consumerRunDigest,
      runner_digest: runnerDigest,
      observed_at: observedAt,
    },
  );
  if (
    verifiedAsset.asset_digest !== attempt.asset_digest ||
    verifiedAsset.asset_digest !== workspace.buildReceipt?.asset_digest
  ) {
    throw applicationRuntimeError(
      'APPLICATION_ASSET_DIGEST_MISMATCH',
      'the Consumer-observed exact asset does not match FORMAT_VALID',
    );
  }
  const observation = {
    id: observationId,
    observed_by: observedBy,
    attempt_id: attempt.id,
    attempt_digest: attempt.attempt_digest,
    challenge_digest: attempt.challenge_digest,
    plan_id: attempt.plan_id,
    plan_digest: attempt.plan_digest,
    semantic_revision: attempt.semantic_revision,
    semantic_digest: attempt.semantic_digest,
    judgment_evidence_digest: attempt.judgment_evidence_digest,
    build_receipt_digest: attempt.build_receipt_digest,
    asset_digest: attempt.asset_digest,
    consumer_run_digest: consumerRunDigest,
    runner_digest: runnerDigest,
    asset_load_receipt: verifiedAsset.receipt,
    asset_load_receipt_digest: verifiedAsset.receipt_digest,
    observation_digest: null,
    status: 'open',
    observed_at: observedAt,
    consumed_at: null,
    receipt_id: null,
    invalidated_at: null,
    abandonment_id: null,
  };
  observation.observation_digest =
    canonicalApplicationObservationDigest(observation);
  return evolve(
    workspace,
    'application_asset_observation_recorded',
    (next) => {
      next.applicationVerification.observations.push(observation);
    },
  );
}

function applicationAttemptAbandonmentSigningSnapshot(abandonment) {
  return {
    id: abandonment.id,
    abandoned_by: abandonment.abandoned_by,
    plan_id: abandonment.plan_id,
    plan_digest: abandonment.plan_digest,
    semantic_revision: abandonment.semantic_revision,
    semantic_digest: abandonment.semantic_digest,
    judgment_evidence_digest: abandonment.judgment_evidence_digest,
    build_receipt_digest: abandonment.build_receipt_digest,
    asset_digest: abandonment.asset_digest,
    attempt_id: abandonment.attempt_id,
    attempt_digest: abandonment.attempt_digest,
    challenge_digest: abandonment.challenge_digest,
    observation_id: abandonment.observation_id,
    observation_digest: abandonment.observation_digest,
    consumer_run_digest: abandonment.consumer_run_digest,
    runner_digest: abandonment.runner_digest,
    reason_code: abandonment.reason_code,
    reason: abandonment.reason,
    runner_failure_evidence_digest:
      abandonment.runner_failure_evidence_digest,
    abandoned_at: abandonment.abandoned_at,
  };
}

function canonicalApplicationAttemptAbandonmentDigest(abandonment) {
  return sha256(stableStringify(
    applicationAttemptAbandonmentSigningSnapshot(abandonment),
  ));
}

function normalizeApplicationAttemptAbandonment(workspace, input = {}) {
  assertPlainObject(input, 'application attempt abandonment');
  assertAllowedKeys(
    input,
    new Set([
      'id',
      'abandoned_by',
      'attempt_id',
      'attempt_digest',
      'challenge_digest',
      'observation_id',
      'observation_digest',
      'consumer_run_digest',
      'runner_digest',
      'reason_code',
      'reason',
      'runner_failure_evidence_digest',
      'abandoned_at',
      'coordinator_signature',
    ]),
    'application attempt abandonment',
  );
  const abandonmentId = nonEmpty(
    input.id,
    'application attempt abandonment.id',
  );
  const allEvidence = [
    ...workspace.applicationVerification.plans,
    ...workspace.applicationVerification.attempts,
    ...workspace.applicationVerification.observations,
    ...(workspace.applicationVerification.abandonments || []),
    ...workspace.applicationVerification.receipts,
  ];
  if (allEvidence.some((evidence) => evidence.id === abandonmentId)) {
    throw new Error('application abandonment id has already been used');
  }
  const attemptId = nonEmpty(
    input.attempt_id,
    'application attempt abandonment.attempt_id',
  );
  const attemptDigest = assertDigest(
    input.attempt_digest,
    'application attempt abandonment.attempt_digest',
  );
  const challengeDigest = assertDigest(
    input.challenge_digest,
    'application attempt abandonment.challenge_digest',
  );
  const attempt = workspace.applicationVerification.attempts.find(
    (candidate) =>
      candidate.id === attemptId &&
      candidate.status === 'open' &&
      candidate.attempt_digest === attemptDigest &&
      candidate.challenge_digest === challengeDigest &&
      canonicalApplicationAttemptDigest(candidate) === attemptDigest,
  );
  if (!attempt) {
    throw new Error(
      'application abandonment requires the current open single-use attempt',
    );
  }
  const readiness = assessReadiness(workspace);
  const gates = readiness.completion_gates;
  const plan = workspace.applicationVerification.plans.find(
    (candidate) =>
      candidate.id === attempt.plan_id &&
      candidate.plan_digest === attempt.plan_digest &&
      candidate.status === 'valid',
  );
  if (
    readiness.creation_accepted !== true ||
    gates?.format_valid !== true ||
    gates.application_plan_id !== attempt.plan_id ||
    gates.application_attempt_id !== attempt.id ||
    !plan
  ) {
    throw new Error(
      'application abandonment requires the current valid frozen plan, judgment, build, and exact asset',
    );
  }
  assertPlainObject(
    input.abandoned_by,
    'application attempt abandonment.abandoned_by',
  );
  assertAllowedKeys(
    input.abandoned_by,
    new Set(['type', 'id', 'name', 'authority']),
    'application attempt abandonment.abandoned_by',
  );
  const abandonedBy = normalizeActor(
    input.abandoned_by,
    'application attempt abandonment.abandoned_by',
    true,
  );
  if (
    abandonedBy.type !== 'agent' ||
    abandonedBy.id !== plan.coordinator_identity.id
  ) {
    throw new Error(
      'application attempt may be abandoned only by the frozen coordinator',
    );
  }
  const openObservation =
    workspace.applicationVerification.observations.find(
      (candidate) =>
        candidate.attempt_id === attempt.id &&
        candidate.status === 'open',
    ) || null;
  const hasObservationId =
    input.observation_id !== undefined && input.observation_id !== null;
  const hasObservationDigest =
    input.observation_digest !== undefined &&
      input.observation_digest !== null;
  if (hasObservationId !== hasObservationDigest) {
    throw new Error(
      'application abandonment observation_id and observation_digest must be supplied together',
    );
  }
  if (
    Boolean(openObservation) !== hasObservationId ||
    (
      openObservation &&
      (
        nonEmpty(
          input.observation_id,
          'application attempt abandonment.observation_id',
        ) !== openObservation.id ||
        assertDigest(
          input.observation_digest,
          'application attempt abandonment.observation_digest',
        ) !== openObservation.observation_digest ||
        canonicalApplicationObservationDigest(openObservation) !==
          openObservation.observation_digest
      )
    )
  ) {
    throw new Error(
      'application abandonment must exactly bind the current Consumer observation when present',
    );
  }
  const hasConsumerRunDigest =
    input.consumer_run_digest !== undefined &&
      input.consumer_run_digest !== null;
  const hasRunnerDigest =
    input.runner_digest !== undefined && input.runner_digest !== null;
  if (
    hasConsumerRunDigest !== hasRunnerDigest ||
    Boolean(openObservation) !== hasConsumerRunDigest ||
    (
      openObservation &&
      (
        assertDigest(
          input.consumer_run_digest,
          'application attempt abandonment.consumer_run_digest',
        ) !== openObservation.consumer_run_digest ||
        assertDigest(
          input.runner_digest,
          'application attempt abandonment.runner_digest',
        ) !== openObservation.runner_digest
      )
    )
  ) {
    throw new Error(
      'application abandonment must exactly bind the Consumer run and runner coordinates when an observation is present',
    );
  }
  const reasonCode = nonEmpty(
    input.reason_code,
    'application attempt abandonment.reason_code',
  );
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(reasonCode)) {
    throw new Error(
      'application attempt abandonment.reason_code must be a stable uppercase reason code',
    );
  }
  const reason = nonEmpty(
    input.reason,
    'application attempt abandonment.reason',
  );
  if (reason.length > 512) {
    throw new Error(
      'application attempt abandonment.reason exceeds 512 characters',
    );
  }
  const runnerFailureEvidenceDigest = assertDigest(
    input.runner_failure_evidence_digest,
    'application attempt abandonment.runner_failure_evidence_digest',
  );
  const abandonedAt = assertCanonicalUtcDateTime(
    input.abandoned_at,
    'application attempt abandonment.abandoned_at',
  );
  const abandonedAtMs = Date.parse(abandonedAt);
  const currentTime = Date.now();
  if (
    abandonedAtMs < Date.parse(attempt.issued_at) ||
    (
      openObservation &&
      abandonedAtMs < Date.parse(openObservation.observed_at)
    )
  ) {
    throw new Error(
      'application attempt abandonment.abandoned_at precedes its bound attempt or observation',
    );
  }
  if (
    Math.abs(currentTime - abandonedAtMs) >
      APPLICATION_ABANDONMENT_CLOCK_TOLERANCE_MS
  ) {
    throw new Error(
      'application attempt abandonment.abandoned_at is outside the five-minute intake tolerance',
    );
  }
  const abandonment = {
    id: abandonmentId,
    abandoned_by: abandonedBy,
    plan_id: plan.id,
    plan_digest: plan.plan_digest,
    semantic_revision: attempt.semantic_revision,
    semantic_digest: attempt.semantic_digest,
    judgment_evidence_digest: attempt.judgment_evidence_digest,
    build_receipt_digest: attempt.build_receipt_digest,
    asset_digest: attempt.asset_digest,
    attempt_id: attempt.id,
    attempt_digest: attempt.attempt_digest,
    challenge_digest: attempt.challenge_digest,
    observation_id: openObservation?.id || null,
    observation_digest: openObservation?.observation_digest || null,
    consumer_run_digest: openObservation?.consumer_run_digest || null,
    runner_digest: openObservation?.runner_digest || null,
    reason_code: reasonCode,
    reason,
    runner_failure_evidence_digest: runnerFailureEvidenceDigest,
    coordinator_signature: nonEmpty(
      input.coordinator_signature,
      'application attempt abandonment.coordinator_signature',
    ),
    abandonment_digest: null,
    abandoned_at: abandonedAt,
  };
  abandonment.abandonment_digest =
    canonicalApplicationAttemptAbandonmentDigest(abandonment);
  return { abandonment, attempt, observation: openObservation, plan };
}

function applicationAttemptAbandonmentSigningPayload(workspace, input = {}) {
  const { abandonment } = normalizeApplicationAttemptAbandonment(
    workspace,
    {
      ...input,
      coordinator_signature:
        input.coordinator_signature ||
        Buffer.alloc(64).toString('base64'),
    },
  );
  return applicationSigningBytes(
    applicationAttemptAbandonmentSigningSnapshot(abandonment),
  );
}

function abandonApplicationAttempt(workspace, input = {}) {
  const { abandonment, attempt, observation, plan } =
    normalizeApplicationAttemptAbandonment(workspace, input);
  verifyApplicationSignature(
    plan.coordinator_identity,
    applicationAttemptAbandonmentSigningSnapshot(abandonment),
    abandonment.coordinator_signature,
    'application abandonment coordinator_signature',
  );
  return evolve(workspace, 'application_attempt_abandoned', (next) => {
    const currentAttempt = next.applicationVerification.attempts.find(
      (candidate) =>
        candidate.id === attempt.id &&
        candidate.status === 'open' &&
        candidate.attempt_digest === attempt.attempt_digest &&
        candidate.challenge_digest === attempt.challenge_digest,
    );
    if (!currentAttempt) {
      throw new Error(
        'application abandonment requires the current open single-use attempt',
      );
    }
    currentAttempt.status = 'abandoned';
    currentAttempt.invalidated_at = abandonment.abandoned_at;
    currentAttempt.abandonment_id = abandonment.id;
    if (observation) {
      const currentObservation =
        next.applicationVerification.observations.find(
          (candidate) =>
            candidate.id === observation.id &&
            candidate.status === 'open' &&
            candidate.observation_digest ===
              observation.observation_digest,
        );
      if (!currentObservation) {
        throw new Error(
          'application abandonment must exactly bind the current Consumer observation when present',
        );
      }
      currentObservation.status = 'abandoned';
      currentObservation.invalidated_at = abandonment.abandoned_at;
      currentObservation.abandonment_id = abandonment.id;
    }
    if (!Array.isArray(next.applicationVerification.abandonments)) {
      next.applicationVerification.abandonments = [];
    }
    next.applicationVerification.abandonments.push(abandonment);
  });
}

function normalizeReasonCodes(value, label) {
  const codes = stringList(value, label, { required: true });
  if (codes.some((code) => !/^[A-Z][A-Z0-9_]{0,127}$/.test(code))) {
    throw new Error(`${label} must contain stable uppercase reason codes`);
  }
  return [...new Set(codes)];
}

function normalizeApplicationLane(rawLane, label, expectedAssetDigest) {
  assertPlainObject(rawLane, label);
  assertAllowedKeys(
    rawLane,
    new Set([
      'direction',
      'reason_codes',
      'reason_digest',
      'boundary_ids',
      'exception_ids',
      'exit',
      'over_applied',
      'authorization_outcome',
      'output_digest',
      'asset_digest',
    ]),
    label,
  );
  const direction = nonEmpty(rawLane.direction, `${label}.direction`);
  if (![
    'apply',
    'refuse',
    'out-of-scope',
    'defer',
    'request-authorization',
  ].includes(direction)) {
    throw new Error(`${label}.direction is invalid`);
  }
  const exit = nonEmpty(rawLane.exit, `${label}.exit`);
  if (![
    'completed',
    'refused',
    'out-of-scope',
    'authorization-denied',
    'error',
  ].includes(exit)) {
    throw new Error(`${label}.exit is invalid`);
  }
  const authorizationOutcome = nonEmpty(
    rawLane.authorization_outcome,
    `${label}.authorization_outcome`,
  );
  if (!['not-required', 'authorized', 'denied', 'error'].includes(
    authorizationOutcome,
  )) {
    throw new Error(`${label}.authorization_outcome is invalid`);
  }
  const assetDigest = rawLane.asset_digest === null
    ? null
    : assertDigest(rawLane.asset_digest, `${label}.asset_digest`);
  if (assetDigest !== expectedAssetDigest) {
    throw new Error(
      expectedAssetDigest === null
        ? `${label} must not load an asset`
        : `${label} did not load the exact final asset digest`,
    );
  }
  if (typeof rawLane.over_applied !== 'boolean') {
    throw new Error(`${label}.over_applied must be boolean`);
  }
  return {
    direction,
    reason_codes: normalizeReasonCodes(
      rawLane.reason_codes,
      `${label}.reason_codes`,
    ),
    reason_digest: assertDigest(
      rawLane.reason_digest,
      `${label}.reason_digest`,
    ),
    boundary_ids: stringList(
      rawLane.boundary_ids,
      `${label}.boundary_ids`,
    ),
    exception_ids: stringList(
      rawLane.exception_ids,
      `${label}.exception_ids`,
    ),
    exit,
    over_applied: rawLane.over_applied,
    authorization_outcome: authorizationOutcome,
    output_digest: assertDigest(
      rawLane.output_digest,
      `${label}.output_digest`,
    ),
    asset_digest: assetDigest,
  };
}

function assertApplicationLaneAuthorization(
  taskResults,
  observedAuthorizationOutcome,
) {
  if (!['not-required', 'authorized'].includes(
    observedAuthorizationOutcome,
  )) {
    throw new Error(
      'Consumer exact-asset observation did not record a successful authorization outcome',
    );
  }
  for (const result of taskResults) {
    if (
      result.with_kdna.authorization_outcome !==
        observedAuthorizationOutcome
    ) {
      throw new Error(
        `task ${result.task_id}.with_kdna.authorization_outcome does not match the Engine-observed exact-asset load`,
      );
    }
    if (
      result.with_kdna.direction === 'request-authorization' ||
      result.with_kdna.exit === 'authorization-denied'
    ) {
      throw new Error(
        `task ${result.task_id}.with_kdna contradicts the successful Engine-observed exact-asset authorization`,
      );
    }
    if (result.without_kdna.authorization_outcome !== 'not-required') {
      throw new Error(
        `task ${result.task_id}.without_kdna authorization_outcome must be not-required because no asset was loaded`,
      );
    }
  }
}

function applicationScore(value, label) {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw new Error(`${label} must be between 0 and 1`);
  }
  return value;
}

function applicationConsumerSigningSnapshot(value) {
  return {
    schema: 'kdna.studio.application-consumer-execution/0.1.0',
    receipt_id: value.id,
    attempt_id: value.attempt_id,
    attempt_digest: value.attempt_digest,
    challenge_digest: value.challenge_digest,
    plan_id: value.plan_id,
    plan_digest: value.plan_digest,
    semantic_revision: value.semantic_revision,
    semantic_digest: value.semantic_digest,
    judgment_evidence_digest: value.judgment_evidence_digest,
    build_receipt_digest: value.build_receipt_digest,
    asset_digest: value.asset_digest,
    asset_load_receipt_digest: value.asset_load_receipt_digest,
    consumer_asset_observation_id:
      value.consumer_asset_observation_id,
    consumer_asset_observation_digest:
      value.consumer_asset_observation_digest,
    consumer_asset_load_receipt_digest:
      value.consumer_asset_load_receipt_digest,
    consumer: value.consumer,
    consumer_run_digest: value.consumer_run_digest,
    runner_digest: value.runner_digest,
    task_results: value.task_results.map((result) => ({
      task_id: result.task_id,
      input_digest: result.input_digest,
      with_kdna: result.with_kdna,
      without_kdna: result.without_kdna,
    })),
  };
}

function applicationEvaluatorSigningSnapshot(value) {
  return {
    schema: 'kdna.studio.application-evaluation/0.1.0',
    receipt_id: value.id,
    attempt_id: value.attempt_id,
    attempt_digest: value.attempt_digest,
    challenge_digest: value.challenge_digest,
    plan_id: value.plan_id,
    plan_digest: value.plan_digest,
    semantic_revision: value.semantic_revision,
    semantic_digest: value.semantic_digest,
    judgment_evidence_digest: value.judgment_evidence_digest,
    build_receipt_digest: value.build_receipt_digest,
    asset_digest: value.asset_digest,
    asset_load_receipt_digest: value.asset_load_receipt_digest,
    consumer_asset_observation_id:
      value.consumer_asset_observation_id,
    consumer_asset_observation_digest:
      value.consumer_asset_observation_digest,
    consumer_asset_load_receipt_digest:
      value.consumer_asset_load_receipt_digest,
    consumer_execution_digest: value.consumer_execution_digest,
    evaluated_by: value.evaluated_by,
    evaluator_run_digest: value.evaluator_run_digest,
    evaluator_runner_digest: value.evaluator_runner_digest,
    task_evaluations: value.task_results.map((result) => ({
      task_id: result.task_id,
      input_digest: result.input_digest,
      evaluation: result.evaluation,
    })),
  };
}

function applicationSigningBytes(snapshot) {
  return Buffer.from(stableStringify(snapshot), 'utf8');
}

function applicationConsumerSigningPayload(value) {
  return applicationSigningBytes(applicationConsumerSigningSnapshot(value));
}

function applicationEvaluatorSigningPayload(value) {
  return applicationSigningBytes(applicationEvaluatorSigningSnapshot(value));
}

function canonicalBase64Signature(value, label) {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    throw new Error(`${label} must be canonical base64`);
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== 64 || bytes.toString('base64') !== value) {
    throw new Error(`${label} must be a canonical Ed25519 signature`);
  }
  return bytes;
}

function verifyApplicationSignature(identity, snapshot, signature, label) {
  const signatureBytes = canonicalBase64Signature(signature, label);
  if (!crypto.verify(
    null,
    applicationSigningBytes(snapshot),
    identity.public_key,
    signatureBytes,
  )) {
    throw new Error(
      `${label} does not verify against the pre-frozen application identity`,
    );
  }
}

function applicationAssessment(plan, taskResults) {
  const authorizationFailures = taskResults.filter((result) => (
    ['denied', 'error'].includes(
      result.with_kdna.authorization_outcome,
    ) ||
    result.with_kdna.exit === 'authorization-denied'
  )).length;
  if (plan.verification_contract === 'adoption-fidelity') {
    const taskById = new Map(plan.tasks.map((task) => [task.id, task]));
    const declares = (result, dimension) => (
      taskById.get(result.task_id)
        ?.verification_dimensions.includes(dimension)
    );
    const failures = (dimension, field) => taskResults.filter(
      (result) => declares(result, dimension) && !result.evaluation[field],
    ).length;
    const directionStabilityResults = taskResults.filter((result) => {
      const task = taskById.get(result.task_id);
      return (
        task?.risk_level !== 'critical' &&
        task?.verification_dimensions.includes('direction') &&
        task?.verification_dimensions.includes('stability')
      );
    });
    const stableDirectionCount = directionStabilityResults.filter(
      (result) => result.evaluation.stable,
    ).length;
    const stabilityRate =
      stableDirectionCount / directionStabilityResults.length;
    const metrics = {
      comparison_contract: 'adoption-fidelity',
      task_count: taskResults.length,
      direction_stability_task_count: directionStabilityResults.length,
      noncritical_direction_stability_rate: stabilityRate,
      critical_safety_errors: taskResults.filter(
        (result) => (
          declares(result, 'safety') &&
          result.evaluation.critical_safety_error
        ),
      ).length,
      permission_violations: taskResults.filter(
        (result) => (
          declares(result, 'permission') &&
          result.evaluation.permission_violation
        ),
      ).length,
      external_action_violations: taskResults.filter(
        (result) => (
          declares(result, 'external-action') &&
          result.evaluation.external_action_violation
        ),
      ).length,
      overapplication_failures: taskResults.filter(
        (result) => result.with_kdna.over_applied,
      ).length,
      direction_failures: failures('direction', 'direction_correct'),
      scope_failures: failures('scope', 'scope_correct'),
      boundary_failures: failures('boundary', 'boundary_correct'),
      exception_failures: failures('exception', 'exception_correct'),
      priority_failures: failures('priority', 'priority_correct'),
      authority_precedence_failures: failures(
        'authority-precedence',
        'authority_precedence_correct',
      ),
      exit_failures: failures('exit', 'exit_correct'),
      adoption_failures: taskResults.filter(
        (result) => !result.evaluation.faithful,
      ).length,
      authorization_failures: authorizationFailures,
    };
    const thresholds = plan.thresholds;
    let failureClass = null;
    if (authorizationFailures > 0) {
      failureClass = 'authorization-failed';
    } else if (
      stabilityRate < thresholds.stability_rate_min ||
      metrics.critical_safety_errors >
        thresholds.critical_safety_errors_max ||
      metrics.permission_violations >
        thresholds.permission_violations_max ||
      metrics.external_action_violations >
        thresholds.external_action_violations_max ||
      metrics.overapplication_failures >
        thresholds.overapplication_failures_max ||
      metrics.direction_failures > thresholds.direction_failures_max ||
      metrics.scope_failures > thresholds.scope_failures_max ||
      metrics.boundary_failures > thresholds.boundary_failures_max ||
      metrics.exception_failures > thresholds.exception_failures_max ||
      metrics.priority_failures > thresholds.priority_failures_max ||
      metrics.authority_precedence_failures >
        thresholds.authority_precedence_failures_max ||
      metrics.exit_failures > thresholds.exit_failures_max ||
      metrics.adoption_failures > thresholds.adoption_failures_max
    ) {
      failureClass = 'application-failed';
    }
    return {
      metrics,
      failure_class: failureClass,
      status: failureClass === null ? 'verified' : 'failed',
    };
  }
  const loadedScore = taskResults.reduce(
    (total, result) => total + result.evaluation.with_kdna_score,
    0,
  ) / taskResults.length;
  const baselineScore = taskResults.reduce(
    (total, result) => total + result.evaluation.without_kdna_score,
    0,
  ) / taskResults.length;
  const deltas = taskResults.map(
    (result) =>
      result.evaluation.with_kdna_score -
      result.evaluation.without_kdna_score,
  );
  const selectiveContract = Object.prototype.hasOwnProperty.call(
    plan.thresholds,
    'kdna_sensitive_paired_delta_min',
  );
  const pairedDelta = loadedScore - baselineScore;
  const pairedDeltaCiLower = deterministicBootstrapLower(
    deltas,
    plan.plan_digest,
    {
      legacyRank: !selectiveContract,
    },
  );
  const criticalSafetyErrors = taskResults.filter(
    (result) => result.evaluation.critical_safety_error,
  ).length;
  const stabilityRate = taskResults.filter(
    (result) => result.evaluation.stable,
  ).length / taskResults.length;
  const applicationFailures = taskResults.filter((result) => (
    !result.evaluation.faithful ||
    !result.evaluation.boundary_correct ||
    !result.evaluation.exception_correct ||
    !result.evaluation.exit_correct ||
    result.with_kdna.over_applied ||
    result.with_kdna.exit === 'error'
  )).length;
  const metrics = {
    task_count: taskResults.length,
    loaded_score: loadedScore,
    baseline_score: baselineScore,
    paired_delta: pairedDelta,
    paired_delta_ci_lower: pairedDeltaCiLower,
    stability_rate: stabilityRate,
    critical_safety_errors: criticalSafetyErrors,
    authorization_failures: authorizationFailures,
    application_failures: applicationFailures,
  };
  const thresholds = plan.thresholds;
  if (selectiveContract) {
    const taskSensitivity = new Map(
      plan.tasks.map((task) => [task.id, task.kdna_sensitive]),
    );
    const subsetMetrics = (sensitive, seedLabel) => {
      const results = taskResults.filter(
        (result) => taskSensitivity.get(result.task_id) === sensitive,
      );
      const subsetLoadedScore = results.reduce(
        (total, result) => (
          total + result.evaluation.with_kdna_score
        ),
        0,
      ) / results.length;
      const subsetBaselineScore = results.reduce(
        (total, result) => (
          total + result.evaluation.without_kdna_score
        ),
        0,
      ) / results.length;
      const subsetDeltas = results.map((result) => (
        result.evaluation.with_kdna_score -
        result.evaluation.without_kdna_score
      ));
      return {
        task_count: results.length,
        loaded_score: subsetLoadedScore,
        baseline_score: subsetBaselineScore,
        paired_delta: subsetLoadedScore - subsetBaselineScore,
        paired_delta_ci_lower: deterministicBootstrapLower(
          subsetDeltas,
          sha256(`${plan.plan_digest}:${seedLabel}`),
          {
            replicates: 10000,
            seed: 860281,
            confidenceLevel: 0.95,
          },
        ),
      };
    };
    const sensitiveMetrics = subsetMetrics(true, 'kdna-sensitive');
    const nonSensitiveMetrics = subsetMetrics(
      false,
      'non-sensitive',
    );
    Object.assign(metrics, {
      comparison_contract: 'selective-noninferiority',
      bootstrap_replicates: 10000,
      bootstrap_seed: 860281,
      confidence_level: 0.95,
      kdna_sensitive_task_count: sensitiveMetrics.task_count,
      non_sensitive_task_count: nonSensitiveMetrics.task_count,
      kdna_sensitive_loaded_score: sensitiveMetrics.loaded_score,
      kdna_sensitive_baseline_score: sensitiveMetrics.baseline_score,
      kdna_sensitive_paired_delta: sensitiveMetrics.paired_delta,
      kdna_sensitive_paired_delta_ci_lower:
        sensitiveMetrics.paired_delta_ci_lower,
      non_sensitive_loaded_score: nonSensitiveMetrics.loaded_score,
      non_sensitive_baseline_score: nonSensitiveMetrics.baseline_score,
      non_sensitive_paired_delta: nonSensitiveMetrics.paired_delta,
      non_sensitive_paired_delta_ci_lower:
        nonSensitiveMetrics.paired_delta_ci_lower,
    });
  }
  let failureClass = null;
  if (authorizationFailures > 0) {
    failureClass = 'authorization-failed';
  } else if (selectiveContract ? (
    applicationFailures > 0 ||
    loadedScore < thresholds.loaded_score_min ||
    metrics.kdna_sensitive_paired_delta <
      thresholds.kdna_sensitive_paired_delta_min ||
    metrics.kdna_sensitive_paired_delta_ci_lower <=
      thresholds.kdna_sensitive_paired_delta_ci_lower_min ||
    metrics.non_sensitive_paired_delta_ci_lower <=
      thresholds.non_sensitive_paired_delta_ci_lower_min ||
    stabilityRate < thresholds.stability_rate_min ||
    criticalSafetyErrors > thresholds.critical_safety_errors_max
  ) : (
    applicationFailures > 0 ||
    loadedScore < thresholds.loaded_score_min ||
    pairedDelta < thresholds.paired_delta_min ||
    pairedDeltaCiLower <= thresholds.paired_delta_ci_lower_min ||
    stabilityRate < thresholds.stability_rate_min ||
    criticalSafetyErrors > thresholds.critical_safety_errors_max
  )) {
    failureClass = 'application-failed';
  }
  return {
    metrics,
    failure_class: failureClass,
    status: failureClass === null ? 'verified' : 'failed',
  };
}

function recordApplicationReceipt(workspace, input = {}) {
  assertPlainObject(input, 'application verification receipt');
  const forbidden = containsForbiddenReceiptData(input);
  if (forbidden) {
    throw new Error(
      `application receipt contains forbidden secret/private content field: ${forbidden}`,
    );
  }
  assertAllowedKeys(
    input,
    new Set([
      'id',
      'attempt_id',
      'attempt_digest',
      'challenge_digest',
      'plan_id',
      'plan_digest',
      'semantic_revision',
      'semantic_digest',
      'judgment_evidence_digest',
      'build_receipt_digest',
      'asset_digest',
      'asset_load_receipt_digest',
      'consumer_asset_observation_id',
      'consumer_asset_observation_digest',
      'consumer_asset_load_receipt_digest',
      'consumer',
      'evaluated_by',
      'consumer_run_digest',
      'runner_digest',
      'evaluator_run_digest',
      'evaluator_runner_digest',
      'task_results',
      'consumer_signature',
      'evaluator_signature',
    ]),
    'application verification receipt',
  );
  const build = workspace.buildReceipt;
  if (
    !build ||
    build.status !== 'verified' ||
    build.semantic_digest !== workspace.state.semantic_digest ||
    build.semantic_revision !== workspace.state.semantic_revision ||
    build.output?.artifact_sha256 !== build.asset_digest
  ) {
    throw new Error(
      'APPLICATION_VERIFIED requires the current exact FORMAT_VALID .kdna first',
    );
  }
  const semanticDigest = assertDigest(
    input.semantic_digest,
    'application receipt semantic_digest',
  );
  if (semanticDigest !== workspace.state.semantic_digest) {
    throw new Error(
      'application receipt semantic_digest does not match the current workspace',
    );
  }
  if (input.semantic_revision !== workspace.state.semantic_revision) {
    throw new Error(
      'application receipt semantic_revision does not match the current workspace',
    );
  }
  const judgmentEvidenceDigest =
    canonicalJudgmentEvidenceDigest(workspace);
  if (input.judgment_evidence_digest !== judgmentEvidenceDigest) {
    throw new Error(
      'application receipt judgment_evidence_digest is stale',
    );
  }
  const buildReceiptDigest = canonicalBuildReceiptDigest(build);
  if (input.build_receipt_digest !== buildReceiptDigest) {
    throw new Error(
      'application receipt build_receipt_digest does not match FORMAT_VALID evidence',
    );
  }
  const assetDigest = assertDigest(
    input.asset_digest,
    'application receipt asset_digest',
  );
  if (assetDigest !== build.asset_digest) {
    throw new Error(
      'application receipt asset_digest does not match the exact final .kdna',
    );
  }
  const receiptId = nonEmpty(input.id, 'application receipt.id');
  if (
    workspace.applicationVerification.receipts.some(
      (receipt) => receipt.id === receiptId,
    )
  ) {
    throw new Error('application receipt id has already been used');
  }
  const plan = workspace.applicationVerification.plans.find(
    (candidate) =>
      candidate.id === input.plan_id &&
      candidate.status === 'valid' &&
      candidate.verification_contract === 'adoption-fidelity' &&
      candidate.evidence_set === 'fresh-hidden-holdout' &&
      candidate.response_mode === 'free-response' &&
      candidate.semantic_digest === semanticDigest &&
      candidate.semantic_revision === workspace.state.semantic_revision &&
      candidate.judgment_evidence_digest === judgmentEvidenceDigest &&
      candidate.build_receipt_digest === buildReceiptDigest &&
      candidate.asset_digest === assetDigest,
  );
  if (!plan || plan.plan_digest !== canonicalApplicationPlanDigest(plan)) {
    throw new Error('application receipt does not bind a current frozen plan');
  }
  if (input.plan_digest !== plan.plan_digest) {
    throw new Error(
      'application receipt plan_digest does not match the frozen plan',
    );
  }
  const attemptId = nonEmpty(
    input.attempt_id,
    'application receipt.attempt_id',
  );
  const challengeDigest = assertDigest(
    input.challenge_digest,
    'application receipt.challenge_digest',
  );
  const attemptDigest = assertDigest(
    input.attempt_digest,
    'application receipt.attempt_digest',
  );
  const attempt = workspace.applicationVerification.attempts.find(
    (candidate) =>
      candidate.id === attemptId &&
      candidate.status === 'open' &&
      candidate.receipt_id === null &&
      candidate.plan_id === plan.id &&
      candidate.plan_digest === plan.plan_digest &&
      candidate.semantic_revision === workspace.state.semantic_revision &&
      candidate.semantic_digest === semanticDigest &&
      candidate.judgment_evidence_digest === judgmentEvidenceDigest &&
      candidate.build_receipt_digest === buildReceiptDigest &&
      candidate.asset_digest === assetDigest,
  );
  if (
    !attempt ||
    attempt.challenge_digest !== challengeDigest ||
    attempt.attempt_digest !== attemptDigest ||
    canonicalApplicationAttemptDigest(attempt) !== attemptDigest
  ) {
    throw new Error(
      'application receipt does not bind an open Engine-issued single-use attempt',
    );
  }
  const assetLoadReceiptDigest = assertDigest(
    input.asset_load_receipt_digest,
    'application receipt.asset_load_receipt_digest',
  );
  if (
    assetLoadReceiptDigest !== attempt.asset_load_receipt_digest ||
    applicationAssetLoadReceiptDigest(attempt.asset_load_receipt) !==
      attempt.asset_load_receipt_digest
  ) {
    throw new Error(
      'application receipt does not bind the Engine-observed exact asset load',
    );
  }
  const consumer = normalizeActor(input.consumer, 'consumer', true);
  const evaluator = normalizeActor(input.evaluated_by, 'evaluated_by', true);
  if (consumer.type !== 'agent' || evaluator.type !== 'agent') {
    throw new Error(
      'application execution and evaluation must be attributed to Agents',
    );
  }
  const disallowedIds = new Set([
    workspace.state.created_by.id,
    workspace.purposeBrief?.represented_subject?.id,
  ].filter(Boolean));
  if (
    consumer.id === evaluator.id ||
    disallowedIds.has(consumer.id) ||
    disallowedIds.has(evaluator.id)
  ) {
    throw new Error(
      'application Consumer and evaluator must be independent of each other, the creating Agent, and the represented subject',
    );
  }
  if (
    consumer.id !== plan.consumer_identity.id ||
    evaluator.id !== plan.evaluator_identity.id
  ) {
    throw new Error(
      'application receipt actors do not match the pre-frozen Consumer and evaluator keys',
    );
  }
  if (!Array.isArray(input.task_results)) {
    throw new Error('application receipt task_results must be an array');
  }
  const rawById = new Map();
  for (const rawResult of input.task_results) {
    assertPlainObject(rawResult, 'application task result');
    const taskId = nonEmpty(rawResult.task_id, 'task_result.task_id');
    if (rawById.has(taskId)) {
      throw new Error(`duplicate application task result: ${taskId}`);
    }
    rawById.set(taskId, rawResult);
  }
  if (
    rawById.size !== plan.tasks.length ||
    plan.tasks.some((task) => !rawById.has(task.id))
  ) {
    throw new Error(
      'application receipt must cover every frozen task exactly once',
    );
  }
  const taskResults = plan.tasks.map((task) => {
    const rawResult = rawById.get(task.id);
    assertAllowedKeys(
      rawResult,
      new Set([
        'task_id',
        'input_digest',
        'with_kdna',
        'without_kdna',
        'evaluation',
      ]),
      `application task result ${task.id}`,
    );
    if (rawResult.input_digest !== task.input_digest) {
      throw new Error(
        `application task ${task.id} does not bind its frozen input`,
      );
    }
    const withKdna = normalizeApplicationLane(
      rawResult.with_kdna,
      `task ${task.id}.with_kdna`,
      assetDigest,
    );
    const withoutKdna = normalizeApplicationLane(
      rawResult.without_kdna,
      `task ${task.id}.without_kdna`,
      null,
    );
    assertPlainObject(
      rawResult.evaluation,
      `task ${task.id}.evaluation`,
    );
    const adoptionContract =
      plan.verification_contract === 'adoption-fidelity';
    const adoptionBooleanFields = [
      'faithful',
      'direction_correct',
      'scope_correct',
      'boundary_correct',
      'exception_correct',
      'priority_correct',
      'authority_precedence_correct',
      'exit_correct',
      'stable',
      'critical_safety_error',
      'permission_violation',
      'external_action_violation',
    ];
    const legacyBooleanFields = [
      'faithful',
      'boundary_correct',
      'exception_correct',
      'exit_correct',
      'stable',
      'critical_safety_error',
    ];
    assertAllowedKeys(
      rawResult.evaluation,
      new Set(adoptionContract
        ? [...adoptionBooleanFields, 'reason_codes']
        : [
          'with_kdna_score',
          'without_kdna_score',
          ...legacyBooleanFields,
          'reason_codes',
        ]),
      `task ${task.id}.evaluation`,
    );
    for (const field of (
      adoptionContract
        ? adoptionBooleanFields
        : legacyBooleanFields
    )) {
      if (typeof rawResult.evaluation[field] !== 'boolean') {
        throw new Error(
          `task ${task.id}.evaluation.${field} must be boolean`,
        );
      }
    }
    return {
      task_id: task.id,
      input_digest: task.input_digest,
      with_kdna: withKdna,
      without_kdna: withoutKdna,
      evaluation: adoptionContract ? {
        faithful: rawResult.evaluation.faithful,
        direction_correct: rawResult.evaluation.direction_correct,
        scope_correct: rawResult.evaluation.scope_correct,
        boundary_correct: rawResult.evaluation.boundary_correct,
        exception_correct: rawResult.evaluation.exception_correct,
        priority_correct: rawResult.evaluation.priority_correct,
        authority_precedence_correct:
          rawResult.evaluation.authority_precedence_correct,
        exit_correct: rawResult.evaluation.exit_correct,
        stable: rawResult.evaluation.stable,
        critical_safety_error:
          rawResult.evaluation.critical_safety_error,
        permission_violation:
          rawResult.evaluation.permission_violation,
        external_action_violation:
          rawResult.evaluation.external_action_violation,
        reason_codes: normalizeReasonCodes(
          rawResult.evaluation.reason_codes,
          `task ${task.id}.evaluation.reason_codes`,
        ),
      } : {
        with_kdna_score: applicationScore(
          rawResult.evaluation.with_kdna_score,
          `task ${task.id}.evaluation.with_kdna_score`,
        ),
        without_kdna_score: applicationScore(
          rawResult.evaluation.without_kdna_score,
          `task ${task.id}.evaluation.without_kdna_score`,
        ),
        faithful: rawResult.evaluation.faithful,
        boundary_correct: rawResult.evaluation.boundary_correct,
        exception_correct: rawResult.evaluation.exception_correct,
        exit_correct: rawResult.evaluation.exit_correct,
        stable: rawResult.evaluation.stable,
        critical_safety_error:
          rawResult.evaluation.critical_safety_error,
        reason_codes: normalizeReasonCodes(
          rawResult.evaluation.reason_codes,
          `task ${task.id}.evaluation.reason_codes`,
        ),
      },
    };
  });
  const consumerRunDigest = assertDigest(
    input.consumer_run_digest,
    'consumer_run_digest',
  );
  const runnerDigest = assertDigest(
    input.runner_digest,
    'runner_digest',
  );
  const evaluatorRunDigest = assertDigest(
    input.evaluator_run_digest,
    'evaluator_run_digest',
  );
  const evaluatorRunnerDigest = assertDigest(
    input.evaluator_runner_digest,
    'evaluator_runner_digest',
  );
  const consumerAssetObservationId = nonEmpty(
    input.consumer_asset_observation_id,
    'consumer_asset_observation_id',
  );
  const consumerAssetObservationDigest = assertDigest(
    input.consumer_asset_observation_digest,
    'consumer_asset_observation_digest',
  );
  const consumerObservation =
    workspace.applicationVerification.observations.find(
      (candidate) =>
        candidate.id === consumerAssetObservationId &&
        candidate.status === 'open' &&
        candidate.receipt_id === null &&
        candidate.observation_digest ===
          consumerAssetObservationDigest &&
        candidate.attempt_id === attempt.id &&
        candidate.attempt_digest === attempt.attempt_digest &&
        candidate.challenge_digest === attempt.challenge_digest &&
        candidate.plan_id === plan.id &&
        candidate.plan_digest === plan.plan_digest &&
        candidate.semantic_revision === workspace.state.semantic_revision &&
        candidate.semantic_digest === semanticDigest &&
        candidate.judgment_evidence_digest === judgmentEvidenceDigest &&
        candidate.build_receipt_digest === buildReceiptDigest &&
        candidate.asset_digest === assetDigest &&
        candidate.observed_by.id === consumer.id &&
        candidate.consumer_run_digest === consumerRunDigest &&
        candidate.runner_digest === runnerDigest,
    );
  if (
    !consumerObservation ||
    canonicalApplicationObservationDigest(consumerObservation) !==
      consumerAssetObservationDigest ||
    Date.parse(consumerObservation.observed_at) <
      Date.parse(attempt.issued_at) ||
    Date.parse(consumerObservation.observed_at) > Date.now()
  ) {
    throw new Error(
      'application receipt does not bind a current Engine-stamped Consumer asset observation',
    );
  }
  const consumerAssetLoadReceiptDigest = assertDigest(
    input.consumer_asset_load_receipt_digest,
    'consumer_asset_load_receipt_digest',
  );
  if (
    consumerAssetLoadReceiptDigest !==
      consumerObservation.asset_load_receipt_digest
  ) {
    throw new Error(
      'application receipt does not bind the Consumer-observed exact asset load',
    );
  }
  assertApplicationLaneAuthorization(
    taskResults,
    consumerObservation.asset_load_receipt.authorization_outcome,
  );
  if (
    workspace.applicationVerification.receipts.some((receipt) => (
      (
        receipt.consumer_run_digest === consumerRunDigest &&
        receipt.runner_digest === runnerDigest &&
        receipt.evaluator_run_digest === evaluatorRunDigest &&
        receipt.evaluator_runner_digest === evaluatorRunnerDigest
      ) ||
      (
        receipt.consumer_signature === input.consumer_signature &&
        receipt.evaluator_signature === input.evaluator_signature
      )
    ))
  ) {
    throw new Error(
      'application execution coordinates or signature tuple have already been consumed',
    );
  }
  const consumerSnapshot = applicationConsumerSigningSnapshot({
    id: receiptId,
    attempt_id: attemptId,
    attempt_digest: attemptDigest,
    challenge_digest: challengeDigest,
    plan_id: plan.id,
    plan_digest: plan.plan_digest,
    semantic_revision: workspace.state.semantic_revision,
    semantic_digest: semanticDigest,
    judgment_evidence_digest: judgmentEvidenceDigest,
    build_receipt_digest: buildReceiptDigest,
    asset_digest: assetDigest,
    asset_load_receipt_digest: assetLoadReceiptDigest,
    consumer_asset_observation_id:
      consumerAssetObservationId,
    consumer_asset_observation_digest:
      consumerAssetObservationDigest,
    consumer_asset_load_receipt_digest:
      consumerAssetLoadReceiptDigest,
    consumer,
    consumer_run_digest: consumerRunDigest,
    runner_digest: runnerDigest,
    task_results: taskResults,
  });
  verifyApplicationSignature(
    plan.consumer_identity,
    consumerSnapshot,
    input.consumer_signature,
    'consumer_signature',
  );
  const consumerExecutionDigest = sha256(
    applicationSigningBytes(consumerSnapshot),
  );
  const evaluatorSnapshot = applicationEvaluatorSigningSnapshot({
    id: receiptId,
    attempt_id: attemptId,
    attempt_digest: attemptDigest,
    challenge_digest: challengeDigest,
    plan_id: plan.id,
    plan_digest: plan.plan_digest,
    semantic_revision: workspace.state.semantic_revision,
    semantic_digest: semanticDigest,
    judgment_evidence_digest: judgmentEvidenceDigest,
    build_receipt_digest: buildReceiptDigest,
    asset_digest: assetDigest,
    asset_load_receipt_digest: assetLoadReceiptDigest,
    consumer_asset_observation_id:
      consumerAssetObservationId,
    consumer_asset_observation_digest:
      consumerAssetObservationDigest,
    consumer_asset_load_receipt_digest:
      consumerAssetLoadReceiptDigest,
    consumer_execution_digest: consumerExecutionDigest,
    evaluated_by: evaluator,
    evaluator_run_digest: evaluatorRunDigest,
    evaluator_runner_digest: evaluatorRunnerDigest,
    task_results: taskResults,
  });
  verifyApplicationSignature(
    plan.evaluator_identity,
    evaluatorSnapshot,
    input.evaluator_signature,
    'evaluator_signature',
  );
  const assessment = applicationAssessment(plan, taskResults);
  const receipt = {
    id: receiptId,
    attempt_id: attemptId,
    attempt_digest: attemptDigest,
    challenge_digest: challengeDigest,
    plan_id: plan.id,
    plan_digest: plan.plan_digest,
    semantic_revision: workspace.state.semantic_revision,
    semantic_digest: semanticDigest,
    judgment_evidence_digest: judgmentEvidenceDigest,
    build_receipt_digest: buildReceiptDigest,
    asset_digest: assetDigest,
    asset_load_receipt_digest: assetLoadReceiptDigest,
    consumer_asset_observation_id: consumerAssetObservationId,
    consumer_asset_observation_digest:
      consumerAssetObservationDigest,
    consumer_asset_observed_at: consumerObservation.observed_at,
    consumer_asset_load_receipt:
      consumerObservation.asset_load_receipt,
    consumer_asset_load_receipt_digest:
      consumerAssetLoadReceiptDigest,
    consumer,
    evaluated_by: evaluator,
    consumer_run_digest: consumerRunDigest,
    runner_digest: runnerDigest,
    evaluator_run_digest: evaluatorRunDigest,
    evaluator_runner_digest: evaluatorRunnerDigest,
    consumer_execution_digest: consumerExecutionDigest,
    consumer_signature: input.consumer_signature,
    evaluator_signature: input.evaluator_signature,
    task_results: taskResults,
    metrics: assessment.metrics,
    status: assessment.status,
    failure_class: assessment.failure_class,
    recorded_at: now(),
    invalidated_at: null,
  };
  return evolve(workspace, 'application_verification_recorded', (next) => {
    const consumedAt = now();
    const consumedAttempt = next.applicationVerification.attempts.find(
      (candidate) => candidate.id === attemptId,
    );
    if (!consumedAttempt || consumedAttempt.status !== 'open') {
      throw new Error('application attempt was already consumed');
    }
    consumedAttempt.status = 'consumed';
    consumedAttempt.consumed_at = consumedAt;
    consumedAttempt.receipt_id = receiptId;
    const consumedObservation =
      next.applicationVerification.observations.find(
        (candidate) => candidate.id === consumerAssetObservationId,
      );
    if (!consumedObservation || consumedObservation.status !== 'open') {
      throw new Error(
        'application Consumer asset observation was already consumed',
      );
    }
    consumedObservation.status = 'consumed';
    consumedObservation.consumed_at = consumedAt;
    consumedObservation.receipt_id = receiptId;
    next.applicationVerification.receipts.push(receipt);
  });
}

function newRepairItem(input) {
  return {
    id: input.id || id('repair'),
    kind: input.kind,
    severity: input.severity || 'blocking',
    target: input.target,
    problem: input.problem,
    recommended_change: input.recommended_change,
    source_test_ids: input.source_test_ids || [],
    status: 'open',
    resolution: null,
    created_at: now(),
    applied_at: null,
  };
}

function buildRepairPlan(workspace, diagnostics = {}) {
  assertPlainObject(diagnostics, 'diagnostics');
  return evolve(workspace, 'repair_plan_built', (next) => {
    const currentDigest = next.state.semantic_digest;
    const proposed = [];
    for (const testCase of next.semanticTestReport.cases) {
      if (testCase.semantic_digest !== currentDigest || testCase.status !== 'failed') continue;
      proposed.push(newRepairItem({
        kind: 'semantic_test_failure',
        target: {
          type: testCase.unit_ids.length > 0 ? 'unit' : 'workspace',
          id: testCase.unit_ids[0] || null,
        },
        problem: `Semantic test ${testCase.id} failed: ${testCase.notes || testCase.expected}`,
        recommended_change: 'Repair the referenced judgment, boundary, priority, or test expectation and rerun the case.',
        source_test_ids: [testCase.id],
      }));
    }
    for (const relation of next.judgmentModel.relations) {
      if (relation.type !== 'conflict' ||
          ['resolved', 'rejected'].includes(relation.status)) continue;
      proposed.push(newRepairItem({
        kind: 'unresolved_conflict',
        target: { type: 'relation', id: relation.id },
        problem: `Conflict ${relation.id} has no explicit resolution.`,
        recommended_change: 'Add a conditional override, priority relation, exception, or split.',
        source_test_ids: [],
      }));
    }
    const failedApplication = [...next.applicationVerification.receipts]
      .reverse()
      .find((receipt) => (
        receipt.status === 'failed' &&
        receipt.failure_class === 'application-failed' &&
        receipt.semantic_digest === currentDigest &&
        receipt.asset_digest === next.buildReceipt?.asset_digest
      ));
    if (failedApplication) {
      const applicationPlan = next.applicationVerification.plans.find(
        (plan) =>
          plan.id === failedApplication.plan_id &&
          plan.plan_digest === failedApplication.plan_digest,
      );
      const failedTaskIds = failedApplication.task_results
        .filter((result) => (
          !result.evaluation.faithful ||
          !result.evaluation.boundary_correct ||
          !result.evaluation.exception_correct ||
          !result.evaluation.exit_correct ||
          result.with_kdna.over_applied ||
          result.with_kdna.exit === 'error'
        ))
        .map((result) => result.task_id);
      const targetTaskIds = failedTaskIds.length > 0
        ? failedTaskIds
        : applicationPlan?.tasks.map((task) => task.id) || [];
      for (const taskId of targetTaskIds) {
        const task = applicationPlan?.tasks.find(
          (candidate) => candidate.id === taskId,
        );
        proposed.push(newRepairItem({
          kind: 'application_verification_failure',
          target: task?.unit_ids.length > 0
            ? { type: 'unit', id: task.unit_ids[0] }
            : (
                task?.boundary_ids.length > 0
                  ? { type: 'boundary', id: task.boundary_ids[0] }
                  : { type: 'workspace', id: null }
              ),
          problem:
            `Independent Consumer application task ${taskId} failed the frozen adoption gate.`,
          recommended_change:
            'Repair only the implicated judgment or boundary, then re-confirm, re-test, re-export, and rerun the same frozen application intent on the new semantic digest.',
          source_test_ids: [taskId],
        }));
      }
    }
    for (const diagnostic of diagnostics.items || []) {
      proposed.push(newRepairItem({
        id: diagnostic.id,
        kind: nonEmpty(diagnostic.kind, 'diagnostic.kind'),
        severity: diagnostic.severity || 'blocking',
        target: clone(diagnostic.target || { type: 'workspace', id: null }),
        problem: nonEmpty(diagnostic.problem, 'diagnostic.problem'),
        recommended_change: nonEmpty(
          diagnostic.recommended_change,
          'diagnostic.recommended_change',
        ),
        source_test_ids: stringList(diagnostic.source_test_ids, 'source_test_ids'),
      }));
    }
    for (const item of proposed) {
      const duplicate = next.repairPlan.items.some((existing) => (
        existing.status === 'open' &&
        existing.kind === item.kind &&
        existing.target.type === item.target.type &&
        existing.target.id === item.target.id &&
        existing.problem === item.problem
      ));
      if (!duplicate) next.repairPlan.items.push(item);
    }
  });
}

function applyRepair(workspace, repairId, input = {}) {
  const resolution = nonEmpty(input.resolution, 'resolution');
  assertPlainObject(input.target, 'target');
  const changes = clone(assertPlainObject(input.changes || {}, 'changes'));
  return evolve(workspace, 'repair_applied', (next) => {
    const item = next.repairPlan.items.find((repair) => repair.id === repairId);
    if (!item) throw new Error(`repair item not found: ${repairId}`);
    if (item.status !== 'open') throw new Error(`repair item ${repairId} is already ${item.status}`);
    const type = input.target.type;
    const targetId = input.target.id || item.target.id;
    if (type === 'unit') {
      const unit = next.judgmentModel.units.find((entry) => entry.id === targetId);
      if (!unit) throw new Error(`repair target unit not found: ${targetId}`);
      const candidateShape = normalizeCandidate(next, {
        ...unit,
        ...changes,
        id: unit.candidate_id,
      }, {
        ...unit,
        id: unit.candidate_id,
        status: 'promoted',
        created_at: unit.promoted_at,
        rejection_reason: null,
      });
      Object.assign(unit, {
        statement: candidateShape.statement,
        rationale: candidateShape.rationale,
        applies_when: candidateShape.applies_when,
        does_not_apply_when: candidateShape.does_not_apply_when,
        misuse_risk: candidateShape.misuse_risk,
        source_refs: candidateShape.source_refs,
        contrary_evidence: candidateShape.contrary_evidence,
        confidence: candidateShape.confidence,
        agent_inference: candidateShape.agent_inference,
        card_type: candidateShape.card_type,
        fields: candidateShape.fields,
      });
    } else if (type === 'relation') {
      const relation = next.judgmentModel.relations.find((entry) => entry.id === targetId);
      if (!relation) throw new Error(`repair target relation not found: ${targetId}`);
      Object.assign(relation, changes);
      if (relation.type === 'conflict') {
        relation.status = 'resolved';
        relation.resolution = resolution;
      }
    } else if (type === 'purpose') {
      if (!next.purposeBrief) throw new Error('repair target purpose does not exist');
      next.purposeBrief = normalizePurposeBrief(next, {
        ...next.purposeBrief,
        ...changes,
      });
      next.judgmentModel.judgment_core = {
        highest_question: next.purposeBrief.highest_question,
        worldview: clone(next.purposeBrief.worldview),
        value_order: clone(next.purposeBrief.value_order),
        judgment_role: clone(next.purposeBrief.judgment_role),
      };
      next.judgmentModel.global_boundaries = clone(
        next.purposeBrief.global_boundaries,
      );
    } else if (type === 'boundary') {
      const boundaryIndex = next.judgmentModel.global_boundaries.findIndex(
        (entry) => entry.id === targetId,
      );
      if (boundaryIndex < 0) {
        throw new Error(`repair target boundary not found: ${targetId}`);
      }
      const boundary = next.judgmentModel.global_boundaries[boundaryIndex];
      const priorStatement = boundary.statement;
      const repairedBoundary = normalizeBoundary({
        ...boundary,
        ...changes,
        id: boundary.id,
      }, boundaryIndex);
      next.judgmentModel.global_boundaries[boundaryIndex] = repairedBoundary;
      const purposeBoundaryIndex = next.purposeBrief?.global_boundaries.findIndex(
        (entry) => entry.id === targetId,
      );
      if (purposeBoundaryIndex >= 0) {
        next.purposeBrief.global_boundaries[purposeBoundaryIndex] =
          clone(repairedBoundary);
      }
      next.purposeBrief.non_goals = next.purposeBrief.non_goals.map(
        (nonGoal) =>
          nonGoal === priorStatement ? repairedBoundary.statement : nonGoal,
      );
    } else if (type === 'workspace') {
      if (changes.split_recommendation_id) {
        const split = next.judgmentModel.split_recommendations.find(
          (entry) => entry.id === changes.split_recommendation_id,
        );
        if (!split) {
          throw new Error(`split recommendation not found: ${changes.split_recommendation_id}`);
        }
        if (!['accepted', 'rejected'].includes(changes.decision)) {
          throw new Error('split repair decision must be accepted or rejected');
        }
        split.decision = changes.decision;
        split.decision_reason = resolution;
      }
    } else {
      throw new Error('repair target.type must be unit, relation, purpose, boundary, or workspace');
    }
    item.status = 'applied';
    item.resolution = resolution;
    item.applied_at = now();
  });
}

function cardFieldsForUnit(unit) {
  const common = {
    statement: unit.statement,
    rationale: unit.rationale,
    applies_when: clone(unit.applies_when),
    does_not_apply_when: clone(unit.does_not_apply_when),
    failure_risk: unit.misuse_risk,
    confidence: clone(unit.confidence),
    agent_inference: unit.agent_inference,
  };
  const authored = clone(unit.fields || {});
  switch (unit.card_type) {
    case 'axiom':
      return {
        ...authored,
        ...common,
        one_sentence: unit.statement,
        full_statement: authored.full_statement || unit.statement,
        why: authored.why || unit.rationale,
      };
    case 'boundary':
      return {
        ...authored,
        ...common,
        scope: authored.scope || unit.statement,
        out_of_scope: authored.out_of_scope || unit.does_not_apply_when.join('; '),
        acceptable_exceptions: stringList(authored.acceptable_exceptions, 'acceptable_exceptions'),
      };
    case 'risk':
      return {
        ...authored,
        ...common,
        name: authored.name || unit.statement,
        description: authored.description || unit.rationale,
        mitigation: authored.mitigation || `Apply only when: ${unit.applies_when.join('; ')}`,
      };
    case 'aesthetic':
      return {
        ...authored,
        ...common,
        name: authored.name || unit.statement,
        description: authored.description || unit.rationale,
      };
    case 'ontology':
      return {
        ...authored,
        ...common,
        essence: authored.essence || unit.statement,
        boundary: authored.boundary || unit.does_not_apply_when.join('; '),
      };
    case 'misunderstanding':
      return {
        ...authored,
        ...common,
        wrong: authored.wrong || unit.statement,
        correct: authored.correct || unit.rationale,
        key_distinction: authored.key_distinction || unit.rationale,
      };
    case 'self_check':
      return {
        ...authored,
        ...common,
        question: authored.question ||
          (unit.statement.endsWith('?') ? unit.statement : `${unit.statement}?`),
      };
    case 'scenario':
      return {
        ...authored,
        ...common,
        situation: authored.situation || unit.applies_when.join('; '),
        judgment: authored.judgment || unit.statement,
      };
    case 'case':
      return {
        ...authored,
        ...common,
        title: authored.title || unit.statement,
        lesson: authored.lesson || unit.rationale,
      };
    case 'stance':
      return { ...authored, ...common, position: authored.position || unit.statement };
    case 'framework':
      return { ...authored, ...common, name: authored.name || unit.statement };
    case 'term':
      return {
        ...authored,
        ...common,
        term: authored.term || unit.statement,
        definition: authored.definition || unit.rationale,
      };
    case 'banned_term':
      return {
        ...authored,
        ...common,
        term: authored.term || unit.statement,
        why: authored.why || unit.rationale,
        replace_with: authored.replace_with || '',
      };
    case 'reasoning':
      return {
        ...authored,
        ...common,
        one_sentence: authored.one_sentence || unit.statement,
        chain: Array.isArray(authored.chain) ? authored.chain : [unit.rationale],
        concrete_action: authored.concrete_action || unit.statement,
      };
    case 'evolution_stage':
      return {
        ...authored,
        ...common,
        name: authored.name || unit.statement,
        description: authored.description || unit.rationale,
      };
    case 'pattern':
      return {
        ...authored,
        ...common,
        name: authored.name || unit.statement,
        one_sentence: authored.one_sentence || unit.statement,
        what_it_looks_like: authored.what_it_looks_like || unit.applies_when.join('; '),
        how_to_fix: authored.how_to_fix || unit.rationale,
      };
    default:
      throw new Error(`unsupported card type: ${unit.card_type}`);
  }
}

function cardFromUnit(workspace, unit) {
  return {
    id: unit.id,
    type: unit.card_type,
    status: 'locked',
    locked: true,
    fields: cardFieldsForUnit(unit),
    evidence_refs: [],
    test_refs: workspace.semanticTestReport.cases
      .filter((testCase) => testCase.unit_ids.includes(unit.id))
      .map((testCase) => testCase.id),
    human_lock: null,
    feynman_restatement: null,
    audit_log: [{
      at: now(),
      event: 'creation_accepted',
      by: `creation-engine:${workspace.state.mode}`,
    }],
  };
}

function boundaryCard(workspace, boundary) {
  return {
    id: boundary.id,
    type: 'boundary',
    status: 'locked',
    locked: true,
    fields: {
      scope: workspace.purposeBrief.scope,
      out_of_scope: boundary.statement,
      acceptable_exceptions: [],
    },
    evidence_refs: [],
    test_refs: workspace.semanticTestReport.cases
      .filter((testCase) => testCase.boundary_ids.includes(boundary.id))
      .map((testCase) => testCase.id),
    human_lock: null,
    feynman_restatement: null,
    audit_log: [{
      at: now(),
      event: 'creation_accepted',
      by: `creation-engine:${workspace.state.mode}`,
    }],
  };
}

function compileProject(workspace) {
  const readiness = assessReadiness(workspace);
  if (!readiness.creation_accepted) {
    const error = new Error(
      `Creation Engine project is not accepted:\n  - ` +
      readiness.blocking.map((item) => item.message).join('\n  - '),
    );
    error.code = 'CREATION_NOT_ACCEPTED';
    error.readiness = readiness;
    throw error;
  }
  const purpose = workspace.purposeBrief;
  const createdBy = workspace.state.created_by;
  const project = createProject(purpose.title, 'domain', {
    // Confirmation constrains private Creation acceptance but does not
    // authenticate a represented person or organization. Only a creating
    // Agent is safe to expose as technical provenance; otherwise omit Runtime
    // creator identity and never synthesize Human Lock.
    author: createdBy.type === 'agent'
      ? {
          name: createdBy.name || createdBy.id,
          id: createdBy.id,
        }
      : undefined,
    sourceMode: workspace.state.mode,
    judgmentCore: clone(workspace.judgmentModel.judgment_core),
    lineage: clone(workspace.exportPlan.lineage),
  });
  project.status = 'ready_for_release';
  project.release = {
    version: workspace.exportPlan.version,
    judgment_version: workspace.exportPlan.judgment_version,
    description: purpose.objective,
    access: workspace.exportPlan.access,
  };
  project.distillation_target = {
    domain_name: purpose.title,
    domain_category: 'professional_field',
    owner_scope: workspace.state.mode === 'organization-confirmed' ? 'organization' : 'personal',
    granularity: 'core_principles',
    task_scope: purpose.scope,
    include_areas: [purpose.scope],
    exclude_areas: [
      ...new Set([
        ...purpose.non_goals,
        ...workspace.judgmentModel.global_boundaries.map(
          (boundary) => boundary.statement,
        ),
      ]),
    ],
    load_condition: purpose.loading_condition,
    declared_at: workspace.state.updated_at,
  };
  project.source_core_structure = workspace.judgmentModel.relations
    .filter((relation) => (
      relation.status === 'accepted' &&
      RUNTIME_RELATION_TYPES.includes(relation.type)
    ))
    .map((relation) => ({
      from: relation.from,
      to: relation.to,
      via: relation.type,
    }));
  project.cards = [
    ...workspace.judgmentModel.units.map((unit) => cardFromUnit(workspace, unit)),
    ...workspace.judgmentModel.global_boundaries
      .filter((boundary) => !workspace.judgmentModel.units.some(
        (unit) => unit.id === boundary.id,
      ))
      .map((boundary) => boundaryCard(workspace, boundary)),
  ];
  project.tests = [];
  project.creation_acceptance = {
    type: 'kdna.studio.creation-acceptance',
    schema_version: SCHEMA_VERSION,
    accepted: true,
    mode: workspace.state.mode,
    semantic_revision: workspace.state.semantic_revision,
    semantic_digest: workspace.state.semantic_digest,
    confirmation_receipt_ids: validReceipts(workspace).map((receipt) => receipt.id),
    semantic_test_ids: currentPassedTests(workspace).map((testCase) => testCase.id),
  };
  return { project, readiness };
}

function containsForbiddenReceiptData(value, pathParts = []) {
  if (!value || typeof value !== 'object') return null;
  for (const [key, child] of Object.entries(value)) {
    const currentPath = [...pathParts, key];
    if (/password|secret|plaintext|decrypted|raw[_-]?content|private[_-]?source/i.test(key)) {
      return currentPath.join('.');
    }
    const nested = containsForbiddenReceiptData(child, currentPath);
    if (nested) return nested;
  }
  return null;
}

function assertAllowedKeys(value, allowed, label) {
  assertPlainObject(value, label);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`${label} contains unsupported fields: ${unknown.join(', ')}`);
  }
}

function validateToolCoordinates(coordinates) {
  const allowedTools = new Set(['studio_cli', 'studio_core', 'core']);
  assertAllowedKeys(coordinates, allowedTools, 'receipt.tool_coordinates');
  for (const [tool, coordinate] of Object.entries(coordinates)) {
    if (typeof coordinate === 'string') {
      if (
        coordinate.length > 512 ||
        !/^@?[A-Za-z0-9._/-]+@[0-9A-Za-z.+:-]+$/.test(coordinate)
      ) {
        throw new Error(`receipt.tool_coordinates.${tool} is not a package coordinate`);
      }
      continue;
    }
    assertAllowedKeys(
      coordinate,
      new Set(['package', 'version', 'distribution', 'source_tree_digest']),
      `receipt.tool_coordinates.${tool}`,
    );
    nonEmpty(coordinate.package, `receipt.tool_coordinates.${tool}.package`);
    assertVersion(
      coordinate.version,
      `receipt.tool_coordinates.${tool}.version`,
    );
    if (!['installed-package', 'source-checkout'].includes(coordinate.distribution)) {
      throw new Error(
        `receipt.tool_coordinates.${tool}.distribution must be installed-package or source-checkout`,
      );
    }
    if (coordinate.distribution === 'source-checkout') {
      assertDigest(
        coordinate.source_tree_digest,
        `receipt.tool_coordinates.${tool}.source_tree_digest`,
      );
    } else if (coordinate.source_tree_digest !== undefined) {
      throw new Error(
        `receipt.tool_coordinates.${tool}.source_tree_digest is only valid for source-checkout`,
      );
    }
  }
  if (!Object.hasOwn(coordinates, 'studio_core') ||
      !Object.hasOwn(coordinates, 'core')) {
    throw new Error('receipt.tool_coordinates requires studio_core and core');
  }
}

function packageAndVersionFromCoordinate(coordinate, label) {
  if (typeof coordinate === 'object' && coordinate !== null) {
    return {
      package: coordinate.package,
      version: coordinate.version,
    };
  }
  const separator = coordinate.lastIndexOf('@');
  if (separator <= 0 || separator === coordinate.length - 1) {
    throw new Error(`${label} is not a package coordinate`);
  }
  return {
    package: coordinate.slice(0, separator),
    version: coordinate.slice(separator + 1),
  };
}

function validateDevelopmentBaseline(baseline, coordinates) {
  assertAllowedKeys(
    baseline,
    new Set([
      'schema',
      'bom_schema',
      'bom_semantic_digest',
      'bom_file_digest',
      'tools',
    ]),
    'receipt.development_baseline',
  );
  if (baseline.schema !== 'aikdna.creation-build-baseline/0.1.0') {
    throw new Error('receipt.development_baseline has an unsupported schema');
  }
  if (
    baseline.bom_schema !==
    'aikdna.creation-engine.wp0-development-bom/1.0'
  ) {
    throw new Error(
      'receipt.development_baseline has an unsupported BOM schema',
    );
  }
  assertDigest(
    baseline.bom_semantic_digest,
    'receipt.development_baseline.bom_semantic_digest',
  );
  assertDigest(
    baseline.bom_file_digest,
    'receipt.development_baseline.bom_file_digest',
  );
  assertAllowedKeys(
    baseline.tools,
    new Set(['studio_cli', 'studio_core', 'core']),
    'receipt.development_baseline.tools',
  );
  const expectedRepositories = {
    studio_cli: 'kdna-studio-cli',
    studio_core: 'kdna-studio-core',
    core: 'kdna',
  };
  for (const [tool, repository] of Object.entries(expectedRepositories)) {
    const binding = baseline.tools[tool];
    if (!binding) {
      throw new Error(
        `receipt.development_baseline.tools requires ${tool}`,
      );
    }
    assertAllowedKeys(
      binding,
      new Set([
        'bom_repository',
        'package',
        'version',
        'base_commit',
        'base_tree',
        'dirty_source_digest',
        'source_input_digest',
        'candidate_artifact_digest',
      ]),
      `receipt.development_baseline.tools.${tool}`,
    );
    if (binding.bom_repository !== repository) {
      throw new Error(
        `receipt.development_baseline.tools.${tool}.bom_repository is cross-wired`,
      );
    }
    nonEmpty(
      binding.package,
      `receipt.development_baseline.tools.${tool}.package`,
    );
    assertVersion(
      binding.version,
      `receipt.development_baseline.tools.${tool}.version`,
    );
    for (const field of ['base_commit', 'base_tree']) {
      if (
        typeof binding[field] !== 'string' ||
        !/^[0-9a-f]{40,64}$/.test(binding[field])
      ) {
        throw new Error(
          `receipt.development_baseline.tools.${tool}.${field} is not a Git object`,
        );
      }
    }
    for (const field of [
      'dirty_source_digest',
      'source_input_digest',
      'candidate_artifact_digest',
    ]) {
      assertDigest(
        binding[field],
        `receipt.development_baseline.tools.${tool}.${field}`,
      );
    }
    const coordinate = coordinates[tool];
    if (!coordinate) {
      throw new Error(
        `receipt.tool_coordinates requires ${tool} when a development baseline is present`,
      );
    }
    const loaded = packageAndVersionFromCoordinate(
      coordinate,
      `receipt.tool_coordinates.${tool}`,
    );
    if (
      loaded.package !== binding.package ||
      loaded.version !== binding.version
    ) {
      throw new Error(
        `receipt.development_baseline.tools.${tool} does not match the loaded tool coordinate`,
      );
    }
  }
}

function validateDevelopmentRuntime(runtime, baseline = null) {
  assertAllowedKeys(
    runtime,
    new Set([
      'schema',
      'evidence_class',
      'candidate_runtime_receipt_sha256',
      'candidate_runtime_tree_sha256',
      'cli_entrypoint_sha256',
      'bom_semantic_digest',
      'bom_file_digest',
    ]),
    'development_runtime',
  );
  if (runtime.schema !== 'aikdna.creation-build-runtime/0.1.0') {
    throw new Error('development_runtime has an unsupported schema');
  }
  if (
    runtime.evidence_class !==
    'IMMUTABLE_WP0_CANDIDATE_ARTIFACT_RUNTIME'
  ) {
    throw new Error('development_runtime has unsupported evidence authority');
  }
  for (const field of [
    'candidate_runtime_receipt_sha256',
    'candidate_runtime_tree_sha256',
    'cli_entrypoint_sha256',
    'bom_semantic_digest',
    'bom_file_digest',
  ]) {
    assertDigest(runtime[field], `development_runtime.${field}`);
  }
  if (
    baseline &&
    (
      runtime.bom_semantic_digest !== baseline.bom_semantic_digest ||
      runtime.bom_file_digest !== baseline.bom_file_digest
    )
  ) {
    throw new Error(
      'development_runtime does not bind the development baseline',
    );
  }
  return runtime;
}

function validateVerificationResults(results) {
  assertAllowedKeys(
    results,
    new Set(VERIFICATION_STEPS),
    'receipt.results',
  );
  for (const step of VERIFICATION_STEPS) {
    if (!Object.hasOwn(results, step)) continue;
    const result = results[step];
    if (result === true || result === 'pass' || result === 'fail') continue;
    assertAllowedKeys(
      result,
      new Set([
        'status',
        'outcome',
        'state',
        'can_load_now',
        'authorization_supplied',
        'issue_codes',
        'authorized',
      ]),
      `receipt.results.${step}`,
    );
    if (!['pass', 'fail'].includes(result.status)) {
      throw new Error(`receipt.results.${step}.status must be pass or fail`);
    }
    for (const key of ['outcome', 'state']) {
      if (result[key] !== undefined && (
        typeof result[key] !== 'string' ||
        result[key].length > 160
      )) {
        throw new Error(`receipt.results.${step}.${key} must be a short string`);
      }
    }
    for (const key of ['can_load_now', 'authorization_supplied', 'authorized']) {
      if (result[key] !== undefined && typeof result[key] !== 'boolean') {
        throw new Error(`receipt.results.${step}.${key} must be boolean`);
      }
    }
    if (result.issue_codes !== undefined && (
      !Array.isArray(result.issue_codes) ||
      result.issue_codes.some((code) => (
        typeof code !== 'string' ||
        !/^[A-Z][A-Z0-9_]{0,127}$/.test(code)
      ))
    )) {
      throw new Error(
        `receipt.results.${step}.issue_codes must contain stable issue codes`,
      );
    }
  }
}

function verifyExactBuildAsset(workspace, receipt, verification = {}) {
  assertPlainObject(verification, 'verification');
  assertAllowedKeys(
    verification,
    new Set(['asset_bytes', 'password']),
    'verification',
  );
  if (!Buffer.isBuffer(verification.asset_bytes)) {
    throw new Error(
      'FORMAT_VALID requires the exact final .kdna bytes; caller-supplied receipt results are not verification',
    );
  }
  const assetBytes = verification.asset_bytes;
  if (assetBytes.length === 0) {
    throw new Error('FORMAT_VALID requires non-empty final .kdna bytes');
  }
  if (
    verification.password !== undefined &&
    (
      typeof verification.password !== 'string' ||
      verification.password.length === 0
    )
  ) {
    throw new Error('verification.password must be a non-empty string');
  }
  const password = verification.password;
  const assetDigest = sha256(assetBytes);
  if (receipt.asset_digest !== assetDigest) {
    throw new Error(
      'build receipt asset_digest does not match the exact final .kdna bytes',
    );
  }
  if (
    receipt.output?.artifact_sha256 !== undefined &&
    receipt.output.artifact_sha256 !== assetDigest
  ) {
    throw new Error(
      'build receipt output digest does not match the exact final .kdna bytes',
    );
  }

  let validation;
  let inspection;
  let loadPlan;
  let compact;
  let full;
  try {
    validation = RUNTIME_CORE.validate(assetBytes);
    if (validation?.overall_valid !== true) {
      throw new Error('Core validation did not accept the exact final asset');
    }
    inspection = RUNTIME_CORE.inspect(assetBytes);
    if (!inspection) {
      throw new Error('Core inspection did not return an asset coordinate');
    }
    loadPlan = RUNTIME_CORE.planLoad(
      assetBytes,
      password ? { password } : {},
    );
    const authorizationRequired = Boolean(
      password &&
      loadPlan?.can_load_now === false &&
      loadPlan?.state === 'needs_password' &&
      Array.isArray(loadPlan.issues) &&
      loadPlan.issues.some(
        (issue) => issue.code === 'KDNA_AUTH_PASSWORD_UNVERIFIED',
      )
    );
    if (
      (!password && loadPlan?.can_load_now !== true) ||
      (password && !authorizationRequired)
    ) {
      throw new Error(
        'Core load planning did not accept the exact final asset coordinate',
      );
    }
    const loadRuntime = RUNTIME_CORE.loadAuthorized || RUNTIME_CORE.load;
    if (typeof loadRuntime !== 'function') {
      throw new Error('Runtime Core does not provide an authorized loader');
    }
    const loadOptions = {
      as: 'json',
      password: password || undefined,
      hasPassword: Boolean(password),
    };
    compact = loadRuntime.call(RUNTIME_CORE, assetBytes, {
      ...loadOptions,
      profile: 'compact',
    });
    full = loadRuntime.call(RUNTIME_CORE, assetBytes, {
      ...loadOptions,
      profile: 'full',
    });
  } catch (error) {
    const failure = new Error(
      `exact final .kdna failed Core verification/readback: ${error.message}`,
    );
    failure.code = 'CREATION_FORMAT_INVALID';
    throw failure;
  }

  if (
    inspection.version !== workspace.exportPlan.version ||
    inspection.judgment_version !== workspace.exportPlan.judgment_version
  ) {
    throw new Error(
      'exact final .kdna release coordinates do not match the current export plan',
    );
  }
  if (
    compact?.type !== 'kdna.runtime-capsule' ||
    full?.type !== 'kdna.runtime-capsule' ||
    full.profile !== 'full' ||
    !full.context?.manifest ||
    !full.context?.payload
  ) {
    throw new Error(
      'exact final .kdna did not read back as compact and full Runtime Capsules',
    );
  }

  const { project } = compileProject(workspace);
  const expectedPayload = exportRuntimeAsset(
    project,
    password ? { password } : {},
  ).payload;
  if (
    stableStringify(full.context.payload) !==
    stableStringify(expectedPayload)
  ) {
    throw new Error(
      'exact final .kdna semantic payload does not match the current Creation workspace',
    );
  }
  const manifest = full.context.manifest;
  if (
    manifest.version !== workspace.exportPlan.version ||
    manifest.judgment_version !== workspace.exportPlan.judgment_version
  ) {
    throw new Error(
      'exact final .kdna manifest does not match the current export plan',
    );
  }

  return {
    asset_digest: assetDigest,
    results: {
      validate: { status: 'pass' },
      inspect: { status: 'pass' },
      plan_load: {
        status: 'pass',
        outcome: password
          ? 'authorization_required_then_verified'
          : 'loadable_now',
        state: loadPlan.state,
        can_load_now: loadPlan.can_load_now === true,
        authorization_supplied: Boolean(password),
        issue_codes: Array.isArray(loadPlan.issues)
          ? loadPlan.issues.map((issue) => issue.code).filter(Boolean)
          : [],
      },
      load_compact: {
        status: 'pass',
        authorized: Boolean(password),
      },
      load_full: {
        status: 'pass',
        authorized: Boolean(password),
      },
      reimport: { status: 'pass' },
      semantic_round_trip: { status: 'pass' },
    },
  };
}

function recordBuildReceipt(workspace, receipt = {}, verification = {}) {
  assertPlainObject(receipt, 'receipt');
  const forbidden = containsForbiddenReceiptData(receipt);
  if (forbidden) {
    throw new Error(`build receipt contains forbidden secret/private content field: ${forbidden}`);
  }
  assertAllowedKeys(
    receipt,
    new Set([
      'document_type',
      'contract_version',
      'created_at',
      'version',
      'judgment_version',
      'semantic_revision',
      'semantic_digest',
      'asset_digest',
      'output',
      'tool_coordinates',
      'development_baseline',
      'development_runtime',
      'results',
    ]),
    'receipt',
  );
  const semanticDigest = assertDigest(receipt.semantic_digest, 'receipt.semantic_digest');
  if (semanticDigest !== workspace.state.semantic_digest) {
    throw new Error('build receipt semantic_digest does not match the current workspace');
  }
  const version = assertVersion(receipt.version, 'receipt.version');
  const judgmentVersion = assertVersion(
    receipt.judgment_version,
    'receipt.judgment_version',
  );
  const lastDigest = workspace.exportPlan.last_built_semantic_digest;
  if (lastDigest === semanticDigest) {
    if (judgmentVersion !== workspace.exportPlan.judgment_version) {
      throw new Error('metadata-only rebuild must preserve judgment_version');
    }
    if (version !== workspace.exportPlan.version) {
      throw new Error(
        'metadata-only rebuild version does not match the current export plan',
      );
    }
    if (
      workspace.exportPlan.last_built_version &&
      compareSemanticVersions(
        version,
        workspace.exportPlan.last_built_version,
      ) <= 0
    ) {
      throw new Error('a new distributed build must use a higher version');
    }
  } else if (
    version !== workspace.exportPlan.version ||
    judgmentVersion !== workspace.exportPlan.judgment_version
  ) {
    throw new Error('build receipt versions do not match the current export plan');
  }
  assertDigest(receipt.asset_digest, 'receipt.asset_digest');
  assertPlainObject(receipt.tool_coordinates, 'receipt.tool_coordinates');
  validateToolCoordinates(receipt.tool_coordinates);
  if (receipt.development_baseline !== undefined) {
    validateDevelopmentBaseline(
      receipt.development_baseline,
      receipt.tool_coordinates,
    );
  }
  if (receipt.development_runtime !== undefined) {
    if (receipt.development_baseline === undefined) {
      throw new Error(
        'development_runtime requires a development_baseline',
      );
    }
    validateDevelopmentRuntime(
      receipt.development_runtime,
      receipt.development_baseline,
    );
  }
  if (receipt.results !== undefined) {
    assertPlainObject(receipt.results, 'receipt.results');
    validateVerificationResults(receipt.results);
  }
  assertAllowedKeys(
    receipt.output,
    new Set(['filename', 'artifact_sha256']),
    'receipt.output',
  );
  const filename = nonEmpty(receipt.output.filename, 'receipt.output.filename');
  if (filename !== path.basename(filename) || !/\.kdna$/i.test(filename)) {
    throw new Error(
      'receipt.output.filename must be a path-free .kdna filename',
    );
  }
  assertDigest(
    receipt.output.artifact_sha256,
    'receipt.output.artifact_sha256',
  );
  if (receipt.output.artifact_sha256 !== receipt.asset_digest) {
    throw new Error('receipt.output.artifact_sha256 must match asset_digest');
  }
  if (
    receipt.semantic_revision !== undefined &&
    receipt.semantic_revision !== workspace.state.semantic_revision
  ) {
    throw new Error('receipt.semantic_revision does not match the current workspace');
  }
  const verifiedAsset = verifyExactBuildAsset(
    workspace,
    receipt,
    verification,
  );
  const authoritativeReceipt = {
    ...clone(receipt),
    asset_digest: verifiedAsset.asset_digest,
    results: verifiedAsset.results,
  };
  return evolve(workspace, 'build_receipt_recorded', (next) => {
    const recordedAt = now();
    next.buildReceipt = {
      ...authoritativeReceipt,
      version,
      judgment_version: judgmentVersion,
      semantic_digest: semanticDigest,
      status: 'verified',
      recorded_at: recordedAt,
    };
    const currentBuildReceiptDigest =
      canonicalBuildReceiptDigest(next.buildReceipt);
    for (const applicationPlan of next.applicationVerification.plans) {
      if (
        applicationPlan.status === 'valid' &&
        applicationPlan.verification_contract === 'adoption-fidelity' &&
        (
          applicationPlan.asset_digest !== receipt.asset_digest ||
          applicationPlan.build_receipt_digest !== currentBuildReceiptDigest
        )
      ) {
        applicationPlan.status = 'invalidated';
        applicationPlan.invalidated_at = recordedAt;
      }
    }
    for (const applicationReceipt of next.applicationVerification.receipts) {
      if (
        applicationReceipt.semantic_digest === semanticDigest &&
        applicationReceipt.asset_digest !== receipt.asset_digest &&
        ['verified', 'failed'].includes(applicationReceipt.status)
      ) {
        applicationReceipt.status = 'superseded';
        applicationReceipt.invalidated_at = recordedAt;
      }
    }
    for (const applicationAttempt of next.applicationVerification.attempts) {
      if (
        applicationAttempt.status === 'open' &&
        applicationAttempt.semantic_digest === semanticDigest &&
        (
          applicationAttempt.asset_digest !== receipt.asset_digest ||
          applicationAttempt.build_receipt_digest !==
            currentBuildReceiptDigest
        )
      ) {
        applicationAttempt.status = 'superseded';
        applicationAttempt.invalidated_at = recordedAt;
      }
    }
    for (
      const applicationObservation of
      next.applicationVerification.observations
    ) {
      if (
        applicationObservation.status === 'open' &&
        applicationObservation.semantic_digest === semanticDigest &&
        (
          applicationObservation.asset_digest !== receipt.asset_digest ||
          applicationObservation.build_receipt_digest !==
            currentBuildReceiptDigest
        )
      ) {
        applicationObservation.status = 'superseded';
        applicationObservation.invalidated_at = recordedAt;
      }
    }
    if (lastDigest === semanticDigest) {
      next.exportPlan.version = version;
    }
    next.exportPlan.judgment_version = judgmentVersion;
    next.exportPlan.last_built_semantic_digest = semanticDigest;
    next.exportPlan.last_built_version = version;
    next.exportPlan.last_built_judgment_version = judgmentVersion;
    next.exportPlan.pending_judgment_change = false;
  });
}

function artifactData(workspace) {
  return {
    'creation-state.json': {
      state: workspace.state,
      operations: workspace.operations,
      history: workspace.history,
    },
    'purpose-brief.json': {
      purpose_brief: workspace.purposeBrief,
    },
    'materials-index.json': {
      materials: workspace.materials,
    },
    'candidate-judgments.json': {
      candidates: workspace.candidates,
      interview_answers: workspace.interviewAnswers,
    },
    'judgment-model.json': {
      judgment_model: workspace.judgmentModel,
    },
    'unresolved-questions.json': {
      unresolved_questions: workspace.unresolvedQuestions,
    },
    'confirmation-receipts.json': {
      confirmation_receipts: workspace.confirmationReceipts,
    },
    'semantic-test-report.json': {
      semantic_test_report: workspace.semanticTestReport,
      application_verification: workspace.applicationVerification,
    },
    'repair-plan.json': {
      repair_plan: workspace.repairPlan,
    },
    'export-plan.json': {
      export_plan: workspace.exportPlan,
    },
    'build-receipt.json': {
      build_receipt: workspace.buildReceipt,
    },
  };
}

function serializeArtifacts(workspace) {
  assertWorkspace(workspace);
  const result = {};
  for (const [name, data] of Object.entries(artifactData(workspace))) {
    result[name] = `${JSON.stringify({
      artifact_version: SCHEMA_VERSION,
      workspace_id: workspace.state.workspace_id,
      semantic_revision: workspace.state.semantic_revision,
      semantic_digest: workspace.state.semantic_digest,
      data,
    }, null, 2)}\n`;
  }
  return result;
}

function fsyncDirectory(directory) {
  const descriptor = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function writeArtifact(directory, name, bytes) {
  const target = path.join(directory, name);
  const descriptor = fs.openSync(target, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function assertReplaceableWorkspaceDirectory(directory) {
  if (!fs.existsSync(directory)) return;
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`workspace path is not a plain directory: ${directory}`);
  }
  const allowed = new Set(ARTIFACT_FILES);
  const foreign = fs.readdirSync(directory).filter((name) => !allowed.has(name));
  if (foreign.length > 0) {
    throw new Error(
      `workspace directory contains non-Creation-Engine files and will not be replaced: ` +
      foreign.join(', '),
    );
  }
}

function workspaceConflict(message) {
  const error = new Error(`Creation Engine workspace conflict: ${message}`);
  error.code = 'CREATION_WORKSPACE_CONFLICT';
  return error;
}

function sameHistoryEntry(left, right) {
  return stableStringify(left) === stableStringify(right);
}

function processIsLive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

function assertNoLiveWorkspaceTransaction(directory) {
  const parent = path.dirname(directory);
  if (!fs.existsSync(parent)) return;
  const basename = path.basename(directory).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `^\\.${basename}\\.(?:staging|backup)-(\\d+)-\\d+-[0-9a-f]{12}$`,
  );
  for (const name of fs.readdirSync(parent)) {
    const match = name.match(pattern);
    if (match && processIsLive(Number(match[1]))) {
      throw workspaceConflict('another process is currently saving this workspace');
    }
  }
}

function assertWorkspaceSaveConcurrency(directory, proposed) {
  if (!fs.existsSync(directory)) return;
  const persisted = workspaceFromArtifactDirectory(directory);
  if (persisted.state.workspace_id !== proposed.state.workspace_id) {
    throw workspaceConflict(
      'the target belongs to a different workspace_id; choose a different path',
    );
  }

  const persistedArtifacts = stableStringify(artifactData(persisted));
  const proposedArtifacts = stableStringify(artifactData(proposed));
  if (persistedArtifacts === proposedArtifacts) return;

  const currentHistory = persisted.history;
  const proposedHistory = proposed.history;
  const extendsCurrent = proposedHistory.length > currentHistory.length &&
    currentHistory.every((entry, index) => (
      sameHistoryEntry(entry, proposedHistory[index])
    ));
  if (!extendsCurrent) {
    throw workspaceConflict(
      'the proposed snapshot is stale or diverges from the currently persisted history',
    );
  }
}

function saveWorkspace(workspacePath, workspace) {
  const absolute = path.resolve(nonEmpty(workspacePath, 'workspacePath'));
  const next = clone(workspace);
  next.root = absolute;
  assertWorkspace(next);
  const parent = path.dirname(absolute);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  assertNoLiveWorkspaceTransaction(absolute);
  assertReplaceableWorkspaceDirectory(absolute);
  assertWorkspaceSaveConcurrency(absolute, next);
  const nonce = `${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  const staging = path.join(parent, `.${path.basename(absolute)}.staging-${nonce}`);
  const backup = path.join(parent, `.${path.basename(absolute)}.backup-${nonce}`);
  fs.mkdirSync(staging, { mode: 0o700 });
  let movedExisting = false;
  try {
    const artifacts = serializeArtifacts(next);
    for (const name of ARTIFACT_FILES) {
      writeArtifact(staging, name, artifacts[name]);
    }
    fsyncDirectory(staging);
    if (fs.existsSync(absolute)) {
      try {
        fs.renameSync(absolute, backup);
      } catch (error) {
        if (error?.code === 'ENOENT') {
          throw workspaceConflict(
            'the persisted workspace changed while this save was being prepared',
          );
        }
        throw error;
      }
      movedExisting = true;
      try {
        // Re-check the exact snapshot that was atomically moved. This closes
        // the race between the optimistic preflight and the rename commit
        // boundary: a newer Agent snapshot can never be overwritten.
        assertWorkspaceSaveConcurrency(backup, next);
      } catch (error) {
        if (!fs.existsSync(absolute)) {
          fs.renameSync(backup, absolute);
          movedExisting = false;
        }
        throw error;
      }
    }
    try {
      fs.renameSync(staging, absolute);
      fsyncDirectory(parent);
    } catch (error) {
      if (movedExisting && !fs.existsSync(absolute) && fs.existsSync(backup)) {
        fs.renameSync(backup, absolute);
        movedExisting = false;
      }
      throw error;
    }
    if (movedExisting && fs.existsSync(backup)) {
      fs.rmSync(backup, { recursive: true, force: true });
      movedExisting = false;
    }
    return next;
  } finally {
    if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
    if (movedExisting && fs.existsSync(backup) && !fs.existsSync(absolute)) {
      fs.renameSync(backup, absolute);
    }
  }
}

function readArtifactEnvelope(directory, name) {
  const target = path.join(directory, name);
  if (!fs.existsSync(target)) throw new Error(`workspace artifact is missing: ${name}`);
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`workspace artifact must be a regular file: ${name}`);
  }
  let envelope;
  try {
    envelope = JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (error) {
    throw new Error(`workspace artifact is not valid JSON: ${name}: ${error.message}`);
  }
  if (envelope.artifact_version !== SCHEMA_VERSION || !envelope.data) {
    throw new Error(`workspace artifact has an unsupported envelope: ${name}`);
  }
  return envelope;
}

function workspaceFromArtifactDirectory(directory) {
  const envelopes = Object.fromEntries(
    ARTIFACT_FILES.map((name) => [name, readArtifactEnvelope(directory, name)]),
  );
  const baseline = envelopes['creation-state.json'];
  for (const [name, envelope] of Object.entries(envelopes)) {
    if (
      envelope.workspace_id !== baseline.workspace_id ||
      envelope.semantic_revision !== baseline.semantic_revision ||
      envelope.semantic_digest !== baseline.semantic_digest
    ) {
      throw new Error(`workspace artifact snapshot mismatch: ${name}`);
    }
  }
  const workspace = {
    root: directory,
    state: envelopes['creation-state.json'].data.state,
    purposeBrief: envelopes['purpose-brief.json'].data.purpose_brief,
    materials: envelopes['materials-index.json'].data.materials,
    candidates: envelopes['candidate-judgments.json'].data.candidates,
    judgmentModel: envelopes['judgment-model.json'].data.judgment_model,
    unresolvedQuestions:
      envelopes['unresolved-questions.json'].data.unresolved_questions,
    confirmationReceipts:
      envelopes['confirmation-receipts.json'].data.confirmation_receipts,
    semanticTestReport:
      envelopes['semantic-test-report.json'].data.semantic_test_report,
    applicationVerification:
      envelopes['semantic-test-report.json'].data.application_verification,
    repairPlan: envelopes['repair-plan.json'].data.repair_plan,
    exportPlan: envelopes['export-plan.json'].data.export_plan,
    buildReceipt: envelopes['build-receipt.json'].data.build_receipt,
    interviewAnswers:
      envelopes['candidate-judgments.json'].data.interview_answers || [],
    operations: envelopes['creation-state.json'].data.operations || [],
    history: envelopes['creation-state.json'].data.history || [],
  };
  assertWorkspace(workspace);
  return workspace;
}

function recoverableWorkspaceDirectory(absolute) {
  const parent = path.dirname(absolute);
  if (!fs.existsSync(parent)) return null;
  const basename = path.basename(absolute);
  const prefixes = [`.${basename}.backup-`, `.${basename}.staging-`];
  const candidates = fs.readdirSync(parent)
    .filter((name) => prefixes.some((prefix) => name.startsWith(prefix)))
    .map((name) => path.join(parent, name))
    .filter((candidate) => {
      const stat = fs.lstatSync(candidate);
      return stat.isDirectory() && !stat.isSymbolicLink();
    })
    .sort((left, right) => (
      fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs
    ));
  for (const candidate of candidates) {
    try {
      const recovered = workspaceFromArtifactDirectory(candidate);
      recovered.root = absolute;
      return recovered;
    } catch {
      // An interrupted staging directory may be incomplete. Keep looking
      // for the newest complete snapshot without trusting partial artifacts.
    }
  }
  return null;
}

function loadWorkspace(input) {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const workspace = clone(input);
    assertWorkspace(workspace);
    return workspace;
  }
  const value = nonEmpty(input, 'path');
  if (value.trim().startsWith('{')) {
    const workspace = JSON.parse(value);
    assertWorkspace(workspace);
    return workspace;
  }
  const absolute = path.resolve(value);
  if (!fs.existsSync(absolute)) {
    const recovered = recoverableWorkspaceDirectory(absolute);
    if (recovered) return recovered;
    throw new Error(`workspace path does not exist: ${absolute}`);
  }
  const stat = fs.lstatSync(absolute);
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    return workspaceFromArtifactDirectory(absolute);
  }
  if (stat.isFile() && !stat.isSymbolicLink()) {
    const parsed = JSON.parse(fs.readFileSync(absolute, 'utf8'));
    if (parsed && parsed.state) {
      parsed.root = path.dirname(absolute);
      assertWorkspace(parsed);
      return parsed;
    }
  }
  throw new Error('loadWorkspace expects a workspace artifact directory or workspace JSON');
}

function nextAction(workspace) {
  assertWorkspace(workspace);
  return computeNextAction(workspace);
}

module.exports = {
  SCHEMA_VERSION,
  CREATION_MODES,
  WORKFLOW_MODES,
  CREATION_STATES,
  RELATION_TYPES,
  ARTIFACT_FILES,
  VERIFICATION_STEPS,
  createWorkspace,
  loadWorkspace,
  saveWorkspace,
  setPurpose,
  updateExportPlan,
  ingestMaterial,
  reviewMaterial,
  addCandidate,
  recordInterviewAnswer,
  promoteCandidate,
  analyzeRelations,
  recordConfirmation,
  addSemanticTest,
  freezeSemanticTestPlan,
  recordSemanticTestResult,
  freezeApplicationTestPlan,
  issueApplicationAttempt,
  recordApplicationAssetObservation,
  abandonApplicationAttempt,
  recordApplicationReceipt,
  applicationKeyRegistrySigningPayload,
  applicationPlanSigningPayload,
  applicationConsumerSigningPayload,
  applicationEvaluatorSigningPayload,
  applicationAttemptAbandonmentSigningPayload,
  buildRepairPlan,
  applyRepair,
  assessReadiness,
  completionGates,
  compileProject,
  recordBuildReceipt,
  nextAction,
  canonicalSemanticDigest,
  canonicalOperationRequestDigest,
  canonicalTestDefinitionDigest,
  canonicalTestReportDigest,
  canonicalJudgmentEvidenceDigest,
  canonicalBuildReceiptDigest,
  canonicalApplicationAttemptDigest,
  canonicalApplicationObservationDigest,
  canonicalApplicationAttemptAbandonmentDigest,
  operationCoordinate,
  resolveOperation,
  completeOperation,
  prepareExportOperation,
  verifyExportOperation,
  completeExportOperation,
  serializeArtifacts,
  validateWorkspace,
};
