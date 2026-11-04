// JSON Schema compatibility, modeled on Confluent's json-schema-provider SchemaDiff:
// a list of differences from the ORIGINAL (writer) to the UPDATE (reader), where anything
// outside the policy's compatible set breaks the check.
import type { Issue, Side, Fix, PatchOp } from './types.ts'
import { esc, getAt } from './patch.ts'
import { SchemaParseError } from './avro.ts'

export type JsonPolicy = 'STRICT' | 'LENIENT'

const STRICT = [
  'ID_CHANGED', 'DESCRIPTION_CHANGED', 'TITLE_CHANGED', 'DEFAULT_CHANGED', 'SCHEMA_REMOVED', 'TYPE_EXTENDED',
  'MAX_LENGTH_INCREASED', 'MAX_LENGTH_REMOVED', 'MIN_LENGTH_DECREASED', 'MIN_LENGTH_REMOVED', 'PATTERN_REMOVED',
  'MAXIMUM_INCREASED', 'MAXIMUM_REMOVED', 'MINIMUM_DECREASED', 'MINIMUM_REMOVED',
  'EXCLUSIVE_MAXIMUM_INCREASED', 'EXCLUSIVE_MAXIMUM_REMOVED', 'EXCLUSIVE_MINIMUM_DECREASED', 'EXCLUSIVE_MINIMUM_REMOVED',
  'MULTIPLE_OF_REDUCED', 'MULTIPLE_OF_REMOVED',
  'REQUIRED_ATTRIBUTE_WITH_DEFAULT_ADDED', 'REQUIRED_ATTRIBUTE_REMOVED',
  'MAX_PROPERTIES_INCREASED', 'MAX_PROPERTIES_REMOVED', 'MIN_PROPERTIES_DECREASED', 'MIN_PROPERTIES_REMOVED',
  'ADDITIONAL_PROPERTIES_ADDED', 'ADDITIONAL_PROPERTIES_EXTENDED',
  'PROPERTY_WITH_EMPTY_SCHEMA_ADDED_TO_OPEN_CONTENT_MODEL', 'REQUIRED_PROPERTY_WITH_DEFAULT_ADDED_TO_UNOPEN_CONTENT_MODEL',
  'OPTIONAL_PROPERTY_ADDED_TO_UNOPEN_CONTENT_MODEL', 'PROPERTY_WITH_FALSE_REMOVED_FROM_CLOSED_CONTENT_MODEL',
  'PROPERTY_REMOVED_FROM_OPEN_CONTENT_MODEL', 'PROPERTY_ADDED_IS_COVERED_BY_PARTIALLY_OPEN_CONTENT_MODEL',
  'PROPERTY_REMOVED_IS_COVERED_BY_PARTIALLY_OPEN_CONTENT_MODEL',
  'MAX_ITEMS_INCREASED', 'MAX_ITEMS_REMOVED', 'MIN_ITEMS_DECREASED', 'MIN_ITEMS_REMOVED', 'UNIQUE_ITEMS_REMOVED',
  'ADDITIONAL_ITEMS_ADDED', 'ADDITIONAL_ITEMS_EXTENDED', 'ITEM_WITH_EMPTY_SCHEMA_ADDED_TO_OPEN_CONTENT_MODEL',
  'ITEM_ADDED_TO_CLOSED_CONTENT_MODEL', 'ITEM_REMOVED_FROM_OPEN_CONTENT_MODEL',
  'ENUM_ARRAY_EXTENDED', 'COMBINED_TYPE_EXTENDED', 'PRODUCT_TYPE_NARROWED', 'SUM_TYPE_EXTENDED', 'NOT_TYPE_NARROWED',
]
const LENIENT_EXTRA = [
  'ADDITIONAL_PROPERTIES_NARROWED', 'ADDITIONAL_PROPERTIES_REMOVED',
  'REQUIRED_PROPERTY_WITH_DEFAULT_ADDED_TO_OPEN_CONTENT_MODEL', 'OPTIONAL_PROPERTY_ADDED_TO_OPEN_CONTENT_MODEL',
  'PROPERTY_REMOVED_FROM_CLOSED_CONTENT_MODEL', 'PROPERTY_ADDED_NOT_COVERED_BY_PARTIALLY_OPEN_CONTENT_MODEL',
  'PROPERTY_REMOVED_NOT_COVERED_BY_PARTIALLY_OPEN_CONTENT_MODEL',
]
const SETS: Record<JsonPolicy, Set<string>> = { STRICT: new Set(STRICT), LENIENT: new Set([...STRICT, ...LENIENT_EXTRA]) }

export function parseJsonSchema(text: string): unknown {
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch (e) {
    throw new SchemaParseError(`Invalid JSON: ${(e as Error).message}`)
  }
  if (typeof doc !== 'boolean' && (!doc || typeof doc !== 'object' || Array.isArray(doc)))
    throw new SchemaParseError('A JSON Schema must be an object or a boolean')
  checkRefs(doc, doc, '')
  return doc
}

