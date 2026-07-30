'use strict';

function deterministicBootstrapLower(
  deltas,
  seedDigest,
  options = {},
) {
  const replicates = options.replicates ?? 4000;
  let state = options.seed ??
    (Number.parseInt(seedDigest.slice(-8), 16) || 1);
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
  const means = [];
  for (let sample = 0; sample < replicates; sample += 1) {
    let total = 0;
    for (let index = 0; index < deltas.length; index += 1) {
      total += deltas[Math.floor(random() * deltas.length)];
    }
    means.push(total / deltas.length);
  }
  means.sort((left, right) => left - right);
  const confidenceLevel = options.confidenceLevel ?? 0.95;
  const lowerTail = (1 - confidenceLevel) / 2;
  const rank = options.legacyRank === true
    ? Math.floor(lowerTail * means.length)
    : Math.floor(lowerTail * (means.length - 1));
  return means[rank];
}

module.exports = {
  deterministicBootstrapLower,
};
