/**
 * Compile locked cards into KDNA domain JSON files — SPEC-compatible output.
 *
 * KDNA SPEC v1.0-rc requirements:
 *   - Every file MUST have meta: { version, domain, created, purpose, load_condition }
 *   - Minimum output: KDNA_Core.json + KDNA_Patterns.json
 *   - Maximum 6 KDNA JSON files per domain
 *   - KDNA_Scenarios.json: { meta, scenes[] }
 *   - KDNA_Reasoning.json: { meta, reasoning_chains[] }
 *   - KDNA_Evolution.json: { meta, stages[], capability_layers[], measurements[] }
 *
 * Only locked cards enter compilation. Draft/Revised excluded silently.
 */

function makeMeta(project) {
  return {
    version: (project.release && project.release.version) || '0.1.0',
    domain: project.name,
    created: project.created || new Date().toISOString().slice(0, 10),
    purpose: project.release?.description || `Domain judgment for ${project.name}`,
    load_condition: 'Load when the task matches applies_when on domain axioms.',
  };
}

function compileCore(cards, project) {
  const lockedAxioms = cards.filter(c => c.type === 'axiom' && c.locked).map(c => ({ id: c.id, ...c.fields }));
  const lockedOntology = cards.filter(c => c.type === 'ontology' && c.locked).map(c => ({ id: c.id, ...c.fields }));
  const lockedBoundaries = cards.filter(c => c.type === 'boundary' && c.locked);
  const lockedRisks = cards.filter(c => c.type === 'risk' && c.locked).map(c => ({ id: c.id, ...c.fields }));

  return {
    meta: makeMeta(project),
    axioms: lockedAxioms,
    ontology: lockedOntology,
    frameworks: [],
    stances: [],
    core_structure: [],
    boundaries: lockedBoundaries.map(c => ({
      id: c.id,
      scope: c.fields?.scope || '',
      out_of_scope: c.fields?.out_of_scope || '',
      acceptable_exceptions: c.fields?.acceptable_exceptions || [],
    })),
    risks: lockedRisks,
  };
}

function compilePatterns(cards, project) {
  const lockedMisunderstandings = cards.filter(c => c.type === 'misunderstanding' && c.locked).map(c => ({
    id: c.id,
    wrong: c.fields?.wrong || '',
    correct: c.fields?.correct || '',
    key_distinction: c.fields?.key_distinction || '',
    why: c.fields?.why || `What bad judgment results from believing "${(c.fields?.wrong || '').slice(0, 40)}"`,
    failure_risk: c.fields?.failure_risk || 'No specific failure risk declared',
    applies_when: c.fields?.applies_when || [],
    does_not_apply_when: c.fields?.does_not_apply_when || [],
  }));
  const lockedSelfChecks = cards.filter(c => c.type === 'self_check' && c.locked).map(c => c.fields?.question || '');
  const lockedAesthetics = cards.filter(c => c.type === 'aesthetic' && c.locked).map(c => ({ id: c.id, ...c.fields }));

  return {
    meta: makeMeta(project),
    terminology: {
      standard_terms: [],
      banned_terms: [],
    },
    misunderstandings: lockedMisunderstandings,
    self_check: lockedSelfChecks,
    aesthetics: lockedAesthetics,
  };
}

function compileScenarios(cards, project) {
  const locked = cards.filter(c => c.type === 'scenario' && c.locked);
  if (locked.length === 0) return null;
  return {
    meta: makeMeta(project),
    scenes: locked.map(c => ({ id: c.id, ...c.fields })),
  };
}

function compileCases(cards, project) {
  const locked = cards.filter(c => c.type === 'case' && c.locked);
  if (locked.length === 0) return null;
  return {
    meta: makeMeta(project),
    cases: locked.map(c => ({ id: c.id, ...c.fields })),
  };
}

function compileReasoning(cards, project) {
  const lockedAxioms = cards.filter(c => c.type === 'axiom' && c.locked);
  if (lockedAxioms.length === 0) return null;
  return {
    meta: makeMeta(project),
    reasoning_chains: lockedAxioms.map(ax => ({
      id: `chain_${ax.id}`,
      one_sentence: ax.fields?.one_sentence || '',
      logic: [ax.fields?.full_statement || ''],
      so_what: ax.fields?.why || 'Agent judgment changes when this axiom is loaded.',
    })),
  };
}

