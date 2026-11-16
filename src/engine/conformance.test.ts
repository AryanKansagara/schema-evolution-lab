// Cases written for this project that pin the engine to the registry's documented diff behaviour,
// plus real schema files (see fixtures/SOURCES.md) run through the parsers.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { analyze, applyFix, checkPair, detectFormat, importFile, parseVersion } from './compat.ts'
import { checkAvro, parseAvro } from './avro.ts'
import { checkJsonSchema } from './jsonschema.ts'
import { checkProto, parseProto } from './protobuf.ts'
import { simulate } from './simulate.ts'

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
/** Differences from `original` to `update`, as "TYPE path", the way the registry's diff tests list them. */
const diff = (original: unknown, update: unknown, policy?: 'STRICT' | 'LENIENT') => {
  const issues = checkJsonSchema(update, original, 'reader', policy)
  return { list: issues.map((i) => `${i.type} ${i.path}`).sort(), compatible: issues.every((i) => i.compatible), issues }
}

test('json: paths are rooted at #/ and annotation changes on an untyped schema are reported', () => {
  assert.deepEqual(diff({ type: 'string' }, { type: 'number' }).list, ['TYPE_CHANGED #/'])
  const d = diff({ title: 'a', description: 'x' }, { title: 'b', description: 'y', $id: 'urn:z' })
  assert.deepEqual(d.list, ['DESCRIPTION_CHANGED #/', 'ID_CHANGED #/', 'TITLE_CHANGED #/'])
  assert.equal(d.compatible, true)
})

test('json: a type next to an enum is a product type, so dropping the enum is compatible and adding one is not', () => {
  const drop = diff({ type: 'string', enum: ['red'] }, { type: 'string' })
  assert.deepEqual(drop.list, ['PRODUCT_TYPE_NARROWED #/'])
  assert.equal(drop.compatible, true)
  const addEnum = diff({ type: 'string' }, { type: 'string', enum: ['red'] })
  assert.deepEqual(addEnum.list, ['TYPE_CHANGED #/'])
  assert.equal(addEnum.compatible, false)
  const widen = diff({ type: 'object', properties: { c: { type: 'string', enum: ['a'] } } }, { type: 'object', properties: { c: { type: 'string', enum: ['a', 'b'] } } })
  assert.deepEqual(widen.list, ['ENUM_ARRAY_EXTENDED #/properties/c/allOf/1/enum'])
  assert.equal(diff({ type: 'string', enum: ['a', 'b'] }, { type: 'string', enum: ['a'] }).compatible, false)
})

test('json: an object schema that also has oneOf keeps its properties in the comparison', () => {
  const base = { type: 'object', properties: { a: { type: 'string' } }, oneOf: [{ required: ['a'] }, { required: ['b'] }] }
  const changed = { ...base, properties: { a: { type: 'integer' } } }
  const d = diff(base, changed)
  assert.equal(d.compatible, false)
  assert.ok(d.list.includes('COMBINED_TYPE_SUBSCHEMAS_CHANGED #/'), d.list.join())
  assert.deepEqual(diff(base, structuredClone(base)).list, [])
})

test('json: const, not and required report the paths the registry uses', () => {
  assert.deepEqual(diff({ properties: { f: { const: 1 } } }, { properties: { f: { const: 2 } } }).list, ['ENUM_ARRAY_CHANGED #/properties/f/const'])
  assert.deepEqual(diff({ not: { type: 'number' } }, { not: { type: 'integer' } }).list, ['NOT_TYPE_NARROWED #/not'])
  const wider = diff({ not: { type: 'integer' } }, { not: { type: 'number' } })
  assert.deepEqual(wider.list, ['NOT_TYPE_EXTENDED #/not'])
  assert.equal(wider.compatible, false)
  const req = diff({ properties: { foo: { type: 'string' } } }, { properties: { foo: { type: 'string' } }, required: ['foo'] })
  assert.deepEqual(req.list, ['REQUIRED_ATTRIBUTE_ADDED #/required/foo'])
})

test('json: a difference behind a $ref is reported where it is used, and its fix edits the definition', () => {
  const schema = (t: string) => ({ type: 'array', items: { $ref: '#/definitions/thing' }, definitions: { thing: { type: t } } })
  const d = diff(schema('string'), schema('number'))
  assert.deepEqual(d.list, ['TYPE_CHANGED #/items'])
  const fixed = JSON.parse(applyFix(JSON.stringify(schema('number')), d.issues[0].fix!))
  assert.deepEqual(diff(schema('string'), fixed).compatible, true)
  assert.ok(Array.isArray(fixed.definitions.thing.type) && fixed.definitions.thing.type.includes('string'))
})

