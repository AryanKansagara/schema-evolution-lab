// Avro schema parsing + reader/writer compatibility, mirroring
// org.apache.avro.SchemaCompatibility as used by Confluent Schema Registry.
import type { Issue, Side, Fix } from './types.ts'

const PRIMS = ['null', 'boolean', 'int', 'long', 'float', 'double', 'bytes', 'string'] as const
type Prim = (typeof PRIMS)[number]

export type AvroType =
  | { kind: 'primitive'; name: Prim; logical?: string; ptr: string }
  | { kind: 'record'; name: string; fullName: string; aliases: string[]; fields: AvroField[]; ptr: string; raw: any }
  | { kind: 'enum'; name: string; fullName: string; aliases: string[]; symbols: string[]; default?: string; ptr: string; raw: any }
  | { kind: 'fixed'; name: string; fullName: string; aliases: string[]; size: number; ptr: string; raw: any }
  | { kind: 'array'; items: AvroType; ptr: string }
  | { kind: 'map'; values: AvroType; ptr: string }
  | { kind: 'union'; branches: AvroType[]; ptr: string }

export interface AvroField {
  name: string
  aliases: string[]
  type: AvroType
  hasDefault: boolean
  default?: unknown
  ptr: string
  raw: any
}

export interface AvroSchema {
  root: AvroType
  named: Map<string, AvroType>
  doc: unknown
  warnings: string[]
}

export class SchemaParseError extends Error {}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

export function parseAvro(text: string): AvroSchema {
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch (e) {
    throw new SchemaParseError(`Invalid JSON: ${(e as Error).message}`)
  }
  const named = new Map<string, AvroType>()
  const warnings: string[] = []

  const fullNameOf = (name: string, ns: string | undefined) =>
    name.includes('.') ? name : ns ? `${ns}.${name}` : name

  function parse(node: any, ptr: string, ns: string | undefined): AvroType {
    if (typeof node === 'string') {
      if ((PRIMS as readonly string[]).includes(node)) return { kind: 'primitive', name: node as Prim, ptr }
      const t = named.get(fullNameOf(node, ns)) ?? named.get(node)
      if (!t) throw new SchemaParseError(`Undefined name: "${node}" at ${ptr || '/'}`)
      return t
    }
    if (Array.isArray(node)) {
      const branches = node.map((b, i) => parse(b, `${ptr}/${i}`, ns))
      const seen = new Set<string>()
      for (const b of branches) {
        if (b.kind === 'union') throw new SchemaParseError(`Unions may not immediately contain other unions (${ptr || '/'})`)
        const key = 'fullName' in b ? b.fullName : b.kind === 'primitive' ? b.name : b.kind
        if (seen.has(key)) throw new SchemaParseError(`Duplicate in union: ${key} (${ptr || '/'})`)
        seen.add(key)
      }
      return { kind: 'union', branches, ptr }
    }
    if (!node || typeof node !== 'object') throw new SchemaParseError(`Not a valid schema at ${ptr || '/'}: ${JSON.stringify(node)}`)
    const t = node.type
    if (typeof t === 'string' && (PRIMS as readonly string[]).includes(t))
      return { kind: 'primitive', name: t as Prim, logical: node.logicalType, ptr }
    if (t === 'array') return { kind: 'array', items: parse(node.items, `${ptr}/items`, ns), ptr }
    if (t === 'map') return { kind: 'map', values: parse(node.values, `${ptr}/values`, ns), ptr }
    if (t === 'record' || t === 'error' || t === 'enum' || t === 'fixed') {
      if (typeof node.name !== 'string') throw new SchemaParseError(`No name in ${t} at ${ptr || '/'}`)
      const nsHere = node.name.includes('.') ? node.name.slice(0, node.name.lastIndexOf('.')) : (node.namespace ?? ns)
      const fullName = fullNameOf(node.name, nsHere)
      const name = fullName.split('.').pop()!
      if (!NAME_RE.test(name)) throw new SchemaParseError(`Illegal name: "${name}"`)
      if (named.has(fullName)) throw new SchemaParseError(`Can't redefine: ${fullName}`)
      const aliases: string[] = (node.aliases ?? []).map((a: string) => fullNameOf(a, nsHere))
      if (t === 'enum') {
        const symbols: string[] = node.symbols ?? []
        if (!Array.isArray(symbols)) throw new SchemaParseError(`Enum symbols must be an array (${fullName})`)
        if (new Set(symbols).size !== symbols.length) throw new SchemaParseError(`Duplicate enum symbol in ${fullName}`)
        if (node.default !== undefined && !symbols.includes(node.default))
          throw new SchemaParseError(`Enum default "${node.default}" is not a symbol of ${fullName}`)
        const e: AvroType = { kind: 'enum', name, fullName, aliases, symbols, default: node.default, ptr, raw: node }
        named.set(fullName, e)
        return e
      }
      if (t === 'fixed') {
        if (!Number.isInteger(node.size)) throw new SchemaParseError(`Fixed ${fullName} needs an integer size`)
        const f: AvroType = { kind: 'fixed', name, fullName, aliases, size: node.size, ptr, raw: node }
        named.set(fullName, f)
        return f
      }
      if (!Array.isArray(node.fields)) throw new SchemaParseError(`Record ${fullName} has no fields array`)
      const rec: AvroType = { kind: 'record', name, fullName, aliases, fields: [], ptr, raw: node }
      named.set(fullName, rec) // register before fields: recursive types
      const names = new Set<string>()
      node.fields.forEach((f: any, i: number) => {
        const fptr = `${ptr}/fields/${i}`
        if (typeof f?.name !== 'string') throw new SchemaParseError(`Field ${i} of ${fullName} has no name`)
        if (names.has(f.name)) throw new SchemaParseError(`Duplicate field ${f.name} in ${fullName}`)
        names.add(f.name)
        if (!('type' in f)) throw new SchemaParseError(`Field ${fullName}.${f.name} has no type`)
        const type = parse(f.type, `${fptr}/type`, nsHere)
        const hasDefault = 'default' in f
        if (hasDefault && !defaultMatches(type, f.default))
          warnings.push(`Field ${name}.${f.name}: default ${JSON.stringify(f.default)} does not match its type${type.kind === 'union' ? ' (union defaults must match the FIRST branch)' : ''}`)
        ;(rec as any).fields.push({ name: f.name, aliases: f.aliases ?? [], type, hasDefault, default: f.default, ptr: fptr, raw: f })
      })
      return rec
    }
    if (typeof t === 'object' && t !== null) return parse(t, `${ptr}/type`, ns)
    if (typeof t === 'string') return parse(t, ptr, ns)
    throw new SchemaParseError(`Unknown type ${JSON.stringify(t)} at ${ptr || '/'}`)
  }

  return { root: parse(doc, '', undefined), named, doc, warnings }
}

