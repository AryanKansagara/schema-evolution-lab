import test from 'node:test'
import assert from 'node:assert/strict'
import { analyze, applyFix, breaking, checkPair, detectFormat, lineDiff, modePairs, parseVersion, transitionAdvice, explain, registryError } from './compat.ts'
import { checkAvro, parseAvro, SchemaParseError } from './avro.ts'
import { checkJsonSchema } from './jsonschema.ts'
import { checkProto, parseProto } from './protobuf.ts'
import { simulate, generate } from './simulate.ts'
import { SAMPLES } from './samples.ts'
import { decodeSubject, encodeSubject } from './share.ts'
import { MODES } from './types.ts'

const rec = (fields: unknown[], name = 'R') => parseAvro(JSON.stringify({ type: 'record', name, fields }))
const types = (i: { type: string; compatible: boolean }[]) => i.filter((x) => !x.compatible).map((x) => x.type)
const proto = (body: string, head = 'syntax = "proto3";\npackage a.b;\n') => parseProto(`${head}message M {\n${body}\n}\n`)
const pbad = (r: string, w: string) => types(checkProto(proto(r), proto(w), 'reader'))
const jbad = (r: object, w: object, policy?: 'STRICT' | 'LENIENT') => types(checkJsonSchema(r, w, 'reader', policy))

test('avro: new reader field without a default is READER_FIELD_MISSING_DEFAULT_VALUE, with the registry message', () => {
  const [i] = checkAvro(rec([{ name: 'a', type: 'int' }, { name: 'b', type: 'string' }]), rec([{ name: 'a', type: 'int' }]), 'reader')
  assert.equal(i.type, 'READER_FIELD_MISSING_DEFAULT_VALUE')
  assert.equal(i.path, '/fields/1')
  assert.equal(i.message, "The field 'b' at path '/fields/1' in the new schema has no default value and is missing in the old schema")
})

test('avro: a default on the reader field makes it compatible; removing a field is fine for the reader', () => {
  assert.deepEqual(checkAvro(rec([{ name: 'a', type: 'int' }, { name: 'b', type: 'string', default: 'x' }]), rec([{ name: 'a', type: 'int' }]), 'reader'), [])
  assert.deepEqual(checkAvro(rec([{ name: 'a', type: 'int' }]), rec([{ name: 'a', type: 'int' }, { name: 'b', type: 'int' }]), 'reader'), [])
})

test('avro: promotions go one way only', () => {
  const asInt = rec([{ name: 'a', type: 'int' }]), asLong = rec([{ name: 'a', type: 'long' }])
  assert.deepEqual(checkAvro(asLong, asInt, 'reader'), [])
  const [bad] = checkAvro(asInt, asLong, 'writer')
  assert.equal(bad.type, 'TYPE_MISMATCH')
  assert.equal(bad.path, '/fields/0/type')
  assert.equal(bad.info, 'reader type: INT not compatible with writer type: LONG')
  assert.deepEqual(checkAvro(rec([{ name: 'a', type: 'bytes' }]), rec([{ name: 'a', type: 'string' }]), 'reader'), [])
})

test('avro: union rules', () => {
  const nullable = rec([{ name: 'a', type: ['null', 'string'], default: null }])
  const plain = rec([{ name: 'a', type: 'string' }])
  assert.deepEqual(checkAvro(nullable, plain, 'reader'), [], 'reader union takes a plain writer')
  assert.deepEqual(types(checkAvro(plain, nullable, 'writer')), ['TYPE_MISMATCH'], 'null branch is unreadable')
  const issue = checkAvro(rec([{ name: 'a', type: ['null', 'int'], default: null }]), nullable, 'reader').find((x) => x.type === 'MISSING_UNION_BRANCH')
  assert.ok(issue)
  assert.equal(issue.path, '/fields/0/type/1')
})

test('avro: enums, enum defaults, fixed sizes and names', () => {
  const e = (symbols: string[], extra = {}) => rec([{ name: 'e', type: { type: 'enum', name: 'E', symbols, ...extra } }])
  const [m] = checkAvro(e(['A']), e(['A', 'B']), 'reader')
  assert.equal(m.type, 'MISSING_ENUM_SYMBOLS')
  assert.equal(m.info, '[B]')
  assert.deepEqual(checkAvro(e(['A'], { default: 'A' }), e(['A', 'B']), 'reader'), [])
  const fx = (size: number) => rec([{ name: 'f', type: { type: 'fixed', name: 'F', size } }])
  assert.deepEqual(types(checkAvro(fx(8), fx(16), 'reader')), ['FIXED_SIZE_MISMATCH'])
  assert.deepEqual(types(checkAvro(rec([], 'A'), rec([], 'B'), 'reader')), ['NAME_MISMATCH'])
  assert.deepEqual(checkAvro(parseAvro(JSON.stringify({ type: 'record', name: 'A', aliases: ['B'], fields: [] })), rec([], 'B'), 'reader'), [])
})

