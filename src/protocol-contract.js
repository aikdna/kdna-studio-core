'use strict';

const FORMAT_VERSION = '0.1.0';
const PAYLOAD_PROFILE = 'kdna.payload.judgment';
const PAYLOAD_PROFILE_VERSION = '0.1.0';
const RUNTIME_CAPSULE_TYPE = 'kdna.runtime-capsule';
const RUNTIME_CAPSULE_VERSION = '0.1.0';
const RUNTIME_ENTRY_SET_DIGEST_PROFILE = 'kdna.digest-basis.runtime-entry-set';
const RUNTIME_ENTRY_SET_DIGEST_PROFILE_VERSION = '0.1.0';

const REPORT_CONTRACTS = Object.freeze({
  build: Object.freeze({
    type: 'kdna.studio.build-report',
    schema_version: '0.1.0',
  }),
  humanLock: Object.freeze({
    type: 'kdna.studio.human-lock-report',
    schema_version: '0.1.0',
  }),
  qualityGate: Object.freeze({
    type: 'kdna.studio.quality-gate-report',
    schema_version: '0.1.0',
  }),
  evaluation: Object.freeze({
    type: 'kdna.studio.evaluation-report',
    schema_version: '0.1.0',
  }),
  receipt: Object.freeze({
    type: 'kdna.studio.build-receipt',
    schema_version: '0.1.0',
  }),
});

module.exports = Object.freeze({
  FORMAT_VERSION,
  PAYLOAD_PROFILE,
  PAYLOAD_PROFILE_VERSION,
  RUNTIME_CAPSULE_TYPE,
  RUNTIME_CAPSULE_VERSION,
  RUNTIME_ENTRY_SET_DIGEST_PROFILE,
  RUNTIME_ENTRY_SET_DIGEST_PROFILE_VERSION,
  REPORT_CONTRACTS,
});
