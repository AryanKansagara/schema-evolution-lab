import type { Subject } from './compat.ts'

const j = (o: unknown) => JSON.stringify(o, null, 2)
const v = (id: string, text: string) => ({ id, text })

const baseOrder = [
  { name: 'order_id', type: 'string' },
  { name: 'customer_id', type: 'string' },
  { name: 'amount', type: 'double' },
  { name: 'quantity', type: 'int' },
  { name: 'currency', type: 'string' },
  { name: 'created_at', type: { type: 'long', logicalType: 'timestamp-millis' } },
]
const order = (fields: unknown[]) => j({ type: 'record', name: 'Order', namespace: 'com.acme.orders', fields })
const status = { name: 'status', type: { type: 'enum', name: 'OrderStatus', symbols: ['PENDING', 'PAID', 'SHIPPED', 'CANCELLED'] }, default: 'PENDING' }
const coupon = { name: 'coupon', type: ['null', 'string'], default: null }
const longQty = { name: 'quantity', type: 'long' }

const noCurrency = (fs: any[]) => fs.filter((f) => f.name !== 'currency')
const v2 = [...baseOrder, status, coupon]
const v3 = v2.map((f) => (f.name === 'quantity' ? longQty : f))
const v4 = [...noCurrency(v3), { name: 'channel', type: 'string' }]
const v5 = [...v4, { name: 'region', type: 'string', default: 'eu-west-1' }]

const orders: Subject = {
  name: 'orders-value',
  format: 'AVRO',
  mode: 'BACKWARD',
  policy: 'STRICT',
  versions: [v('o1', order(baseOrder)), v('o2', order(v2)), v('o3', order(v3)), v('o4', order(v4)), v('o5', order(v5))],
}

const user = (properties: object, required: string[], extra: object = {}) =>
  j({ $schema: 'http://json-schema.org/draft-07/schema#', title: 'UserProfile', type: 'object', properties, required, ...extra })
const uBase = { id: { type: 'string' }, email: { type: 'string', maxLength: 254 }, name: { type: 'string' }, plan: { enum: ['free', 'pro', 'enterprise'] } }
const uPhone = { ...uBase, phone: { type: 'string' } }

const users: Subject = {
  name: 'user-profile-value',
  format: 'JSON',
  mode: 'BACKWARD',
  policy: 'STRICT',
  versions: [
    v('u1', user(uBase, ['id', 'email'])),
    v('u2', user(uPhone, ['id', 'email'])),
    v('u3', user({ ...uPhone, email: { type: 'string', maxLength: 120 }, plan: { enum: ['free', 'pro'] } }, ['id', 'email', 'name'])),
    v('u4', user({ ...uPhone, name: { type: ['string', 'null'] } }, ['id', 'email'], { additionalProperties: false })),
  ],
}

const pay = (fields: string, extra = '', oneof = '') => `syntax = "proto3";

package acme.payments.v1;

message Payment {
  enum Status {
    STATUS_UNSPECIFIED = 0;
    AUTHORIZED = 1;
    CAPTURED = 2;
    REFUNDED = 3;${extra}
  }

${fields}${oneof}
}
`

const payments: Subject = {
  name: 'payments-value',
  format: 'PROTOBUF',
  mode: 'BACKWARD',
  policy: 'STRICT',
  versions: [
    v('p1', pay(`  string payment_id = 1;
  int64 amount_minor = 2;
  string currency = 3;
  Status status = 4;`)),
    v('p2', pay(`  string payment_id = 1;
  int64 amount_minor = 2;
  string currency = 3;
  Status status = 4;
  string merchant_id = 5;
  map<string, string> metadata = 6;`, `
    CHARGED_BACK = 4;`)),
    v('p3', pay(`  string payment_id = 1;
  string amount_minor = 2;
  string currency_code = 3;
  Status status = 4;
  map<string, string> metadata = 6;
  string card_token = 7;
  string bank_iban = 8;`, `
    CHARGED_BACK = 4;`)),
    v('p4', pay(`  string payment_id = 1;
  int64 amount_minor = 2;
  string currency_code = 3;
  Status status = 4;
  map<string, string> metadata = 6;`, `
    CHARGED_BACK = 4;`, `
  oneof method {
    string card_token = 7;
    string bank_iban = 8;
  }`)),
  ],
}

export const SAMPLES: { key: string; title: string; blurb: string; subject: Subject }[] = [
  { key: 'orders', title: 'Orders topic', blurb: 'Avro. Safe additions, a widening that only works one way, then a breaking release.', subject: orders },
  { key: 'users', title: 'User profile', blurb: 'JSON Schema. Why adding an optional field fails BACKWARD on an open content model.', subject: users },
  { key: 'payments', title: 'Payments', blurb: 'Protobuf. A tag reuse with a new type, then independent fields merged into a oneof.', subject: payments },
]

export const STARTERS: Record<Subject['format'], string> = {
  AVRO: j({ type: 'record', name: 'Event', namespace: 'com.example', fields: [{ name: 'id', type: 'string' }] }),
  JSON: j({ $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false }),
  PROTOBUF: `syntax = "proto3";\n\npackage example.v1;\n\nmessage Event {\n  string id = 1;\n}\n`,
}
