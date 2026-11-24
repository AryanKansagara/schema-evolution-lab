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
  'DEPENDENCY_ARRAY_NARROWED', 'DEPENDENCY_ARRAY_REMOVED', 'DEPENDENCY_SCHEMA_REMOVED',
  'MAX_PROPERTIES_INCREASED', 'MAX_PROPERTIES_REMOVED', 'MIN_PROPERTIES_DECREASED', 'MIN_PROPERTIES_REMOVED',
  'ADDITIONAL_PROPERTIES_ADDED', 'ADDITIONAL_PROPERTIES_EXTENDED', 'UNEVALUATED_PROPERTIES_ADDED', 'UNEVALUATED_PROPERTIES_EXTENDED',
  'PROPERTY_WITH_EMPTY_SCHEMA_ADDED_TO_OPEN_CONTENT_MODEL', 'REQUIRED_PROPERTY_WITH_DEFAULT_ADDED_TO_UNOPEN_CONTENT_MODEL',
  'OPTIONAL_PROPERTY_ADDED_TO_UNOPEN_CONTENT_MODEL', 'PROPERTY_WITH_FALSE_REMOVED_FROM_CLOSED_CONTENT_MODEL',
  'PROPERTY_REMOVED_FROM_OPEN_CONTENT_MODEL', 'PROPERTY_ADDED_IS_COVERED_BY_PARTIALLY_OPEN_CONTENT_MODEL',
  'PROPERTY_REMOVED_IS_COVERED_BY_PARTIALLY_OPEN_CONTENT_MODEL',
  'MAX_ITEMS_INCREASED', 'MAX_ITEMS_REMOVED', 'MIN_ITEMS_DECREASED', 'MIN_ITEMS_REMOVED', 'UNIQUE_ITEMS_REMOVED',
  'MAX_CONTAINS_INCREASED', 'MAX_CONTAINS_REMOVED', 'MIN_CONTAINS_DECREASED', 'MIN_CONTAINS_REMOVED',
  'ADDITIONAL_ITEMS_ADDED', 'ADDITIONAL_ITEMS_EXTENDED', 'UNEVALUATED_ITEMS_ADDED', 'UNEVALUATED_ITEMS_EXTENDED',
  'ITEM_WITH_EMPTY_SCHEMA_ADDED_TO_OPEN_CONTENT_MODEL', 'ITEM_ADDED_TO_CLOSED_CONTENT_MODEL', 'ITEM_WITH_FALSE_REMOVED_FROM_CLOSED_CONTENT_MODEL',
  'ITEM_REMOVED_FROM_OPEN_CONTENT_MODEL', 'ITEM_ADDED_IS_COVERED_BY_PARTIALLY_OPEN_CONTENT_MODEL', 'ITEM_REMOVED_IS_COVERED_BY_PARTIALLY_OPEN_CONTENT_MODEL',
  'ENUM_ARRAY_EXTENDED', 'COMBINED_TYPE_EXTENDED', 'PRODUCT_TYPE_NARROWED', 'SUM_TYPE_EXTENDED', 'NOT_TYPE_NARROWED',
]
const LENIENT_EXTRA = [
  'ADDITIONAL_PROPERTIES_NARROWED', 'ADDITIONAL_PROPERTIES_REMOVED', 'UNEVALUATED_PROPERTIES_NARROWED', 'UNEVALUATED_PROPERTIES_REMOVED',
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
  /** JSON pointer of this schema inside its own document (where fixes are applied). */
  ptr: string
  /** Location as the registry reports it: shared by both sides and not rewritten by $ref. */
  path: string
  /** Set on a synthetic part of a schema (see combo): the schema it was split from. */
  whole?: Node
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
const KINDS = ['enum', 'const', 'not', ...COMBOS] as const
const ANNOTATIONS = ['$id', 'title', 'description', 'default']

const join = (path: string, seg: string) => (path ? `${path}/${seg}` : seg)
/** A child schema: `seg` extends the reported path, `pseg` (escaped) the JSON pointer. */
const kid = (n: Node, s: any, seg: string, pseg = seg): Node => ({ s, ptr: `${n.ptr}/${pseg}`, path: join(n.path, seg) })
const at = (n: Node, path: string): Node => ({ ...n, path })

function deref(doc: unknown, n: Node): Node {
  let { s, ptr } = n
  for (let i = 0; i < 32 && s && typeof s === 'object' && typeof s.$ref === 'string'; i++) {
    ptr = s.$ref.slice(1)
    s = getAt(doc, ptr)
  }
  return { ...n, s, ptr }
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
  if (s.properties || s.additionalProperties !== undefined || s.required || s.patternProperties || s.minProperties !== undefined || s.maxProperties !== undefined || s.dependencies || s.dependentRequired || s.dependentSchemas || s.unevaluatedProperties !== undefined) return 'object'
  if (s.items !== undefined || s.prefixItems || s.additionalItems !== undefined || s.maxItems !== undefined || s.minItems !== undefined || s.uniqueItems !== undefined || s.unevaluatedItems !== undefined) return 'array'
  if (s.maxLength !== undefined || s.minLength !== undefined || s.pattern !== undefined) return 'string'
  if (s.maximum !== undefined || s.minimum !== undefined || s.multipleOf !== undefined || s.exclusiveMaximum !== undefined || s.exclusiveMinimum !== undefined) return 'number'
  return 'empty'
}

type Combo = { crit: string; subs: (n: Node) => Node[] }

/**
 * How the registry's schema loader sees a schema that is more than one thing at once:
 *  - a type array is a sum type: {"type":["string","null"]} is anyOf of each type;
 *  - a type next to enum / const / not / oneOf / anyOf / allOf is a product type: allOf of each part.
 *    So {"type":"string","enum":[...]} is allOf[string, enum], and dropping the enum narrows the product.
 */
function combo(s: any): Combo | undefined {
  if (!s || typeof s !== 'object') return undefined
  if (Array.isArray(s.type) && s.type.length > 1)
    return { crit: 'anyOf', subs: (n) => s.type.map((t: string) => ({ s: { ...s, type: t }, ptr: n.ptr, path: n.path, whole: n })) }
  if (Array.isArray(s.type) && s.type.length === 1) return combo({ ...s, type: s.type[0] })
  const present = KINDS.filter((k) => (k === 'enum' ? Array.isArray(s.enum) : (COMBOS as readonly string[]).includes(k) ? Array.isArray(s[k]) : s[k] !== undefined))
  if (!present.length) return undefined
  const base = Object.fromEntries(Object.entries(s).filter(([k]) => !(KINDS as readonly string[]).includes(k) && !ANNOTATIONS.includes(k)))
  const parts: any[] = [...(classOf(base) === 'empty' ? [] : [base]), ...present.map((k) => ({ [k]: s[k] }))]
  if (parts.length > 1) return { crit: 'allOf', subs: (n) => parts.map((p) => ({ s: p, ptr: n.ptr, path: n.path, whole: n })) }
  const k = present[0]
  if ((COMBOS as readonly string[]).includes(k)) return { crit: k, subs: (n) => s[k].map((b: unknown, i: number) => ({ s: b, ptr: `${n.ptr}/${k}/${i}`, path: n.path })) }
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
  if (has('DEPENDENCY_ARRAY_ADDED', 'DEPENDENCY_SCHEMA_ADDED', 'SCHEMA_ADDED', 'MAX_CONTAINS_ADDED', 'MIN_CONTAINS_ADDED'))
    return `The keyword at path '${path}' in the ${a} schema is not present in the ${b} schema`
  if (has('DEPENDENCY_ARRAY_EXTENDED')) return `An array or combined type at path '${path}' has more elements in the ${a} schema than the ${b} schema`
  if (has('TYPE_CHANGED', 'TYPE_NARROWED', 'COMBINED_TYPE_CHANGED', 'COMBINED_TYPE_SUBSCHEMAS_CHANGED', 'ENUM_ARRAY_CHANGED', 'DEPENDENCY_ARRAY_CHANGED'))
    return `A type at path '${path}' is different between the ${a} schema and the ${b} schema`
  if (has('REQUIRED_PROPERTY_ADDED_TO_OPEN_CONTENT_MODEL', 'REQUIRED_PROPERTY_WITH_DEFAULT_ADDED_TO_OPEN_CONTENT_MODEL', 'OPTIONAL_PROPERTY_ADDED_TO_OPEN_CONTENT_MODEL', 'ITEM_ADDED_TO_OPEN_CONTENT_MODEL'))
    return `The ${a} schema has an open content model and has a property or item at path '${path}' which is missing in the ${b} schema`
  if (type === 'REQUIRED_PROPERTY_ADDED_TO_UNOPEN_CONTENT_MODEL')
    return `The ${a} schema has an unopen content model and has a required property at path '${path}' which is missing in the ${b} schema`
  if (has('PROPERTY_REMOVED_FROM_CLOSED_CONTENT_MODEL', 'ITEM_REMOVED_FROM_CLOSED_CONTENT_MODEL'))
    return `The ${a} schema has a closed content model and is missing a property or item present at path '${path}' in the ${b} schema`
  if (has('PROPERTY_REMOVED_NOT_COVERED_BY_PARTIALLY_OPEN_CONTENT_MODEL', 'ITEM_REMOVED_NOT_COVERED_BY_PARTIALLY_OPEN_CONTENT_MODEL'))
    return `A property or item is missing in the ${a} schema but present at path '${path}' in the ${b} schema and is not covered by its partially open content model`
  if (has('PROPERTY_ADDED_NOT_COVERED_BY_PARTIALLY_OPEN_CONTENT_MODEL', 'ITEM_ADDED_NOT_COVERED_BY_PARTIALLY_OPEN_CONTENT_MODEL'))
    return `The ${a} schema has a property or item at path '${path}' which is missing in the ${b} schema and is not covered by its partially open content model`
  return `${type} at path '${path}'`
}

/**
 * Differences for reader = update, writer = original. Forward checks call this with the sides
 * swapped, exactly as the registry does. `newer` says which side is being registered.
 */
export function checkJsonSchema(reader: unknown, writer: unknown, newer: Side, policy: JsonPolicy = 'STRICT'): Issue[] {
  const ctx: Ctx = { origDoc: writer, updDoc: reader, newer, policy, out: [], stack: new Set() }
  compare(ctx, { s: writer, ptr: '', path: '' }, { s: reader, ptr: '', path: '' })
  return ctx.out
}

function add(ctx: Ctx, type: string, o: Node, u: Node, info?: string, fix?: Fix) {
  const compatible = SETS[ctx.policy].has(type)
  const path = '#/' + u.path
  const newerPtr = ctx.newer === 'reader' ? u.ptr : o.ptr
  const [a, b] = ctx.newer === 'reader' ? ['new', 'old'] : ['old', 'new']
  ctx.out.push({ type, compatible, path, field: humanOf(newerPtr), message: description(type, path, a, b), info, fix: compatible ? undefined : fix })
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
  if (!o.whole && !u.whole) {
    if (ctx.stack.has(key)) return // a cycle through $ref: treated as compatible
    ctx.stack.add(key)
  }
  compareTypes(ctx, o, u)
  if (!o.whole && !u.whole) ctx.stack.delete(key)
}

function compareTypes(ctx: Ctx, o: Node, u: Node) {
  const oc = combo(o.s), uc = combo(u.s)
  if (!oc && uc) {
    const subs = uc.subs(u)
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
    const subs = oc.subs(o)
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
  if (cO === 'false') return
  for (const [k, t] of [['$id', 'ID_CHANGED'], ['title', 'TITLE_CHANGED'], ['description', 'DESCRIPTION_CHANGED'], ['default', 'DEFAULT_CHANGED']] as const)
    if (JSON.stringify(os[k]) !== JSON.stringify(us[k])) add(ctx, t, o, u, `${JSON.stringify(os[k]) ?? 'none'} → ${JSON.stringify(us[k]) ?? 'none'}`)
  if (cO === 'empty') return

  if (cO === 'combined') return compareCombined(ctx, o, u, oc!, uc!)
  if (enumish(cO)) return compareEnum(ctx, o, u)
  if (cO === 'not') {
    if (JSON.stringify(os.not) === JSON.stringify(us.not)) return
    const a = kid(o, os.not, 'not'), b = kid(u, us.not, 'not')
    // The check runs backwards: what the new schema forbids must already have been forbidden.
    if (probe(ctx, b, a).ok) return add(ctx, 'NOT_TYPE_NARROWED', a, b)
    return add(ctx, 'NOT_TYPE_EXTENDED', a, b, undefined, revert(ctx, o, u))
  }
  if (cO === 'string') {
    limit(ctx, o, u, 'maxLength', 'MAX_LENGTH')
    limit(ctx, o, u, 'minLength', 'MIN_LENGTH')
    const a = os.pattern, b = us.pattern
    if (a !== b) {
      const nodes: [Node, Node] = [kid(o, a, 'pattern'), kid(u, b, 'pattern')]
      if (a === undefined) add(ctx, 'PATTERN_ADDED', ...nodes, b, revertKey(ctx, o, u, 'pattern'))
      else if (b === undefined) add(ctx, 'PATTERN_REMOVED', ...nodes)
      else add(ctx, 'PATTERN_CHANGED', ...nodes, `${a} → ${b}`, revertKey(ctx, o, u, 'pattern'))
    }
  }
  if (cO === 'number') {
    limit(ctx, o, u, 'maximum', 'MAXIMUM')
    limit(ctx, o, u, 'minimum', 'MINIMUM')
    limit(ctx, o, u, 'exclusiveMaximum', 'EXCLUSIVE_MAXIMUM')
    limit(ctx, o, u, 'exclusiveMinimum', 'EXCLUSIVE_MINIMUM')
    const a = os.multipleOf, b = us.multipleOf
    if (a !== b) {
      const nodes: [Node, Node] = [kid(o, a, 'multipleOf'), kid(u, b, 'multipleOf')]
      const fix = revertKey(ctx, o, u, 'multipleOf')
      if (a === undefined) add(ctx, 'MULTIPLE_OF_ADDED', ...nodes, String(b), fix)
      else if (b === undefined) add(ctx, 'MULTIPLE_OF_REMOVED', ...nodes)
      else if (a !== 0 && b % a === 0) add(ctx, 'MULTIPLE_OF_EXPANDED', ...nodes, `${a} → ${b}`, fix)
      else if (b !== 0 && a % b === 0) add(ctx, 'MULTIPLE_OF_REDUCED', ...nodes, `${a} → ${b}`)
      else add(ctx, 'MULTIPLE_OF_CHANGED', ...nodes, `${a} → ${b}`, fix)
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
  const os = single(o.s), us = single(u.s)
  const vals = (s: any): string[] => (Array.isArray(s.enum) ? s.enum : [s.const]).map((x: unknown) => JSON.stringify(x))
  const a = vals(os), b = vals(us)
  if (a.length === b.length && a.every((x) => b.includes(x))) return
  const removed = a.filter((x) => !b.includes(x)), added = b.filter((x) => !a.includes(x))
  if (!Array.isArray(os.enum) && !Array.isArray(us.enum))
    return add(ctx, 'ENUM_ARRAY_CHANGED', kid(o, os.const, 'const'), kid(u, us.const, 'const'), `${a[0]} → ${b[0]}`, revert(ctx, o, u))
  const nodes: [Node, Node] = [kid(o, os.enum, 'enum'), kid(u, us.enum, 'enum')]
  if (!removed.length) add(ctx, 'ENUM_ARRAY_EXTENDED', ...nodes, `added ${added.join(', ')}`)
  else if (!added.length) add(ctx, 'ENUM_ARRAY_NARROWED', ...nodes, `removed ${removed.join(', ')}`, enumFix(ctx, o, u, removed, added))
  else add(ctx, 'ENUM_ARRAY_CHANGED', ...nodes, `removed ${removed.join(', ')}; added ${added.join(', ')}`, enumFix(ctx, o, u, removed, added))
}

/** unevaluatedProperties / unevaluatedItems as the registry classes them: absent, false, empty (true or {}), or a schema. */
const uneval = (v: unknown) => (v === undefined ? 'absent' : v === false ? 'false' : v === true || (typeof v === 'object' && v !== null && !Object.keys(v).length) ? 'empty' : 'schema')
const schemaOf = (v: unknown) => (v && typeof v === 'object' && Object.keys(v).length ? v : null)

function compareUnevaluated(ctx: Ctx, o: Node, u: Node, key: 'unevaluatedProperties' | 'unevaluatedItems') {
  const base = key === 'unevaluatedItems' ? 'UNEVALUATED_ITEMS' : 'UNEVALUATED_PROPERTIES'
  const a = single(o.s)[key], b = single(u.s)[key]
  const ka = uneval(a), kb = uneval(b)
  if (ka === 'absent' && kb === 'absent') return
  const nodes: [Node, Node] = [kid(o, a, key), kid(u, b, key)]
  const fix = revertKey(ctx, o, u, key)
  if (ka === 'absent') add(ctx, kb === 'false' ? `${base}_REMOVED` : `${base}_NARROWED`, ...nodes, undefined, fix)
  else if (kb === 'absent') add(ctx, ka === 'false' ? `${base}_ADDED` : `${base}_EXTENDED`, ...nodes, undefined, fix)
  else if (ka === 'false' && kb !== 'false') add(ctx, `${base}_ADDED`, ...nodes)
  else if (ka !== 'false' && kb === 'false') add(ctx, `${base}_REMOVED`, ...nodes, undefined, fix)
  else if (ka === 'empty' && kb !== 'empty') add(ctx, `${base}_NARROWED`, ...nodes, undefined, fix)
  else if (ka !== 'empty' && kb === 'empty') add(ctx, `${base}_EXTENDED`, ...nodes)
  else compare(ctx, ...nodes)
}

function compareObject(ctx: Ctx, o: Node, u: Node) {
  const os = single(o.s), us = single(u.s)
  const permits = (s: any) => s.additionalProperties !== false
  const apSchema = (s: any) => schemaOf(s.additionalProperties)
  const open = (s: any) => permits(s) && !apSchema(s) && !Object.keys(s.patternProperties ?? {}).length && ['absent', 'empty'].includes(uneval(s.unevaluatedProperties))
  const partial = (n: Node, s: any, name: string, path: string): Node | null => {
    for (const [p, v] of Object.entries(s.patternProperties ?? {})) if (new RegExp(p).test(name)) return { s: v, ptr: `${n.ptr}/patternProperties/${esc(p)}`, path }
    if (apSchema(s)) return { s: apSchema(s), ptr: `${n.ptr}/additionalProperties`, path }
    if (permits(s) && uneval(s.unevaluatedProperties) === 'schema') return { s: s.unevaluatedProperties, ptr: `${n.ptr}/unevaluatedProperties`, path }
    return null
  }
  const op = os.properties ?? {}, up = us.properties ?? {}
  const oreq: string[] = os.required ?? [], ureq: string[] = us.required ?? []
  const propO = (n: string): Node => ({ s: op[n], ptr: `${o.ptr}/properties/${esc(n)}`, path: join(o.path, `properties/${n}`) })
  const propU = (n: string): Node => ({ s: up[n], ptr: `${u.ptr}/properties/${esc(n)}`, path: join(u.path, `properties/${n}`) })

  for (const n of Object.keys(op)) {
    if (!(n in up)) continue
    const req = ureq.includes(n), was = oreq.includes(n)
    const a = at(propO(n), join(o.path, `required/${n}`)), b = at(propU(n), join(u.path, `required/${n}`))
    if (was && !req) add(ctx, 'REQUIRED_ATTRIBUTE_REMOVED', a, b, n)
    else if (!was && req) {
      if (hasDefault(deref(ctx.updDoc, propU(n)).s)) add(ctx, 'REQUIRED_ATTRIBUTE_WITH_DEFAULT_ADDED', a, b, n)
      else add(ctx, 'REQUIRED_ATTRIBUTE_ADDED', a, b, n, requiredFix(ctx, o, u, n))
    }
  }
  for (const n of [...new Set([...Object.keys(op), ...Object.keys(up)])]) {
    const a = propO(n), b = propU(n)
    if (!(n in up)) {
      if (open(us)) add(ctx, 'PROPERTY_REMOVED_FROM_OPEN_CONTENT_MODEL', a, b, n)
      else {
        const par = partial(u, us, n, a.path)
        if (par) {
          const p = probe(ctx, a, par)
          ctx.out.push(...p.diffs.map((d) => ({ ...d, fix: undefined })))
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
        const par = partial(o, os, n, b.path)
        if (par) {
          const p = probe(ctx, par, b)
          ctx.out.push(...p.diffs.map((d) => ({ ...d, fix: undefined })))
          add(ctx, p.ok ? 'PROPERTY_ADDED_IS_COVERED_BY_PARTIALLY_OPEN_CONTENT_MODEL' : 'PROPERTY_ADDED_NOT_COVERED_BY_PARTIALLY_OPEN_CONTENT_MODEL', a, b, n, restore(ctx, o, u, n))
        }
        if (req) add(ctx, def ? 'REQUIRED_PROPERTY_WITH_DEFAULT_ADDED_TO_UNOPEN_CONTENT_MODEL' : 'REQUIRED_PROPERTY_ADDED_TO_UNOPEN_CONTENT_MODEL', a, b, n, requiredFix(ctx, o, u, n))
        else add(ctx, 'OPTIONAL_PROPERTY_ADDED_TO_UNOPEN_CONTENT_MODEL', a, b, n)
      }
    } else compare(ctx, a, b)
  }
  compareDependencies(ctx, o, u)
  const apO = kid(o, os.additionalProperties, 'additionalProperties'), apU = kid(u, us.additionalProperties, 'additionalProperties')
  const fix = revertKey(ctx, o, u, 'additionalProperties')
  if (permits(os) !== permits(us)) {
    if (permits(us)) add(ctx, 'ADDITIONAL_PROPERTIES_ADDED', apO, apU)
    else add(ctx, 'ADDITIONAL_PROPERTIES_REMOVED', apO, apU, undefined, fix)
  } else if (!apSchema(os) && apSchema(us)) add(ctx, 'ADDITIONAL_PROPERTIES_NARROWED', apO, apU, undefined, fix)
  else if (apSchema(os) && !apSchema(us)) add(ctx, 'ADDITIONAL_PROPERTIES_EXTENDED', apO, apU)
  else if (apSchema(os)) compare(ctx, apO, apU)
  compareUnevaluated(ctx, o, u, 'unevaluatedProperties')
  limit(ctx, o, u, 'maxProperties', 'MAX_PROPERTIES')
  limit(ctx, o, u, 'minProperties', 'MIN_PROPERTIES')
}

/**
 * "If property X is present then ..." rules. Draft 4-7 keep both kinds under `dependencies`;
 * 2019-09 and later split them into dependentRequired (name lists) and dependentSchemas.
 */
function compareDependencies(ctx: Ctx, o: Node, u: Node) {
  const read = (n: Node) => {
    const s = single(n.s)
    const lists: Record<string, { v: string[]; key: string }> = {}, schemas: Record<string, { v: unknown; key: string }> = {}
    for (const [k, v] of Object.entries(s.dependencies ?? {})) (Array.isArray(v) ? lists : schemas)[k] = { v: v as any, key: 'dependencies' }
    for (const [k, v] of Object.entries(s.dependentRequired ?? {})) lists[k] = { v: v as string[], key: 'dependentRequired' }
    for (const [k, v] of Object.entries(s.dependentSchemas ?? {})) schemas[k] = { v, key: 'dependentSchemas' }
    return { lists, schemas }
  }
  const a = read(o), b = read(u)
  const node = (n: Node, e: { v: unknown; key: string } | undefined, k: string): Node => ({ s: e?.v, ptr: `${n.ptr}/${e?.key ?? 'dependencies'}/${esc(k)}`, path: join(n.path, `dependencies/${k}`) })
  // Restoring the old rule on the newer side undoes either kind of change.
  const fixFor = (k: string, oe?: { v: unknown; key: string }, ue?: { v: unknown; key: string }): Fix => {
    const [mine, theirs, n] = ctx.newer === 'reader' ? [ue, oe, u] : [oe, ue, o]
    const ptr = `${n.ptr}/${(mine ?? theirs)!.key}/${esc(k)}`
    if (!theirs) return { label: `Remove the dependency on '${k}' from the new version`, ops: [{ op: 'remove', ptr }] }
    if (!mine) return { label: `Restore the dependency on '${k}'`, ops: [{ op: 'set', ptr: `${n.ptr}/${theirs.key}`, value: { ...(single(n.s)[theirs.key] ?? {}), [k]: theirs.v } }] }
    return { label: `Restore the dependency on '${k}'`, ops: [{ op: 'set', ptr, value: theirs.v }] }
  }
  for (const k of new Set([...Object.keys(a.lists), ...Object.keys(b.lists)])) {
    const x = a.lists[k], y = b.lists[k]
    const nodes: [Node, Node] = [node(o, x, k), node(u, y, k)]
    if (!y) add(ctx, 'DEPENDENCY_ARRAY_REMOVED', ...nodes, k)
    else if (!x) add(ctx, 'DEPENDENCY_ARRAY_ADDED', ...nodes, k, fixFor(k, x, y))
    else {
      const more = y.v.filter((p) => !x.v.includes(p)), fewer = x.v.filter((p) => !y.v.includes(p))
      if (!more.length && !fewer.length) continue
      if (!fewer.length) add(ctx, 'DEPENDENCY_ARRAY_EXTENDED', ...nodes, `also requires ${more.join(', ')}`, fixFor(k, x, y))
      else if (!more.length) add(ctx, 'DEPENDENCY_ARRAY_NARROWED', ...nodes, `no longer requires ${fewer.join(', ')}`)
      else add(ctx, 'DEPENDENCY_ARRAY_CHANGED', ...nodes, `${x.v.join(', ')} → ${y.v.join(', ')}`, fixFor(k, x, y))
    }
  }
  for (const k of new Set([...Object.keys(a.schemas), ...Object.keys(b.schemas)])) {
    const x = a.schemas[k], y = b.schemas[k]
    const nodes: [Node, Node] = [node(o, x, k), node(u, y, k)]
    if (!y) add(ctx, 'DEPENDENCY_SCHEMA_REMOVED', ...nodes, k)
    else if (!x) add(ctx, 'DEPENDENCY_SCHEMA_ADDED', ...nodes, k, fixFor(k, x, y))
    else compare(ctx, ...nodes)
  }
}

function compareArray(ctx: Ctx, o: Node, u: Node) {
  const os = single(o.s), us = single(u.s)
  // Three shapes of the same idea: draft 4-2019 `items: [..]` + additionalItems, 2020-12 prefixItems + items,
  // and a plain `items` schema for every element.
  const shape = (s: any) => {
    const tupleKey = s.prefixItems ? 'prefixItems' : Array.isArray(s.items) ? 'items' : null
    const restKey = s.prefixItems ? 'items' : 'additionalItems'
    const rest = tupleKey ? s[restKey] : s.prefixItems ? s.items : s.additionalItems
    return {
      tupleKey, restKey,
      tuple: (tupleKey ? s[tupleKey] : []) as unknown[],
      all: tupleKey || s.items === undefined ? undefined : s.items,
      rest,
      permits: rest !== false,
      restSchema: schemaOf(rest),
    }
  }
  const A = shape(os), B = shape(us)
  const isOpen = (x: typeof A, s: any) => x.permits && !x.restSchema && ['absent', 'empty'].includes(uneval(s.unevaluatedItems))
  const partial = (x: typeof A, n: Node, s: any, path: string): Node | null =>
    x.restSchema ? { s: x.restSchema, ptr: `${n.ptr}/${x.restKey}`, path }
    : x.permits && uneval(s.unevaluatedItems) === 'schema' ? { s: s.unevaluatedItems, ptr: `${n.ptr}/unevaluatedItems`, path }
    : null

  compare(ctx, kid(o, A.all, 'items'), kid(u, B.all, 'items'))

  for (let i = 0; i < Math.max(A.tuple.length, B.tuple.length); i++) {
    const path = join(u.path, `items/${i}`)
    const a: Node = { s: A.tuple[i], ptr: `${o.ptr}/${A.tupleKey ?? 'items'}/${i}`, path }
    const b: Node = { s: B.tuple[i], ptr: `${u.ptr}/${B.tupleKey ?? 'items'}/${i}`, path }
    // Undoing a tuple change means putting the whole old tuple back on the newer side.
    const [nNode, oShape, nShape] = ctx.newer === 'reader' ? [u, A, B] : [o, B, A]
    const fix: Fix | undefined = oShape.tupleKey
      ? { label: 'Restore the previous list of item schemas', ops: [{ op: 'set', ptr: `${nNode.ptr}/${nShape.tupleKey ?? oShape.tupleKey}`, value: oShape.tuple }] }
      : undefined
    if (i < A.tuple.length && i < B.tuple.length) compare(ctx, a, b)
    else if (i >= B.tuple.length) {
      if (isOpen(B, us)) add(ctx, 'ITEM_REMOVED_FROM_OPEN_CONTENT_MODEL', a, b, String(i))
      else {
        const par = partial(B, u, us, path)
        if (par) {
          const p = probe(ctx, a, par)
          ctx.out.push(...p.diffs.map((d) => ({ ...d, fix: undefined })))
          add(ctx, p.ok ? 'ITEM_REMOVED_IS_COVERED_BY_PARTIALLY_OPEN_CONTENT_MODEL' : 'ITEM_REMOVED_NOT_COVERED_BY_PARTIALLY_OPEN_CONTENT_MODEL', a, b, String(i), fix)
        } else add(ctx, A.tuple[i] === false ? 'ITEM_WITH_FALSE_REMOVED_FROM_CLOSED_CONTENT_MODEL' : 'ITEM_REMOVED_FROM_CLOSED_CONTENT_MODEL', a, b, String(i), fix)
      }
    } else if (isOpen(A, os)) add(ctx, classOf(B.tuple[i]) === 'empty' ? 'ITEM_WITH_EMPTY_SCHEMA_ADDED_TO_OPEN_CONTENT_MODEL' : 'ITEM_ADDED_TO_OPEN_CONTENT_MODEL', a, b, String(i), fix)
    else {
      const par = partial(A, o, os, path)
      if (par) {
        const p = probe(ctx, par, b)
        ctx.out.push(...p.diffs.map((d) => ({ ...d, fix: undefined })))
        add(ctx, p.ok ? 'ITEM_ADDED_IS_COVERED_BY_PARTIALLY_OPEN_CONTENT_MODEL' : 'ITEM_ADDED_NOT_COVERED_BY_PARTIALLY_OPEN_CONTENT_MODEL', a, b, String(i), fix)
      } else add(ctx, 'ITEM_ADDED_TO_CLOSED_CONTENT_MODEL', a, b, String(i))
    }
  }

  const restO: Node = { s: A.rest, ptr: `${o.ptr}/${A.restKey}`, path: join(o.path, 'additionalItems') }
  const restU: Node = { s: B.rest, ptr: `${u.ptr}/${B.restKey}`, path: join(u.path, 'additionalItems') }
  const [nShape, oShape, nNode] = ctx.newer === 'reader' ? [B, A, u] : [A, B, o]
  const restFix: Fix = oShape.rest === undefined
    ? { label: `Remove "${nShape.restKey}" from the new version`, ops: [{ op: 'remove', ptr: `${nNode.ptr}/${nShape.restKey}` }] }
    : { label: `Restore "${nShape.restKey}": ${JSON.stringify(oShape.rest)}`, ops: [{ op: 'set', ptr: `${nNode.ptr}/${nShape.restKey}`, value: oShape.rest }] }
  if (A.permits !== B.permits) {
    if (B.permits) add(ctx, 'ADDITIONAL_ITEMS_ADDED', restO, restU)
    else add(ctx, 'ADDITIONAL_ITEMS_REMOVED', restO, restU, undefined, restFix)
  } else if (!A.restSchema && B.restSchema) add(ctx, 'ADDITIONAL_ITEMS_NARROWED', restO, restU, undefined, restFix)
  else if (A.restSchema && !B.restSchema) add(ctx, 'ADDITIONAL_ITEMS_EXTENDED', restO, restU)
  else if (A.restSchema) compare(ctx, { ...restO, s: A.restSchema }, { ...restU, s: B.restSchema })

  compareUnevaluated(ctx, o, u, 'unevaluatedItems')
  limit(ctx, o, u, 'maxItems', 'MAX_ITEMS')
  limit(ctx, o, u, 'minItems', 'MIN_ITEMS')
  limit(ctx, o, u, 'maxContains', 'MAX_CONTAINS')
  limit(ctx, o, u, 'minContains', 'MIN_CONTAINS')
  if (!!os.uniqueItems !== !!us.uniqueItems) {
    const nodes: [Node, Node] = [kid(o, os.uniqueItems, 'uniqueItems'), kid(u, us.uniqueItems, 'uniqueItems')]
    if (us.uniqueItems) add(ctx, 'UNIQUE_ITEMS_ADDED', ...nodes, undefined, revertKey(ctx, o, u, 'uniqueItems'))
    else add(ctx, 'UNIQUE_ITEMS_REMOVED', ...nodes)
  }
}

function compareCombined(ctx: Ctx, o: Node, u: Node, oc: Combo, uc: Combo) {
  const unique = (ns: Node[]) => ns.filter((n, i) => ns.findIndex((m) => JSON.stringify(m.s) === JSON.stringify(n.s)) === i)
  const a = unique(oc.subs(o)), b = unique(uc.subs(u))
  if (oc.crit !== uc.crit) {
    const widen = uc.crit === 'anyOf' || (a.length === 1 && b.length === 1) || (a.length === 1 && uc.crit === 'oneOf') || (b.length === 1 && oc.crit === 'allOf')
    if (!widen) return add(ctx, 'COMBINED_TYPE_CHANGED', o, u, `${oc.crit} → ${uc.crit}`, revert(ctx, o, u))
    add(ctx, 'COMBINED_TYPE_EXTENDED', o, u, `${oc.crit} → ${uc.crit}`)
  }
  const fix = revert(ctx, o, u)
  if (a.length < b.length) add(ctx, uc.crit === 'allOf' ? 'PRODUCT_TYPE_EXTENDED' : 'SUM_TYPE_EXTENDED', o, u, `${a.length} → ${b.length} subschemas`, fix)
  else if (a.length > b.length) add(ctx, oc.crit === 'allOf' ? 'PRODUCT_TYPE_NARROWED' : 'SUM_TYPE_NARROWED', o, u, `${a.length} → ${b.length} subschemas`, fix)

  // Maximum bipartite matching over compatible subschema pairs (Kuhn's augmenting paths).
  // Differences inside a pair are reported under the original side's keyword and index.
  const edges = a.map((x, i) => {
    const path = join(o.path, `${oc.crit}/${i}`)
    return b.map((y) => probe(ctx, at(x, path), at(y, path)))
  })
  const matchB = new Array<number>(b.length).fill(-1)
  // Try an unchanged subschema first, so an untouched branch is paired with itself, not with a look-alike.
  const order = a.map((x) => {
    const same = b.findIndex((y) => JSON.stringify(y.s) === JSON.stringify(x.s))
    return same < 0 ? b.map((_, j) => j) : [same, ...b.map((_, j) => j).filter((j) => j !== same)]
  })
  const augment = (i: number, seen: Set<number>): boolean => {
    for (const j of order[i]) {
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

function limit(ctx: Ctx, o: Node, u: Node, key: string, base: string) {
  const a = single(o.s)[key], b = single(u.s)[key]
  if (a === b || typeof a === 'boolean' || typeof b === 'boolean') return
  const t = a === undefined ? `${base}_ADDED` : b === undefined ? `${base}_REMOVED` : b > a ? `${base}_INCREASED` : `${base}_DECREASED`
  add(ctx, t, kid(o, a, key), kid(u, b, key), `${a ?? 'none'} → ${b ?? 'none'}`, revertKey(ctx, o, u, key))
}

// ---- fixes: always edit the newer document ----

function revert(ctx: Ctx, o0: Node, u0: Node): Fix {
  // A synthetic part cannot be replaced on its own: revert the schema it was split from.
  const o = o0.whole ?? o0, u = u0.whole ?? u0
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
    const p = deref(ctx.updDoc, { s: u.s.properties?.[name], ptr: `${u.ptr}/properties/${esc(name)}`, path: '' })
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

// ---------- Confluent-faithful keyword type validation & spec-violation warnings ----------

const JSON_TYPES = new Set(['string', 'integer', 'number', 'boolean', 'null', 'array', 'object'])
const KNOWN_SCHEMA_URIS = /^https?:\/\/json-schema\.org\/(draft-0[467]\/schema|draft\/(2019-09|2020-12)\/schema)#?$/
const INT_KEYWORDS = ['minLength', 'maxLength', 'minProperties', 'maxProperties', 'minItems', 'maxItems', 'minContains', 'maxContains'] as const
const NUM_KEYWORDS = ['minimum', 'maximum', 'multipleOf'] as const
const BOOL_KEYWORDS = ['uniqueItems', 'readOnly', 'writeOnly', 'deprecated'] as const
const STR_KEYWORDS = ['$id', 'id', '$schema', 'title', 'description', 'format', 'contentEncoding', 'contentMediaType', '$comment'] as const
const SUB_KEYWORDS = ['additionalProperties', 'unevaluatedProperties', 'additionalItems', 'unevaluatedItems', 'not', 'contains', 'propertyNames', 'if', 'then', 'else'] as const
const SUB_ARRAY_KEYWORDS = ['allOf', 'anyOf', 'oneOf', 'prefixItems'] as const

const isObjRecord = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
const isSchemaValue = (v: unknown): v is boolean | Record<string, any> => typeof v === 'boolean' || isObjRecord(v)

function stableKey(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableKey).join(',')}]`
  if (isObjRecord(v)) {
    const keys = Object.keys(v).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableKey(v[k])}`).join(',')}}`
  }
  return JSON.stringify(v)
}

/**
 * Parses and validates a JSON Schema according to Confluent Schema Registry's json-schema-provider
 * (Everit draft-04/06/07 and json-sKema draft 2019-09/2020-12):
 *  - Refuses wrong-typed schema keywords, unknown `type` values, invalid regexes, and bad `$ref`s.
 *  - Emits warnings for JSON Schema spec violations that Everit / json-sKema accept at load time
 *    (negative integer counts, `multipleOf <= 0`, empty `enum` / combinators, duplicate list entries, inverted bounds).
 */
export function parseJsonSchemaWithWarnings(text: string): { doc: unknown; warnings: string[] } {
  const doc = parseJsonSchema(text)
  const warnings: string[] = []
  const draft4 = isObjRecord(doc) && typeof doc.$schema === 'string' && /draft-04\/schema#?$/.test(doc.$schema)

  if (isObjRecord(doc) && typeof doc.$schema === 'string' && !KNOWN_SCHEMA_URIS.test(doc.$schema)) {
    warnings.push(`Unrecognized $schema "${doc.$schema}" (checked with draft-07 keyword rules)`)
  }

  function walk(node: unknown, at: string) {
    if (!isSchemaValue(node)) throw new SchemaParseError(`Expected schema object or boolean at ${at || '#'}`)
    if (typeof node === 'boolean') return

    if (node.$ref !== undefined) {
      if (typeof node.$ref !== 'string') throw new SchemaParseError(`"$ref" must be a string at ${at || '#'}`)
      if (!node.$ref.startsWith('#')) {
        throw new SchemaParseError(`External $ref "${node.$ref}" at ${at || '#'} is not supported: inline it or use a local #/... reference`)
      }
      const seen = new Set<string>()
      let cur: unknown = node
      let ptr = node.$ref
      for (let i = 0; i < 64 && isObjRecord(cur) && typeof cur.$ref === 'string'; i++) {
        if (!cur.$ref.startsWith('#')) {
          throw new SchemaParseError(`External $ref "${cur.$ref}" at ${at || '#'} is not supported: inline it or use a local #/... reference`)
        }
        if (seen.has(cur.$ref)) throw new SchemaParseError(`Cyclic $ref "${ptr}" at ${at || '#'}`)
        seen.add(cur.$ref)
        const target = getAt(doc, cur.$ref.slice(1))
        if (target === undefined) throw new SchemaParseError(`Unresolved $ref "${cur.$ref}" at ${at || '#'}`)
        if (!isSchemaValue(target)) throw new SchemaParseError(`$ref target "${cur.$ref}" must be an object or boolean schema`)
        ptr = cur.$ref
        cur = target
      }
    }
    for (const kw of STR_KEYWORDS) {
      if (node[kw] !== undefined && typeof node[kw] !== 'string') {
        throw new SchemaParseError(`"${kw}" must be a string at ${at || '#'}`)
      }
    }
    for (const kw of BOOL_KEYWORDS) {
      if (node[kw] !== undefined && typeof node[kw] !== 'boolean') {
        throw new SchemaParseError(`"${kw}" must be a boolean at ${at || '#'}`)
      }
    }

    if (node.type !== undefined) {
      if (typeof node.type === 'string') {
        if (!JSON_TYPES.has(node.type)) throw new SchemaParseError(`Invalid JSON Schema type "${node.type}" at ${at || '#'}`)
      } else if (Array.isArray(node.type)) {
        for (const entry of node.type) {
          if (typeof entry !== 'string' || !JSON_TYPES.has(entry)) {
            throw new SchemaParseError(`Invalid JSON Schema type ${JSON.stringify(entry)} at ${at || '#'}`)
          }
        }
        if (node.type.length === 0) {
          warnings.push(`Empty "type" array at ${at || '#'} (JSON Schema spec requires at least one type; accepted by Schema Registry)`)
        } else if (new Set(node.type).size !== node.type.length) {
          warnings.push(`Duplicate entries in "type" array at ${at || '#'} (JSON Schema spec requires unique items; accepted by Schema Registry)`)
        }
      } else {
        throw new SchemaParseError(`"type" must be a string or an array of strings at ${at || '#'}`)
      }
    }

    if (node.required !== undefined) {
      if (!Array.isArray(node.required) || node.required.some((r) => typeof r !== 'string')) {
        throw new SchemaParseError(`"required" must be an array of strings at ${at || '#'}`)
      }
      if (new Set(node.required).size !== node.required.length) {
        warnings.push(`Duplicate entries in "required" at ${at || '#'} (JSON Schema spec requires unique items; accepted by Schema Registry)`)
      }
    }

    if (node.enum !== undefined) {
      if (!Array.isArray(node.enum)) throw new SchemaParseError(`"enum" must be an array at ${at || '#'}`)
      if (node.enum.length === 0) {
        warnings.push(`Empty "enum" array at ${at || '#'} (JSON Schema spec requires at least one item; accepted by Schema Registry)`)
      } else if (new Set(node.enum.map(stableKey)).size !== node.enum.length) {
        warnings.push(`Duplicate values in "enum" at ${at || '#'} (JSON Schema spec requires unique items; accepted by Schema Registry)`)
      }
    }

    for (const kw of INT_KEYWORDS) {
      if (node[kw] !== undefined) {
        if (typeof node[kw] !== 'number' || !Number.isInteger(node[kw])) {
          throw new SchemaParseError(`"${kw}" must be an integer at ${at || '#'}`)
        }
        if (node[kw] < 0) {
          warnings.push(`"${kw}" is negative (${node[kw]}) at ${at || '#'} (JSON Schema spec requires >= 0; accepted by Schema Registry)`)
        }
      }
    }
    for (const [lo, hi] of [['minLength', 'maxLength'], ['minProperties', 'maxProperties'], ['minItems', 'maxItems'], ['minContains', 'maxContains']] as const) {
      if (typeof node[lo] === 'number' && typeof node[hi] === 'number' && node[lo] > node[hi]) {
        warnings.push(`"${lo}" (${node[lo]}) exceeds "${hi}" (${node[hi]}) at ${at || '#'}`)
      }
    }

    for (const kw of NUM_KEYWORDS) {
      if (node[kw] !== undefined && (typeof node[kw] !== 'number' || !Number.isFinite(node[kw]))) {
        throw new SchemaParseError(`"${kw}" must be a number at ${at || '#'}`)
      }
    }
    if (typeof node.multipleOf === 'number' && node.multipleOf <= 0) {
      warnings.push(`"multipleOf" is ${node.multipleOf} at ${at || '#'} (JSON Schema spec requires > 0; accepted by Schema Registry)`)
    }
    if (typeof node.minimum === 'number' && typeof node.maximum === 'number' && node.minimum > node.maximum) {
      warnings.push(`"minimum" (${node.minimum}) exceeds "maximum" (${node.maximum}) at ${at || '#'}`)
    }

    for (const kw of ['exclusiveMinimum', 'exclusiveMaximum'] as const) {
      if (node[kw] !== undefined) {
        if (draft4) {
          if (typeof node[kw] !== 'boolean') throw new SchemaParseError(`"${kw}" must be a boolean in draft-04 at ${at || '#'}`)
        } else if (typeof node[kw] !== 'number' || !Number.isFinite(node[kw])) {
          throw new SchemaParseError(`"${kw}" must be a number in draft-06+ at ${at || '#'}`)
        }
      }
    }

    if (node.pattern !== undefined) {
      if (typeof node.pattern !== 'string') throw new SchemaParseError(`"pattern" must be a string at ${at || '#'}`)
      try {
        new RegExp(node.pattern)
      } catch {
        throw new SchemaParseError(`Invalid regex in "pattern" at ${at || '#'}`)
      }
    }

    if (node.properties !== undefined) {
      if (!isObjRecord(node.properties)) throw new SchemaParseError(`"properties" must be an object at ${at || '#'}`)
      for (const [k, v] of Object.entries(node.properties)) walk(v, `${at}/properties/${k}`)
    }

    if (node.patternProperties !== undefined) {
      if (!isObjRecord(node.patternProperties)) throw new SchemaParseError(`"patternProperties" must be an object at ${at || '#'}`)
      for (const [k, v] of Object.entries(node.patternProperties)) {
        try {
          new RegExp(k)
        } catch {
          throw new SchemaParseError(`Invalid patternProperties regex "${k}" at ${at}/patternProperties/${k}`)
        }
        walk(v, `${at}/patternProperties/${k}`)
      }
    }

    for (const kw of SUB_KEYWORDS) {
      if (node[kw] !== undefined) walk(node[kw], `${at}/${kw}`)
    }

    if (node.prefixItems !== undefined && Array.isArray(node.items)) {
      throw new SchemaParseError(`"items" cannot be an array alongside "prefixItems" at ${at || '#'}`)
    }

    if (node.items !== undefined) {
      if (Array.isArray(node.items)) {
        if (node.items.length === 0) warnings.push(`Empty "items" tuple array at ${at || '#'} (accepted by Schema Registry)`)
        node.items.forEach((item, i) => walk(item, `${at}/items/${i}`))
      } else {
        walk(node.items, `${at}/items`)
      }
    }

    for (const kw of SUB_ARRAY_KEYWORDS) {
      if (node[kw] !== undefined) {
        if (!Array.isArray(node[kw])) throw new SchemaParseError(`"${kw}" must be an array of schemas at ${at || '#'}`)
        if (node[kw].length === 0) {
          warnings.push(`Empty "${kw}" array at ${at || '#'} (JSON Schema spec requires at least one schema; accepted by Schema Registry)`)
        }
        node[kw].forEach((sub, i) => walk(sub, `${at}/${kw}/${i}`))
      }
    }

    if (node.dependencies !== undefined) {
      if (!isObjRecord(node.dependencies)) throw new SchemaParseError(`"dependencies" must be an object at ${at || '#'}`)
      for (const [k, v] of Object.entries(node.dependencies)) {
        if (Array.isArray(v)) {
          if (v.some((x) => typeof x !== 'string')) throw new SchemaParseError(`Dependency "${k}" array entries must be strings at ${at}/dependencies/${k}`)
          if (new Set(v).size !== v.length) warnings.push(`Duplicate entries in dependency "${k}" at ${at}/dependencies/${k}`)
        } else {
          walk(v, `${at}/dependencies/${k}`)
        }
      }
    }

    if (node.dependentRequired !== undefined) {
      if (!isObjRecord(node.dependentRequired)) throw new SchemaParseError(`"dependentRequired" must be an object at ${at || '#'}`)
      for (const [k, v] of Object.entries(node.dependentRequired)) {
        if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
          throw new SchemaParseError(`dependentRequired "${k}" must be an array of strings at ${at}/dependentRequired/${k}`)
        }
        if (new Set(v).size !== v.length) warnings.push(`Duplicate entries in dependentRequired "${k}" at ${at}/dependentRequired/${k}`)
      }
    }

    if (node.dependentSchemas !== undefined) {
      if (!isObjRecord(node.dependentSchemas)) throw new SchemaParseError(`"dependentSchemas" must be an object at ${at || '#'}`)
      for (const [k, v] of Object.entries(node.dependentSchemas)) walk(v, `${at}/dependentSchemas/${k}`)
    }

    for (const kw of ['definitions', '$defs'] as const) {
      if (node[kw] !== undefined) {
        if (!isObjRecord(node[kw])) throw new SchemaParseError(`"${kw}" must be an object at ${at || '#'}`)
        for (const [k, v] of Object.entries(node[kw])) walk(v, `${at}/${kw}/${k}`)
      }
    }
  }

  walk(doc, '')
  return { doc, warnings }
}
