'use strict';
// Reused strict JSON encoding primitive; no legacy verifier/provider metadata.
const own = (value, key) => value != null && Object.hasOwn(value, key);
const uint = value => Number.isSafeInteger(value) && value >= 0;
function malformed() { throw new TypeError('Malformed current Studio JSON input.'); }

function validateJSON(value, evidenceNumbers = false) {
  let count = 0;
  const active = new Set();
  function visit(item, depth) {
    if (++count > 100000 || depth > 64) malformed();
    if (item === null || typeof item === 'boolean') return;
    if (typeof item === 'string') { if (!item.isWellFormed()) malformed(); return; }
    if (typeof item === 'number') {
      if (!Number.isFinite(item) || (evidenceNumbers && !uint(item))) malformed();
      return;
    }
    if (!item || typeof item !== 'object' || active.has(item)) malformed();
    active.add(item);
    if (Array.isArray(item)) {
      if (Object.getPrototypeOf(item) !== Array.prototype || Reflect.ownKeys(item).length !== item.length + 1) malformed();
      for (let i = 0; i < item.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(i));
        if (!descriptor || !descriptor.enumerable || !own(descriptor, 'value')) malformed();
        visit(descriptor.value, depth + 1);
      }
    } else {
      if (![Object.prototype, null].includes(Object.getPrototypeOf(item))) malformed();
      for (const key of Reflect.ownKeys(item)) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (typeof key !== 'string' || !key.isWellFormed() || !descriptor.enumerable || !own(descriptor, 'value')) malformed();
        if (evidenceNumbers && ['revision', 'sequence', 'bytes'].includes(key) && !uint(descriptor.value)) malformed();
        visit(descriptor.value, depth + 1);
      }
    }
    active.delete(item);
  }
  visit(value, 0);
}
function sortedJSON(value) {
  if (Array.isArray(value)) return `[${value.map(sortedJSON).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${sortedJSON(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function canonicalStringify(value) { validateJSON(value); return sortedJSON(value); }

module.exports={canonicalStringify};
