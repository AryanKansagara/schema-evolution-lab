// Confluent Schema Registry validation parity tests for Avro, JSON Schema, and Protobuf:
// refuses what Confluent Schema Registry refuses and warns (instead of refusing) where
// Confluent's underlying parsers accept spec-violating constructs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { analyze, detectFormat, importFile, parseVersion } from './compat.ts'
import { SAMPLES } from './samples.ts'
import { MODES } from './types.ts'

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

const avroRec = (fields: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'record', name: 'R', namespace: 'com.acme', fields, ...extra })

test('existing registry samples keep their exact verdicts and emit no spurious warnings', () => {
  for (const s of SAMPLES) {
    const a = analyze(s.subject)
    for (let k = 0; k < s.subject.versions.length; k++) {
      const p = a.parsed[k]
      assert.ok(p.ok, `${s.key} v${k + 1} should parse: ${!p.ok ? p.error : ''}`)
      assert.deepEqual(p.warnings, [], `${s.key} v${k + 1} should have no warnings`)
      for (const m of MODES) {
        assert.notEqual(a.verdict(k, m), 'invalid', `${s.key} v${k + 1} ${m}`)
      }
    }
  }
})

test('existing fixture suite files parse cleanly with zero warnings', () => {
  for (const name of ['user.avsc', 'interop.avsc', 'money.proto', 'cloudevents.json']) {
    const text = fixture(name)
    const format = detectFormat(name, text)
    const p = parseVersion(format, text)
    assert.ok(p.ok, `${name} failed: ${!p.ok ? p.error : ''}`)
    assert.deepEqual(p.warnings, [], `${name} produced unexpected warnings: ${p.warnings.join('; ')}`)
  }
  const exported = importFile('shipments-value.json', fixture('registry-export.json'))
  for (const v of exported) {
    const p = parseVersion(v.format, v.text)
    assert.ok(p.ok, `${v.name} failed`)
    assert.deepEqual(p.warnings, [], `${v.name} produced unexpected warnings`)
  }
})

test('avro: refuses strict NameValidator violations, invalid field metadata, and unbuildable cycles', () => {
  const bad = [
    // NameValidator.STRICT_VALIDATOR
    avroRec([{ name: 'a', type: 'string' }], { name: '1Bad' }),
    avroRec([{ name: 'a', type: 'string' }], { name: 'bad-name' }),
    avroRec([{ name: 'a', type: 'string' }], { namespace: '123.bad' }),
    avroRec([{ name: 'a', type: 'string' }], { namespace: 'a..b' }),
    JSON.stringify({ type: 'record', name: 'string', fields: [{ name: 'a', type: 'int' }] }),
    avroRec([{ name: '1field', type: 'string' }]),
    avroRec([{ name: 'a', type: 'string', aliases: ['1bad'] }]),
    avroRec([{ name: 'a', type: { type: 'enum', name: 'E', symbols: ['1SYM'] } }]),
    // Invalid structural properties
    avroRec([{ name: 'a', type: 'string', order: 'random' }]),
    avroRec([{ name: 'a', type: { type: 'fixed', name: 'F', size: -1 } }]),
    avroRec([{ name: 'a', type: { type: 'fixed', name: 'F', size: 1.5 } }]),
    avroRec([{ name: 'a', type: { type: 'array' } }]),
    avroRec([{ name: 'a', type: { type: 'map' } }]),
    // AvroSchema.validate(false) / buildableRecords
    JSON.stringify({ type: 'enum', name: 'Empty', symbols: [] }),
    JSON.stringify([]),
    JSON.stringify({ type: 'record', name: 'Cycle', fields: [{ name: 'self', type: 'Cycle' }] }),
    JSON.stringify({
      type: 'record',
      name: 'PairA',
      fields: [{ name: 'b', type: { type: 'record', name: 'PairB', fields: [{ name: 'a', type: 'PairA' }] } }],
    }),
  ]
  for (const text of bad) {
    const p = parseVersion('AVRO', text)
    assert.equal(p.ok, false, `Expected Avro refusal for ${text}`)
  }

  // Valid recursive types remain accepted
  const tree = JSON.stringify({
    type: 'record',
    name: 'Node',
    fields: [{ name: 'children', type: { type: 'array', items: 'Node' } }, { name: 'next', type: ['null', 'Node'] }],
  })
  assert.equal(parseVersion('AVRO', tree).ok, true)
})