export function defaultMatches(t: AvroType, v: unknown): boolean {
  switch (t.kind) {
    case 'union':
      return defaultMatches(t.branches[0], v)
    case 'primitive':
      switch (t.name) {
        case 'null': return v === null
        case 'boolean': return typeof v === 'boolean'
        case 'int': case 'long': return Number.isInteger(v)
        case 'float': case 'double': return typeof v === 'number'
        default: return typeof v === 'string'
      }
    case 'enum': return typeof v === 'string' && t.symbols.includes(v)
    case 'fixed': return typeof v === 'string'
    case 'array': return Array.isArray(v) && v.every((x) => defaultMatches(t.items, x))
    case 'map': return !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((x) => defaultMatches(t.values, x))
    case 'record':
      return !!v && typeof v === 'object' && !Array.isArray(v) && t.fields.every((f) => (f.name in (v as object) ? defaultMatches(f.type, (v as any)[f.name]) : f.hasDefault))
  }
}

export function typeName(t: AvroType): string {
  if (t.kind === 'primitive') return t.logical ? `${t.name} (${t.logical})` : t.name
  if (t.kind === 'array') return `array<${typeName(t.items)}>`
  if (t.kind === 'map') return `map<${typeName(t.values)}>`
  if (t.kind === 'union') return `[${t.branches.map(typeName).join(', ')}]`
  return t.fullName
}