test('json: adding or removing an items schema', () => {
  const added = diff({ type: 'array' }, { type: 'array', items: { type: 'string' } })
  assert.deepEqual(added.list, ['SCHEMA_ADDED #/items'])
  assert.equal(added.compatible, false)
  const removed = diff({ type: 'array', items: { type: 'string' } }, { type: 'array' })
  assert.deepEqual(removed.list, ['SCHEMA_REMOVED #/items'])
  assert.equal(removed.compatible, true)
})

test('json: tuple items follow the open / partially open / closed content model rules', () => {
  const tuple = (items: unknown[], additionalItems?: unknown) => ({ type: 'array', items, ...(additionalItems === undefined ? {} : { additionalItems }) })
  const s = { type: 'string' }, n = { type: 'number' }
  // open: removing is fine, adding a typed item is not
  assert.deepEqual(diff(tuple([s, n]), { type: 'array' }).list, ['ITEM_REMOVED_FROM_OPEN_CONTENT_MODEL #/items/0', 'ITEM_REMOVED_FROM_OPEN_CONTENT_MODEL #/items/1'])
  assert.equal(diff(tuple([s]), tuple([s, n])).compatible, false)
  assert.deepEqual(diff(tuple([s]), tuple([s, {}])).list, ['ITEM_WITH_EMPTY_SCHEMA_ADDED_TO_OPEN_CONTENT_MODEL #/items/1'])
  // partially open: the additionalItems schema decides
  assert.deepEqual(diff(tuple([s, n], s), tuple([s, n, s], s)).list, ['ITEM_ADDED_IS_COVERED_BY_PARTIALLY_OPEN_CONTENT_MODEL #/items/2'])
  const notCovered = diff(tuple([s, n], s), tuple([s, n, n], s))
  assert.deepEqual(notCovered.list, ['ITEM_ADDED_NOT_COVERED_BY_PARTIALLY_OPEN_CONTENT_MODEL #/items/2', 'TYPE_CHANGED #/items/2'])
  assert.equal(notCovered.compatible, false)
  assert.equal(diff(tuple([s, n, s], s), tuple([s, n], s)).compatible, true)
  // closed: adding is fine, removing is not unless the item was `false`
  assert.deepEqual(diff(tuple([s], false), tuple([s, n], false)).list, ['ITEM_ADDED_TO_CLOSED_CONTENT_MODEL #/items/1'])
  assert.deepEqual(diff(tuple([s, n], false), tuple([s], false)).list, ['ITEM_REMOVED_FROM_CLOSED_CONTENT_MODEL #/items/1'])
  assert.deepEqual(diff(tuple([s, false], false), tuple([s], false)).list, ['ITEM_WITH_FALSE_REMOVED_FROM_CLOSED_CONTENT_MODEL #/items/1'])
  // additionalItems itself
  assert.deepEqual(diff(tuple([s]), tuple([s], false)).list, ['ADDITIONAL_ITEMS_REMOVED #/additionalItems'])
  assert.deepEqual(diff(tuple([s], s), tuple([s], n)).list, ['TYPE_CHANGED #/additionalItems'])
  // 2020-12 spelling of the same tuple
  assert.deepEqual(diff({ type: 'array', prefixItems: [s], items: false }, { type: 'array', prefixItems: [s, n], items: false }).list, ['ITEM_ADDED_TO_CLOSED_CONTENT_MODEL #/items/1'])
})

test('json: the fix for a removed tuple item restores it', () => {
  const before = { type: 'array', items: [{ type: 'string' }, { type: 'number' }], additionalItems: false }
  const after = { type: 'array', items: [{ type: 'string' }], additionalItems: false }
  const [issue] = diff(before, after).issues
  assert.deepEqual(JSON.parse(applyFix(JSON.stringify(after), issue.fix!)), before)
})