function checkRefs(root: unknown, node: any, at: string) {
  if (!node || typeof node !== 'object') return
  if (typeof node.$ref === 'string') {
    if (!node.$ref.startsWith('#')) throw new SchemaParseError(`External $ref "${node.$ref}" at ${at || '#'} is not supported: inline it or use a local #/... reference`)
    if (getAt(root, node.$ref.slice(1)) === undefined) throw new SchemaParseError(`Unresolved $ref "${node.$ref}" at ${at || '#'}`)
  }
  for (const k of Object.keys(node)) checkRefs(root, node[k], `${at}/${k}`)
}

interface Node {
  s: any
  ptr: string
}

interface Ctx {
  origDoc: unknown
  updDoc: unknown
  newer: Side
  policy: JsonPolicy
  out: Issue[]
  stack: Set<string>
}

const COMBOS = ['oneOf', 'anyOf', 'allOf'] as const

function deref(doc: unknown, n: Node): Node {
  let { s, ptr } = n
  for (let i = 0; i < 32 && s && typeof s === 'object' && typeof s.$ref === 'string'; i++) {
    ptr = s.$ref.slice(1)
    s = getAt(doc, ptr)
  }
  return { s, ptr }
}

/** A schema's everit-style class: same class or the comparison stops at TYPE_CHANGED. */
function classOf(s: any): string {
  if (s === false) return 'false'
  if (s === true) return 'empty'
  if (combo(s)) return 'combined'
  if (Array.isArray(s.enum)) return 'enum'
  if ('const' in s) return 'const'
  if (s.not !== undefined) return 'not'
  const t = s.type
  if (t === 'integer' || t === 'number') return 'number'
  if (typeof t === 'string') return t
  if (s.properties || s.additionalProperties !== undefined || s.required || s.patternProperties || s.minProperties !== undefined || s.maxProperties !== undefined) return 'object'
  if (s.items !== undefined || s.prefixItems || s.maxItems !== undefined || s.minItems !== undefined || s.uniqueItems !== undefined) return 'array'
  if (s.maxLength !== undefined || s.minLength !== undefined || s.pattern !== undefined) return 'string'
  if (s.maximum !== undefined || s.minimum !== undefined || s.multipleOf !== undefined || s.exclusiveMaximum !== undefined || s.exclusiveMinimum !== undefined) return 'number'
  return 'empty'
}

/** A type array is a sum type: {"type":["string","null"]} behaves as anyOf of each type. */
function combo(s: any): { crit: string; subs: (ptr: string) => Node[] } | undefined {
  if (!s || typeof s !== 'object') return undefined
  if (Array.isArray(s.type) && s.type.length > 1)
    return { crit: 'anyOf', subs: (ptr) => s.type.map((t: string) => ({ s: { ...s, type: t }, ptr })) }
  if (Array.isArray(s.type) && s.type.length === 1) return combo({ ...s, type: s.type[0] })
  for (const k of COMBOS)
    if (Array.isArray(s[k])) return { crit: k, subs: (ptr) => s[k].map((b: unknown, i: number) => ({ s: b, ptr: `${ptr}/${k}/${i}` })) }
  return undefined
}