/** JSON form of a type for use at a site in the other document. Named types become references. */
function rawRef(t: AvroType): unknown {
  if (t.kind === 'primitive') return t.logical ? { type: t.name, logicalType: t.logical } : t.name
  if (t.kind === 'array') return { type: 'array', items: rawRef(t.items) }
  if (t.kind === 'map') return { type: 'map', values: rawRef(t.values) }
  if (t.kind === 'union') return t.branches.map(rawRef)
  return t.fullName
}

/** Inline raw definition, unless the target schema already defines that name. */
function rawFor(t: AvroType, target: AvroSchema, seen = new Set<string>()): unknown {
  if ('fullName' in t) {
    if (target.named.has(t.fullName) || seen.has(t.fullName)) return t.fullName
    seen.add(t.fullName)
    if (t.kind !== 'record') return structuredClone(t.raw)
    const out = { ...structuredClone(t.raw), fields: t.fields.map((f) => ({ ...structuredClone(f.raw), type: rawFor(f.type, target, seen) })) }
    return out
  }
  if (t.kind === 'array') return { type: 'array', items: rawFor(t.items, target, seen) }
  if (t.kind === 'map') return { type: 'map', values: rawFor(t.values, target, seen) }
  if (t.kind === 'union') return t.branches.map((b) => rawFor(b, target, seen))
  return rawRef(t)
}

/** A sensible default value for a type (used by the "add default" fix). */
export function zeroValue(t: AvroType): unknown {
  switch (t.kind) {
    case 'primitive':
      return t.name === 'null' ? null : t.name === 'boolean' ? false : t.name === 'string' || t.name === 'bytes' ? '' : 0
    case 'enum': return t.default ?? t.symbols[0]
    case 'array': return []
    case 'map': return {}
    case 'union': return zeroValue(t.branches[0])
    case 'fixed': return '\u0000'.repeat(t.size)
    case 'record': return Object.fromEntries(t.fields.map((f) => [f.name, f.hasDefault ? f.default : zeroValue(f.type)]))
  }
}

const PROMOTIONS: Record<string, string[]> = {
  long: ['int'],
  float: ['int', 'long'],
  double: ['int', 'long', 'float'],
  bytes: ['string'],
  string: ['bytes'],
}

interface Ctx {
  reader: AvroSchema
  writer: AvroSchema
  newer: Side
  out: Issue[]
  /** record pairs on the current stack (recursion guard) */
  stack: Set<string>
}

/** Same-site context: the field we're inside, on both sides (for fixes). */
interface Site {
  loc: string[]
  human: string
  rField?: AvroField
  wField?: AvroField
  wRecord?: AvroType
}

const label = (newer: Side, side: Side) => (newer === side ? 'new' : 'old')

/**
 * Can `reader` decode data written with `writer`? Returns every incompatibility
 * (Confluent reports all of them), each with a Confluent-style message and a fix
 * that edits the newer schema.
 */
export function checkAvro(reader: AvroSchema, writer: AvroSchema, newer: Side): Issue[] {
  const ctx: Ctx = { reader, writer, newer, out: [], stack: new Set() }
  const rootName = 'fullName' in reader.root ? reader.root.name : 'root'
  walk(ctx, reader.root, writer.root, { loc: [], human: rootName })
  return ctx.out
}

function add(ctx: Ctx, type: string, site: Site, message: string, info: string, fix?: Fix) {
  ctx.out.push({ type, compatible: false, path: '/' + site.loc.join('/'), field: site.human, message, info, fix })
}

function sameKind(r: AvroType, w: AvroType) {
  if (r.kind !== w.kind) return false
  return r.kind !== 'primitive' || r.name === (w as typeof r).name
}

