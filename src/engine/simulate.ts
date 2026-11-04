// Avro schema resolution: write a sample record with the writer schema, read it with the reader schema.
import { type AvroSchema, type AvroType, typeName, checkAvro } from './avro.ts'

export interface SimNote {
  path: string
  kind: 'default' | 'dropped' | 'promoted' | 'union' | 'enum-default' | 'error'
  detail: string
}

export interface SimResult {
  written: unknown
  read: unknown
  notes: SimNote[]
  ok: boolean
}

function hash(s: string) {
  let h = 2166136261
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619)
  return h >>> 0
}

function sampleFor(name: string, t: Extract<AvroType, { kind: 'primitive' }>): unknown {
  const n = name.toLowerCase()
  const h = hash(name)
  switch (t.name) {
    case 'null': return null
    case 'boolean': return h % 3 !== 0
    case 'int':
    case 'long':
      if (t.logical?.startsWith('timestamp') || /(_at|time|ts)$/.test(n)) return t.logical === 'timestamp-micros' ? 1767225600000000 : 1767225600000
      if (t.logical === 'date') return 20454
      if (/qty|quantity|count/.test(n)) return 1 + (h % 5)
      if (/amount|price|total|minor|cents/.test(n)) return 4999 + (h % 9000)
      return h % 1000
    case 'float':
    case 'double':
      return /amount|price|total/.test(n) ? 129.99 : Math.round((h % 10000) / 7) / 10
    case 'bytes': return 'deadbeef'
    case 'string':
      if (t.logical === 'uuid') return '7c9e6679-7425-40de-944b-e07fc1f90ae7'
      if (/email/.test(n)) return 'ada@example.com'
      if (/currency/.test(n)) return 'EUR'
      if (/country/.test(n)) return 'DE'
      if (/city/.test(n)) return 'Berlin'
      if (/phone/.test(n)) return '+49 30 1234567'
      if (/name/.test(n)) return 'Ada Lovelace'
      if (/id$/.test(n)) return `${n.replace(/_?id$/, '').slice(0, 3) || 'id'}_${h.toString(36).slice(0, 6)}`
      return `${n}-${h.toString(36).slice(0, 4)}`
  }
}

/** Deterministic, realistic-looking record for a writer schema. Unions pick the first non-null branch. */
export function generate(t: AvroType, name = 'value', depth = 0): unknown {
  switch (t.kind) {
    case 'primitive': return sampleFor(name, t)
    case 'enum': return t.symbols[hash(name) % t.symbols.length]
    case 'fixed': return 'f'.repeat(t.size)
    case 'array': return depth > 3 ? [] : [generate(t.items, name + '0', depth + 1), generate(t.items, name + '1', depth + 1)]
    case 'map': return depth > 3 ? {} : { key1: generate(t.values, name, depth + 1) }
    case 'union': {
      const b = t.branches.find((x) => !(x.kind === 'primitive' && x.name === 'null')) ?? t.branches[0]
      return depth > 3 && t.branches.some((x) => x.kind === 'primitive' && x.name === 'null') ? null : generate(b, name, depth + 1)
    }
    case 'record':
      return depth > 4 ? {} : Object.fromEntries(t.fields.map((f) => [f.name, generate(f.type, f.name, depth + 1)]))
  }
}

function conforms(t: AvroType, v: unknown): boolean {
  switch (t.kind) {
    case 'primitive':
      switch (t.name) {
        case 'null': return v === null
        case 'boolean': return typeof v === 'boolean'
        case 'int': case 'long': return Number.isInteger(v)
        case 'float': case 'double': return typeof v === 'number'
        default: return typeof v === 'string'
      }
    case 'enum': return typeof v === 'string' && t.symbols.includes(v)
    case 'fixed': return typeof v === 'string' && v.length === t.size
    case 'array': return Array.isArray(v)
    case 'map': case 'record': return !!v && typeof v === 'object' && !Array.isArray(v)
    case 'union': return t.branches.some((b) => conforms(b, v))
  }
}