test('avro: refuses mismatched defaults while warning on union non-first-branch and non-fatal spec quirks', () => {
  // Refused defaults (Schema.Parser.setValidateDefaults(true))
  const badDefaults = [
    avroRec([{ name: 'n', type: 'int', default: 'not-int' }]),
    avroRec([{ name: 'n', type: 'int', default: 2147483648 }]),
    avroRec([{ name: 'f', type: 'float', default: 'nan' }]),
    avroRec([{ name: 'b', type: 'boolean', default: 1 }]),
    avroRec([{ name: 's', type: 'null', default: 'null' }]),
    avroRec([{ name: 'arr', type: { type: 'array', items: 'int' }, default: ['x'] }]),
    avroRec([{ name: 'u', type: ['null', 'string'], default: 123 }]),
    avroRec([{ name: 'e', type: { type: 'enum', name: 'E', symbols: ['A', 'B'] }, default: 'C' }]),
  ]
  for (const text of badDefaults) {
    const p = parseVersion('AVRO', text)
    assert.equal(p.ok, false, `Expected Avro default refusal for ${text}`)
  }

  // Accepted with warning: union default matches second branch (isValidDefault uses anyMatch in Avro)
  const uWarn = parseVersion('AVRO', avroRec([{ name: 'u', type: ['null', 'string'], default: 'hi' }]))
  assert.ok(uWarn.ok)
  assert.match(uWarn.warnings[0], /FIRST branch/)

  // Accepted with warning: empty enum inside buildable union, invalid logicalType, field-level logicalType, fixed default length
  const buildableEmptyEnum = parseVersion('AVRO', avroRec([{ name: 'u', type: ['null', { type: 'enum', name: 'EmptyE', symbols: [] }], default: null }]))
  assert.ok(buildableEmptyEnum.ok)
  assert.ok(buildableEmptyEnum.warnings.some((w) => /no symbols/i.test(w)))

  const badLogical = parseVersion('AVRO', avroRec([{ name: 'x', type: { type: 'string', logicalType: 'timestamp-millis' } }]))
  assert.ok(badLogical.ok)
  assert.ok(badLogical.warnings.some((w) => /logicalType/i.test(w)))

  const fieldLogical = parseVersion('AVRO', avroRec([{ name: 'x', type: 'long', logicalType: 'timestamp-millis' }]))
  assert.ok(fieldLogical.ok)
  assert.ok(fieldLogical.warnings.some((w) => /field object is ignored/i.test(w)))

  const fixedDefault = parseVersion('AVRO', avroRec([{ name: 'h', type: { type: 'fixed', name: 'Hash', size: 4 }, default: 'ab' }]))
  assert.ok(fixedDefault.ok)
  assert.ok(fixedDefault.warnings.some((w) => /fixed default length/i.test(w)))
})

test('json schema: refuses Confluent Everit/json-sKema keyword type errors and warns on accepted spec violations', () => {
  const refused = [
    '{"properties": 5}',
    '{"required": "id"}',
    '{"required": [1, 2]}',
    '{"additionalProperties": "yes"}',
    '{"items": 123}',
    '{"allOf": {"type": "string"}}',
    '{"anyOf": "string"}',
    '{"oneOf": [123]}',
    '{"not": "string"}',
    '{"definitions": []}',
    '{"$defs": 5}',
    '{"dependencies": {"a": [1]}}',
    '{"dependentRequired": {"a": "b"}}',
    '{"dependentSchemas": {"a": 5}}',
    '{"patternProperties": {"[invalid": {"type": "string"}}}',
    '{"type": "uuid"}',
    '{"type": ["string", 5]}',
    '{"type": "string", "minLength": 1.5}',
    '{"type": "string", "maxLength": "ten"}',
    '{"type": "number", "minimum": "0"}',
    '{"type": "string", "pattern": "[unclosed"}',
    '{"type": "array", "uniqueItems": "true"}',
    '{"title": 42}',
    '{"$schema": 7}',
    '{"enum": "a"}',
    // Default dialect in Confluent is draft-07, where exclusiveMinimum must be a number
    '{"type": "number", "exclusiveMinimum": true}',
    // Explicit draft-04 expects boolean exclusiveMinimum
    '{"$schema": "http://json-schema.org/draft-04/schema#", "type": "number", "exclusiveMinimum": 5}',
    // 2020-12 forbids array items alongside prefixItems
    '{"$schema": "https://json-schema.org/draft/2020-12/schema", "type": "array", "prefixItems": [{"type": "string"}], "items": [{"type": "number"}]}',
    // Cyclic $ref
    '{"$ref": "#/definitions/a", "definitions": {"a": {"$ref": "#/definitions/a"}}}',
  ]
  for (const text of refused) {
    const p = parseVersion('JSON', text)
    assert.equal(p.ok, false, `Expected JSON Schema refusal for ${text}`)
  }

  // Valid draft-04 boolean exclusiveMinimum and instance data in default/examples must pass without error
  const d4 = parseVersion('JSON', '{"$schema": "http://json-schema.org/draft-04/schema#", "type": "number", "minimum": 0, "exclusiveMinimum": true}')
  assert.ok(d4.ok)
  assert.deepEqual(d4.warnings, [])

  const withExamples = parseVersion('JSON', '{"type": "object", "properties": {"a": {"type": "string"}}, "examples": [{"properties": 5, "required": "id"}]}')
  assert.ok(withExamples.ok)
  assert.deepEqual(withExamples.warnings, [])

  // Accepted by Confluent Everit/json-sKema but violate JSON Schema spec -> warn instead of refusing
  const warned: [string, RegExp][] = [
    ['{"type": "string", "minLength": -1}', /negative/i],
    ['{"type": "number", "multipleOf": 0}', /multipleOf/i],
    ['{"type": "string", "minLength": 10, "maxLength": 2}', /exceeds/i],
    ['{"type": "number", "minimum": 10, "maximum": 5}', /exceeds/i],
    ['{"enum": []}', /Empty "enum"/],
    ['{"enum": [{"a": 1, "b": 2}, {"b": 2, "a": 1}]}', /Duplicate values in "enum"/],
    ['{"allOf": []}', /Empty "allOf"/],
    ['{"type": []}', /Empty "type"/],
    ['{"type": ["string", "string"]}', /Duplicate entries in "type"/],
    ['{"type": "object", "required": ["id", "id"]}', /Duplicate entries in "required"/],
    ['{"$schema": "https://example.com/custom-schema", "type": "string"}', /Unrecognized \$schema/],
  ]
  for (const [text, pattern] of warned) {
    const p = parseVersion('JSON', text)
    assert.ok(p.ok, `Expected JSON Schema to parse with warning: ${text} (${!p.ok ? p.error : ''})`)
    assert.ok(p.warnings.some((w) => pattern.test(w)), `Expected warning matching ${pattern} for ${text}, got: ${p.warnings.join('; ')}`)
  }
})