function walk(ctx: Ctx, r: AvroType, w: AvroType, site: Site) {
  const R = label(ctx.newer, 'reader')
  const W = label(ctx.newer, 'writer')
  const at = () => '/' + site.loc.join('/')
  if (sameKind(r, w)) {
    switch (r.kind) {
      case 'primitive':
        return
      case 'fixed': {
        const wf = w as Extract<AvroType, { kind: 'fixed' }>
        checkNames(ctx, r, wf, site)
        if (r.size !== wf.size) {
          const newerT = ctx.newer === 'reader' ? r : wf
          const olderT = ctx.newer === 'reader' ? wf : r
          add(ctx, 'FIXED_SIZE_MISMATCH', { ...site, loc: [...site.loc, 'size'] },
            `The size of FIXED type field at path '${at()}/size' in the ${R} schema does not match with the ${W} schema`,
            `expected: ${wf.size}, found: ${r.size}`,
            { label: `Set ${newerT.name} size back to ${olderT.size}`, ops: [{ op: 'set', ptr: `${newerT.ptr}/size`, value: olderT.size }] })
        }
        return
      }
      case 'enum': {
        const we = w as Extract<AvroType, { kind: 'enum' }>
        checkNames(ctx, r, we, site)
        const missing = we.symbols.filter((s) => !r.symbols.includes(s))
        if (missing.length && r.default === undefined) {
          const fix: Fix =
            ctx.newer === 'reader'
              ? { label: `Add back symbol${missing.length > 1 ? 's' : ''} ${missing.join(', ')} to ${r.name}`, ops: [{ op: 'set', ptr: `${r.ptr}/symbols`, value: [...r.symbols, ...missing] }] }
              : { label: `Remove new symbol${missing.length > 1 ? 's' : ''} ${missing.join(', ')} from ${we.name}`, ops: [{ op: 'set', ptr: `${we.ptr}/symbols`, value: we.symbols.filter((s) => !missing.includes(s)) }] }
          add(ctx, 'MISSING_ENUM_SYMBOLS', { ...site, loc: [...site.loc, 'symbols'] },
            `The ${R} schema is missing enum symbols '[${missing.join(', ')}]' at path '${at()}/symbols' in the ${W} schema`,
            `[${missing.join(', ')}]`, fix)
        }
        return
      }
      case 'record':
        return walkRecord(ctx, r, w as typeof r, site)
      case 'array':
        return walk(ctx, r.items, (w as typeof r).items, { ...site, loc: [...site.loc, 'items'], human: site.human + '[]' })
      case 'map':
        return walk(ctx, r.values, (w as typeof r).values, { ...site, loc: [...site.loc, 'values'], human: site.human + '{}' })
      case 'union': {
        // every writer branch must be readable by the reader union
        ;(w as typeof r).branches.forEach((wb, i) => walk(ctx, r, wb, { ...site, loc: [...site.loc, String(i)] }))
        return
      }
    }
  }
  if (w.kind === 'union') {
    w.branches.forEach((wb, i) => walk(ctx, r, wb, { ...site, loc: [...site.loc, String(i)] }))
    return
  }
  if (r.kind === 'primitive' && w.kind === 'primitive' && PROMOTIONS[r.name]?.includes(w.name)) return
  if (r.kind === 'union') {
    for (const rb of r.branches) {
      const probe: Ctx = { ...ctx, out: [], stack: new Set(ctx.stack) }
      walk(probe, rb, w, site)
      if (!probe.out.length) return
    }
    let fix: Fix | undefined
    if (ctx.newer === 'reader') {
      fix = { label: `Add ${typeName(w)} back into the union`, ops: [{ op: 'insert', ptr: r.ptr, index: r.branches.length, value: rawFor(w, ctx.reader) }] }
    } else if (site.wField) {
      const u = site.wField.type
      if (u.kind === 'union') {
        const keep = u.branches.filter((b) => b !== w)
        fix = { label: `Drop ${typeName(w)} from the new union`, ops: [{ op: 'set', ptr: `${site.wField.ptr}/type`, value: keep.length === 1 ? rawRef(keep[0]) : keep.map(rawRef) }] }
      }
    }
    add(ctx, 'MISSING_UNION_BRANCH', site,
      `The ${R} schema is missing a type inside a union field at path '${at()}' in the ${W} schema`,
      `reader union lacking writer type: ${typeName(w).toUpperCase()}`, fix)
    return
  }
  add(ctx, 'TYPE_MISMATCH', site,
    `The type (path '${at()}') of a field in the ${R} schema does not match with the ${W} schema`,
    `reader type: ${typeName(r).toUpperCase()} not compatible with writer type: ${typeName(w).toUpperCase()}`,
    revertFieldType(ctx, site))
}