const wrap = (t: AvroType): AvroSchema => ({ root: t, named: new Map(), doc: null, warnings: [] })
const readable = (r: AvroType, w: AvroType) => checkAvro(wrap(r), wrap(w), 'reader').length === 0

export function simulate(reader: AvroSchema, writer: AvroSchema, written: unknown = generate(writer.root, 'name' in writer.root ? writer.root.name : 'value')): SimResult {
  const notes: SimNote[] = []
  let ok = true
  function res(r: AvroType, w: AvroType, v: unknown, path: string): unknown {
    if (w.kind === 'union') {
      const wb = w.branches.find((b) => conforms(b, v)) ?? w.branches[0]
      return res(r, wb, v, path)
    }
    if (r.kind === 'union') {
      const rb = r.branches.find((b) => readable(b, w))
      if (!rb) {
        ok = false
        notes.push({ path, kind: 'error', detail: `no branch of ${typeName(r)} can read writer type ${typeName(w)}` })
        return undefined
      }
      if (r.branches.length > 1) notes.push({ path, kind: 'union', detail: `writer ${typeName(w)} resolved to reader branch ${typeName(rb)}` })
      return res(rb, w, v, path)
    }
    if (r.kind === 'record' && w.kind === 'record') {
      const out: Record<string, unknown> = {}
      const src = (v ?? {}) as Record<string, unknown>
      for (const rf of r.fields) {
        const wf = w.fields.find((f) => f.name === rf.name) ?? w.fields.find((f) => rf.aliases.includes(f.name))
        const p = `${path}.${rf.name}`
        if (wf) {
          if (wf.name !== rf.name) notes.push({ path: p, kind: 'promoted', detail: `read from writer field '${wf.name}' via alias` })
          out[rf.name] = res(rf.type, wf.type, src[wf.name], p)
        } else if (rf.hasDefault) {
          out[rf.name] = rf.default
          notes.push({ path: p, kind: 'default', detail: `not in writer, filled with default ${JSON.stringify(rf.default)}` })
        } else {
          ok = false
          notes.push({ path: p, kind: 'error', detail: 'not in writer and has no default: AvroTypeException, record cannot be read' })
        }
      }
      for (const wf of w.fields)
        if (!r.fields.some((rf) => rf.name === wf.name || rf.aliases.includes(wf.name)))
          notes.push({ path: `${path}.${wf.name}`, kind: 'dropped', detail: `written as ${JSON.stringify(src[wf.name])}, skipped by reader` })
      return out
    }
    if (r.kind === 'enum' && w.kind === 'enum') {
      if (r.symbols.includes(v as string)) return v
      if (r.default !== undefined) {
        notes.push({ path, kind: 'enum-default', detail: `symbol ${v} unknown to reader, using enum default ${r.default}` })
        return r.default
      }
      ok = false
      notes.push({ path, kind: 'error', detail: `symbol ${v} unknown to reader and no enum default` })
      return undefined
    }
    if (r.kind === 'array' && w.kind === 'array') return (v as unknown[]).map((x, i) => res(r.items, w.items, x, `${path}[${i}]`))
    if (r.kind === 'map' && w.kind === 'map')
      return Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, res(r.values, w.values, x, `${path}.${k}`)]))
    if (r.kind === 'primitive' && w.kind === 'primitive') {
      if (r.name === w.name) return v
      if (readable(r, w)) {
        notes.push({ path, kind: 'promoted', detail: `${w.name} promoted to ${r.name}` })
        return r.name === 'float' || r.name === 'double' ? Number(v) : v
      }
    }
    if (r.kind === 'fixed' && w.kind === 'fixed' && r.size === w.size) return v
    ok = false
    notes.push({ path, kind: 'error', detail: `reader ${typeName(r)} cannot read writer ${typeName(w)}` })
    return undefined
  }
  const read = res(reader.root, writer.root, written, 'name' in reader.root ? reader.root.name : 'value')
  return { written, read, notes, ok }
}
