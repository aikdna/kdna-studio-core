'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  deterministicBootstrapLower,
} = require('../src/creation-engine/application-metrics');

test('selective bootstrap uses the frozen lower confidence-bound index', () => {
  const deltas = [
    0.4351300236303359,
    0.03865125775337219,
    0.22087990469299257,
    0.3594270762987435,
    0.5902441388461739,
    0.361280900426209,
    0.3268499083351344,
    0.07973951241001487,
    0.6479622528422624,
    0.6049802396446466,
    0.9694624783005565,
    0.7677612067200243,
  ];
  const lower = deterministicBootstrapLower(
    deltas,
    'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    {
      replicates: 10000,
      seed: 860281,
      confidenceLevel: 0.95,
    },
  );
  assert.equal(lower, 0.30260181702518213);
  assert.notEqual(lower, 0.302697802738597);
  assert.equal(
    deterministicBootstrapLower(
      deltas,
      'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      {
        replicates: 10000,
        seed: 860281,
        confidenceLevel: 0.95,
        legacyRank: true,
      },
    ),
    0.302697802738597,
  );
});
