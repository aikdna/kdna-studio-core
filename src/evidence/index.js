/**
 * Evidence management — import, annotate, and link raw material to judgment cards.
 *
 * Evidence proves "there is material here." It does NOT prove "this is judgment."
 * Spans are extracted text segments that MAY indicate a judgment pattern.
 */

const crypto = require('crypto');

function createEvidenceEntry(type, title, content, source = 'manual') {
  return {
    id: `ev_${crypto.randomUUID()}`,
    type,
    title,
    content_hash: `sha256:${crypto.createHash('sha256').update(content || '').digest('hex')}`,
    source,
    imported_at: new Date().toISOString(),
    spans: [],
    content: type === 'text' || type === 'chat' ? content : undefined,
  };
}

function addEvidence(project, evidence) {
  // Bug (#66): the prior version wrote to `project.evidence`, but every
  // consumer (cmdFilter, cmdSourceClassify, cmdDistill) reads from
  // `project.evidence_materials`. The mismatch meant imported evidence
  // was effectively invisible: filter always returned empty, source
  // classify always reported "no evidence", and AI distillation never
  // had any source material to extract from.
  //
  // The fix writes to BOTH fields so legacy callers (the studio UI
  // reads `project.evidence` for the evidence_room display) keep
  // working and the canonical `evidence_materials` field stays in
  // sync. New code should read `project.evidence_materials`; the
  // `project.evidence` write is preserved for backward compatibility
  // only and is documented as such.
  project.evidence = project.evidence || [];
  project.evidence.push(evidence);
  project.evidence_materials = project.evidence_materials || [];
  project.evidence_materials.push(evidence);
  if (project.stages?.evidence_room) {
    project.stages.evidence_room.evidence_count = project.evidence_materials.length;
    project.stages.evidence_room.status = 'in_progress';
  }
  return project;
}

function extractSpan(evidence, start, end, candidatePattern = null) {
  const text = evidence.content ? evidence.content.slice(start, end) : '';
  const span = {
    id: `span_${evidence.id}_${evidence.spans.length}`,
    text: text.slice(0, 200), // cap at 200 chars
    start,
    end,
    candidate_pattern: candidatePattern,
    extracted_at: new Date().toISOString(),
  };
  evidence.spans.push(span);
  return span;
}

function linkEvidenceToCard(evidence, spanId, card) {
  if (!card.evidence_refs) card.evidence_refs = [];
  const ref = `${evidence.id}:${spanId}`;
  if (!card.evidence_refs.includes(ref)) {
    card.evidence_refs.push(ref);
  }
  return card;
}

function getEvidenceForCard(evidenceEntries, card) {
  if (!card.evidence_refs) return [];
  return card.evidence_refs.map(ref => {
    const [evId, spanId] = ref.split(':');
    const ev = evidenceEntries.find(e => e.id === evId);
    if (!ev) return null;
    const span = spanId ? ev.spans.find(s => s.id === spanId) : null;
    return { evidence: ev, span };
  }).filter(Boolean);
}

function markEvidenceRoomComplete(project) {
  if (project.stages?.evidence_room) {
    project.stages.evidence_room.status = 'complete';
  }
  return project;
}

module.exports = {
  createEvidenceEntry,
  addEvidence,
  extractSpan,
  linkEvidenceToCard,
  getEvidenceForCard,
  markEvidenceRoomComplete,
};
