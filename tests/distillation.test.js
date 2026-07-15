// Domain-First Distillation API Tests
// Aligned with SOURCE_DISTILLATION_CONTRACT.md 0.2

const { test } = require('node:test');
const assert = require('node:assert/strict');
const distillation = require('../src/distillation');

test('DOMAIN_CATEGORIES — all 8 categories exist', () => {
  const cats = distillation.DOMAIN_CATEGORIES;
  const keys = Object.keys(cats);
  assert.equal(keys.length, 8);
  for (const key of keys) {
    assert.ok(cats[key].id);
    assert.ok(cats[key].displayName);
  }
});

test('OWNER_SCOPES — all 4 scopes exist', () => {
  const scopes = distillation.OWNER_SCOPES;
  assert.equal(Object.keys(scopes).length, 4);
  assert.ok(scopes.personal);
  assert.ok(scopes.team);
  assert.ok(scopes.organization);
  assert.ok(scopes.field);
});

test('GRANULARITY_LEVELS — all 3 levels exist', () => {
  const levels = distillation.GRANULARITY_LEVELS;
  assert.equal(Object.keys(levels).length, 3);
  assert.ok(levels.core_principles);
  assert.ok(levels.concrete_patterns);
  assert.ok(levels.specific_scenarios);
});

test('createDistillationTarget — creates valid target', () => {
  const target = distillation.createDistillationTarget({
    domainName: 'writing_style',
    domainCategory: 'expression_writing',
    ownerScope: 'personal',
    granularity: 'core_principles',
    taskScope: 'longform article diagnosis',
    includeAreas: ['argument structure', 'tone'],
    excludeAreas: ['life habits', 'food preference'],
    loadCondition: 'Load when reviewing longform writing.',
  });

  assert.equal(target.domain_name, 'writing_style');
  assert.equal(target.domain_category, 'expression_writing');
  assert.equal(target.owner_scope, 'personal');
  assert.equal(target.granularity, 'core_principles');
  assert.equal(target.task_scope, 'longform article diagnosis');
  assert.deepStrictEqual(target.include_areas, ['argument structure', 'tone']);
  assert.deepStrictEqual(target.exclude_areas, ['life habits', 'food preference']);
  assert.ok(target.id.startsWith('tgt_'));
  assert.ok(target.declared_at);
  assert.ok(target.load_condition);
});

test('createDistillationTarget — domainName required', () => {
  assert.throws(() => distillation.createDistillationTarget({}), /domainName is required/);
});

test('createDistillationTarget — invalid category throws', () => {
  assert.throws(
    () => distillation.createDistillationTarget({ domainName: 'test', domainCategory: 'invalid' }),
    /Invalid domainCategory/,
  );
});

test('createDistillationTarget — invalid scope throws', () => {
  assert.throws(
    () => distillation.createDistillationTarget({ domainName: 'test', ownerScope: 'world' }),
    /Invalid ownerScope/,
  );
});

test('createDistillationTarget — invalid granularity throws', () => {
  assert.throws(
    () => distillation.createDistillationTarget({ domainName: 'test', granularity: 'nano' }),
    /Invalid granularity/,
  );
});

test('createDistillationTarget — defaults fill loadCondition', () => {
  const target = distillation.createDistillationTarget({
    domainName: 'test',
    domainCategory: 'professional_field',
    ownerScope: 'team',
    granularity: 'concrete_patterns',
    taskScope: 'code review',
  });
  assert.ok(target.load_condition.includes('professional field'));
});

test('validateDistillationTarget — valid target passes', () => {
  const target = distillation.createDistillationTarget({
    domainName: 'writing_style',
    domainCategory: 'expression_writing',
    ownerScope: 'personal',
    granularity: 'core_principles',
    taskScope: 'article review',
  });
  const result = distillation.validateDistillationTarget(target);
  assert.equal(result.valid, true);
  assert.deepStrictEqual(result.errors, []);
});

test('validateDistillationTarget — empty task_scope fails', () => {
  const target = distillation.createDistillationTarget({
    domainName: 'test',
    domainCategory: 'expression_writing',
    ownerScope: 'personal',
    granularity: 'core_principles',
    taskScope: '',
  });
  const result = distillation.validateDistillationTarget(target);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('task_scope')));
});

test('targetScopeDescription — produces meaningful description', () => {
  const target = distillation.createDistillationTarget({
    domainName: 'writing_style',
    domainCategory: 'expression_writing',
    ownerScope: 'personal',
    granularity: 'core_principles',
    taskScope: 'article review',
    loadCondition: 'Load when reviewing.',
  });
  const desc = distillation.targetScopeDescription(target);
  assert.ok(desc.includes('Expression & Writing'));
  assert.ok(desc.includes('Personal'));
  assert.ok(desc.includes('Core Principles'));
  assert.ok(desc.includes('article review'));
  assert.ok(desc.includes('Load when reviewing'));
});