function compileEvolution(cards, project) {
  const lockedCards = cards.filter(c => c.locked);
  if (lockedCards.length === 0) return null;

  const stages = [];
  const seenAxioms = new Set();
  for (const card of lockedCards) {
    if (seenAxioms.has(card.id)) continue;
    seenAxioms.add(card.id);
    for (const entry of (card.audit_log || [])) {
      if (entry.event === 'locked') {
        stages.push({
          id: `stage_${card.id}`,
          name: card.fields?.one_sentence || card.fields?.question || card.id,
          description: `Card ${card.id} was locked by ${entry.by} at ${entry.at}. Type: ${card.type}.`,
          indicators: [`${card.type} card locked`, 'Human judgment confirmed'],
        });
      }
    }
  }

  return {
    meta: makeMeta(project),
    stages: stages.sort((a, b) => a.id.localeCompare(b.id)),
    evolution_layers: [
      { id: 'layer_1', name: 'Foundation', capability: 'Core axioms and patterns established.', from_stage: stages[0]?.id || 'none', to_stage: stages[stages.length - 1]?.id || 'none' },
    ],
    measurement: [
      { id: 'meas_axioms', what: 'locked_axioms', how: 'Count of locked axiom cards', threshold: `${lockedCards.filter(c => c.type === 'axiom').length}` },
      { id: 'meas_misunderstandings', what: 'locked_misunderstandings', how: 'Count of locked misunderstanding cards', threshold: `${lockedCards.filter(c => c.type === 'misunderstanding').length}` },
      { id: 'meas_self_checks', what: 'self_checks', how: 'Count of locked self-check cards', threshold: `${lockedCards.filter(c => c.type === 'self_check').length}` },
    ],
  };
}

function compileManifest(project, files) {
  const kdnaFileCount = Object.keys(files).filter(f => f.startsWith('KDNA_')).length;
  return {
    kdna_spec: '1.0-rc',
    name: project.name,
    version: (project.release && project.release.version) || '0.1.0',
    status: (project.release && project.release.status) || 'experimental',
    access: (project.release && project.release.access) || 'open',
    author: project.author || { name: '', id: '' },
    description: project.release?.description || project.name,
    file_count: kdnaFileCount,
    created: project.created || new Date().toISOString().slice(0, 10),
    updated: project.updated || new Date().toISOString().slice(0, 10),
  };
}

function compileDomain(project) {
  const cards = project.cards || [];
  const core = compileCore(cards, project);
  const patterns = compilePatterns(cards, project);
  const scenarios = compileScenarios(cards, project);
  const cases = compileCases(cards, project);
  const reasoning = compileReasoning(cards, project);
  const evolution = compileEvolution(cards, project);

  const files = {};
  files['KDNA_Core.json'] = JSON.stringify(core, null, 2);
  files['KDNA_Patterns.json'] = JSON.stringify(patterns, null, 2);
  if (scenarios) files['KDNA_Scenarios.json'] = JSON.stringify(scenarios, null, 2);
  if (cases) files['KDNA_Cases.json'] = JSON.stringify(cases, null, 2);
  if (reasoning) files['KDNA_Reasoning.json'] = JSON.stringify(reasoning, null, 2);
  if (evolution) files['KDNA_Evolution.json'] = JSON.stringify(evolution, null, 2);
  files['kdna.json'] = JSON.stringify(compileManifest(project, files), null, 2);

  // ── KDNA Card (governance metadata) ─────────────────────────────
  if (project.governance) {
    const { generateKdnaCard } = require('../governance');
    const prov = require('../provenance').buildProvenance(project, files);
    const kdnaCard = generateKdnaCard(project, {}, prov);
    files['KDNA_CARD.json'] = JSON.stringify(kdnaCard, null, 2);
  }

  const excludedCount = cards.filter(c => !c.locked && !['deprecated'].includes(c.status)).length;

  return {
    files,
    stats: {
      total_cards: cards.length,
      locked_cards: cards.filter(c => c.locked).length,
      excluded_cards: excludedCount,
      deprecated_cards: cards.filter(c => c.status === 'deprecated').length,
      kdna_files: Object.keys(files).filter(f => f.startsWith('KDNA_')).length,
      total_files: Object.keys(files).length,
    },
  };
}

