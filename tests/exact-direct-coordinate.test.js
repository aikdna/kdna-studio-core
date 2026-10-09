'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isExactDirectCoordinate } = require('../scripts/runtime-candidate-binding');

// The repository's manifest is a candidate manifest, so a direct coordinate may
// be an exact stable version or an exact canonical candidate coordinate. This
// is the negative control that keeps the accepted set exact: no floating range,
// wildcard, dist-tag, range over a prerelease, malformed prerelease or local
// file coordinate may pass.
test('a direct coordinate is exact SemVer or an exact canonical candidate', () => {
  for (const accepted of ['1.2.3', '0.0.0', '10.20.30', '1.2.3-rc.probe.1', '0.37.1-rc.browser.1', '0.11.2-rc.browser.1', '4.0.0-rc.components.2']) {
    assert.equal(isExactDirectCoordinate(accepted), true, accepted);
  }
  for (const rejected of [
    '^1.2.3',
    '~1.2.3',
    '*',
    'latest',
    'next',
    '>=1.2.3-rc.1',
    '1.2.3 - 2.0.0',
    '1.2.x',
    '1.2',
    '1',
    '1.2.3-rc.01',
    '1.2.3-rc..1',
    'file:vendor/a.tgz',
    '',
    undefined,
    null,
    123,
  ]) {
    assert.equal(isExactDirectCoordinate(rejected), false, String(rejected));
  }
});
