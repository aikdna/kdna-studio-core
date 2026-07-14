const { isDeepStrictEqual } = require('node:util');

const JUDGMENT_CORE_FIELDS = [
  'highest_question',
  'worldview',
  'value_order',
  'judgment_role',
];

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateString(value, path, issues) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    issues.push(`${path}: expected a non-empty string`);
  }
}

function validateStringList(value, path, issues) {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push(`${path}: expected a non-empty string array`);
    return;
  }
  value.forEach((item, index) => validateString(item, `${path}[${index}]`, issues));
}

function validateJudgmentCore(value) {
  const issues = [];
  if (value === undefined) return issues;
  if (!isObject(value)) return ['judgment_core: expected an object'];

  for (const key of Object.keys(value)) {
    if (!JUDGMENT_CORE_FIELDS.includes(key)) {
      issues.push(`judgment_core.${key}: unsupported field`);
    }
  }
  if (Object.hasOwn(value, 'highest_question')) {
    validateString(value.highest_question, 'judgment_core.highest_question', issues);
  }
  if (Object.hasOwn(value, 'worldview')) {
    validateStringList(value.worldview, 'judgment_core.worldview', issues);
  }
  if (Object.hasOwn(value, 'value_order')) {
    validateStringList(value.value_order, 'judgment_core.value_order', issues);
  }
  if (Object.hasOwn(value, 'judgment_role')) {
    const role = value.judgment_role;
    if (!isObject(role)) {
      issues.push('judgment_core.judgment_role: expected an object');
    } else {
      const allowed = ['acts_as', 'does_not_act_as', 'responsibility'];
      for (const key of Object.keys(role)) {
        if (!allowed.includes(key)) {
          issues.push(`judgment_core.judgment_role.${key}: unsupported field`);
        }
      }
      if (Object.hasOwn(role, 'acts_as')) {
        validateString(role.acts_as, 'judgment_core.judgment_role.acts_as', issues);
      }
      if (Object.hasOwn(role, 'does_not_act_as')) {
        validateStringList(
          role.does_not_act_as,
          'judgment_core.judgment_role.does_not_act_as',
          issues,
        );
      }
      if (Object.hasOwn(role, 'responsibility')) {
        validateString(
          role.responsibility,
          'judgment_core.judgment_role.responsibility',
          issues,
        );
      }
      if (Object.keys(role).length === 0) {
        issues.push('judgment_core.judgment_role: expected at least one declared role field');
      }
    }
  }
  if (Object.keys(value).length === 0) {
    issues.push('judgment_core: expected at least one declared semantic field');
  }
  return issues;
}

function copyDeclaredJudgmentCore(value) {
  if (value === undefined) return {};
  const issues = validateJudgmentCore(value);
  if (issues.length > 0) {
    const error = new Error(`invalid judgment_core:\n  - ${issues.join('\n  - ')}`);
    error.code = 'JUDGMENT_CORE_INVALID';
    error.issues = issues;
    throw error;
  }
  return JSON.parse(JSON.stringify(value));
}

function pickJudgmentCore(value) {
  const picked = {};
  if (!isObject(value)) return picked;
  for (const field of JUDGMENT_CORE_FIELDS) {
    if (Object.hasOwn(value, field)) {
      picked[field] = JSON.parse(JSON.stringify(value[field]));
    }
  }
  return picked;
}

function assertJudgmentCorePreserved(expected, actual, stage) {
  const failures = [];
  for (const field of Object.keys(expected)) {
    if (!isDeepStrictEqual(expected[field], actual[field])) {
      failures.push(field);
    }
  }
  if (failures.length > 0) {
    const error = new Error(
      `judgment_core fidelity failed at ${stage}: ${failures.join(', ')}`,
    );
    error.code = 'SEMANTIC_FIDELITY_FAILED';
    error.stage = stage;
    error.failures = failures;
    throw error;
  }
}

module.exports = {
  JUDGMENT_CORE_FIELDS,
  validateJudgmentCore,
  copyDeclaredJudgmentCore,
  pickJudgmentCore,
  assertJudgmentCorePreserved,
};