/** Fix: make the newer field's type equal the older field's type. */
function revertFieldType(ctx: Ctx, site: Site): Fix | undefined {
  const nf = ctx.newer === 'reader' ? site.rField : site.wField
  const of = ctx.newer === 'reader' ? site.wField : site.rField
  if (!nf || !of) return undefined
  const target = ctx.newer === 'reader' ? ctx.reader : ctx.writer
  const ops: Fix['ops'] = [{ op: 'set', ptr: `${nf.ptr}/type`, value: rawFor(of.type, target) }]
  if (nf.hasDefault && !(of.hasDefault && defaultMatches(of.type, of.default))) ops.push({ op: 'remove', ptr: `${nf.ptr}/default` })
  if (of.hasDefault) ops.push({ op: 'set', ptr: `${nf.ptr}/default`, value: of.default })
  return { label: `Revert '${nf.name}' to ${typeName(of.type)} (add a new field for the new type instead)`, ops }
}

function checkNames(ctx: Ctx, r: Extract<AvroType, { name: string; fullName: string }>, w: typeof r, site: Site) {
  if (r.name === w.name || r.aliases.includes(w.fullName)) return
  const fix: Fix =
    ctx.newer === 'reader'
      ? { label: `Add alias "${w.fullName}" to ${r.name}`, ops: [{ op: 'set', ptr: `${r.ptr}/aliases`, value: [...(r.raw.aliases ?? []), w.fullName] }] }
      : { label: `Rename ${w.name} back to ${r.name}`, ops: [{ op: 'set', ptr: `${w.ptr}/name`, value: w.raw.name.includes('.') ? r.fullName : r.name }] }
  add(ctx, 'NAME_MISMATCH', { ...site, loc: [...site.loc, 'name'] },
    `The name of the schema has changed (path '/${[...site.loc, 'name'].join('/')}')`,
    `expected: ${w.fullName}`, fix)
}

function walkRecord(ctx: Ctx, r: Extract<AvroType, { kind: 'record' }>, w: typeof r, site: Site) {
  checkNames(ctx, r, w, site)
  const key = r.fullName + '|' + w.fullName
  if (ctx.stack.has(key)) return
  ctx.stack.add(key)
  const R = label(ctx.newer, 'reader')
  const W = label(ctx.newer, 'writer')
  r.fields.forEach((rf, i) => {
    const wf = w.fields.find((f) => f.name === rf.name) ?? w.fields.find((f) => rf.aliases.includes(f.name))
    const fsite: Site = { loc: [...site.loc, 'fields', String(i)], human: `${site.human}.${rf.name}`, rField: rf, wField: wf, wRecord: w }
    if (!wf) {
      if (rf.hasDefault) return
      const path = '/' + fsite.loc.join('/')
      let fix: Fix
      if (ctx.newer === 'reader') fix = addDefaultFix(rf)
      else {
        const restored = { ...structuredClone(rf.raw), type: rawFor(rf.type, ctx.writer) }
        if (!('default' in restored)) restored.default = zeroValue(rf.type)
        fix = { label: `Keep '${rf.name}' in the new schema (with a default so it can be removed later)`, ops: [{ op: 'insert', ptr: `${w.ptr}/fields`, index: i, value: restored }] }
      }
      add(ctx, 'READER_FIELD_MISSING_DEFAULT_VALUE', fsite,
        `The field '${rf.name}' at path '${path}' in the ${R} schema has no default value and is missing in the ${W} schema`,
        rf.name, fix)
      return
    }
    walk(ctx, rf.type, wf.type, { ...fsite, loc: [...fsite.loc, 'type'] })
  })
  ctx.stack.delete(key)
}

function addDefaultFix(f: AvroField): Fix {
  const t = f.type
  if (t.kind === 'union') {
    const ni = t.branches.findIndex((b) => b.kind === 'primitive' && b.name === 'null')
    if (ni === 0) return { label: `Add "default": null to '${f.name}'`, ops: [{ op: 'set', ptr: `${f.ptr}/default`, value: null }] }
    if (ni > 0) {
      const raw = f.raw.type as unknown[]
      const reordered = [raw[ni], ...raw.filter((_, i) => i !== ni)]
      return { label: `Move "null" first in '${f.name}' and add "default": null`, ops: [{ op: 'set', ptr: `${f.ptr}/type`, value: reordered }, { op: 'set', ptr: `${f.ptr}/default`, value: null }] }
    }
    return { label: `Add a default to '${f.name}'`, ops: [{ op: 'set', ptr: `${f.ptr}/default`, value: zeroValue(t) }] }
  }
  if (t.kind === 'record' || t.kind === 'fixed' || (t.kind === 'primitive' && t.name === 'bytes')) {
    return { label: `Make '${f.name}' optional: ["null", ${typeName(t)}] with "default": null`, ops: [{ op: 'set', ptr: `${f.ptr}/type`, value: ['null', f.raw.type] }, { op: 'set', ptr: `${f.ptr}/default`, value: null }] }
  }
  const v = zeroValue(t)
  return { label: `Add "default": ${JSON.stringify(v)} to '${f.name}'`, ops: [{ op: 'set', ptr: `${f.ptr}/default`, value: v }] }
}

