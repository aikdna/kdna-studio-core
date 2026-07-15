'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PROJECT_SCHEMA_PATH = path.resolve(__dirname, '..', 'schemas', 'studio.project.schema.json');

function parseProjectSchemaAuthority(bytes) {
  const schemaBytes = Buffer.isBuffer(bytes) ? Buffer.from(bytes) : Buffer.from(String(bytes));
  const schema = JSON.parse(schemaBytes.toString('utf8'));
  const declaredCardTypes = schema?.properties?.cards?.items?.properties?.type?.enum;

  if (!Array.isArray(declaredCardTypes) || declaredCardTypes.length !== 16) {
    throw new Error('studio.project.schema.json must declare exactly 16 card types');
  }
  if (new Set(declaredCardTypes).size !== declaredCardTypes.length) {
    throw new Error('studio.project.schema.json card types must be unique');
  }
  if (declaredCardTypes.some((type) => typeof type !== 'string' || type.length === 0)) {
    throw new Error('studio.project.schema.json card types must be non-empty strings');
  }

  return Object.freeze({
    bytes: schemaBytes,
    schema,
    cardTypes: Object.freeze([...declaredCardTypes]),
  });
}

const authority = parseProjectSchemaAuthority(fs.readFileSync(PROJECT_SCHEMA_PATH));
const PROJECT_SCHEMA_BYTES = authority.bytes;
const PROJECT_SCHEMA = authority.schema;
const CARD_TYPES = authority.cardTypes;

module.exports = {
  CARD_TYPES,
  PROJECT_SCHEMA,
  PROJECT_SCHEMA_BYTES,
  PROJECT_SCHEMA_PATH,
  parseProjectSchemaAuthority,
};