function generateReadme(project, options = {}) {
  const cards = project.cards || [];
  const locked = cards.filter(c => c.locked);
  const lockedAxioms = locked.filter(c => c.type === 'axiom');
  const lockedMisunderstandings = locked.filter(c => c.type === 'misunderstanding');
  const lockedSelfChecks = locked.filter(c => c.type === 'self_check');
  const lockedBoundaries = locked.filter(c => c.type === 'boundary');
  const tests = project.tests || [];

  const lines = [];
  lines.push(`# ${project.name}`);
  lines.push('');
  if (options.description) { lines.push(options.description); lines.push(''); }

  lines.push('## Where it comes from');
  lines.push('');
  lines.push(options.origin || `Domain expertise encoded into ${locked.length} judgment cards through structured interview and human lock.`);
  lines.push('');

  lines.push('## Where it applies');
  lines.push('');
  const appliesWhen = [...new Set(lockedAxioms.flatMap(ax => ax.fields?.applies_when || []))];
  appliesWhen.length ? appliesWhen.forEach(w => lines.push(`- ${w}`)) : lines.push('- As declared in each axiom\'s applies_when field.');
  lines.push('');

  lines.push('## How it is verified');
  lines.push('');
  lines.push(`- ${tests.length} eval cases (${tests.filter(t => t.result).length} rated)`);
  lines.push(`- ${lockedAxioms.length} locked axioms with applies_when / does_not_apply_when / failure_risk`);
  lines.push(`- ${lockedSelfChecks.length} self-check questions`);
  lines.push(`- ${lockedMisunderstandings.length} misunderstanding patterns`);
  lines.push('');

  lines.push('## When it does NOT apply');
  lines.push('');
  const notApply = [...new Set(lockedAxioms.flatMap(ax => ax.fields?.does_not_apply_when || []))];
  notApply.forEach(w => lines.push(`- ${w}`));
  for (const oos of lockedBoundaries.flatMap(b => [b.fields?.out_of_scope || '']).filter(Boolean)) {
    if (!notApply.includes(oos)) lines.push(`- ${oos}`);
  }
  lines.push('');

  if (lockedAxioms.length > 0) {
    lines.push('## Top Axioms'); lines.push('');
    lockedAxioms.forEach(ax => {
      lines.push(`- **${ax.fields?.one_sentence || ax.id}**`);
      if (ax.fields?.failure_risk) lines.push(`  - Failure risk: ${ax.fields.failure_risk}`);
    });
    lines.push('');
  }

  if (lockedMisunderstandings.length > 0) {
    lines.push('## Top Misunderstandings'); lines.push('');
    lockedMisunderstandings.forEach(ms => {
      lines.push(`- WRONG: ${ms.fields?.wrong}`);
      lines.push(`  CORRECT: ${ms.fields?.correct}`);
    });
    lines.push('');
  }

  if (lockedSelfChecks.length > 0) {
    lines.push('## Eval Score'); lines.push('');
    lines.push(`- quality_badge: ${tests.filter(t => t.result === 'with_kdna_better').length >= 5 ? 'tested' : 'untested'}`);
    lines.push(`- eval cases: ${tests.length}`);
    lines.push('');
  }

  lines.push('## Files'); lines.push('');
  const kdnaFileCount = 2
    + (cards.filter(c => c.type === 'scenario' && c.locked).length > 0 ? 1 : 0)
    + (cards.filter(c => c.type === 'case' && c.locked).length > 0 ? 1 : 0)
    + (lockedAxioms.length > 0 ? 1 : 0)
    + (locked.length > 0 ? 1 : 0);
  lines.push(`${kdnaFileCount} KDNA JSON files + evals/ + demo/`);
  lines.push('');

  return lines.join('\n');
}

module.exports = { compileDomain, compileCore, compilePatterns, compileScenarios, compileCases, compileReasoning, compileEvolution, compileManifest, generateReadme };