test('avro: nested and recursive records, field aliases', () => {
  const nested = (extra: object[]) => rec([{ name: 'n', type: { type: 'record', name: 'N', fields: [{ name: 'x', type: 'int' }, ...extra] } }])
  const [i] = checkAvro(nested([{ name: 'y', type: 'int' }]), nested([]), 'reader')
  assert.equal(i.path, '/fields/0/type/fields/1')
  assert.equal(i.field, 'R.n.y')
  const list = parseAvro(JSON.stringify({ type: 'record', name: 'L', fields: [{ name: 'next', type: ['null', 'L'], default: null }] }))
  assert.deepEqual(checkAvro(list, list, 'reader'), [])
  assert.deepEqual(checkAvro(rec([{ name: 'b', aliases: ['a'], type: 'int' }]), rec([{ name: 'a', type: 'int' }]), 'reader'), [])
})

test('avro: parser rejects bad schemas and warns on a union default that misses the first branch', () => {
  assert.throws(() => parseAvro('{nope'), SchemaParseError)
  assert.throws(() => parseAvro('{"type":"record","name":"R","fields":[{"name":"a","type":"Missing"}]}'), /Undefined name/)
  assert.throws(() => parseAvro('["int","int"]'), /Duplicate in union/)
  assert.match(rec([{ name: 'a', type: ['string', 'null'], default: null }]).warnings[0], /FIRST branch/)
})

test('simulate: defaults filled, fields dropped, values promoted', () => {
  const w = rec([{ name: 'id', type: 'string' }, { name: 'qty', type: 'int' }, { name: 'gone', type: 'string' }])
  const r = rec([{ name: 'id', type: 'string' }, { name: 'qty', type: 'double' }, { name: 'added', type: 'string', default: 'dflt' }, { name: 'opt', type: ['null', 'int'], default: null }])
  const s = simulate(r, w, { id: 'x', qty: 3, gone: 'bye' })
  assert.equal(s.ok, true)
  assert.deepEqual(s.read, { id: 'x', qty: 3, added: 'dflt', opt: null })
  assert.ok(s.notes.some((n) => n.kind === 'dropped' && n.path === 'R.gone'))
  assert.ok(s.notes.some((n) => n.kind === 'default' && n.path === 'R.added'))
  assert.ok(s.notes.some((n) => n.kind === 'promoted' && n.path === 'R.qty'))
})

test('simulate: missing default and unknown enum symbol fail; enum default resolves', () => {
  const bad = simulate(rec([{ name: 'x', type: 'int' }]), rec([]))
  assert.equal(bad.ok, false)
  const e = (symbols: string[], extra = {}) => rec([{ name: 'e', type: { type: 'enum', name: 'E', symbols, ...extra } }])
  assert.equal(simulate(e(['A']), e(['A', 'B']), { e: 'B' }).ok, false)
  assert.deepEqual(simulate(e(['A'], { default: 'A' }), e(['A', 'B']), { e: 'B' }).read, { e: 'A' })
})

test('simulate: generated records conform to every sample writer schema', () => {
  for (const v of SAMPLES[0].subject.versions) {
    const s = parseAvro(v.text)
    assert.deepEqual(simulate(s, s, generate(s.root)).notes.filter((n) => n.kind === 'error'), [])
  }
})

test('json: open content model makes an added optional property incompatible under STRICT, fine under LENIENT', () => {
  const r = { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } } }
  const w = { type: 'object', properties: { a: { type: 'string' } } }
  assert.deepEqual(jbad(r, w), ['OPTIONAL_PROPERTY_ADDED_TO_OPEN_CONTENT_MODEL'])
  assert.deepEqual(jbad(r, w, 'LENIENT'), [])
})

test('json: closed content model flips the rules', () => {
  const c = (properties: object, required: string[] = []) => ({ type: 'object', additionalProperties: false, properties, required })
  assert.deepEqual(jbad(c({ a: { type: 'string' }, b: { type: 'string' } }), c({ a: { type: 'string' } })), [])
  assert.deepEqual(jbad(c({ a: { type: 'string' }, b: { type: 'string' } }, ['b']), c({ a: { type: 'string' } })), ['REQUIRED_PROPERTY_ADDED_TO_UNOPEN_CONTENT_MODEL'])
  assert.deepEqual(jbad(c({ a: { type: 'string' }, b: { type: 'string', default: '' } }, ['b']), c({ a: { type: 'string' } })), [])
  assert.deepEqual(jbad(c({}), c({ a: { type: 'string' } })), ['PROPERTY_REMOVED_FROM_CLOSED_CONTENT_MODEL'])
})

