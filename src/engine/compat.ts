// Ties the three formats together: parse, pairwise checks, mode verdicts, explanations, upgrade order.
import { MODES, type Format, type Issue, type Mode, type Fix, type Side } from './types.ts'
import { checkAvro, diffAvro, parseAvro, SchemaParseError, type AvroSchema, type Change } from './avro.ts'
import { checkJsonSchema, parseJsonSchema, type JsonPolicy } from './jsonschema.ts'
import { checkProto, parseProto, type ProtoFile } from './protobuf.ts'
import { applyPatch } from './patch.ts'

export interface Version {
  id: string
  text: string
}

export interface Subject {
  name: string
  format: Format
  mode: Mode
  policy: JsonPolicy
  versions: Version[]
}

export type Parsed =
  | { ok: true; schema: AvroSchema | ProtoFile | unknown; warnings: string[] }
  | { ok: false; error: string }

export function parseVersion(format: Format, text: string): Parsed {
  try {
    if (!text.trim()) return { ok: false, error: 'Schema is empty' }
    if (format === 'AVRO') {
      const schema = parseAvro(text)
      return { ok: true, schema, warnings: schema.warnings }
    }
    if (format === 'JSON') return { ok: true, schema: parseJsonSchema(text), warnings: [] }
    return { ok: true, schema: parseProto(text), warnings: [] }
  } catch (e) {
    if (e instanceof SchemaParseError) return { ok: false, error: e.message }
    return { ok: false, error: (e as Error).message }
  }
}

/** All differences (compatible included) for reader/writer. `newer` is the side being registered. */
export function checkPair(format: Format, reader: any, writer: any, newer: Side, policy: JsonPolicy = 'STRICT'): Issue[] {
  if (format === 'AVRO') return checkAvro(reader, writer, newer)
  if (format === 'JSON') return checkJsonSchema(reader, writer, newer, policy)
  return checkProto(reader, writer, newer)
}

export const breaking = (issues: Issue[]) => issues.filter((i) => !i.compatible)

export interface ModeCheck {
  reader: number
  writer: number
  issues: Issue[]
}

export interface Analysis {
  parsed: Parsed[]
  /** differences for reader index, writer index; null if either side doesn't parse */
  pair(reader: number, writer: number): Issue[] | null
  /** the reader/writer checks a mode performs for version k, against earlier versions */
  checks(k: number, mode: Mode): ModeCheck[]
  verdict(k: number, mode: Mode): 'pass' | 'fail' | 'invalid' | 'first'
  breaks(k: number, mode: Mode): ModeCheck[]
}

export function modePairs(k: number, mode: Mode): { reader: number; writer: number }[] {
  if (mode === 'NONE' || k === 0) return []
  const prev = /TRANSITIVE/.test(mode) ? Array.from({ length: k }, (_, i) => k - 1 - i) : [k - 1]
  const out: { reader: number; writer: number }[] = []
  if (mode.startsWith('BACKWARD') || mode.startsWith('FULL')) for (const j of prev) out.push({ reader: k, writer: j })
  if (mode.startsWith('FORWARD') || mode.startsWith('FULL')) for (const j of prev) out.push({ reader: j, writer: k })
  return out
}

export function analyze(subject: Pick<Subject, 'format' | 'versions' | 'policy'>): Analysis {
  const { format, versions, policy } = subject
  const parsed = versions.map((v) => parseVersion(format, v.text))
  const memo = new Map<string, Issue[] | null>()
  const pair = (r: number, w: number) => {
    const key = `${r}|${w}`
    if (!memo.has(key)) {
      const a = parsed[r], b = parsed[w]
      memo.set(key, a?.ok && b?.ok ? checkPair(format, a.schema, b.schema, r >= w ? 'reader' : 'writer', policy) : null)
    }
    return memo.get(key)!
  }
  const checks = (k: number, mode: Mode): ModeCheck[] => modePairs(k, mode).map(({ reader, writer }) => ({ reader, writer, issues: pair(reader, writer) ?? [] }))
  const verdict: Analysis['verdict'] = (k, mode) => {
    if (!parsed[k]?.ok) return 'invalid'
    if (k === 0) return 'first'
    if (modePairs(k, mode).some(({ reader, writer }) => pair(reader, writer) === null)) return 'invalid'
    return checks(k, mode).every((c) => breaking(c.issues).length === 0) ? 'pass' : 'fail'
  }
  const breaks: Analysis['breaks'] = (k, mode) => checks(k, mode).filter((c) => breaking(c.issues).length)
  return { parsed, pair, checks, verdict, breaks }
}

