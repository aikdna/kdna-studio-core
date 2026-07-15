'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const JsonSchema2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');

const { createProject, validateProject } = require('../src/project');
const { createCard, CARD_TYPES } = require('../src/cards');
const {
  PROJECT_SCHEMA,
  PROJECT_SCHEMA_BYTES,
  PROJECT_SCHEMA_PATH,
  parseProjectSchemaAuthority,
} = require('../src/project-schema');

function schemaCopy() {
  return JSON.parse(PROJECT_SCHEMA_BYTES.toString('utf8'));
}

function schemaBytes(mutator) {
  const value = schemaCopy();
  mutator(value);
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function schemaValidator() {
  const ajv = new JsonSchema2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(PROJECT_SCHEMA);
}

test('shipped project-schema bytes are the runtime card-type authority', () => {
  assert.deepEqual(PROJECT_SCHEMA_BYTES, fs.readFileSync(PROJECT_SCHEMA_PATH));
  assert.deepEqual(CARD_TYPES, PROJECT_SCHEMA.properties.cards.items.properties.type.enum);
  assert.equal(CARD_TYPES.length, 16);
  assert.equal(Object.isFrozen(CARD_TYPES), true);
});

test('all 16 authoritative card types pass both JSON Schema and validateProject', () => {
  const validateSchema = schemaValidator();
  for (const type of CARD_TYPES) {
    const project = createProject(`project_${type}`);
    project.cards = [createCard(type, {}, `card_${type}`)];
    assert.equal(validateSchema(project), true, `${type}: ${JSON.stringify(validateSchema.errors)}`);
    assert.deepEqual(validateProject(project), { valid: true, issues: [] }, type);
  }
});

test('an unsupported card type fails both JSON Schema and validateProject', () => {
  const validateSchema = schemaValidator();
  const project = createProject('unsupported_card');
  project.cards = [{ id: 'card_unknown', type: 'shadow_card', status: 'draft' }];
  assert.equal(validateSchema(project), false);
  assert.equal(validateProject(project).valid, false);
  assert.throws(() => createCard('shadow_card'), /Invalid card type/);
});

test('malformed project-schema bytes fail closed', () => {
  assert.throws(() => parseProjectSchemaAuthority('{not-json'), SyntaxError);
});

test('a missing card-type enum fails closed', () => {
  const bytes = schemaBytes((schema) => {
    delete schema.properties.cards.items.properties.type.enum;
  });
  assert.throws(() => parseProjectSchemaAuthority(bytes), /exactly 16 card types/);
});

test('a truncated or expanded card-type enum fails closed', () => {
  const truncated = schemaBytes((schema) => {
    schema.properties.cards.items.properties.type.enum.pop();
  });
  const expanded = schemaBytes((schema) => {
    schema.properties.cards.items.properties.type.enum.push('shadow_card');
  });
  assert.throws(() => parseProjectSchemaAuthority(truncated), /exactly 16 card types/);
  assert.throws(() => parseProjectSchemaAuthority(expanded), /exactly 16 card types/);
});

test('duplicate or non-string card-type declarations fail closed', () => {
  const duplicate = schemaBytes((schema) => {
    schema.properties.cards.items.properties.type.enum[15] =
      schema.properties.cards.items.properties.type.enum[0];
  });
  const nonString = schemaBytes((schema) => {
    schema.properties.cards.items.properties.type.enum[15] = 17;
  });
  assert.throws(() => parseProjectSchemaAuthority(duplicate), /must be unique/);
  assert.throws(() => parseProjectSchemaAuthority(nonString), /non-empty strings/);
});