test('json: required, types and sum types', () => {
  const o = (a: object, required: string[] = []) => ({ type: 'object', properties: { a }, required })
  assert.deepEqual(jbad(o({ type: 'string' }, ['a']), o({ type: 'string' })), ['REQUIRED_ATTRIBUTE_ADDED'])
  assert.deepEqual(jbad(o({ type: 'string', default: 'x' }, ['a']), o({ type: 'string', default: 'x' })), [])
  assert.deepEqual(jbad(o({ type: 'number' }), o({ type: 'string' })), ['TYPE_CHANGED'])
  assert.deepEqual(jbad(o({ type: 'number' }), o({ type: 'integer' })), [])
  assert.deepEqual(jbad(o({ type: 'integer' }), o({ type: 'number' })), ['TYPE_NARROWED'])
  assert.deepEqual(jbad(o({ type: ['string', 'null'] }), o({ type: 'string' })), [], 'making it nullable extends the sum type')
  assert.deepEqual(jbad(o({ type: 'string' }), o({ type: ['string', 'null'] })), ['TYPE_CHANGED'])
})

test('json: constraints, enums and $ref', () => {
  const s = (x: object) => ({ type: 'string', ...x })
  assert.deepEqual(jbad(s({ maxLength: 5 }), s({ maxLength: 10 })), ['MAX_LENGTH_DECREASED'])
  assert.deepEqual(jbad(s({ maxLength: 10 }), s({ maxLength: 5 })), [])
  assert.deepEqual(jbad(s({ minLength: 2 }), s({})), ['MIN_LENGTH_ADDED'])
  assert.deepEqual(jbad(s({ pattern: 'a' }), s({ pattern: 'b' })), ['PATTERN_CHANGED'])
  assert.deepEqual(jbad({ enum: ['a'] }, { enum: ['a', 'b'] }), ['ENUM_ARRAY_NARROWED'])
  assert.deepEqual(jbad({ enum: ['a', 'b'] }, { enum: ['a'] }), [])
  const ref = (t: string) => ({ type: 'object', properties: { x: { $ref: '#/definitions/D' } }, definitions: { D: { type: t } } })
  assert.deepEqual(jbad(ref('number'), ref('string')), ['TYPE_CHANGED'])
  assert.equal(parseVersion('JSON', '{"$ref":"#/nope"}').ok, false)
})

test('json: combined types use a matching over subschemas', () => {
  const one = (...t: string[]) => ({ oneOf: t.map((type) => ({ type })) })
  assert.deepEqual(jbad(one('string', 'null', 'number'), one('string', 'null')), [])
  assert.deepEqual(jbad(one('string'), one('string', 'null')), ['SUM_TYPE_NARROWED'])
  assert.deepEqual(jbad(one('number', 'boolean'), one('string', 'null')), ['COMBINED_TYPE_SUBSCHEMAS_CHANGED'])
})

test('proto: wire groups and field kinds', () => {
  assert.deepEqual(pbad('int64 a = 1;', 'int32 a = 1;'), [])
  assert.deepEqual(pbad('string a = 1;', 'bytes a = 1;'), [])
  assert.deepEqual(pbad('string a = 1;', 'int64 a = 1;'), ['FIELD_SCALAR_KIND_CHANGED'])
  assert.deepEqual(pbad('sint32 a = 1;', 'int32 a = 1;'), ['FIELD_SCALAR_KIND_CHANGED'])
  assert.deepEqual(pbad('message N {} N a = 1;', 'message N {} int32 a = 1;'), ['FIELD_KIND_CHANGED'])
  assert.deepEqual(pbad('map<string, string> a = 1;', 'string a = 1;'), ['FIELD_KIND_CHANGED'])
  assert.deepEqual(pbad('enum E { Z = 0; } E a = 1;', 'enum E { Z = 0; } int32 a = 1;'), [], 'an enum is wire-compatible with int32')
})

test('proto: renames, additions and removals are compatible; labels follow the registry', () => {
  assert.deepEqual(pbad('string b = 1;', 'string a = 1;'), [])
  assert.deepEqual(pbad('string a = 1; string b = 2;', 'string a = 1;'), [])
  assert.deepEqual(pbad('string a = 1;', 'string a = 1; string b = 2;'), [])
  assert.deepEqual(pbad('repeated string a = 1;', 'optional string a = 1;'), [])
  assert.deepEqual(pbad('repeated int32 a = 1;', 'optional int32 a = 1;'), ['FIELD_NUMERIC_LABEL_CHANGED'])
})

