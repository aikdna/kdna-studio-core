#!/usr/bin/env node
/**
 * KDNA Creator Lifecycle Demo
 *
 * Demonstrates the complete creator journey:
 *   1. Create project → 2. Review provenance → 3. Quality Check → 4. Compile → 5. Export
 *
 * Usage: node examples/creator-lifecycle.js
 */

const { createProject, checkHumanLockGate, exportProject } = require('../src/project');
const { createCard, lockCard, transitionCard } = require('../src/cards');
const { compileDomain } = require('../src/compile');
const { computeReadiness } = require('../src/quality');

console.log('═'.repeat(60));
console.log('  KDNA Creator Lifecycle Demo');
console.log('═'.repeat(60));
console.log('');

// ═══ Step 1: Create ═══
console.log('1. CREATE — Initialize a Studio Project');
const project = createProject('writing_judgment', 'domain', {
  author: { name: 'Writing Expert', id: 'writer_001' },
});
console.log(`   Project: ${project.name} (${project.project_id})`);
console.log(`   Status:  ${project.status}`);
console.log('');

// ═══ Step 2: Author — Add judgment cards ═══
console.log('2. AUTHOR — Create judgment cards (human, agent, tool, or hybrid)');
const axiom = createCard('axiom', {
  one_sentence: 'Most writing problems are structural, not language-level.',
  full_statement: 'When reviewing content, diagnose structure before language. Surface polishing on structurally weak content wastes effort.',
  why: 'Without this principle, agents default to surface-level editing.',
  applies_when: ['User asks to review content', 'User submits a draft', 'User asks whether writing is good'],
  does_not_apply_when: ['User explicitly asks for grammar check only', 'User asks for translation'],
  failure_risk: 'May over-diagnose structural problems in content that only needs language polish.',
});
project.cards.push(axiom);

const misunderstanding = createCard('misunderstanding', {
  wrong: 'Good writing means clear sentences and proper grammar.',
  correct: 'Good writing means having a clear argument, specific evidence, and a hook that captures attention.',
  key_distinction: 'Surface clarity can mask structural emptiness.',
});
project.cards.push(misunderstanding);

const selfCheck = createCard('self_check', {
  question: 'Before suggesting language changes, did I verify the content has a clear argument and sufficient evidence?',
});
project.cards.push(selfCheck);

console.log(`   Cards created: ${project.cards.length}`);
console.log(`   Types: ${project.cards.map(c => c.type).join(', ')}`);
console.log('');

// ═══ Step 3: Review Provenance ═══
console.log('3. REVIEW — Optional Human Lock provenance for reviewed publishing');

// Check gate BEFORE locking
const gateBefore = checkHumanLockGate(project);
console.log(`   Gate check (before lock): ${gateBefore.blocked ? '❌ BLOCKED' : '✅ PASS'}`);
if (gateBefore.blocked) {
  console.log(`   Issues: ${gateBefore.issues.length}`);
  for (const issue of gateBefore.issues) {
    console.log(`     - ${issue.cardId}: ${issue.reason}`);
  }
}

// Lock the axiom (judgment-class card)
const reviewedAxiom = transitionCard(axiom, 'revised', { by: 'writer_001' });
const locked = lockCard(reviewedAxiom, {
  by: 'writer_001',
  statement: 'I confirm this is my professional writing judgment.',
  checked: { applies_when: true, does_not_apply_when: true, failure_risk: true },
});
project.cards[0] = locked;

// Check gate AFTER locking
const gateAfter = checkHumanLockGate(project);
console.log(`   Gate check (after lock):  ${gateAfter.blocked ? '❌ BLOCKED' : '✅ PASS'}`);
console.log(`   Locked judgment cards:    ${gateAfter.lockedJudgmentCards}`);
if (gateAfter.issues.length > 0) {
  console.log(`   Remaining issues:         ${gateAfter.issues.length}`);
  for (const issue of gateAfter.issues) {
    console.log(`     - ${issue.cardId}: ${issue.reason}`);
  }
}
console.log('');

// ═══ Step 4: Quality Check ═══
console.log('4. QUALITY — Check readiness');
const readiness = computeReadiness(project);
console.log(`   Grade:      ${readiness.grade}`);
console.log(`   Score:      ${readiness.score}`);
console.log(`   Blocking:   ${readiness.blocking.length}`);
console.log(`   Warnings:   ${readiness.warnings.length}`);
console.log('');

// ═══ Step 5: Compile ═══
console.log('5. COMPILE — Generate KDNA files from complete cards');
try {
  const compiled = compileDomain(project);
  console.log(`   Files:      ${compiled.stats.kdna_files}`);
  console.log(`   Compiled:   ${compiled.stats.compiled_cards} complete cards`);
  console.log(`   Reviewed:   ${compiled.stats.human_lock_count} cards with Human Lock`);
  console.log(`   Excluded:   ${compiled.stats.excluded_cards} incomplete/deprecated cards`);
  console.log('');

  // Show a snippet
  const coreContent = compiled.files['KDNA_Core.json'];
  const preview = JSON.parse(coreContent);
  console.log('   KDNA_Core.json preview:');
  console.log(`     axioms: ${preview.axioms?.length || 0}`);
  if (preview.axioms?.[0]) {
    console.log(`     first axiom: "${preview.axioms[0].one_sentence}"`);
  }
} catch (e) {
  console.log(`   ❌ ${e.message}`);
}
console.log('');

// ═══ Step 6: Export ═══
console.log('6. EXPORT — Final gate check and export');
try {
  const json = exportProject(project);
  const exported = JSON.parse(json);
  console.log(`   Status:        exported`);
  console.log(`   Locked cards:  ${exported.release?.locked_judgment_cards}`);
  console.log(`   Gate passed:   ${exported.release?.human_lock_gate_passed}`);
} catch (e) {
  console.log(`   ❌ BLOCKED: ${e.message.split('\n')[0]}`);
  console.log('   (Studio review provenance is separate from KDNA format validity)');
}
console.log('');

// ═══ Summary ═══
console.log('═'.repeat(60));
console.log('  Lifecycle Complete');
console.log('');
console.log('  ✅ Create     — Studio Project initialized');
console.log('  ✅ Author     — Judgment cards created');
console.log('  ✅ Review     — Optional Human Lock provenance recorded');
console.log('  ✅ Quality    — Readiness check before compile');
console.log('  ✅ Compile    — Complete cards → KDNA files');
console.log('  ✅ Export     — Runtime asset + optional review provenance');
console.log('');
console.log('  Principle: .kdna format validity is content-neutral.');
console.log('  Human Lock is optional provenance for reviewed publishing flows.');
console.log('═'.repeat(60));