test('json: dependencies in both spellings', () => {
  const dep = (dependencies: unknown) => ({ type: 'object', dependencies })
  const moved = diff(dep({ foo: ['bar'] }), dep({ bar: ['foo'] }))
  assert.deepEqual(moved.list, ['DEPENDENCY_ARRAY_ADDED #/dependencies/bar', 'DEPENDENCY_ARRAY_REMOVED #/dependencies/foo'])
  assert.equal(moved.compatible, false)
  assert.equal(diff(dep({ foo: ['a', 'b'] }), dep({ foo: ['a'] })).compatible, true)
  assert.deepEqual(diff(dep({ foo: ['a'] }), dep({ foo: ['a', 'b'] })).list, ['DEPENDENCY_ARRAY_EXTENDED #/dependencies/foo'])
  assert.deepEqual(diff(dep({ foo: { type: 'string' } }), dep({ foo: { type: 'number' } })).list, ['TYPE_CHANGED #/dependencies/foo'])
  assert.deepEqual(diff(dep({ foo: { type: 'string' } }), dep({})).list, ['DEPENDENCY_SCHEMA_REMOVED #/dependencies/foo'])
  const modern = diff({ type: 'object', dependentRequired: { card: ['cvv'] } }, { type: 'object', dependentRequired: { card: ['cvv', 'zip'] } })
  assert.deepEqual(modern.list, ['DEPENDENCY_ARRAY_EXTENDED #/dependencies/card'])
  const after = { type: 'object', dependentRequired: { card: ['cvv', 'zip'] } }
  assert.deepEqual(JSON.parse(applyFix(JSON.stringify(after), modern.issues[0].fix!)), { type: 'object', dependentRequired: { card: ['cvv'] } })
})

test('json: unevaluatedProperties closes or opens the content model', () => {
  const closed = diff({ type: 'object' }, { type: 'object', unevaluatedProperties: false })
  assert.deepEqual(closed.list, ['UNEVALUATED_PROPERTIES_REMOVED #/unevaluatedProperties'])
  assert.equal(closed.compatible, false)
  assert.equal(diff({ type: 'object' }, { type: 'object', unevaluatedProperties: false }, 'LENIENT').compatible, true)
  assert.equal(diff({ type: 'object', unevaluatedProperties: false }, { type: 'object' }).compatible, true)
  // with unevaluatedProperties:false the model is closed, so a new optional property is compatible
  const base = { type: 'object', unevaluatedProperties: false, properties: { a: { type: 'string' } } }
  const d = diff(base, { ...base, properties: { ...base.properties, b: { type: 'string' } } })
  assert.deepEqual(d.list, ['OPTIONAL_PROPERTY_ADDED_TO_UNOPEN_CONTENT_MODEL #/properties/b'])
})

test('json: a property added under a matching additionalProperties schema lists what differs', () => {
  const before = { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: { type: 'integer' } }
  const after = { ...before, properties: { ...before.properties, n: { type: 'number' } } }
  const d = diff(before, after)
  assert.deepEqual(d.list, ['OPTIONAL_PROPERTY_ADDED_TO_UNOPEN_CONTENT_MODEL #/properties/n', 'PROPERTY_ADDED_IS_COVERED_BY_PARTIALLY_OPEN_CONTENT_MODEL #/properties/n', 'TYPE_EXTENDED #/properties/n'])
  assert.equal(d.compatible, true)
})

test('json: a nullable type array is a sum type on both sides', () => {
  const d = diff({ type: 'object', properties: { a: { type: 'string' } } }, { type: 'object', properties: { a: { type: ['string', 'null'] } } })
  assert.deepEqual(d.list, ['SUM_TYPE_EXTENDED #/properties/a'])
  const back = diff({ type: 'object', properties: { a: { type: ['string', 'null'] } } }, { type: 'object', properties: { a: { type: 'string' } } })
  assert.equal(back.compatible, false)
  const longer = diff({ type: ['string', 'null'], maxLength: 5 }, { type: ['string', 'null'], maxLength: 9 })
  assert.deepEqual(longer.list, ['MAX_LENGTH_INCREASED #/anyOf/0/maxLength'])
})

test('json: an unchanged oneOf branch is paired with itself', () => {
  const branch = (n: string) => ({ type: 'object', properties: { kind: { const: n } }, not: { required: [n] } })
  const s = { oneOf: [branch('a'), branch('b'), branch('c')] }
  assert.deepEqual(diff(s, structuredClone(s)).list, [])
})

test('protobuf: nested messages are path segments', () => {
  const p = (extra: string) => parseProto(`syntax = "proto3";\nmessage Wrapper {\n  message Inner {\n    string a = 1;\n${extra}  }\n  Inner inner = 1;\n}\n`)
  const issues = checkProto(p('    int32 b = 2;\n'), p(''), 'reader')
  assert.deepEqual(issues.map((i) => `${i.type} ${i.path}`), ['FIELD_ADDED #/Wrapper/Inner/2'])
})