test('proto: required, oneof moves, package and message removal', () => {
  assert.deepEqual(pbad('required string a = 1;', ''), ['REQUIRED_FIELD_ADDED'])
  assert.deepEqual(pbad('', 'required string a = 1;'), ['REQUIRED_FIELD_REMOVED'])
  assert.deepEqual(pbad('oneof o { string a = 1; string b = 2; }', 'string a = 1; string b = 2;'), ['MULTIPLE_FIELDS_MOVED_TO_ONEOF'])
  assert.deepEqual(pbad('oneof o { string a = 1; string b = 2; }', 'string a = 1; oneof o { string b = 2; }'), ['FIELD_MOVED_TO_EXISTING_ONEOF'])
  assert.deepEqual(pbad('oneof o { string a = 1; }', 'oneof o { string a = 1; string b = 2; }'), ['ONEOF_FIELD_REMOVED'])
  assert.deepEqual(pbad('string a = 1; string b = 2;', 'oneof o { string a = 1; string b = 2; }'), [], 'moving out of a oneof relaxes exclusivity')
  const other = proto('', 'syntax = "proto3";\npackage x.y;\n')
  assert.deepEqual(types(checkProto(other, proto(''), 'reader')), ['PACKAGE_CHANGED'])
  const two = parseProto('message M {}\nmessage N {}\n'), lone = parseProto('message M {}\n')
  assert.deepEqual(types(checkProto(lone, two, 'reader')), ['MESSAGE_REMOVED'])
  assert.deepEqual(types(checkProto(two, lone, 'reader')), [])
})

test('proto: parser handles comments, options, reserved and nesting, and reports line numbers', () => {
  const f = parseProto(`// c\nsyntax = "proto3"; /* b */\nimport "x.proto";\noption java_package = "a";\nmessage A {\n  reserved 2, 5 to 7;\n  reserved "old";\n  message B { int32 x = 1 [deprecated = true]; }\n  B b = 1;\n}\nservice S { rpc F (A) returns (A) {} }\n`)
  assert.equal(f.messages[0].messages[0].fullName, 'A.B')
  assert.ok(f.messages[0].reservedNumbers.has(6))
  assert.throws(() => parseProto('message A {\n string = ;\n}'), /line 2/)
  assert.throws(() => parseProto('message A { int32 a = 1; int32 b = 1; }'), /used twice/)
})

test('modes: pairs the registry checks, with reader and writer in the right order', () => {
  assert.deepEqual(modePairs(2, 'BACKWARD'), [{ reader: 2, writer: 1 }])
  assert.deepEqual(modePairs(2, 'FORWARD'), [{ reader: 1, writer: 2 }])
  assert.deepEqual(modePairs(2, 'FULL'), [{ reader: 2, writer: 1 }, { reader: 1, writer: 2 }])
  assert.deepEqual(modePairs(2, 'BACKWARD_TRANSITIVE'), [{ reader: 2, writer: 1 }, { reader: 2, writer: 0 }])
  assert.equal(modePairs(2, 'FULL_TRANSITIVE').length, 4)
  assert.deepEqual(modePairs(3, 'NONE'), [])
})

test('orders sample: the matrix reads as the story says', () => {
  const a = analyze(SAMPLES[0].subject)
  const row = (k: number) => Object.fromEntries(MODES.map((m) => [m, a.verdict(k, m)]))
  assert.equal(a.verdict(0, 'FULL'), 'first')
  assert.equal(a.verdict(1, 'FULL_TRANSITIVE'), 'pass')
  assert.equal(row(2).BACKWARD, 'pass')
  assert.equal(row(2).FORWARD, 'fail')
  assert.equal(row(3).BACKWARD, 'fail')
  assert.equal(row(3).FORWARD, 'fail')
  assert.equal(row(3).NONE, 'pass')
  // v5 passes against v4, and only fails when it is checked against older history
  assert.equal(row(4).BACKWARD, 'pass')
  assert.equal(row(4).BACKWARD_TRANSITIVE, 'fail')
  assert.equal(transitionAdvice(a, 2).order, 'Consumers first')
  assert.equal(transitionAdvice(a, 3).order, 'No safe order')
})

