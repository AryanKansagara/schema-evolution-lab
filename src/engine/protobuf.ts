// A proto2/proto3 parser (messages, enums, oneofs, maps, reserved, nested types) plus Confluent's
// protobuf SchemaDiff rules. Fields compare by tag; messages and enums by name in their scope.
import type { Issue, Side, Fix, PatchOp } from './types.ts'
import { SchemaParseError } from './avro.ts'

export interface PField {
  name: string
  number: number
  label: 'optional' | 'repeated' | 'required' | null
  type: string
  map?: { key: string; value: string }
  oneof?: string
  start: number
  end: number
}
export interface POneof {
  name: string
  start: number
  end: number
}
export interface PEnum {
  name: string
  fullName: string
  values: { name: string; number: number }[]
  start: number
  end: number
}
export interface PMessage {
  name: string
  fullName: string
  fields: PField[]
  oneofs: POneof[]
  messages: PMessage[]
  enums: PEnum[]
  reservedNumbers: Set<number>
  start: number
  /** offset of the closing brace */
  close: number
  end: number
}
export interface ProtoFile {
  text: string
  syntax: string
  pkg?: string
  pkgSpan?: [number, number]
  messages: PMessage[]
  enums: PEnum[]
}

interface Tok {
  v: string
  start: number
  end: number
}

function tokenize(text: string): Tok[] {
  const toks: Tok[] = []
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (/\s/.test(c)) i++
    else if (text.startsWith('//', i)) {
      const n = text.indexOf('\n', i)
      i = n < 0 ? text.length : n
    } else if (text.startsWith('/*', i)) {
      const n = text.indexOf('*/', i + 2)
      if (n < 0) throw new SchemaParseError('Unterminated block comment')
      i = n + 2
    } else if (c === '"' || c === "'") {
      let j = i + 1
      while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1
      if (j >= text.length) throw new SchemaParseError(`Unterminated string at line ${lineOf(text, i)}`)
      toks.push({ v: text.slice(i, j + 1), start: i, end: j + 1 })
      i = j + 1
    } else if (/[A-Za-z0-9_.+-]/.test(c)) {
      let j = i
      while (j < text.length && /[A-Za-z0-9_.+-]/.test(text[j])) j++
      toks.push({ v: text.slice(i, j), start: i, end: j })
      i = j
    } else {
      toks.push({ v: c, start: i, end: i + 1 })
      i++
    }
  }
  return toks
}

const lineOf = (text: string, off: number) => text.slice(0, off).split('\n').length