test('avro: a reader enum with a default tolerates unknown writer symbols', () => {
  const en = (symbols: string[], extra = {}) => parseAvro(JSON.stringify({ type: 'enum', name: 'Suit', symbols, ...extra }))
  assert.deepEqual(checkAvro(en(['HEARTS'], { default: 'HEARTS' }), en(['HEARTS', 'SPADES']), 'reader'), [])
  assert.deepEqual(checkAvro(en(['HEARTS']), en(['HEARTS', 'SPADES']), 'reader').map((i) => i.type), ['MISSING_ENUM_SYMBOLS'])
  assert.throws(() => en(['HEARTS'], { default: 'CLUBS' }), /not a symbol/)
})

test('real files parse, are compatible with themselves, and round-trip through the Avro simulation', () => {
  for (const name of ['user.avsc', 'interop.avsc', 'money.proto', 'cloudevents.json']) {
    const text = fixture(name)
    const format = detectFormat(name, text)
    const p = parseVersion(format, text)
    assert.ok(p.ok, `${name}: ${!p.ok && p.error}`)
    assert.deepEqual(checkPair(format, p.schema, p.schema, 'reader'), [], name)
    if (format === 'AVRO') assert.equal(simulate(p.schema as any, p.schema as any).ok, true, name)
  }
  assert.equal(detectFormat('interop.avsc', fixture('interop.avsc')), 'AVRO')
  assert.equal(detectFormat('money.proto', fixture('money.proto')), 'PROTOBUF')
  assert.equal(detectFormat('cloudevents.json', fixture('cloudevents.json')), 'JSON')
  // a doc string that starts a line with "message" must not turn an Avro file into Protobuf
  assert.equal(detectFormat('pasted', '{"type":"record","name":"R","doc":"\\nmessage Foo is here","fields":[]}'), 'AVRO')
})

test('real evolution: adding a field to the Avro interop record', () => {
  const v1 = JSON.parse(fixture('interop.avsc'))
  const v2 = { ...v1, fields: [...v1.fields, { name: 'traceId', type: 'string' }] }
  const [issue] = checkAvro(parseAvro(JSON.stringify(v2)), parseAvro(JSON.stringify(v1)), 'reader')
  assert.equal(issue.type, 'READER_FIELD_MISSING_DEFAULT_VALUE')
  const fixed = applyFix(JSON.stringify(v2), issue.fix!)
  assert.deepEqual(checkAvro(parseAvro(fixed), parseAvro(JSON.stringify(v1)), 'reader'), [])
})

test('import: a registry API export becomes an ordered subject', () => {
  const versions = importFile('shipments-value.json', fixture('registry-export.json'))
  assert.deepEqual(versions.map((v) => [v.subject, v.version, v.format]), [['shipments-value', 1, 'JSON'], ['shipments-value', 2, 'JSON'], ['shipments-value', 3, 'JSON']])
  assert.match(versions[0].text, /^\{\n {2}"\$schema"/)
  const a = analyze({ format: 'JSON', policy: 'STRICT', versions: versions.map((v, i) => ({ id: String(i), text: v.text })) })
  assert.equal(a.verdict(1, 'BACKWARD'), 'pass') // enum widened, optional property added to a closed model
  assert.equal(a.verdict(1, 'FORWARD'), 'fail')
  assert.equal(a.verdict(2, 'BACKWARD'), 'fail') // number narrowed to integer and made required
  const types = (a.pair(2, 1) ?? []).filter((i) => !i.compatible).map((i) => i.type).sort()
  assert.deepEqual(types, ['REQUIRED_ATTRIBUTE_ADDED', 'TYPE_NARROWED'])
  assert.ok((a.pair(2, 1) ?? []).some((i) => i.type === 'PRODUCT_TYPE_NARROWED' && i.compatible))
})

test('import: single responses, Avro without schemaType, and plain files', () => {
  const avro = importFile('v1.json', JSON.stringify({ subject: 'test', version: 1, id: 1, schema: '"string"' }))
  assert.deepEqual(avro, [{ name: 'test v1', text: '"string"', format: 'AVRO', subject: 'test', version: 1 }])
  const proto = importFile('p.json', JSON.stringify({ subject: 'p', version: 4, id: 9, schemaType: 'PROTOBUF', schema: 'syntax = "proto3";\nmessage M { string a = 1; }\n' }))
  assert.equal(proto[0].format, 'PROTOBUF')
  assert.ok(parseVersion('PROTOBUF', proto[0].text).ok)
  // a JSON Schema that happens to describe a "schema" property is not an envelope
  const plain = importFile('s.json', '{"type":"object","properties":{"schema":{"type":"string"}}}')
  assert.equal(plain.length, 1)
  assert.equal(plain[0].format, 'JSON')
  assert.equal(plain[0].version, undefined)
  assert.equal(importFile('user.avsc', fixture('user.avsc'))[0].format, 'AVRO')
})