test('protobuf: refuses Wire ProtoParser syntax errors and warns on protoc/validate.fields violations', () => {
  const refused = [
    'edition = "2023"; message M { string a = 1; }',
    'syntax = proto3; message M { string a = 1; }',
    'syntax = "proto4"; message M { string a = 1; }',
    'message M { string a = 1; }\nsyntax = "proto3";',
    'syntax = "proto3";\nsyntax = "proto3";\nmessage M { string a = 1; }',
    'syntax = "proto3"; package a..b; message M { string a = 1; }',
    'syntax = "proto3"; package a; package b; message M { string a = 1; }',
    'syntax = "proto3"; message 1Bad { string a = 1; }',
    'syntax = "proto3"; message M { string a = 1; }\nmessage M { string b = 2; }',
    'syntax = "proto3"; message M { required string a = 1; }',
    'syntax = "proto2"; message M { string a = 1; }',
    'syntax = "proto3"; message M { optional map<string, string> m = 1; }',
    'syntax = "proto3"; message M { oneof o { optional string a = 1; } }',
    'syntax = "proto3"; message M { oneof o { map<string, string> m = 1; } }',
    'syntax = "proto3"; message M { string a = 1.5; }',
    'syntax = "proto3"; message M { string a = 2147483648; }',
    'syntax = "proto3"; enum 1E { A = 0; }',
    'syntax = "proto3"; enum E { 1A = 0; }',
  ]
  for (const text of refused) {
    const p = parseVersion('PROTOBUF', text)
    assert.equal(p.ok, false, `Expected Protobuf refusal for:\n${text}`)
  }

  // Accepted by Confluent ProtobufSchema.validate(false) (schema.validate.fields=false by default) -> warn instead of refusing
  const warned: [string, RegExp][] = [
    ['syntax = "proto3"; message M { string bad = 0; }', /invalid\/reserved tag 0/i],
    ['syntax = "proto3"; message M { string bad = -1; }', /invalid\/reserved tag -1/i],
    ['syntax = "proto3"; message M { string bad = 19500; }', /19500/],
    ['syntax = "proto3"; message M { string bad = 536870912; }', /536870912/],
    ['syntax = "proto3"; message M { string dup = 1; int32 dup = 2; }', /duplicate field name "dup"/i],
    ['syntax = "proto3"; message M { reserved 5; string a = 5; }', /reserved field number 5/i],
    ['syntax = "proto3"; message M { reserved "old"; string old = 1; }', /reserved field name "old"/i],
    ['syntax = "proto3"; message M { map<float, string> m = 1; }', /Map key type "float"/],
    ['syntax = "proto3"; enum Status { ACTIVE = 1; }', /proto3 requires 0/i],
    ['syntax = "proto3"; enum Empty {}', /has no values/i],
    ['syntax = "proto3"; enum Dup { A = 0; B = 0; }', /without option allow_alias = true/i],
    ['syntax = "proto3"; message M { oneof empty {} }', /has no fields/i],
    ['syntax = "proto3"; message M { message N {} enum N { X = 0; } }', /duplicate nested type "N"/i],
    ['syntax = "proto3"; enum E1 { X = 0; } enum E2 { X = 0; }', /conflicts with sibling enum/i],
  ]
  for (const [text, pattern] of warned) {
    const p = parseVersion('PROTOBUF', text)
    assert.ok(p.ok, `Expected Protobuf to parse with warning:\n${text}\nGot error: ${!p.ok ? p.error : ''}`)
    assert.ok(p.warnings.some((w) => pattern.test(w)), `Expected warning matching ${pattern} for:\n${text}\nGot: ${p.warnings.join('; ')}`)
  }

  // allow_alias = true suppresses duplicate enum number warning
  const aliasOk = parseVersion('PROTOBUF', 'syntax = "proto3"; enum Alias { option allow_alias = true; A = 0; B = 0; }')
  assert.ok(aliasOk.ok)
  assert.deepEqual(aliasOk.warnings, [])
})