export function parseProto(text: string): ProtoFile {
  const toks = tokenize(text)
  let p = 0
  const peek = () => toks[p]?.v
  const fail = (msg: string): never => {
    const t = toks[Math.min(p, toks.length - 1)]
    throw new SchemaParseError(`${msg} (line ${t ? lineOf(text, t.start) : 1}${peek() ? `, near "${peek()}"` : ''})`)
  }
  const next = () => toks[p++] ?? fail('Unexpected end of file')
  const expect = (v: string) => (peek() === v ? toks[p++] : fail(`Expected "${v}"`))
  const skipStatement = () => {
    let depth = 0
    while (p < toks.length) {
      const t = next().v
      if (t === '{' || t === '[' || t === '(') depth++
      if (t === '}' || t === ']' || t === ')') {
        depth--
        if (depth === 0 && t === '}') return
      }
      if (t === ';' && depth === 0) return
    }
  }
  const skipOpts = () => {
    if (peek() !== '[') return
    let d = 0
    do {
      const t = next().v
      if (t === '[') d++
      if (t === ']') d--
    } while (d > 0)
  }
  const num = (s: string) => {
    if (!/^(0x[0-9a-fA-F]+|-?\d+)$/.test(s)) fail(`Expected a number, got "${s}"`)
    return Number(s)
  }

  function parseEnum(prefix: string): PEnum {
    const start = expect('enum').start
    const name = next().v
    expect('{')
    const values: PEnum['values'] = []
    while (peek() !== '}') {
      if (p >= toks.length) fail(`Unterminated enum ${name}`)
      if (peek() === 'option' || peek() === 'reserved') { skipStatement(); continue }
      if (peek() === ';') { p++; continue }
      const n = next().v
      expect('=')
      values.push({ name: n, number: num(next().v) })
      skipOpts()
      expect(';')
    }
    const end = next().end
    return { name, fullName: prefix + name, values, start, end }
  }

  function parseField(owner: PMessage, oneof?: string): void {
    const start = toks[p].start
    let label: PField['label'] = null
    if (peek() === 'optional' || peek() === 'repeated' || peek() === 'required') label = next().v as PField['label']
    let type: string
    let map: PField['map']
    if (peek() === 'map' && toks[p + 1]?.v === '<') {
      p += 2
      const key = next().v
      expect(',')
      const value = next().v
      expect('>')
      map = { key, value }
      type = `map<${key}, ${value}>`
    } else type = next().v
    const name = next().v
    if (!/^[A-Za-z_]\w*$/.test(name)) fail(`Invalid field name "${name}"`)
    expect('=')
    const number = num(next().v)
    skipOpts()
    const end = expect(';').end
    if (owner.fields.some((f) => f.number === number)) fail(`Field number ${number} is used twice in ${owner.name}`)
    owner.fields.push({ name, number, label, type, map, oneof, start, end })
  }

  function parseMessage(prefix: string): PMessage {
    const start = expect('message').start
    const name = next().v
    expect('{')
    const m: PMessage = { name, fullName: prefix + name, fields: [], oneofs: [], messages: [], enums: [], reservedNumbers: new Set(), start, close: 0, end: 0 }
    for (;;) {
      if (p >= toks.length) fail(`Unterminated message ${name}`)
      const t = peek()
      if (t === '}') break
      if (t === ';') p++
      else if (t === 'message') m.messages.push(parseMessage(m.fullName + '.'))
      else if (t === 'enum') m.enums.push(parseEnum(m.fullName + '.'))
      else if (t === 'option' || t === 'extensions' || t === 'extend') skipStatement()
      else if (t === 'reserved') {
        p++
        while (peek() !== ';') {
          const v = next().v
          if (/^\d+$/.test(v)) {
            if (peek() === 'to') {
              p++
              const to = next().v
              const hi = to === 'max' ? Number(v) : Number(to)
              for (let n = Number(v); n <= Math.min(hi, Number(v) + 4096); n++) m.reservedNumbers.add(n)
            } else m.reservedNumbers.add(Number(v))
          }
          if (p >= toks.length) fail('Unterminated reserved statement')
        }
        p++
      } else if (t === 'oneof') {
        const os = next().start
        const oname = next().v
        expect('{')
        while (peek() !== '}') {
          if (p >= toks.length) fail(`Unterminated oneof ${oname}`)
          if (peek() === 'option') skipStatement()
          else if (peek() === ';') p++
          else parseField(m, oname)
        }
        m.oneofs.push({ name: oname, start: os, end: next().end })
      } else parseField(m)
    }
    const closeTok = next()
    m.close = closeTok.start
    m.end = closeTok.end
    return m
  }

  const file: ProtoFile = { text, syntax: 'proto2', messages: [], enums: [] }
  let prefix = ''
  while (p < toks.length) {
    const t = peek()
    if (t === 'syntax' || t === 'edition') {
      p++
      expect('=')
      file.syntax = next().v.replace(/["']/g, '')
      expect(';')
    } else if (t === 'package') {
      const s = next().start
      const pkg = next().v
      const e = expect(';').end
      file.pkg = pkg
      file.pkgSpan = [s, e]
      prefix = pkg + '.'
    } else if (t === 'import' || t === 'option' || t === 'service' || t === 'extend') skipStatement()
    else if (t === 'message') file.messages.push(parseMessage(prefix))
    else if (t === 'enum') file.enums.push(parseEnum(prefix))
    else if (t === ';') p++
    else fail('Expected message, enum, service, import, option, package or syntax')
  }
  if (!file.messages.length && !file.enums.length) throw new SchemaParseError('No message or enum found')
  return file
}

export const COMPATIBLE_CHANGES = new Set([
  'MESSAGE_ADDED', 'MESSAGE_MOVED', 'ENUM_ADDED', 'ENUM_REMOVED', 'ENUM_CONST_ADDED', 'ENUM_CONST_CHANGED', 'ENUM_CONST_REMOVED',
  'FIELD_ADDED', 'FIELD_REMOVED', 'FIELD_NAME_CHANGED', 'FIELD_STRING_OR_BYTES_LABEL_CHANGED',
  'ONEOF_ADDED', 'ONEOF_REMOVED', 'ONEOF_FIELD_ADDED', 'ONEOF_FIELD_MOVED_TO_TOP_LEVEL',
])

const SCALAR_GROUPS: Record<string, string> = {
  int32: 'GENERAL_NUMBER', int64: 'GENERAL_NUMBER', uint32: 'GENERAL_NUMBER', uint64: 'GENERAL_NUMBER', bool: 'GENERAL_NUMBER',
  sint32: 'SIGNED_NUMBER', sint64: 'SIGNED_NUMBER',
  string: 'STRING_OR_BYTES', bytes: 'STRING_OR_BYTES',
  fixed32: 'FIXED32', sfixed32: 'FIXED32', fixed64: 'FIXED64', sfixed64: 'FIXED64',
  float: 'FLOAT', double: 'DOUBLE',
}

function description(type: string, path: string, a: string, b: string): string {
  switch (type) {
    case 'PACKAGE_CHANGED': return `The package at '${path}' in the ${a} schema does not match the package in the ${b} schema`
    case 'MESSAGE_REMOVED': return `The ${a} schema is missing a MESSAGE type at path '${path}' in the ${b} schema`
    case 'FIELD_KIND_CHANGED': return `The type of a field at path '${path}' in the ${a} schema does not match the ${b} schema`
    case 'FIELD_SCALAR_KIND_CHANGED': return `The kind of a SCALAR field at path '${path}' in the ${a} schema does not match its kind in the ${b} schema`
    case 'FIELD_NAMED_TYPE_CHANGED': return `The type of a MESSAGE field at path '${path}' in the ${a} schema does not match its type in the ${b} schema`
    case 'FIELD_NUMERIC_LABEL_CHANGED': return `The label for a NUMERIC field at path '${path}' in the ${a} schema does not match its label in the ${b} schema`
    case 'REQUIRED_FIELD_ADDED': return `A required field at path '${path}' in the ${a} schema is missing in the ${b} schema`
    case 'REQUIRED_FIELD_REMOVED': return `The ${a} schema is missing a required field at path: '${path}' in the ${b} schema`
    case 'ONEOF_FIELD_REMOVED': return `The ${a} schema is missing a oneof field at path '${path}' in the ${b} schema`
    case 'ONEOF_FIELD_MOVED_TO_TOP_LEVEL': return `The oneof field at path '${path}' in the ${b} schema was moved out of its oneof to a top-level field in the ${a} schema`
    case 'MULTIPLE_FIELDS_MOVED_TO_ONEOF': return `Multiple fields in the oneof at path '${path}' in the ${a} schema are outside a oneof in the ${b} schema`
    case 'FIELD_MOVED_TO_EXISTING_ONEOF': return `A field in the oneof at path '${path}' in the ${a} schema is outside an existing oneof in the ${b} schema`
    default: return `${type} at path '${path}'`
  }
}

/** Resolve a type name per protobuf scoping: innermost scope outwards. */
function resolver(file: ProtoFile) {
  const kinds = new Map<string, 'message' | 'enum'>()
  const walk = (ms: PMessage[], es: PEnum[]) => {
    for (const e of es) kinds.set(e.fullName, 'enum')
    for (const m of ms) {
      kinds.set(m.fullName, 'message')
      walk(m.messages, m.enums)
    }
  }
  walk(file.messages, file.enums)
  const local = (full: string) => (file.pkg && full.startsWith(file.pkg + '.') ? full.slice(file.pkg.length + 1) : full)
  return (scope: string, type: string): { name: string; kind: 'message' | 'enum' | 'unknown' } => {
    if (type.startsWith('.')) {
      const n = type.slice(1)
      return { name: local(n), kind: kinds.get(n) ?? 'unknown' }
    }
    const parts = scope.split('.')
    for (let i = parts.length; i >= 0; i--) {
      const cand = [...parts.slice(0, i), type].join('.')
      if (kinds.has(cand)) return { name: local(cand), kind: kinds.get(cand)! }
    }
    return { name: type, kind: 'unknown' }
  }
}

interface Ctx {
  orig: ProtoFile
  upd: ProtoFile
  newer: Side
  out: Issue[]
  resO: ReturnType<typeof resolver>
  resU: ReturnType<typeof resolver>
}

/** Differences for reader = update, writer = original. Forward checks swap the sides. */
export function checkProto(reader: ProtoFile, writer: ProtoFile, newer: Side): Issue[] {
  const ctx: Ctx = { orig: writer, upd: reader, newer, out: [], resO: resolver(writer), resU: resolver(reader) }
  if (writer.pkg !== reader.pkg) {
    const n = newer === 'reader' ? reader : writer, o = newer === 'reader' ? writer : reader
    let fix: Fix | undefined
    if (o.pkg && n.pkgSpan) fix = { label: `Restore package ${o.pkg}`, ops: [{ op: 'text', start: n.pkgSpan[0], end: n.pkgSpan[1], value: `package ${o.pkg};` }] }
    else if (n.pkgSpan) fix = { label: 'Remove the package declaration', ops: [{ op: 'text', start: n.pkgSpan[0], end: n.pkgSpan[1], value: '' }] }
    else if (o.pkg) fix = { label: `Restore package ${o.pkg}`, ops: [{ op: 'text', start: 0, end: 0, value: `package ${o.pkg};\n` }] }
    add(ctx, 'PACKAGE_CHANGED', '#/', '(package)', `${writer.pkg ?? 'none'} → ${reader.pkg ?? 'none'}`, fix)
  }
  compareTypes(ctx, writer.messages, reader.messages, writer.enums, reader.enums, '')
  return ctx.out
}

function add(ctx: Ctx, type: string, path: string, field: string, info?: string, fix?: Fix) {
  const compatible = COMPATIBLE_CHANGES.has(type)
  const [a, b] = ctx.newer === 'reader' ? ['new', 'old'] : ['old', 'new']
  ctx.out.push({ type, compatible, path, field, message: compatible ? `${type} at path '${path}'` : description(type, path, a, b), info, fix })
}

function compareTypes(ctx: Ctx, om: PMessage[], um: PMessage[], oe: PEnum[], ue: PEnum[], prefix: string) {
  const newerIsUpd = ctx.newer === 'reader'
  for (const m of om) {
    const u = um.find((x) => x.name === m.name)
    const name = prefix + m.name
    if (!u) {
      // message is in the writer but not the reader
      const fix: Fix = newerIsUpd
        ? { label: `Restore message ${m.name}`, ops: [insertType(ctx, um, m, prefix)] }
        : { label: `Remove the new message ${m.name}`, ops: [removeSpan(ctx.orig.text, m.start, m.end)] }
      add(ctx, 'MESSAGE_REMOVED', `#/${name}`, name, undefined, fix)
    } else {
      compareMessage(ctx, m, u, name)
      if (om.indexOf(m) !== um.indexOf(u)) add(ctx, 'MESSAGE_MOVED', `#/${name}`, name)
    }
  }
  for (const u of um) if (!om.some((m) => m.name === u.name)) add(ctx, 'MESSAGE_ADDED', `#/${prefix}${u.name}`, prefix + u.name)
  for (const e of oe) {
    const u = ue.find((x) => x.name === e.name)
    const name = prefix + e.name
    if (!u) add(ctx, 'ENUM_REMOVED', `#/${name}`, name)
    else {
      for (const v of e.values) {
        const w = u.values.find((x) => x.number === v.number)
        if (!w) add(ctx, 'ENUM_CONST_REMOVED', `#/${name}/${v.number}`, `${name}.${v.name}`)
        else if (w.name !== v.name) add(ctx, 'ENUM_CONST_CHANGED', `#/${name}/${v.number}`, `${name}.${w.name}`, `${v.name} → ${w.name}`)
      }
      for (const w of u.values) if (!e.values.some((x) => x.number === w.number)) add(ctx, 'ENUM_CONST_ADDED', `#/${name}/${w.number}`, `${name}.${w.name}`)
    }
  }
  for (const u of ue) if (!oe.some((e) => e.name === u.name)) add(ctx, 'ENUM_ADDED', `#/${prefix}${u.name}`, prefix + u.name)
}

/** Remove a span and the indentation and newline around it. */
function removeSpan(text: string, start: number, end: number): PatchOp {
  let s = start, e = end
  while (s > 0 && (text[s - 1] === ' ' || text[s - 1] === '\t')) s--
  if (text[e] === '\n') e++
  return { op: 'text', start: s, end: e, value: '' }
}

function insertType(ctx: Ctx, siblings: PMessage[], m: PMessage, prefix: string): PatchOp {
  const body = ctx.orig.text.slice(m.start, m.end)
  if (prefix) {
    // nested: put it right before the enclosing message's closing brace
    const parent = findMessage(ctx.upd.messages, prefix.slice(0, -1))
    if (parent) return { op: 'text', start: parent.close, end: parent.close, value: `${body}\n` }
  }
  void siblings
  const at = ctx.upd.text.length
  return { op: 'text', start: at, end: at, value: `\n${body}\n` }
}

function findMessage(ms: PMessage[], path: string): PMessage | undefined {
  const [head, ...rest] = path.split('.')
  const m = ms.find((x) => x.name === head)
  return m && rest.length ? findMessage(m.messages, rest.join('.')) : m
}

function compareMessage(ctx: Ctx, o: PMessage, u: PMessage, name: string) {
  const byTagO = new Map(o.fields.map((f) => [f.number, f]))
  const byTagU = new Map(u.fields.map((f) => [f.number, f]))
  const oneofNames = new Set(o.oneofs.map((x) => x.name))
  const updOneofNames = new Set(u.oneofs.map((x) => x.name))
  const completelyDeleted = new Set(
    o.oneofs.filter((x) => !updOneofNames.has(x.name) && !o.fields.some((f) => f.oneof === x.name && byTagU.has(f.number))).map((x) => x.name),
  )
  for (const one of u.oneofs) {
    const groups = new Set<string>()
    let movedIn = 0
    for (const f of u.fields.filter((x) => x.oneof === one.name)) {
      const of = byTagO.get(f.number)
      if (!of) continue
      if (of.oneof) groups.add('oneof:' + of.oneof)
      else {
        groups.add('field:' + f.number)
        movedIn++
      }
    }
    if (groups.size > 1) add(ctx, movedIn > 1 ? 'MULTIPLE_FIELDS_MOVED_TO_ONEOF' : 'FIELD_MOVED_TO_EXISTING_ONEOF', `#/${name}/${one.name}`, `${name}.${one.name}`)
  }
  for (const n of [...new Set([...oneofNames, ...updOneofNames])].sort()) {
    if (!updOneofNames.has(n)) add(ctx, 'ONEOF_REMOVED', `#/${name}/${n}`, `${name}.${n}`)
    else if (!oneofNames.has(n)) add(ctx, 'ONEOF_ADDED', `#/${name}/${n}`, `${name}.${n}`)
  }
  const tags = [...new Set([...byTagO.keys(), ...byTagU.keys()])].sort((a, b) => a - b)
  const newerIsUpd = ctx.newer === 'reader'
  const newerMsg = newerIsUpd ? u : o
  const reserveFix = (f: PField): Fix => ({ label: `Reserve tag ${f.number} and name "${f.name}"`, ops: [{ op: 'text', start: newerMsg.close, end: newerMsg.close, value: `  reserved ${f.number};\n  reserved "${f.name}";\n` }] })
  const restoreField = (f: PField, text: string): Fix => {
    const line = text.slice(f.start, f.end)
    return { label: `Restore field ${f.number}: ${line}`, ops: [{ op: 'text', start: newerMsg.close, end: newerMsg.close, value: `  ${line}\n` }] }
  }
  for (const tag of tags) {
    const a = byTagO.get(tag), b = byTagU.get(tag)
    const fname = b?.name ?? a!.name
    if (!b) {
      const path = a!.oneof ? `#/${name}/${a!.oneof}/${tag}` : `#/${name}/${tag}`
      if (a!.oneof) {
        if (!completelyDeleted.has(a!.oneof)) add(ctx, 'ONEOF_FIELD_REMOVED', path, `${name}.${fname}`, undefined, newerIsUpd ? restoreToOneof(ctx, a!, u) : { label: `Remove ${a!.name} from the new oneof`, ops: [removeSpan(ctx.orig.text, a!.start, a!.end)] })
      } else if (a!.label === 'required') {
        add(ctx, 'REQUIRED_FIELD_REMOVED', path, `${name}.${fname}`, undefined, newerIsUpd ? restoreField(a!, ctx.orig.text) : { label: `Remove required field ${a!.name} from the new schema`, ops: [removeSpan(ctx.orig.text, a!.start, a!.end)] })
      } else {
        const reserved = newerIsUpd && (u.reservedNumbers.has(tag))
        add(ctx, 'FIELD_REMOVED', path, `${name}.${fname}`, reserved ? `tag ${tag} is reserved` : undefined, newerIsUpd && !reserved ? reserveFix(a!) : undefined)
      }
    } else if (!a) {
      const path = b.oneof ? `#/${name}/${b.oneof}/${tag}` : `#/${name}/${tag}`
      if (b.oneof) add(ctx, 'ONEOF_FIELD_ADDED', path, `${name}.${fname}`)
      else if (b.label === 'required') {
        // reader requires a field the writer does not have
        const fix: Fix = newerIsUpd
          ? { label: `Make '${b.name}' optional`, ops: [{ op: 'text', start: b.start, end: b.start + 'required'.length, value: 'optional' }] }
          : restoreField(b, ctx.upd.text)
        add(ctx, 'REQUIRED_FIELD_ADDED', path, `${name}.${fname}`, undefined, fix)
      } else add(ctx, 'FIELD_ADDED', path, `${name}.${fname}`)
    } else {
      if (a.oneof && !b.oneof) add(ctx, 'ONEOF_FIELD_MOVED_TO_TOP_LEVEL', `#/${name}/${tag}`, `${name}.${fname}`)
      const path = b.oneof ? `#/${name}/${b.oneof}/${tag}` : `#/${name}/${tag}`
      compareField(ctx, a, b, o, u, path, `${name}.${fname}`)
    }
  }
  compareTypes(ctx, o.messages, u.messages, o.enums, u.enums, name + '.')
}

function restoreToOneof(ctx: Ctx, f: PField, u: PMessage): Fix {
  const one = u.oneofs.find((x) => x.name === f.oneof)
  const line = ctx.orig.text.slice(f.start, f.end)
  const at = one ? one.end - 1 : u.close
  return { label: `Restore oneof field ${f.name}`, ops: [{ op: 'text', start: at, end: at, value: `  ${line}\n  ` }] }
}

function compareField(ctx: Ctx, a: PField, b: PField, om: PMessage, um: PMessage, path: string, human: string) {
  if (a.name !== b.name) add(ctx, 'FIELD_NAME_CHANGED', path, human, `${a.name} → ${b.name}`)
  const fix = () => fieldFix(ctx, a, b, om, um)
  const kindOf = (f: PField, res: Ctx['resO'], scope: string): 'SCALAR' | 'MAP' | 'MESSAGE' => {
    if (f.map) return 'MAP'
    if (SCALAR_GROUPS[f.type]) return 'SCALAR'
    return res(scope, f.type).kind === 'enum' ? 'SCALAR' : 'MESSAGE'
  }
  const ka = kindOf(a, ctx.resO, om.fullName), kb = kindOf(b, ctx.resU, um.fullName)
  if (ka !== kb) return add(ctx, 'FIELD_KIND_CHANGED', path, human, `${a.type} → ${b.type}`, fix())
  if (ka === 'MAP') {
    const o = a.map!, u = b.map!
    if (SCALAR_GROUPS[o.key] !== SCALAR_GROUPS[u.key]) add(ctx, 'FIELD_SCALAR_KIND_CHANGED', path, human, `map key ${o.key} → ${u.key}`, fix())
    compareValueType(ctx, o.value, u.value, om, um, path, human, null, null, fix)
    return
  }
  compareValueType(ctx, a.type, b.type, om, um, path, human, a.label, b.label, fix)
}

function compareValueType(ctx: Ctx, ta: string, tb: string, om: PMessage, um: PMessage, path: string, human: string, la: PField['label'], lb: PField['label'], fix: () => Fix) {
  const ra = ctx.resO(om.fullName, ta), rb = ctx.resU(um.fullName, tb)
  const scalarA = SCALAR_GROUPS[ta] ?? (ra.kind === 'enum' ? 'GENERAL_NUMBER' : null)
  const scalarB = SCALAR_GROUPS[tb] ?? (rb.kind === 'enum' ? 'GENERAL_NUMBER' : null)
  if (!!scalarA !== !!scalarB) return add(ctx, 'FIELD_KIND_CHANGED', path, human, `${ta} → ${tb}`, fix())
  if (scalarA) {
    if (scalarA !== scalarB) return add(ctx, 'FIELD_SCALAR_KIND_CHANGED', path, human, `${ta} (${scalarA}) → ${tb} (${scalarB})`, fix())
    if (la && lb && la !== lb) {
      if (scalarA === 'STRING_OR_BYTES') add(ctx, 'FIELD_STRING_OR_BYTES_LABEL_CHANGED', path, human, `${la} → ${lb}`)
      else add(ctx, 'FIELD_NUMERIC_LABEL_CHANGED', path, human, `${la} → ${lb}`, fix())
    }
    return
  }
  if (ra.name !== rb.name) add(ctx, 'FIELD_NAMED_TYPE_CHANGED', path, human, `${ra.name} → ${rb.name}`, fix())
}

/**
 * The idiomatic fix: tags are forever. Put the old definition back on this tag, and
 * carry the new definition as a fresh field on an unused tag.
 */
function fieldFix(ctx: Ctx, a: PField, b: PField, om: PMessage, um: PMessage): Fix {
  const newerIsUpd = ctx.newer === 'reader'
  const [nf, of_, nm, oText, nText] = newerIsUpd ? [b, a, um, ctx.orig.text, ctx.upd.text] : [a, b, om, ctx.upd.text, ctx.orig.text]
  const used = new Set([...nm.fields.map((f) => f.number), ...nm.reservedNumbers])
  let tag = Math.max(0, ...used) + 1
  while (used.has(tag)) tag++
  const oldLine = oText.slice(of_.start, of_.end)
  const typeSpec = nText.slice(nf.start, nf.end).replace(/\s*=\s*\d+/, ` = ${tag}`)
  const renamed = nf.name === of_.name ? typeSpec.replace(new RegExp(`\\b${nf.name}(\\s*=)`), `${nf.name}_v2$1`) : typeSpec
  return {
    label: `Keep tag ${nf.number} as "${oldLine}" and move the new type to tag ${tag}`,
    ops: [
      { op: 'text', start: nf.start, end: nf.end, value: oldLine },
      { op: 'text', start: nm.close, end: nm.close, value: `  ${renamed}\n` },
    ],
  }
}