test('users and payments samples: surface their advertised breaks', () => {
  const u = analyze(SAMPLES[1].subject)
  assert.deepEqual(types(u.pair(1, 0)!), ['OPTIONAL_PROPERTY_ADDED_TO_OPEN_CONTENT_MODEL'])
  assert.ok(types(u.pair(2, 1)!).includes('REQUIRED_ATTRIBUTE_ADDED'))
  assert.ok(types(u.pair(2, 1)!).includes('MAX_LENGTH_DECREASED'))
  assert.ok(types(u.pair(2, 1)!).includes('ENUM_ARRAY_NARROWED'))
  const p = analyze(SAMPLES[2].subject)
  assert.deepEqual(types(p.pair(1, 0)!), [])
  assert.ok(p.pair(1, 0)!.some((i) => i.type === 'FIELD_ADDED'))
  assert.deepEqual(types(p.pair(2, 1)!), ['FIELD_SCALAR_KIND_CHANGED'])
  assert.ok(p.pair(2, 1)!.some((i) => i.type === 'FIELD_NAME_CHANGED'))
  assert.ok(types(p.pair(3, 2)!).includes('MULTIPLE_FIELDS_MOVED_TO_ONEOF'))
})

test('every fix on every sample applies cleanly and clears the issue it targets', () => {
  let tried = 0
  for (const { subject } of SAMPLES) {
    const a = analyze(subject)
    for (let r = 0; r < subject.versions.length; r++)
      for (let w = 0; w < subject.versions.length; w++) {
        if (r === w) continue
        for (const issue of breaking(a.pair(r, w)!)) {
          if (!issue.fix) continue
          tried++
          const k = Math.max(r, w)
          const fixed = applyFix(subject.versions[k].text, issue.fix)
          const parsed = parseVersion(subject.format, fixed)
          assert.ok(parsed.ok, `${issue.type}: ${issue.fix.label}\n${fixed}\n${JSON.stringify(parsed)}`)
          const rs = r === k ? parsed : a.parsed[r], ws = w === k ? parsed : a.parsed[w]
          if (!rs.ok || !ws.ok) continue
          const after = breaking(checkPair(subject.format, rs.schema, ws.schema, r > w ? 'reader' : 'writer', subject.policy))
          assert.ok(!after.some((x) => x.type === issue.type && x.path === issue.path), `${issue.type} at ${issue.path} survived "${issue.fix.label}"\n${fixed}`)
        }
      }
  }
  assert.ok(tried > 20, `only tried ${tried}`)
})

test('avro fix: repeatedly applying fixes converges on a subject that is FULL_TRANSITIVE clean for that version', () => {
  const subject = SAMPLES[0].subject
  let text = subject.versions[3].text
  for (let n = 0; n < 10; n++) {
    const a = analyze({ ...subject, versions: subject.versions.map((v, i) => (i === 3 ? { ...v, text } : v)) })
    const b = a.breaks(3, 'FULL_TRANSITIVE')
    if (!b.length) break
    text = applyFix(text, breaking(b[0].issues)[0].fix!)
  }
  const final = analyze({ ...subject, versions: subject.versions.map((v, i) => (i === 3 ? { ...v, text } : v)) })
  assert.equal(final.verdict(3, 'FULL'), 'pass')
})

test('explanations name who breaks, and the registry string keeps the error type', () => {
  const [i] = checkAvro(rec([{ name: 'b', type: 'string' }]), rec([]), 'reader')
  const e = explain(i, 'v2', 'v1', true)
  assert.match(e.who, /Consumers on v2 cannot read records produced with v1/)
  assert.match(explain(i, 'v1', 'v2', false).who, /still on v1/)
  assert.match(registryError('AVRO', i), /^\{errorType:"READER_FIELD_MISSING_DEFAULT_VALUE", description:".*", additionalInfo:"b"\}$/)
})

test('line diff and format detection', () => {
  const d = lineDiff('a\nb\nc', 'a\nx\nc')
  assert.deepEqual(d.map((l) => l.kind), ['same', 'add', 'del', 'same'])
  assert.equal(detectFormat('x.proto', ''), 'PROTOBUF')
  assert.equal(detectFormat('x.avsc', '{}'), 'AVRO')
  assert.equal(detectFormat('x.json', '{"type":"record","name":"R","fields":[]}'), 'AVRO')
  assert.equal(detectFormat('x.json', '{"type":"object"}'), 'JSON')
})

test('share links round-trip; junk hashes are refused', async () => {
  const s = SAMPLES[2].subject
  const back = await decodeSubject(await encodeSubject(s))
  assert.ok(back)
  assert.deepEqual(back.versions.map((v) => v.text), s.versions.map((v) => v.text))
  assert.equal(back.format, 'PROTOBUF')
  assert.equal(await decodeSubject('not-a-real-hash'), null)
})
