import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { makeBundle, makeFindings, temporary } from './pr-review/test-helpers.mjs';

function resolveReference(root, reference) {
  assert.match(reference, /^#\//);
  return reference.slice(2).split('/').reduce((value, key) => value[key.replaceAll('~1', '/').replaceAll('~0', '~')], root);
}

function validate(schema, value, root, location = '$') {
  if (schema.$ref) return validate(resolveReference(root, schema.$ref), value, root, location);
  if (schema.const !== undefined) assert.deepEqual(value, schema.const, `${location} const`);
  if (schema.enum) assert.ok(schema.enum.includes(value), `${location} enum`);
  if (schema.type === 'object') assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${location} object`);
  if (schema.type === 'array') assert.ok(Array.isArray(value), `${location} array`);
  if (schema.type === 'string') assert.equal(typeof value, 'string', `${location} string`);
  if (schema.type === 'integer') assert.ok(Number.isInteger(value), `${location} integer`);
  if (schema.type === 'boolean') assert.equal(typeof value, 'boolean', `${location} boolean`);
  if (typeof value === 'string') {
    if (schema.minLength !== undefined) assert.ok(value.length >= schema.minLength, `${location} minLength`);
    if (schema.maxLength !== undefined) assert.ok(value.length <= schema.maxLength, `${location} maxLength`);
    if (schema.pattern) assert.match(value, new RegExp(schema.pattern), `${location} pattern`);
    if (schema.format === 'uri') assert.doesNotThrow(() => new URL(value), `${location} uri`);
    if (schema.format === 'date-time') assert.ok(!Number.isNaN(Date.parse(value)), `${location} date-time`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined) assert.ok(value >= schema.minimum, `${location} minimum`);
    if (schema.maximum !== undefined) assert.ok(value <= schema.maximum, `${location} maximum`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined) assert.ok(value.length >= schema.minItems, `${location} minItems`);
    if (schema.maxItems !== undefined) assert.ok(value.length <= schema.maxItems, `${location} maxItems`);
    if (schema.uniqueItems) {
      assert.ok(value.every((item, index) => !value.slice(0, index).some((other) => isDeepStrictEqual(item, other))), `${location} uniqueItems`);
    }
    if (schema.items) value.forEach((item, index) => validate(schema.items, item, root, `${location}[${index}]`));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (schema.required) schema.required.forEach((key) => assert.ok(Object.hasOwn(value, key), `${location}.${key} required`));
    for (const [key, dependencies] of Object.entries(schema.dependentRequired ?? {})) {
      if (Object.hasOwn(value, key)) dependencies.forEach((dependency) => assert.ok(Object.hasOwn(value, dependency), `${location}.${dependency} required`));
    }
    if (schema.minProperties !== undefined) assert.ok(Object.keys(value).length >= schema.minProperties, `${location} minProperties`);
    for (const [key, item] of Object.entries(value)) {
      if (schema.propertyNames) validate(schema.propertyNames, key, root, `${location} key`);
      if (schema.properties?.[key]) validate(schema.properties[key], item, root, `${location}.${key}`);
      else if (schema.additionalProperties === false) assert.fail(`${location}.${key} additional property`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') validate(schema.additionalProperties, item, root, `${location}.${key}`);
    }
  }
  if (schema.not) assert.throws(() => validate(schema.not, value, root, location), `${location} not`);
  if (schema.anyOf) {
    assert.ok(schema.anyOf.some((rule) => {
      try {
        validate(rule, value, root, location);
        return true;
      } catch {
        return false;
      }
    }), `${location} anyOf`);
  }
  for (const rule of schema.allOf ?? []) validate(rule, value, root, location);
  if (schema.if) validateConditional(schema, value, root, location);
}

function validateConditional(rule, value, root, location) {
  if (!rule.if) return validate(rule, value, root, location);
  let matches = true;
  try { validate(rule.if, value, root, location); } catch { matches = false; }
  if (matches && rule.then) validate(rule.then, value, root, location);
  if (!matches && rule.else) validate(rule.else, value, root, location);
}

test('generated bundle and findings validate against canonical schemas', async (t) => {
  const schemaDirectory = process.env.PR_REVIEW_SCHEMA_DIR;
  if (!schemaDirectory) {
    if (process.env.PR_REVIEW_REQUIRE_SCHEMAS === '1') assert.fail('PR_REVIEW_SCHEMA_DIR is required');
    return t.skip('PR_REVIEW_SCHEMA_DIR is not configured');
  }
  const root = await temporary();
  const bundle = await makeBundle(root);
  const findingsPath = await makeFindings(root, bundle);
  const schemas = {};
  const documents = {};
  for (const [schemaName, documentPath] of [
    ['bundle', path.join(bundle.root, 'manifest.json')],
    ['findings', findingsPath],
  ]) {
    const schema = JSON.parse(await readFile(path.join(schemaDirectory, `pr-review-${schemaName}.v1.schema.json`)));
    const document = JSON.parse(await readFile(documentPath));
    schemas[schemaName] = schema;
    documents[schemaName] = document;
    validate(schema, document, schema);
  }

  const oversizedArtifact = structuredClone(documents.bundle);
  oversizedArtifact.artifacts[0].bytes = 8388609;
  assert.throws(() => validate(schemas.bundle, oversizedArtifact, schemas.bundle), /maximum/);

  const missingInlineField = structuredClone(documents.findings);
  delete missingInlineField.findings[0].diffSide;
  assert.throws(() => validate(schemas.findings, missingInlineField, schemas.findings), /required/);

  const fileLevelFinding = structuredClone(documents.findings);
  delete fileLevelFinding.findings[0].line;
  delete fileLevelFinding.findings[0].diffSide;
  assert.doesNotThrow(() => validate(schemas.findings, fileLevelFinding, schemas.findings));

  const orphanedInlineField = structuredClone(documents.findings);
  delete orphanedInlineField.findings[0].filePath;
  assert.throws(() => validate(schemas.findings, orphanedInlineField, schemas.findings), /required/);
});