test('applyScopeGate — in-scope candidate passes', () => {
  const target = distillation.createDistillationTarget({
    domainName: 'writing_style',
    domainCategory: 'expression_writing',
    ownerScope: 'personal',
    granularity: 'core_principles',
    taskScope: 'article review',
    includeAreas: ['argument structure'],
    excludeAreas: ['life habits'],
  });

  const candidate = {
    one_sentence: 'User prioritizes argument structure over surface polish.',
    full_statement: 'In writing, always check argument structure first, then expression.',
    candidate_status: 'proposed',
  };

  const result = distillation.applyScopeGate(candidate, target);
  assert.equal(result.scope_fit, true);
  assert.ok(result.domain_relevance_score >= 50);
});

test('applyScopeGate — exclude match fails scope', () => {
  const target = distillation.createDistillationTarget({
    domainName: 'writing_style',
    domainCategory: 'expression_writing',
    ownerScope: 'personal',
    granularity: 'core_principles',
    taskScope: 'article review',
    excludeAreas: ['life habits'],
  });

  const candidate = {
    one_sentence: 'User prefers coffee over tea in the morning.',
    full_statement: 'Life habits and consumption choices include daily coffee ritual.',
    candidate_status: 'proposed',
  };

  const result = distillation.applyScopeGate(candidate, target);
  assert.equal(result.scope_fit, false);
  assert.equal(result.domain_relevance_score, 10);
});

test('applyScopeGate — suggests split domain', () => {
  const target = distillation.createDistillationTarget({
    domainName: 'writing_style',
    domainCategory: 'expression_writing',
    ownerScope: 'personal',
    granularity: 'core_principles',
    taskScope: 'article review',
    includeAreas: ['argument structure'],
    excludeAreas: [],
  });

  const candidate = {
    one_sentence: 'User makes professional investment decisions.',
    full_statement: 'Prefers communication style that is direct and clear, related to decision preference.',
    candidate_status: 'proposed',
  };

  const result = distillation.applyScopeGate(candidate, target);
  assert.equal(result.scope_fit, false);
  assert.ok(result.suggested_split_domain, 'should suggest a different domain');
});

test('candidateStatusSummary — counts correctly', () => {
  const candidates = [
    { candidate_status: 'proposed', scope_fit: true, sensitive_content_flag: false },
    { candidate_status: 'accepted', scope_fit: true, sensitive_content_flag: false },
    { candidate_status: 'accepted', scope_fit: true, sensitive_content_flag: false },
    { candidate_status: 'rejected', scope_fit: true, sensitive_content_flag: false },
    { candidate_status: 'accepted', scope_fit: false, sensitive_content_flag: false },
    { candidate_status: 'proposed', scope_fit: true, sensitive_content_flag: true },
  ];
  const summary = distillation.candidateStatusSummary(candidates);
  assert.equal(summary.proposed, 1);
  assert.equal(summary.accepted, 3);
  assert.equal(summary.rejected, 1);
  assert.equal(summary.blocked, 1);
  assert.equal(summary.outOfScope, 1);
});

test('EVIDENCE_RELEVANCE — all classifications exist', () => {
  const r = distillation.EVIDENCE_RELEVANCE;
  assert.ok(r.relevant);
  assert.ok(r.weakly_relevant);
  assert.ok(r.out_of_scope);
  assert.ok(r.split_domain);
  assert.equal(r.relevant.label, 'Relevant');
  assert.equal(r.out_of_scope.label, 'Out of Scope');
});

test('checkSensitiveContent — detects English medical content', () => {
  const result = distillation.checkSensitiveContent('Based on their medical condition and therapy history');
  assert.equal(result.flagged, true);
  assert.ok(result.reason.includes('health'));
});

test('checkSensitiveContent — detects Chinese medical content', () => {
  const result = distillation.checkSensitiveContent('根据其心理疾病诊断和药物治疗情况');
  assert.equal(result.flagged, true);
});

test('checkSensitiveContent — detects Chinese financial content', () => {
  const result = distillation.checkSensitiveContent('他的月收入达到五万元，工资水平较高');
  assert.equal(result.flagged, true);
});

test('checkSensitiveContent — detects Chinese political content', () => {
  const result = distillation.checkSensitiveContent('他因为政治立场不同而选择离开');
  assert.equal(result.flagged, true);
});

test('checkSensitiveContent — passes normal Chinese content', () => {
  const result = distillation.checkSensitiveContent('用户偏好简洁有力的写作风格，强调论证结构优先于文字润色');
  assert.equal(result.flagged, false);
  assert.equal(result.reason, null);
});

test('SENSITIVE_KEYWORDS — all 6 domains present with bilingual entries', () => {
  const kw = distillation.SENSITIVE_KEYWORDS;
  const domains = Object.keys(kw);
  assert.equal(domains.length, 6);
  for (const domain of domains) {
    assert.ok(kw[domain].length >= 4, `${domain} should have at least 4 keywords`);
    const hasChinese = kw[domain].some(w => /[\u4e00-\u9fff]/.test(w));
    assert.ok(hasChinese, `${domain} should have Chinese keywords`);
  }
});