// ---------- structural diff (human-level change list) ----------

export interface Change {
  kind: 'added' | 'removed' | 'changed'
  field: string
  detail: string
}

export function diffAvro(a: AvroSchema, b: AvroSchema): Change[] {
  const out: Change[] = []
  const seen = new Set<string>()
  function go(x: AvroType, y: AvroType, path: string) {
    if (x.kind === 'record' && y.kind === 'record') {
      const k = x.fullName + '|' + y.fullName
      if (seen.has(k)) return
      seen.add(k)
      if (x.fullName !== y.fullName) out.push({ kind: 'changed', field: path, detail: `renamed ${x.fullName} → ${y.fullName}` })
      for (const f of x.fields) {
        const g = y.fields.find((q) => q.name === f.name || q.aliases.includes(f.name))
        if (!g) out.push({ kind: 'removed', field: `${path}.${f.name}`, detail: typeName(f.type) + (f.hasDefault ? ` (default ${JSON.stringify(f.default)})` : ', no default') })
        else {
          if (g.name !== f.name) out.push({ kind: 'changed', field: `${path}.${f.name}`, detail: `renamed to ${g.name} (via alias)` })
          if (f.hasDefault !== g.hasDefault || JSON.stringify(f.default) !== JSON.stringify(g.default))
            out.push({ kind: 'changed', field: `${path}.${g.name}`, detail: `default ${f.hasDefault ? JSON.stringify(f.default) : 'none'} → ${g.hasDefault ? JSON.stringify(g.default) : 'none'}` })
          go(f.type, g.type, `${path}.${g.name}`)
        }
      }
      for (const g of y.fields)
        if (!x.fields.some((f) => f.name === g.name || g.aliases.includes(f.name)))
          out.push({ kind: 'added', field: `${path}.${g.name}`, detail: typeName(g.type) + (g.hasDefault ? ` (default ${JSON.stringify(g.default)})` : ', no default') })
      return
    }
    if (x.kind === 'enum' && y.kind === 'enum') {
      const add = y.symbols.filter((s) => !x.symbols.includes(s))
      const rem = x.symbols.filter((s) => !y.symbols.includes(s))
      if (add.length) out.push({ kind: 'added', field: path, detail: `enum symbols ${add.join(', ')}` })
      if (rem.length) out.push({ kind: 'removed', field: path, detail: `enum symbols ${rem.join(', ')}` })
      if (x.default !== y.default) out.push({ kind: 'changed', field: path, detail: `enum default ${x.default ?? 'none'} → ${y.default ?? 'none'}` })
      return
    }
    if (x.kind === 'array' && y.kind === 'array') return go(x.items, y.items, path + '[]')
    if (x.kind === 'map' && y.kind === 'map') return go(x.values, y.values, path + '{}')
    if (x.kind === 'union' && y.kind === 'union' && x.branches.length === y.branches.length) {
      const same = x.branches.every((b, i) => typeName(b) === typeName(y.branches[i]))
      if (same) {
        x.branches.forEach((b, i) => go(b, y.branches[i], path))
        return
      }
    }
    if (typeName(x) !== typeName(y)) out.push({ kind: 'changed', field: path, detail: `type ${typeName(x)} → ${typeName(y)}` })
    else if (x.kind === 'fixed' && y.kind === 'fixed' && x.size !== y.size) out.push({ kind: 'changed', field: path, detail: `fixed size ${x.size} → ${y.size}` })
  }
  go(a.root, b.root, 'fullName' in b.root ? b.root.name : 'root')
  return out
}