/** The error string the registry returns for this difference. */
export function registryError(format: Format, issue: Issue): string {
  const esc = (s: string) => s.replace(/"/g, '\\"')
  const info = format === 'AVRO' && issue.info ? `, additionalInfo:"${esc(issue.info)}"` : ''
  return `{errorType:"${issue.type}", description:"${esc(issue.message)}"${info}}`
}

export interface Explanation {
  title: string
  who: string
  why: string
  advice: string
}

const ADVICE: Record<string, [string, string, string]> = {
  // [title, why, advice]
  READER_FIELD_MISSING_DEFAULT_VALUE: ['Reader needs a field the writer never wrote', 'Avro resolves fields by name. When a field exists in the reader but not in the writer, the reader must fill it from a default. There is none, so decoding throws.', 'Give the reader field a default. For optional data use a union with null first: ["null", T] with "default": null.'],
  TYPE_MISMATCH: ['Field type cannot be resolved', 'Avro only promotes int → long → float → double and string ↔ bytes. Any other type change means the reader cannot decode the bytes on the wire.', 'Keep the old type and add a new field for the new representation, then migrate consumers.'],
  MISSING_UNION_BRANCH: ['Writer can produce a union branch the reader lacks', 'The writer may encode any branch of its union. The reader has no branch that accepts this one, so records using it fail to decode.', 'Keep the branch in the reader union, or stop writing it.'],
  MISSING_ENUM_SYMBOLS: ['Writer can send an enum symbol the reader does not know', 'Enum symbols resolve by name. A symbol unknown to the reader fails, unless the reader enum declares a default symbol.', 'Declare an enum-level "default" from the very first version, so future symbols can be added safely.'],
  NAME_MISMATCH: ['Named type was renamed', 'Records, enums and fixed types resolve by name. The reader sees a different name and refuses the writer type.', 'Add the old full name to the reader type\'s "aliases" rather than renaming outright.'],
  FIXED_SIZE_MISMATCH: ['Fixed size changed', 'A fixed value has no length prefix: the reader takes exactly its declared size, and would misalign every field after it.', 'Keep the size. Add a new fixed field for the new width.'],

  TYPE_CHANGED: ['Type changed', 'The writer can produce values of the old type, and the reader validates against an unrelated type, so those documents are rejected.', 'Accept both types with a type array or oneOf, or add a new property for the new type.'],
  TYPE_NARROWED: ['Type narrowed', 'The reader accepts fewer values than the writer can produce. "number" to "integer" rejects 1.5.', 'Keep the wider type.'],
  OPTIONAL_PROPERTY_ADDED_TO_OPEN_CONTENT_MODEL: ['New property on an open content model', 'With additionalProperties left open, old producers were allowed to send this property name with ANY type. The new schema constrains it, so old data could fail validation. This is why adding an optional field to a default JSON Schema fails BACKWARD.', 'Declare "additionalProperties": false from the first version, then optional properties can be added. Otherwise set the subject to FORWARD, or the LENIENT policy, or relax the property to {}.'],
  REQUIRED_PROPERTY_ADDED_TO_OPEN_CONTENT_MODEL: ['New required property on an open content model', 'Old records do not carry this property, and the open model means they could also carry it with any type. Either way the new reader rejects them.', 'Make it optional and start from a closed content model.'],
  REQUIRED_PROPERTY_WITH_DEFAULT_ADDED_TO_OPEN_CONTENT_MODEL: ['New required property with default on an open content model', 'The default covers records that omit it, but the open content model still allows old producers to have sent this name with any type.', 'Use a closed content model from the first version, or the LENIENT policy.'],
  REQUIRED_PROPERTY_ADDED_TO_UNOPEN_CONTENT_MODEL: ['New required property with no default', 'Old records cannot contain this property, because the old schema was closed. They fail the new required check.', 'Add a default to the property, or leave it optional.'],
  REQUIRED_ATTRIBUTE_ADDED: ['Existing property became required', 'Old records were allowed to omit this property, so some of them will fail the new required check.', 'Add a default to the property, or leave it optional.'],
  PROPERTY_REMOVED_FROM_CLOSED_CONTENT_MODEL: ['Property removed from a closed content model', 'Old records may contain this property. The closed reader no longer allows it, so they are rejected.', 'Keep the property, or open the content model with an additionalProperties schema that covers it.'],
  PROPERTY_ADDED_NOT_COVERED_BY_PARTIALLY_OPEN_CONTENT_MODEL: ['New property not covered by additionalProperties', 'Old records may hold this name under the additionalProperties schema, which accepts values this property does not.', 'Make the property schema at least as wide as additionalProperties.'],
  PROPERTY_REMOVED_NOT_COVERED_BY_PARTIALLY_OPEN_CONTENT_MODEL: ['Removed property not covered by additionalProperties', 'Old records may contain this property, and it now falls through to an additionalProperties schema that rejects those values.', 'Widen additionalProperties to cover it, or keep the property.'],
  ADDITIONAL_PROPERTIES_REMOVED: ['Content model closed', 'Old records may carry extra properties. Setting additionalProperties to false rejects them.', 'Keep the content model open.'],
  ADDITIONAL_PROPERTIES_NARROWED: ['additionalProperties narrowed', 'Extra properties in old records could have any type, and the new schema constrains them.', 'Keep additionalProperties open.'],
  ENUM_ARRAY_NARROWED: ['Enum values removed', 'Old records may contain the removed values, which the reader now rejects.', 'Keep the values. Deprecate them in documentation until the data ages out.'],
  ENUM_ARRAY_CHANGED: ['Enum values changed', 'Old records may contain the values that are gone.', 'Add new values without removing old ones.'],
  SCHEMA_ADDED: ['Schema added', 'A subschema now constrains values the writer did not constrain.', 'Revert this subschema.'],
  COMBINED_TYPE_CHANGED: ['Combined type changed', 'oneOf, anyOf and allOf have different rules, and this change can reject values that used to pass.', 'Keep the same combinator, or widen to anyOf.'],
  COMBINED_TYPE_SUBSCHEMAS_CHANGED: ['Combined subschema no longer matched', 'At least one subschema has no compatible partner in the reader, so values matching it are rejected.', 'Keep a compatible branch for each old subschema.'],
  SUM_TYPE_NARROWED: ['Branch removed from oneOf/anyOf', 'Old records may match only the removed branch.', 'Keep the branch.'],
  PRODUCT_TYPE_EXTENDED: ['Constraint added to allOf', 'Every allOf branch must pass, so one more branch rejects more values.', 'Remove the added allOf branch.'],
  NOT_TYPE_EXTENDED: ['"not" now rejects more', 'A wider "not" schema rejects values the writer could produce.', 'Revert the "not" schema.'],
  UNIQUE_ITEMS_ADDED: ['uniqueItems added', 'Old arrays may contain duplicates.', 'Deduplicate in the producer and leave the schema alone.'],
  ADDITIONAL_ITEMS_REMOVED: ['Tuple closed', 'Old tuples may have had extra items, which are now rejected.', 'Keep additionalItems open.'],
  ITEM_ADDED_TO_OPEN_CONTENT_MODEL: ['Tuple item added on an open tuple', 'Old tuples could already have a value at this position, of any type.', 'Close the tuple from the first version.'],
  ITEM_REMOVED_FROM_CLOSED_CONTENT_MODEL: ['Tuple item removed from a closed tuple', 'Old tuples have a value at this position, and the reader rejects it.', 'Keep the tuple item.'],

  PACKAGE_CHANGED: ['Package changed', 'Fully qualified message names change, so type lookups across versions no longer line up.', 'Keep the package. Create a new subject for a new package.'],
  MESSAGE_REMOVED: ['Message type missing', 'The schema resolves message types by name and message index. A message that exists only on the writer side has no reader counterpart. Note that this also makes adding a message fail FORWARD.', 'Keep the message definition, even if nothing references it.'],
  FIELD_KIND_CHANGED: ['Field kind changed', 'Scalars, messages and maps use different wire encodings on the same tag, so decoding fails or silently yields garbage.', 'Tags are forever: keep this tag, add the new shape on an unused tag.'],
  FIELD_SCALAR_KIND_CHANGED: ['Scalar kind changed', 'Only scalars in the same wire group interchange: int32/int64/uint32/uint64/bool, sint32/sint64, string/bytes, fixed32/sfixed32, fixed64/sfixed64. This change crosses groups.', 'Tags are forever: keep this tag, add the new type on an unused tag.'],
  FIELD_NAMED_TYPE_CHANGED: ['Message type of a field changed', 'The tag now points to a different message type, so nested fields are read with the wrong meaning.', 'Keep this tag, add a new field for the new message.'],
  FIELD_NUMERIC_LABEL_CHANGED: ['Numeric field label changed', 'Repeated numerics are packed: one length-delimited record on the wire. A singular reader does not decode that as a number.', 'Keep the label. Add a new repeated field on an unused tag.'],
  REQUIRED_FIELD_ADDED: ['Required field added', 'Records from the writer do not have this field, and the reader refuses to parse a message that lacks a required field.', 'Make it optional. Protobuf treats required as forever.'],
  REQUIRED_FIELD_REMOVED: ['Required field removed', 'Readers that still require it reject new messages. The registry flags the removal in either direction.', 'Keep the field. Keep sending it until no reader requires it.'],
  ONEOF_FIELD_REMOVED: ['Member removed from a oneof', 'Old records may have this member set, and the data would be lost or misread when the rest of the oneof survives.', 'Keep the member, or delete the entire oneof.'],
  MULTIPLE_FIELDS_MOVED_TO_ONEOF: ['Independent fields merged into a oneof', 'Old records may set several of these fields at once. In a oneof, the last one parsed wins and the rest vanish.', 'Add a new oneof with new fields. Leave the old fields as they are.'],
  FIELD_MOVED_TO_EXISTING_ONEOF: ['Field moved into an existing oneof', 'Old records may set this field along with a member of the oneof. Now only one survives.', 'Add a new field inside the oneof, and leave the old one outside.'],
}

const CONSTRAINT = /^(MAX_LENGTH|MIN_LENGTH|PATTERN|MAXIMUM|MINIMUM|EXCLUSIVE_MAXIMUM|EXCLUSIVE_MINIMUM|MULTIPLE_OF|MAX_PROPERTIES|MIN_PROPERTIES|MAX_ITEMS|MIN_ITEMS)_/

export function explain(issue: Issue, readerLabel: string, writerLabel: string, readerIsNewer: boolean): Explanation {
  const who = readerIsNewer
    ? `Consumers on ${readerLabel} cannot read records produced with ${writerLabel}. Upgraded consumers would fail on anything older still in the topic.`
    : `Consumers still on ${readerLabel} cannot read records produced with ${writerLabel}. Upgraded producers would break consumers that have not moved yet.`
  const a = ADVICE[issue.type]
  if (a) return { title: a[0], who, why: a[1], advice: a[2] }
  if (CONSTRAINT.test(issue.type))
    return { title: 'Validation constraint tightened', who, why: 'The writer can produce values the reader\'s tighter constraint now rejects.', advice: 'Tighten in the producer\'s code path, and leave the schema constraint as wide as the data already out there.' }
  return { title: issue.type.toLowerCase().replace(/_/g, ' '), who, why: 'The registry treats this change as incompatible.', advice: 'Revert this part of the schema.' }
}

export interface UpgradeAdvice {
  order: string
  detail: string
  rewind: string
}

export const MODE_INFO: Record<Mode, UpgradeAdvice & { checks: string }> = {
  BACKWARD: { checks: 'New schema reads data from the latest version', order: 'Consumers first', detail: 'Upgrade consumers, let them drain, then upgrade producers. New consumers can read what old producers write.', rewind: 'Consumers can only rewind to the previous version.' },
  BACKWARD_TRANSITIVE: { checks: 'New schema reads data from all versions', order: 'Consumers first', detail: 'Same order as BACKWARD, and the new schema reads the whole history.', rewind: 'Consumers can rewind to the beginning of the topic.' },
  FORWARD: { checks: 'Latest version reads data from the new schema', order: 'Producers first', detail: 'Upgrade producers, then consumers once ready. Old consumers can read what new producers write.', rewind: 'Consumers can only process back to the previous version.' },
  FORWARD_TRANSITIVE: { checks: 'All versions read data from the new schema', order: 'Producers first', detail: 'Same order as FORWARD, and consumers on any earlier version keep working.', rewind: 'Consumers on any version keep working.' },
  FULL: { checks: 'Both directions against the latest version', order: 'Any order', detail: 'Producers and consumers upgrade independently.', rewind: 'Consumers can only rewind to the previous version.' },
  FULL_TRANSITIVE: { checks: 'Both directions against all versions', order: 'Any order', detail: 'Producers and consumers upgrade independently, with any version in play.', rewind: 'Consumers can rewind to the beginning of the topic.' },
  NONE: { checks: 'No checks', order: 'Coordinate by hand', detail: 'The registry accepts anything, so nothing protects you. Roll out together, or write the new format to a new topic.', rewind: 'No guarantee.' },
}

/** What this particular transition allows, whatever the configured mode says. */
export function transitionAdvice(a: Analysis, k: number): { order: string; tone: 'ok' | 'warn' | 'bad'; detail: string } {
  const back = a.verdict(k, 'BACKWARD') === 'pass'
  const fwd = a.verdict(k, 'FORWARD') === 'pass'
  if (back && fwd) return { order: 'Any order', tone: 'ok', detail: 'Compatible in both directions, so producers and consumers can move independently.' }
  if (back) return { order: 'Consumers first', tone: 'warn', detail: 'New consumers read old data, but old consumers fail on new data.' }
  if (fwd) return { order: 'Producers first', tone: 'warn', detail: 'Old consumers read new data, but new consumers fail on old data still in the topic.' }
  return { order: 'No safe order', tone: 'bad', detail: 'Broken in both directions. Use a new topic or subject with dual writes, then migrate consumers.' }
}

/** The strictest modes this version would satisfy. */
export const passingModes = (a: Analysis, k: number) => MODES.filter((m) => a.verdict(k, m) === 'pass')

export function applyFix(text: string, fix: Fix): string {
  return applyPatch(text, fix.ops)
}

// ---------- structural diff ----------

export type { Change }

export function structuralChanges(format: Format, a: any, b: any, policy: JsonPolicy = 'STRICT'): Change[] {
  if (format === 'AVRO') return diffAvro(a, b)
  const issues = format === 'JSON' ? checkJsonSchema(b, a, 'reader', policy) : checkProto(b, a, 'reader')
  return issues.map((i) => ({
    kind: /ADDED|EXTENDED|INCREASED|EXPANDED/.test(i.type) ? ('added' as const) : /REMOVED|NARROWED|DECREASED|REDUCED/.test(i.type) ? ('removed' as const) : ('changed' as const),
    field: i.field,
    detail: i.type + (i.info ? ` · ${i.info}` : ''),
  }))
}

export interface DiffLine {
  kind: 'same' | 'add' | 'del'
  text: string
  a?: number
  b?: number
}

/** LCS line diff. Prefix and suffix are trimmed first, so the table stays small in practice. */
export function lineDiff(aText: string, bText: string): DiffLine[] {
  const a = aText.split('\n'), b = bText.split('\n')
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let suf = 0
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++
  const am = a.slice(pre, a.length - suf), bm = b.slice(pre, b.length - suf)
  const dp = Array.from({ length: am.length + 1 }, () => new Uint32Array(bm.length + 1))
  for (let i = am.length - 1; i >= 0; i--)
    for (let j = bm.length - 1; j >= 0; j--) dp[i][j] = am[i] === bm[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const out: DiffLine[] = []
  for (let i = 0; i < pre; i++) out.push({ kind: 'same', text: a[i], a: i + 1, b: i + 1 })
  let i = 0, j = 0
  while (i < am.length || j < bm.length) {
    if (i < am.length && j < bm.length && am[i] === bm[j]) {
      out.push({ kind: 'same', text: am[i], a: pre + i + 1, b: pre + j + 1 })
      i++, j++
    } else if (j < bm.length && (i === am.length || dp[i][j + 1] >= dp[i + 1][j])) {
      out.push({ kind: 'add', text: bm[j], b: pre + j + 1 })
      j++
    } else {
      out.push({ kind: 'del', text: am[i], a: pre + i + 1 })
      i++
    }
  }
  for (let k = 0; k < suf; k++) out.push({ kind: 'same', text: a[a.length - suf + k], a: a.length - suf + k + 1, b: b.length - suf + k + 1 })
  return out
}

/** Pretty-print JSON so whitespace-only edits stay out of the line diff. */
export function canonicalText(format: Format, text: string): string {
  if (format === 'PROTOBUF') return text.trim()
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

export function detectFormat(filename: string, text: string): Format {
  if (/\.proto$/i.test(filename) || /^\s*(syntax\s*=|message\s+\w+|package\s+[\w.]+\s*;)/m.test(text)) return 'PROTOBUF'
  if (/\.avsc$/i.test(filename)) return 'AVRO'
  try {
    const doc = JSON.parse(text)
    if (Array.isArray(doc) || typeof doc === 'string') return 'AVRO'
    if (['record', 'enum', 'fixed'].includes(doc?.type) && doc?.name) return 'AVRO'
    return 'JSON'
  } catch {
    return 'AVRO'
  }
}
