/**
 * createStudioPipeline(project, options) — retired 2.x compatibility surface.
 *
 * This was a semver-stable root export in the published 2.x line. It remains
 * in the repository for historical regression coverage, but is not exported
 * or packaged by 3.x. New integrations use the admitted authoring primitives.
 */

const { validateProject } = require('./project');
const { computeReadiness } = require('./quality');
const { compileDomain, generateReadme } = require('./compile');
const { buildProvenance } = require('./provenance');
const { validateAllCards } = require('./quality/validate-cards');

function createStudioPipeline(project, options = {}) {
  return new StudioPipeline(project, options);
}

class StudioPipeline {
  constructor(project, options = {}) {
    this.project = project;
    this.options = options;
    this.results = {};
  }

  validateProject() { this.results.project_valid = validateProject(this.project); return this; }
  validateCards() { const cardIssues = validateAllCards(this.project); this.results.card_validation = { total: cardIssues.length, issues: cardIssues }; return this; }
  computeReadiness() { this.results.readiness = computeReadiness(this.project); return this; }
  
  compile() {
    this.results.compile = compileDomain(this.project);
    return this;
  }

  generateReadme(readmeOptions = {}) {
    this.results.readme = generateReadme(this.project, readmeOptions);
    return this;
  }

  buildProvenance() {
    if (!this.results.compile) throw new Error('Must call compile() before buildProvenance()');
    this.results.provenance = buildProvenance(this.project, this.results.compile.files);
    return this;
  }

  runAll(options = {}) {
    this.validateProject();
    this.validateCards();
    this.computeReadiness();
    this.compile();
    if (options.generateReadme !== false) this.generateReadme(options.readmeOptions);
    if (options.buildProvenance !== false) this.buildProvenance();
    return this;
  }

  // ── Getters ─────────────────────────────────────────────────────

  /** @deprecated Use .readiness instead */
  get readyness() { return this.results.readiness; }
  get readiness() { return this.results.readiness; }
  get compiled() { return this.results.compile; }
  get kdnaFiles() { return this.results.compile?.files || {}; }
  get isPublishable() { return this.results.readiness?.publishable === true; }

  // ── Output methods ──────────────────────────────────────────────

  /** Flat summary for UI display */
  toResult() {
    return {
      project_valid: this.results.project_valid?.valid === true,
      card_issues: this.results.card_validation?.total || 0,
      readiness: this.results.readiness?.grade || 'unknown',
      publishable: this.results.readiness?.publishable || false,
      score: this.results.readiness?.score || 0,
      kdna_files: this.results.compile?.stats?.kdna_files || 0,
      locked_cards: this.results.compile?.stats?.locked_cards || 0,
      excluded_cards: this.results.compile?.stats?.excluded_cards || 0,
      build_id: this.results.provenance?.build_id || null,
      fingerprint: this.results.provenance?.content_fingerprint || null,
      blocking: this.results.readiness?.blocking || [],
      warnings: this.results.readiness?.warnings || [],
      next_step: this.results.readiness?.next_step || '',
    };
  }

  /** Full artifacts: files + readme + provenance + summary */
  toArtifacts() {
    const result = this.toResult();
    return {
      ...result,
      files: this.results.compile?.files || {},
      readme: this.results.readme || '',
      provenance: this.results.provenance || null,
      readiness_raw: this.results.readiness || null,
      card_validation_raw: this.results.card_validation || null,
    };
  }
}

module.exports = { createStudioPipeline };