const single = (s: any) => (s && Array.isArray(s.type) && s.type.length === 1 ? { ...s, type: s.type[0] } : s)
const hasDefault = (s: any) => !!s && typeof s === 'object' && 'default' in s
const humanOf = (ptr: string) => ptr.replace(/\/properties\//g, '.').replace(/\/items/g, '[]').replace(/\/(oneOf|anyOf|allOf)\/(\d+)/g, '<$1 $2>').replace(/^\./, '').replace(/^\//, '').replace(/~1/g, '/').replace(/~0/g, '~') || '(root)'

function description(type: string, path: string, a: string, b: string): string {
  const has = (...t: string[]) => t.includes(type)
  if (/(_ADDED)$/.test(type) && has('MAXIMUM_ADDED', 'MINIMUM_ADDED', 'EXCLUSIVE_MAXIMUM_ADDED', 'EXCLUSIVE_MINIMUM_ADDED', 'MULTIPLE_OF_ADDED', 'MAX_LENGTH_ADDED', 'MIN_LENGTH_ADDED', 'PATTERN_ADDED', 'REQUIRED_ATTRIBUTE_ADDED', 'MAX_PROPERTIES_ADDED', 'MIN_PROPERTIES_ADDED', 'MAX_ITEMS_ADDED', 'MIN_ITEMS_ADDED', 'UNIQUE_ITEMS_ADDED') || has('ADDITIONAL_ITEMS_REMOVED', 'ADDITIONAL_PROPERTIES_REMOVED'))
    return `The keyword at path '${path}' in the ${a} schema is not present in the ${b} schema`
  if (has('MIN_LENGTH_INCREASED', 'MINIMUM_INCREASED', 'EXCLUSIVE_MINIMUM_INCREASED', 'MIN_PROPERTIES_INCREASED', 'MULTIPLE_OF_EXPANDED', 'MIN_ITEMS_INCREASED'))
    return `The value at path '${path}' in the ${a} schema is more than its value in the ${b} schema`
  if (has('MAX_LENGTH_DECREASED', 'MAXIMUM_DECREASED', 'MAX_ITEMS_DECREASED', 'EXCLUSIVE_MAXIMUM_DECREASED', 'MAX_PROPERTIES_DECREASED'))
    return `The value at path '${path}' in the ${a} schema is less than its value in the ${b} schema`
  if (has('PATTERN_CHANGED', 'MULTIPLE_OF_CHANGED')) return `The value at path '${path}' is different between the ${a} and ${b} schema`
  if (has('ADDITIONAL_ITEMS_NARROWED', 'ENUM_ARRAY_NARROWED', 'SUM_TYPE_NARROWED', 'ADDITIONAL_PROPERTIES_NARROWED'))
    return `An array or combined type at path '${path}' has fewer elements in the ${a} schema than the ${b} schema`
  if (has('PRODUCT_TYPE_EXTENDED', 'SUM_TYPE_EXTENDED', 'NOT_TYPE_EXTENDED'))
    return `An array or combined type at path '${path}' has more elements in the ${a} schema than the ${b} schema`
  if (has('TYPE_CHANGED', 'TYPE_NARROWED', 'COMBINED_TYPE_CHANGED', 'COMBINED_TYPE_SUBSCHEMAS_CHANGED', 'ENUM_ARRAY_CHANGED'))
    return `A type at path '${path}' is different between the ${a} schema and the ${b} schema`
  if (has('REQUIRED_PROPERTY_ADDED_TO_OPEN_CONTENT_MODEL', 'REQUIRED_PROPERTY_WITH_DEFAULT_ADDED_TO_OPEN_CONTENT_MODEL', 'OPTIONAL_PROPERTY_ADDED_TO_OPEN_CONTENT_MODEL', 'ITEM_ADDED_TO_OPEN_CONTENT_MODEL'))
    return `The ${a} schema has an open content model and has a property or item at path '${path}' which is missing in the ${b} schema`
  if (type === 'REQUIRED_PROPERTY_ADDED_TO_UNOPEN_CONTENT_MODEL')
    return `The ${a} schema has an unopen content model and has a required property at path '${path}' which is missing in the ${b} schema`
  if (has('PROPERTY_REMOVED_FROM_CLOSED_CONTENT_MODEL', 'ITEM_REMOVED_FROM_CLOSED_CONTENT_MODEL'))
    return `The ${a} schema has a closed content model and is missing a property or item present at path '${path}' in the ${b} schema`
  if (type === 'PROPERTY_REMOVED_NOT_COVERED_BY_PARTIALLY_OPEN_CONTENT_MODEL')
    return `A property or item is missing in the ${a} schema but present at path '${path}' in the ${b} schema and is not covered by its partially open content model`
  if (type === 'PROPERTY_ADDED_NOT_COVERED_BY_PARTIALLY_OPEN_CONTENT_MODEL')
    return `The ${a} schema has a property or item at path '${path}' which is missing in the ${b} schema and is not covered by its partially open content model`
  return `${type} at path '${path}'`
}

/**
 * Differences for reader = update, writer = original. Forward checks call this with the sides
 * swapped, exactly as the registry does. `newer` says which side is being registered.
 */
export function checkJsonSchema(reader: unknown, writer: unknown, newer: Side, policy: JsonPolicy = 'STRICT'): Issue[] {
  const ctx: Ctx = { origDoc: writer, updDoc: reader, newer, policy, out: [], stack: new Set() }
  compare(ctx, { s: writer, ptr: '' }, { s: reader, ptr: '' })
  return ctx.out
}

function add(ctx: Ctx, type: string, o: Node, u: Node, info?: string, fix?: Fix) {
  const compatible = SETS[ctx.policy].has(type)
  const ptr = u.ptr || o.ptr
  const newerPtr = ctx.newer === 'reader' ? u.ptr : o.ptr
  const [a, b] = ctx.newer === 'reader' ? ['new', 'old'] : ['old', 'new']
  ctx.out.push({ type, compatible, path: '#' + ptr, field: humanOf(newerPtr), message: description(type, '#' + ptr, a, b), info, fix: compatible ? undefined : fix })
}

function probe(ctx: Ctx, o: Node, u: Node) {
  const sub: Ctx = { ...ctx, out: [], stack: new Set(ctx.stack) }
  compare(sub, o, u)
  return { diffs: sub.out, ok: sub.out.every((i) => i.compatible) }
}

function compare(ctx: Ctx, o0: Node, u0: Node) {
  const o = deref(ctx.origDoc, o0)
  const u = deref(ctx.updDoc, u0)
  if (o.s === undefined && u.s === undefined) return
  if (o.s === undefined) return add(ctx, 'SCHEMA_ADDED', o, u, undefined, revert(ctx, o, u))
  if (u.s === undefined) return add(ctx, 'SCHEMA_REMOVED', o, u)
  const key = o.ptr + '|' + u.ptr
  if (ctx.stack.has(key)) return // a cycle through $ref: treated as compatible
  ctx.stack.add(key)
  compareTypes(ctx, o, u)
  ctx.stack.delete(key)
}

function compareTypes(ctx: Ctx, o: Node, u: Node) {
  const oc = combo(o.s), uc = combo(u.s)
  if (!oc && uc) {
    const subs = uc.subs(u.ptr)
    if (subs.length === 1) {
      const p = probe(ctx, o, subs[0])
      if (p.ok) return void ctx.out.push(...p.diffs)
    } else if (uc.crit !== 'allOf') {
      for (const sub of subs) {
        const p = probe(ctx, o, sub)
        if (p.ok) {
          ctx.out.push(...p.diffs)
          return add(ctx, 'SUM_TYPE_EXTENDED', o, u)
        }
      }
    }
  } else if (oc && !uc) {
    const subs = oc.subs(o.ptr)
    if (subs.length === 1) {
      const p = probe(ctx, subs[0], u)
      if (p.ok) return void ctx.out.push(...p.diffs)
    } else if (oc.crit === 'allOf') {
      for (const sub of subs) {
        const p = probe(ctx, sub, u)
        if (p.ok) {
          ctx.out.push(...p.diffs)
          return add(ctx, 'PRODUCT_TYPE_NARROWED', o, u)
        }
      }
    }
  }
  const os = single(o.s), us = single(u.s)
  const cO = classOf(os), cU = classOf(us)
  const enumish = (c: string) => c === 'enum' || c === 'const'
  if (cO !== cU && !(enumish(cO) && enumish(cU))) {
    if (cO === 'false' || cU === 'empty') return
    return add(ctx, 'TYPE_CHANGED', o, u, `${cO} → ${cU}`, typeFix(ctx, o, u))
  }
  if (cO === 'false' || cO === 'empty') return
  for (const [k, t] of [['$id', 'ID_CHANGED'], ['title', 'TITLE_CHANGED'], ['description', 'DESCRIPTION_CHANGED'], ['default', 'DEFAULT_CHANGED']] as const)
    if (JSON.stringify(os[k]) !== JSON.stringify(us[k])) add(ctx, t, o, u, `${JSON.stringify(os[k]) ?? 'none'} → ${JSON.stringify(us[k]) ?? 'none'}`)

  if (cO === 'combined') return compareCombined(ctx, o, u, oc!, uc!)
  if (enumish(cO)) return compareEnum(ctx, o, u)
  if (cO === 'not') {
    const a: Node = { s: os.not, ptr: `${o.ptr}/not` }, b: Node = { s: us.not, ptr: `${u.ptr}/not` }
    if (JSON.stringify(os.not) === JSON.stringify(us.not)) return
    if (probe(ctx, a, b).ok) return add(ctx, 'NOT_TYPE_EXTENDED', o, u, undefined, revert(ctx, o, u))
    if (probe(ctx, b, a).ok) return add(ctx, 'NOT_TYPE_NARROWED', o, u)
    return add(ctx, 'TYPE_CHANGED', o, u, 'not', revert(ctx, o, u))
  }
  if (cO === 'string') {
    limit(ctx, o, u, 'maxLength', 'MAX_LENGTH', 'max')
    limit(ctx, o, u, 'minLength', 'MIN_LENGTH', 'min')
    const a = os.pattern, b = us.pattern
    if (a !== b) {
      const at: [Node, Node] = [{ s: a, ptr: `${o.ptr}/pattern` }, { s: b, ptr: `${u.ptr}/pattern` }]
      if (a === undefined) add(ctx, 'PATTERN_ADDED', ...at, b, revertKey(ctx, o, u, 'pattern'))
      else if (b === undefined) add(ctx, 'PATTERN_REMOVED', ...at)
      else add(ctx, 'PATTERN_CHANGED', ...at, `${a} → ${b}`, revertKey(ctx, o, u, 'pattern'))
    }
  }
  if (cO === 'number') {
    limit(ctx, o, u, 'maximum', 'MAXIMUM', 'max')
    limit(ctx, o, u, 'minimum', 'MINIMUM', 'min')
    limit(ctx, o, u, 'exclusiveMaximum', 'EXCLUSIVE_MAXIMUM', 'max')
    limit(ctx, o, u, 'exclusiveMinimum', 'EXCLUSIVE_MINIMUM', 'min')
    const a = os.multipleOf, b = us.multipleOf
    if (a !== b) {
      const at: [Node, Node] = [{ s: a, ptr: `${o.ptr}/multipleOf` }, { s: b, ptr: `${u.ptr}/multipleOf` }]
      const fix = revertKey(ctx, o, u, 'multipleOf')
      if (a === undefined) add(ctx, 'MULTIPLE_OF_ADDED', ...at, String(b), fix)
      else if (b === undefined) add(ctx, 'MULTIPLE_OF_REMOVED', ...at)
      else if (a !== 0 && b % a === 0) add(ctx, 'MULTIPLE_OF_EXPANDED', ...at, `${a} → ${b}`, fix)
      else if (b !== 0 && a % b === 0) add(ctx, 'MULTIPLE_OF_REDUCED', ...at, `${a} → ${b}`)
      else add(ctx, 'MULTIPLE_OF_CHANGED', ...at, `${a} → ${b}`, fix)
    }
    if ((os.type === 'integer') !== (us.type === 'integer')) {
      if (os.type === 'integer') add(ctx, 'TYPE_EXTENDED', o, u, 'integer → number')
      else add(ctx, 'TYPE_NARROWED', o, u, 'number → integer', revertKey(ctx, o, u, 'type'))
    }
  }
  if (cO === 'object') compareObject(ctx, o, u)
  if (cO === 'array') compareArray(ctx, o, u)
}

function compareEnum(ctx: Ctx, o: Node, u: Node) {
  const vals = (s: any): string[] => (Array.isArray(s.enum) ? s.enum : [s.const]).map((x: unknown) => JSON.stringify(x))
  const a = vals(single(o.s)), b = vals(single(u.s))
  const same = a.length === b.length && a.every((x) => b.includes(x))
  if (same) return
  const at: [Node, Node] = [{ s: o.s.enum, ptr: `${o.ptr}/enum` }, { s: u.s.enum, ptr: `${u.ptr}/enum` }]
  const removed = a.filter((x) => !b.includes(x)), added = b.filter((x) => !a.includes(x))
  if (a.every((x) => b.includes(x))) add(ctx, 'ENUM_ARRAY_EXTENDED', ...at, `added ${added.join(', ')}`)
  else if (b.every((x) => a.includes(x))) add(ctx, 'ENUM_ARRAY_NARROWED', ...at, `removed ${removed.join(', ')}`, enumFix(ctx, o, u, removed, added))
  else add(ctx, 'ENUM_ARRAY_CHANGED', ...at, `removed ${removed.join(', ')}; added ${added.join(', ')}`, enumFix(ctx, o, u, removed, added))
}

function compareObject(ctx: Ctx, o: Node, u: Node) {
  const os = single(o.s), us = single(u.s)
  const permits = (s: any) => s.additionalProperties !== false
  const apSchema = (s: any) => (s.additionalProperties && typeof s.additionalProperties === 'object' && Object.keys(s.additionalProperties).length ? s.additionalProperties : null)
  const open = (s: any) => permits(s) && !apSchema(s) && !Object.keys(s.patternProperties ?? {}).length
  const partial = (s: any, name: string): Node | null => {
    for (const [p, v] of Object.entries(s.patternProperties ?? {})) if (new RegExp(p).test(name)) return { s: v, ptr: `/patternProperties/${esc(p)}` }
    return apSchema(s) ? { s: apSchema(s), ptr: '/additionalProperties' } : null
  }
  const op = os.properties ?? {}, up = us.properties ?? {}
  const oreq: string[] = os.required ?? [], ureq: string[] = us.required ?? []
  const propO = (n: string): Node => ({ s: op[n], ptr: `${o.ptr}/properties/${esc(n)}` })
  const propU = (n: string): Node => ({ s: up[n], ptr: `${u.ptr}/properties/${esc(n)}` })

  for (const n of Object.keys(op)) {
    if (!(n in up)) continue
    const req = ureq.includes(n), was = oreq.includes(n)
    if (was && !req) add(ctx, 'REQUIRED_ATTRIBUTE_REMOVED', propO(n), propU(n), n)
    else if (!was && req) {
      if (hasDefault(deref(ctx.updDoc, propU(n)).s)) add(ctx, 'REQUIRED_ATTRIBUTE_WITH_DEFAULT_ADDED', propO(n), propU(n), n)
      else add(ctx, 'REQUIRED_ATTRIBUTE_ADDED', propO(n), propU(n), n, requiredFix(ctx, o, u, n))
    }
  }
  for (const n of [...new Set([...Object.keys(op), ...Object.keys(up)])]) {
    const a = propO(n), b = propU(n)
    if (!(n in up)) {
      if (open(us)) add(ctx, 'PROPERTY_REMOVED_FROM_OPEN_CONTENT_MODEL', a, b, n)
      else {
        const par = partial(us, n)
        if (par) {
          const p = probe(ctx, a, { s: par.s, ptr: u.ptr + par.ptr })
          add(ctx, p.ok ? 'PROPERTY_REMOVED_IS_COVERED_BY_PARTIALLY_OPEN_CONTENT_MODEL' : 'PROPERTY_REMOVED_NOT_COVERED_BY_PARTIALLY_OPEN_CONTENT_MODEL', a, b, n, restore(ctx, o, u, n))
        } else if (op[n] === false) add(ctx, 'PROPERTY_WITH_FALSE_REMOVED_FROM_CLOSED_CONTENT_MODEL', a, b, n)
        else add(ctx, 'PROPERTY_REMOVED_FROM_CLOSED_CONTENT_MODEL', a, b, n, restore(ctx, o, u, n))
      }
    } else if (!(n in op)) {
      const req = ureq.includes(n), def = hasDefault(deref(ctx.updDoc, b).s)
      if (open(os)) {
        if (classOf(up[n]) === 'empty') add(ctx, 'PROPERTY_WITH_EMPTY_SCHEMA_ADDED_TO_OPEN_CONTENT_MODEL', a, b, n)
        else add(ctx, req ? (def ? 'REQUIRED_PROPERTY_WITH_DEFAULT_ADDED_TO_OPEN_CONTENT_MODEL' : 'REQUIRED_PROPERTY_ADDED_TO_OPEN_CONTENT_MODEL') : 'OPTIONAL_PROPERTY_ADDED_TO_OPEN_CONTENT_MODEL', a, b, n, openAddFix(ctx, o, u, n))
      } else {
        const par = partial(os, n)
        if (par) {
          const p = probe(ctx, { s: par.s, ptr: o.ptr + par.ptr }, b)
          add(ctx, p.ok ? 'PROPERTY_ADDED_IS_COVERED_BY_PARTIALLY_OPEN_CONTENT_MODEL' : 'PROPERTY_ADDED_NOT_COVERED_BY_PARTIALLY_OPEN_CONTENT_MODEL', a, b, n, restore(ctx, o, u, n))
        }
        if (req) add(ctx, def ? 'REQUIRED_PROPERTY_WITH_DEFAULT_ADDED_TO_UNOPEN_CONTENT_MODEL' : 'REQUIRED_PROPERTY_ADDED_TO_UNOPEN_CONTENT_MODEL', a, b, n, requiredFix(ctx, o, u, n))
        else add(ctx, 'OPTIONAL_PROPERTY_ADDED_TO_UNOPEN_CONTENT_MODEL', a, b, n)
      }
    } else compare(ctx, a, b)
  }

  const apO: Node = { s: os.additionalProperties, ptr: `${o.ptr}/additionalProperties` }
  const apU: Node = { s: us.additionalProperties, ptr: `${u.ptr}/additionalProperties` }
  const fix = revertKey(ctx, o, u, 'additionalProperties')
  if (permits(os) !== permits(us)) {
    if (permits(us)) add(ctx, 'ADDITIONAL_PROPERTIES_ADDED', apO, apU)
    else add(ctx, 'ADDITIONAL_PROPERTIES_REMOVED', apO, apU, undefined, fix)
  } else if (!apSchema(os) && apSchema(us)) add(ctx, 'ADDITIONAL_PROPERTIES_NARROWED', apO, apU, undefined, fix)
  else if (apSchema(os) && !apSchema(us)) add(ctx, 'ADDITIONAL_PROPERTIES_EXTENDED', apO, apU)
  else if (apSchema(os)) compare(ctx, apO, apU)
  limit(ctx, o, u, 'maxProperties', 'MAX_PROPERTIES', 'max')
  limit(ctx, o, u, 'minProperties', 'MIN_PROPERTIES', 'min')
}

function compareArray(ctx: Ctx, o: Node, u: Node) {
  const os = single(o.s), us = single(u.s)
  const tuple = (s: any): any[] | null => s.prefixItems ?? (Array.isArray(s.items) ? s.items : null)
  const tO = tuple(os), tU = tuple(us)
  const key = (s: any) => (s.prefixItems ? 'prefixItems' : 'items')
  if (!tO && !tU) {
    if (os.items !== undefined || us.items !== undefined) compare(ctx, { s: os.items ?? true, ptr: `${o.ptr}/items` }, { s: us.items ?? true, ptr: `${u.ptr}/items` })
  } else if (tO && tU) {
    const addO = os.additionalItems !== false, addU = us.additionalItems !== false
    for (let i = 0; i < Math.max(tO.length, tU.length); i++) {
      const a: Node = { s: tO[i], ptr: `${o.ptr}/${key(os)}/${i}` }, b: Node = { s: tU[i], ptr: `${u.ptr}/${key(us)}/${i}` }
      if (i >= tO.length) add(ctx, addO ? (classOf(tU[i]) === 'empty' ? 'ITEM_WITH_EMPTY_SCHEMA_ADDED_TO_OPEN_CONTENT_MODEL' : 'ITEM_ADDED_TO_OPEN_CONTENT_MODEL') : 'ITEM_ADDED_TO_CLOSED_CONTENT_MODEL', a, b, String(i), revert(ctx, a, b))
      else if (i >= tU.length) add(ctx, addU ? 'ITEM_REMOVED_FROM_OPEN_CONTENT_MODEL' : 'ITEM_REMOVED_FROM_CLOSED_CONTENT_MODEL', a, b, String(i), revert(ctx, a, b))
      else compare(ctx, a, b)
    }
    if (addO !== addU) {
      const at: [Node, Node] = [{ s: os.additionalItems, ptr: `${o.ptr}/additionalItems` }, { s: us.additionalItems, ptr: `${u.ptr}/additionalItems` }]
      if (addU) add(ctx, 'ADDITIONAL_ITEMS_ADDED', ...at)
      else add(ctx, 'ADDITIONAL_ITEMS_REMOVED', ...at, undefined, revertKey(ctx, o, u, 'additionalItems'))
    }
  } else add(ctx, 'TYPE_CHANGED', o, u, 'list items ↔ tuple items', revert(ctx, o, u))
  limit(ctx, o, u, 'maxItems', 'MAX_ITEMS', 'max')
  limit(ctx, o, u, 'minItems', 'MIN_ITEMS', 'min')
  if (!!os.uniqueItems !== !!us.uniqueItems) {
    const at: [Node, Node] = [{ s: os.uniqueItems, ptr: `${o.ptr}/uniqueItems` }, { s: us.uniqueItems, ptr: `${u.ptr}/uniqueItems` }]
    if (us.uniqueItems) add(ctx, 'UNIQUE_ITEMS_ADDED', ...at, undefined, revertKey(ctx, o, u, 'uniqueItems'))
    else add(ctx, 'UNIQUE_ITEMS_REMOVED', ...at)
  }
}

function compareCombined(ctx: Ctx, o: Node, u: Node, oc: NonNullable<ReturnType<typeof combo>>, uc: NonNullable<ReturnType<typeof combo>>) {
  const unique = (ns: Node[]) => ns.filter((n, i) => ns.findIndex((m) => JSON.stringify(m.s) === JSON.stringify(n.s)) === i)
  const a = unique(oc.subs(o.ptr)), b = unique(uc.subs(u.ptr))
  if (oc.crit !== uc.crit) {
    const widen = uc.crit === 'anyOf' || (a.length === 1 && b.length === 1) || (a.length === 1 && uc.crit === 'oneOf') || (b.length === 1 && oc.crit === 'allOf')
    if (!widen) return add(ctx, 'COMBINED_TYPE_CHANGED', o, u, `${oc.crit} → ${uc.crit}`, revert(ctx, o, u))
    add(ctx, 'COMBINED_TYPE_EXTENDED', o, u, `${oc.crit} → ${uc.crit}`)
  }
  const fix = revert(ctx, o, u)
  if (a.length < b.length) add(ctx, uc.crit === 'allOf' ? 'PRODUCT_TYPE_EXTENDED' : 'SUM_TYPE_EXTENDED', o, u, `${a.length} → ${b.length} subschemas`, fix)
  else if (a.length > b.length) add(ctx, oc.crit === 'allOf' ? 'PRODUCT_TYPE_NARROWED' : 'SUM_TYPE_NARROWED', o, u, `${a.length} → ${b.length} subschemas`, fix)

  // Maximum bipartite matching over compatible subschema pairs (Kuhn's augmenting paths).
  const edges = a.map((x) => b.map((y) => probe(ctx, x, y)))
  const matchB = new Array<number>(b.length).fill(-1)
  const augment = (i: number, seen: Set<number>): boolean => {
    for (let j = 0; j < b.length; j++) {
      if (!edges[i][j].ok || seen.has(j)) continue
      seen.add(j)
      if (matchB[j] < 0 || augment(matchB[j], seen)) {
        matchB[j] = i
        return true
      }
    }
    return false
  }
  let matched = 0
  for (let i = 0; i < a.length; i++) if (augment(i, new Set())) matched++
  matchB.forEach((i, j) => {
    if (i >= 0) ctx.out.push(...edges[i][j].diffs)
  })
  if (matched < Math.min(a.length, b.length)) add(ctx, 'COMBINED_TYPE_SUBSCHEMAS_CHANGED', o, u, undefined, fix)
}

function limit(ctx: Ctx, o: Node, u: Node, key: string, base: string, _sense: 'max' | 'min') {
  const a = single(o.s)[key], b = single(u.s)[key]
  if (a === b || typeof a === 'boolean' || typeof b === 'boolean') return
  const t = a === undefined ? `${base}_ADDED` : b === undefined ? `${base}_REMOVED` : b > a ? `${base}_INCREASED` : `${base}_DECREASED`
  add(ctx, t, { s: a, ptr: `${o.ptr}/${key}` }, { s: b, ptr: `${u.ptr}/${key}` }, `${a ?? 'none'} → ${b ?? 'none'}`, revertKey(ctx, o, u, key))
}

// ---- fixes: always edit the newer document ----

function revert(ctx: Ctx, o: Node, u: Node): Fix {
  const [nPtr, oVal] = ctx.newer === 'reader' ? [u.ptr, o.s] : [o.ptr, u.s]
  return { label: 'Revert this subschema to the previous version', ops: [oVal === undefined ? { op: 'remove', ptr: nPtr } : { op: 'set', ptr: nPtr, value: oVal }] }
}

function revertKey(ctx: Ctx, o: Node, u: Node, key: string): Fix {
  const [nPtr, oVal] = ctx.newer === 'reader' ? [u.ptr, o.s?.[key]] : [o.ptr, u.s?.[key]]
  return {
    label: oVal === undefined ? `Remove "${key}" from the new version` : `Restore "${key}": ${JSON.stringify(oVal)}`,
    ops: [oVal === undefined ? { op: 'remove', ptr: `${nPtr}/${key}` } : { op: 'set', ptr: `${nPtr}/${key}`, value: oVal }],
  }
}

function typeFix(ctx: Ctx, o: Node, u: Node): Fix {
  const a = o.s?.type, b = u.s?.type
  if (ctx.newer === 'reader' && typeof a === 'string' && (typeof b === 'string' || Array.isArray(b)))
    return { label: `Accept both types: "type": ${JSON.stringify([a, ...[b].flat().filter((t) => t !== a)])}`, ops: [{ op: 'set', ptr: `${u.ptr}/type`, value: [a, ...[b].flat().filter((t) => t !== a)] }] }
  return revert(ctx, o, u)
}

/** Restore a property on the newer side to what the older side says (or remove it if the older side lacks it). */
function restore(ctx: Ctx, o: Node, u: Node, name: string): Fix {
  const [nNode, oNode] = ctx.newer === 'reader' ? [u, o] : [o, u]
  const oProp = oNode.s.properties?.[name]
  const ptr = `${nNode.ptr}/properties/${esc(name)}`
  if (oProp === undefined)
    return { label: `Remove property '${name}' from the new version`, ops: [{ op: 'remove', ptr }, ...(nNode.s.required?.includes(name) ? [{ op: 'set', ptr: `${nNode.ptr}/required`, value: nNode.s.required.filter((r: string) => r !== name) } as PatchOp] : [])] }
  return { label: `Restore property '${name}'`, ops: [{ op: 'set', ptr: `${nNode.ptr}/properties`, value: { ...(nNode.s.properties ?? {}), [name]: oProp } }] }
}

function openAddFix(ctx: Ctx, o: Node, u: Node, name: string): Fix {
  if (ctx.newer !== 'reader') return restore(ctx, o, u, name)
  const req: string[] = u.s.required ?? []
  const ops: PatchOp[] = [{ op: 'set', ptr: `${u.ptr}/properties/${esc(name)}`, value: {} }]
  if (req.includes(name)) ops.push({ op: 'set', ptr: `${u.ptr}/required`, value: req.filter((r) => r !== name) })
  return { label: `Relax '${name}' to an empty schema {}`, ops }
}

function zeroFor(s: any): unknown {
  if (Array.isArray(s?.enum)) return s.enum[0]
  const t = [s?.type].flat()
  if (t.includes('null')) return null
  if (t[0] === 'string') return ''
  if (t[0] === 'integer' || t[0] === 'number') return s.minimum ?? 0
  if (t[0] === 'boolean') return false
  if (t[0] === 'array') return []
  if (t[0] === 'object') return {}
  return null
}

function requiredFix(ctx: Ctx, o: Node, u: Node, name: string): Fix {
  if (ctx.newer === 'reader') {
    const p = deref(ctx.updDoc, { s: u.s.properties?.[name], ptr: `${u.ptr}/properties/${esc(name)}` })
    if (p.s && typeof p.s === 'object') {
      const v = zeroFor(p.s)
      return { label: `Add "default": ${JSON.stringify(v)} to '${name}'`, ops: [{ op: 'set', ptr: `${p.ptr}/default`, value: v }] }
    }
    return { label: `Make '${name}' optional again`, ops: [{ op: 'set', ptr: `${u.ptr}/required`, value: (u.s.required ?? []).filter((r: string) => r !== name) }] }
  }
  // The newer schema is the writer, the old reader insists on this property: the new version must keep sending it.
  const ops: PatchOp[] = [{ op: 'set', ptr: `${o.ptr}/required`, value: [...new Set([...(o.s.required ?? []), name])] }]
  if (o.s.properties?.[name] === undefined) ops.push({ op: 'set', ptr: `${o.ptr}/properties`, value: { ...(o.s.properties ?? {}), [name]: u.s.properties?.[name] ?? {} } })
  return { label: `Keep '${name}' required in the new version`, ops }
}

function enumFix(ctx: Ctx, o: Node, u: Node, removed: string[], added: string[]): Fix {
  if (ctx.newer === 'reader') {
    if (!Array.isArray(u.s.enum)) return revert(ctx, o, u)
    return { label: `Add back ${removed.join(', ')}`, ops: [{ op: 'set', ptr: `${u.ptr}/enum`, value: [...u.s.enum, ...removed.map((x) => JSON.parse(x))] }] }
  }
  if (!Array.isArray(o.s.enum)) return revert(ctx, o, u)
  return { label: `Remove ${added.length ? 'values the old consumers reject' : 'new values'}: ${removed.join(', ')}`, ops: [{ op: 'set', ptr: `${o.ptr}/enum`, value: o.s.enum.filter((x: unknown) => !removed.includes(JSON.stringify(x))) }] }
}
