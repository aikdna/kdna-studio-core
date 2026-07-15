/**
 * End-to-end validation: prove Studio Core output passes KDNA SPEC validation.
 *
 * Tests:
 *   1. compile → runtime export → pack → kdna validate passes
 *   2. compile → runtime export → pack → kdna inspect returns valid asset
 *   3. compile output matches KDNA SPEC reference structure
 *   4. kdna-core schema validation on compiled output
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { createProject } = require('../src/project');
const { createCard, lockCard, transitionCard, createFeynmanRestatement, attachRestatementToLock } = require('../src/cards');
const { compileDomain } = require('../src/compile');
const { exportRuntimeAsset } = require('../src/export-runtime');
const { buildProvenance } = require('../src/provenance');
const kdnaCore = require('@aikdna/kdna-core');

function makeLockedCard(type, fields, id) {
  let card = createCard(type, fields, id);
  card = card = transitionCard(card, 'revised', { by: 'expert' });
  card = card = lockCard(card, { by: 'expert', statement: 'I confirm this judgment.', checked: { applies_when: true, does_not_apply_when: true, failure_risk: true } });
  return card;
}

function createFullProject() {
  const project = createProject('leadership_decisions', 'domain', {
    author: { name: 'Leadership Expert', id: 'expert_001' },
  });
  project.release = { version: '0.1.0', description: 'Leadership decision-making judgment — diagnose whether execution failures are really decision voids.' };

  // Axioms
  const ax1 = makeLockedCard('axiom', {
    one_sentence: 'Execution failure is often decision failure in disguise.',
    full_statement: 'When a team fails to execute, first check whether a real decision (with named owner, deadline, and criteria) was ever made. Most "execution problems" are decision voids.',
    why: 'Without this axiom, managers address symptoms (motivation, process) while missing the root cause.',
    applies_when: ['Team reports being stuck', 'Deadline was missed', 'Project not progressing'],
    does_not_apply_when: ['Clear decision exists with owner', 'External blocker (vendor, regulation)'],
    failure_risk: 'May cause over-scrutiny of decision quality when issue is resource availability.',
  }, 'ax_001');
  project.cards.push(ax1);

  const ax2 = makeLockedCard('axiom', {
    one_sentence: 'Broad agreement is not commitment. Only named ownership is commitment.',
    full_statement: 'A decision without a single named owner with a deadline has no commitment. Multiple owners = no owner.',
    why: 'Teams confuse "everyone nodding" with actual commitment. Without a named owner, no one wakes up responsible.',
    applies_when: ['Meeting ends with "sounds good"', 'Decision without deadline', 'Multiple people assigned'],
    does_not_apply_when: ['Solo work with clear self-accountability', 'Informal team alignment'],
    failure_risk: 'May create unnecessary formality for trivial decisions.',
  }, 'ax_002');
  project.cards.push(ax2);

  const ax3 = makeLockedCard('axiom', {
    one_sentence: 'The cost of a slow decision is usually higher than the cost of an imperfect decision.',
    full_statement: 'In leadership, decision speed compounds. A two-week delay for a perfect decision often costs more than an 80% decision made today.',
    why: 'Leaders who wait for perfect information create organizational bottlenecks.',
    applies_when: ['Decision is reversible', 'Stakes are below team/org level', 'More information unlikely to change outcome'],
    does_not_apply_when: ['Safety-critical decisions', 'Irreversible resource commitments', 'Legal/compliance required decisions'],
    failure_risk: 'May encourage premature decisions in high-stakes, irreversible situations.',
  }, 'ax_003');
  project.cards.push(ax3);

  // Misunderstandings
  const ms1 = makeLockedCard('misunderstanding', {
    wrong: 'If the team is not executing, they lack motivation or skills.',
    correct: 'If the team is not executing, first check whether a real decision was ever made with owner, deadline, and criteria.',
    key_distinction: 'Motivation gaps produce gradual decline over weeks. Decision voids produce sudden stalls within days. The pattern is fundamentally different.',
  }, 'ms_001');
  project.cards.push(ms1);

  const ms2 = makeLockedCard('misunderstanding', {
    wrong: 'Consensus means everyone agrees with the decision.',
    correct: 'Consensus means everyone understands the decision, knows their role in executing it, and commits to not blocking it — even if they disagree.',
    key_distinction: 'Agreement is an emotional state. Commitment to execute is a behavioral contract. You need the latter, not the former.',
  }, 'ms_002');
  project.cards.push(ms2);

  // Self-checks
  for (let i = 0; i < 5; i++) {
    const checks = [
      'Before concluding execution is the problem, did I verify that a named owner with a deadline exists?',
      'Does this decision have exactly one person who will wake up responsible for it tomorrow?',
      'Is this decision reversible enough that speed matters more than perfection?',
      'Did I check whether this is a decision void disguised as an execution gap?',
      'If I asked the team "who owns this?", would everyone point to the same person?',
    ];
    const sc = makeLockedCard('self_check', { question: checks[i] }, `sc_00${i + 1}`);
    project.cards.push(sc);
  }

  // Feynman for axioms
  attachRestatementToLock(ax1, createFeynmanRestatement(ax1,
    'When your team is stuck and nothing is moving forward, do not immediately assume they lack skills or motivation. First ask: was there a clear decision? Meaning: someone specific was named, a date was given, and everyone knows what "done" looks like. If any of these is missing, you have a decision problem pretending to be an execution problem.'));
  attachRestatementToLock(ax2, createFeynmanRestatement(ax2,
    'After a meeting where everyone seems to agree, do not assume commitment happened. If you cannot name one specific person who knows they are accountable by a specific date, you do not have a decision — you have a discussion. Multiple owners means zero owners.'));
  attachRestatementToLock(ax3, createFeynmanRestatement(ax3,
    'Waiting three weeks for the perfect answer is usually worse than making a good-enough decision today. The only exception is when the decision is irreversible — like hiring someone you cannot fire, or spending money you cannot get back. But most daily leadership decisions are reversible, so speed beats perfection.'));

  return project;
}

const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-studio-e2e-'));

function writeCompiledFiles(domainDir, files) {
  fs.mkdirSync(domainDir, { recursive: true });
  for (const [filename, content] of Object.entries(files)) {
    const target = path.join(domainDir, filename);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

// ─── E2E: compile → runtime export → pack → validate ────────────────

describe('E2E: compile → validate', () => {
  test('compiled output exports and passes kdna validate', () => {
    const project = createFullProject();
    const exported = exportRuntimeAsset(project, {
      asset_uid: 'urn:uuid:00000000-0000-4000-8000-000000000401',
      timestamp: '2026-07-13T00:00:00.000Z',
    });
    const sourceDir = path.join(TMPDIR, 'test-runtime-source');
    const assetPath = path.join(TMPDIR, 'test-runtime.kdna');
    writeCompiledFiles(sourceDir, exported.files);
    kdnaCore.pack(sourceDir, assetPath);

    assert.equal(kdnaCore.validate(assetPath).overall_valid, true);
  });

  test('compiled output structure matches KDNA SPEC', () => {
    const project = createFullProject();
    const result = compileDomain(project);

    // Verify KDNA_Core.json has all SPEC-required fields
    const core = JSON.parse(result.files['KDNA_Core.json']);
    assert.ok(core.meta, 'meta required');
    assert.equal(core.meta.domain, 'leadership_decisions');
    assert.equal(core.meta.version, '0.1.0');
    assert.ok(core.meta.purpose);
    assert.ok(core.meta.load_condition);
    assert.ok(Array.isArray(core.axioms), 'axioms array required');
    assert.equal(core.axioms.length, 3);
    assert.ok(Array.isArray(core.ontology), 'ontology array required');
    assert.ok(Array.isArray(core.frameworks), 'frameworks array required');
    assert.ok(Array.isArray(core.stances), 'stances array required');
    assert.ok(Array.isArray(core.core_structure), 'core_structure array required');

    // Verify KDNA_Patterns.json
    const patterns = JSON.parse(result.files['KDNA_Patterns.json']);
    assert.ok(patterns.meta, 'Patterns meta required');
    assert.ok(Array.isArray(patterns.misunderstandings));
    assert.equal(patterns.misunderstandings.length, 2);
    assert.ok(Array.isArray(patterns.self_check));
    assert.equal(patterns.self_check.length, 5);

    // Verify kdna.json manifest
    const manifest = JSON.parse(result.files['kdna.json']);
    assert.equal(manifest.name, 'leadership_decisions');
    assert.equal(manifest.artifact_type, 'kdna.studio.compile-manifest');
    assert.equal(manifest.schema_version, '1.0');
    assert.equal(manifest.authoring.created_by, 'kdna-studio-sdk');
    assert.equal(manifest.authoring.conformance.passed, true);
    assert.equal(manifest.authoring.conformance.schema_version, '1.0');
    assert.ok(manifest.file_count >= 2, `file_count should be >= 2, got ${manifest.file_count}`);

    // Verify KDNA_Reasoning.json (should exist since we have axioms)
    assert.ok('KDNA_Reasoning.json' in result.files, 'Reasoning file should exist');
    const reasoning = JSON.parse(result.files['KDNA_Reasoning.json']);
    assert.ok(reasoning.meta);
    assert.ok(Array.isArray(reasoning.reasoning_chains));
    assert.ok(reasoning.reasoning_chains.every(c => 'so_what' in c), 'Every chain must have so_what');
    assert.ok(reasoning.reasoning_chains.every(c => 'one_sentence' in c), 'Every chain must have one_sentence');

    // Verify KDNA_Evolution.json
    assert.ok('KDNA_Evolution.json' in result.files, 'Evolution file should exist');
    const evolution = JSON.parse(result.files['KDNA_Evolution.json']);
    assert.ok(evolution.meta);
    assert.ok(Array.isArray(evolution.measurement));
  });

  test('compiled axioms have required fields', () => {
    const project = createFullProject();
    const result = compileDomain(project);
    const core = JSON.parse(result.files['KDNA_Core.json']);

    for (const ax of core.axioms) {
      assert.ok(ax.one_sentence, `${ax.id}: missing one_sentence`);
      assert.ok(ax.full_statement, `${ax.id}: missing full_statement`);
      assert.ok(ax.why, `${ax.id}: missing why`);
      assert.ok(Array.isArray(ax.applies_when), `${ax.id}: applies_when must be array`);
      assert.ok(Array.isArray(ax.does_not_apply_when), `${ax.id}: does_not_apply_when must be array`);
      assert.ok(ax.failure_risk, `${ax.id}: missing failure_risk`);
    }
  });

  test('compiled misunderstandings have key_distinction', () => {
    const project = createFullProject();
    const result = compileDomain(project);
    const patterns = JSON.parse(result.files['KDNA_Patterns.json']);

    for (const ms of patterns.misunderstandings) {
      assert.ok(ms.key_distinction, `${ms.id}: missing key_distinction`);
      assert.ok(ms.key_distinction.length >= 20, `${ms.id}: key_distinction too short`);
    }
  });
});

// ─── E2E: compile → runtime export → pack → inspect ─────────────────

describe('E2E: compile → runtime pack → inspect', () => {
  test('compiled output survives runtime export→pack→inspect', () => {
    const project = createFullProject();
    const exported = exportRuntimeAsset(project, {
      asset_uid: 'urn:uuid:00000000-0000-4000-8000-000000000402',
      timestamp: '2026-07-13T00:00:00.000Z',
    });
    const sourceDir = path.join(TMPDIR, 'inspect-runtime-source');
    const assetPath = path.join(TMPDIR, 'inspect-runtime.kdna');
    writeCompiledFiles(sourceDir, exported.files);
    kdnaCore.pack(sourceDir, assetPath);

    const inspected = kdnaCore.inspect(assetPath);
    assert.equal(inspected.asset_id, 'kdna:studio:leadership_decisions');
    assert.equal(inspected.version, '0.1.0');
  });
});

// ─── E2E: provenance ─────────────────────────────────────────────────

describe('E2E: provenance completeness', () => {
  test('provenance covers all required metadata', () => {
    const project = createFullProject();
    const result = compileDomain(project);
    const prov = buildProvenance(project, result.files);

    assert.equal(prov.studio_core, 'aikdna/kdna-studio-core');
    assert.ok(prov.studio_core_version);
    assert.ok(prov.build_id);
    assert.ok(prov.project_id);
    assert.equal(prov.author_id, 'expert_001');
    assert.equal(prov.locked_card_count, 10); // 3 axioms + 2 misunderstandings + 5 self-checks
    assert.equal(prov.test_case_count, 0);
    assert.ok(prov.built_at);
    assert.ok(prov.content_fingerprint.startsWith('sha256:'));
  });
});

// Cleanup
process.on('exit', () => {
  try { fs.rmSync(TMPDIR, { recursive: true, force: true }); } catch {}
});
