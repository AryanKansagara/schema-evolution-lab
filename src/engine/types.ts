export type Format = 'AVRO' | 'JSON' | 'PROTOBUF'

export type Mode =
  | 'BACKWARD'
  | 'BACKWARD_TRANSITIVE'
  | 'FORWARD'
  | 'FORWARD_TRANSITIVE'
  | 'FULL'
  | 'FULL_TRANSITIVE'
  | 'NONE'

export const MODES: Mode[] = [
  'BACKWARD',
  'BACKWARD_TRANSITIVE',
  'FORWARD',
  'FORWARD_TRANSITIVE',
  'FULL',
  'FULL_TRANSITIVE',
  'NONE',
]

/** Which side of a reader/writer check is the newer version (the one being registered). */
export type Side = 'reader' | 'writer'

/** Edits to a JSON document (by JSON pointer) or to raw text (by offsets). */
export type PatchOp =
  | { op: 'set'; ptr: string; value: unknown }
  | { op: 'remove'; ptr: string }
  | { op: 'insert'; ptr: string; index: number; value: unknown }
  | { op: 'text'; start: number; end: number; value: string }

export interface Fix {
  label: string
  ops: PatchOp[]
}

export interface Issue {
  /** Confluent error / difference type, e.g. READER_FIELD_MISSING_DEFAULT_VALUE */
  type: string
  /** false = this difference breaks compatibility in the checked direction */
  compatible: boolean
  /** Location in Confluent style ("/fields/3/type" for Avro, "#/properties/x" for JSON, "#/Msg/2" for Protobuf) */
  path: string
  /** Human field path, e.g. Order.items[].sku */
  field: string
  /** Confluent-style description sentence */
  message: string
  /** Extra info as in the registry's additionalInfo */
  info?: string
  fix?: Fix
}
