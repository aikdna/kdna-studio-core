/**
 * KDNA Studio Core — Pure logic for authoring KDNA domain judgment.
 *
 * This is the canonical open-source implementation of the Studio authoring
 * workflow. Every exported function is pure logic — no UI dependencies.
 *
 * The package root exposes the supported source → review → confirm → export
 * path. Experimental workshops remain in the repository for research and
 * full regression coverage, but are not part of the public package contract.
 *   cli-bridge/   Adapter to kdna-cli subprocess calls
 */

const cards = require('./cards');
const authoring = require('./authoring');
const compile = require('./compile');
const creatorIdentity = require('./creator-identity');
const evidence = require('./evidence');
const exportRuntime = require('./export-runtime');
const i18n = require('./i18n');
const project = require('./project');
const provenance = require('./provenance');
const distillation = require('./distillation');
const protocolContract = require('./protocol-contract');

module.exports = {
  authoring,
  project,
  cards,
  compile,
  provenance,
  exportRuntime,
  i18n,
  creator: creatorIdentity,
  distillation,
  evidence,
  protocolContract,
};
