import { Footer, Header, Link } from './App.tsx'
import { MODE_INFO } from './engine/compat.ts'
import { MODES } from './engine/types.ts'

const SOURCES: { used: string; label: string; href: string }[] = [
  { used: 'JSON Schema difference types, compatible sets for STRICT and LENIENT, reported paths, content-model rules', label: 'confluentinc/schema-registry, json-schema-provider diff package', href: 'https://github.com/confluentinc/schema-registry/tree/master/json-schema-provider/src/main/java/io/confluent/kafka/schemaregistry/json/diff' },
  { used: 'Protobuf difference types and compatible set', label: 'confluentinc/schema-registry, protobuf-provider diff package', href: 'https://github.com/confluentinc/schema-registry/tree/master/protobuf-provider/src/main/java/io/confluent/kafka/schemaregistry/protobuf/diff' },
  { used: 'Conformance check: 139 JSON Schema and 54 Protobuf diff examples from the registry test suite', label: 'diff-schema-examples.json, diff-combined-schema-examples.json', href: 'https://github.com/confluentinc/schema-registry/tree/master/json-schema-provider/src/test/resources' },
  { used: 'Avro reader/writer rules: promotions, unions, enum defaults, aliases, fixed sizes', label: 'apache/avro SchemaCompatibility.java', href: 'https://github.com/apache/avro/blob/main/lang/java/avro/src/main/java/org/apache/avro/SchemaCompatibility.java' },
  { used: 'Compatibility modes and upgrade order', label: 'Confluent docs: Schema Evolution and Compatibility', href: 'https://docs.confluent.io/platform/current/schema-registry/fundamentals/schema-evolution.html' },
  { used: 'Shape of the registry API responses the importer accepts', label: 'Confluent docs: Schema Registry API reference', href: 'https://docs.confluent.io/platform/current/schema-registry/develop/api.html' },
]

export default function Docs() {
  return (
    <>
      <Header />
      <main>
        <section className="section wrap">
          <p className="eyebrow">How it works</p>
          <h2>What the lab checks, and how far to trust it.</h2>
          <p className="lead">
            The lab re-implements the compatibility checks Schema Registry runs when you register a schema, and runs them for every version
            of a subject under every mode at once. Nothing is sent anywhere: schemas are parsed and compared in your browser.
          </p>
          <p>
            <Link href="/app" className="btn btn-primary">
              Open the lab
            </Link>
          </p>
        </section>

        <section className="section-soft">
          <div className="section wrap">
            <h2>Modes</h2>
            <p>
              A check always has a reader schema and a writer schema. BACKWARD asks whether the new version can read data written with the
              old one; FORWARD asks the opposite; FULL asks both. The plain modes compare against the previous version only, the transitive
              ones against every earlier version.
            </p>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">Mode</th>
                    <th scope="col">What gets checked</th>
                    <th scope="col">Upgrade first</th>
                  </tr>
                </thead>
                <tbody>
                  {MODES.map((m) => (
                    <tr key={m}>
                      <th scope="row">
                        <code>{m}</code>
                      </th>
                      <td>{MODE_INFO[m].checks}</td>
                      <td>{MODE_INFO[m].order}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted small">
              Each matrix row assumes every earlier version was registered. A real registry would have refused a rejected version, so its
              later non-transitive checks would run against the last accepted one.
            </p>
          </div>
        </section>

        <section className="section wrap">
          <h2>The three formats</h2>
          <h3>Avro</h3>
          <p>
            Follows Apache Avro's <code>SchemaCompatibility</code>: a reader field missing from the writer needs a default; int promotes to
            long, float and double, long to float and double, float to double, and string and bytes read each other; every writer union
            branch must be readable by the reader; a reader enum may lack writer symbols only if it declares a default; named types match on
            their short name or a reader alias; fixed sizes must be equal. Logical types are not compared, exactly as in Avro, so changing a
            decimal's scale passes the check even though values will be misread.
          </p>
          <h3>JSON Schema</h3>
          <p>
            Follows the registry's <code>SchemaDiff</code>. The comparison produces a list of differences from the old schema to the new
            one, and the change is compatible when every difference is in the allowed set for the policy (STRICT by default, LENIENT if the
            subject is configured for it). Three rules surprise people:
          </p>
          <ul>
            <li>
              An object without <code>additionalProperties: false</code> is an open content model. Adding a typed property to it is not
              backward compatible, because old data may already carry that property with any value.
            </li>
            <li>
              A type next to <code>enum</code>, <code>const</code>, <code>not</code> or a combinator is treated as a product type (
              <code>allOf</code> of the parts). Dropping the enum from <code>{'{"type":"string","enum":[...]}'}</code> is therefore reported
              as <code>PRODUCT_TYPE_NARROWED</code>, and is compatible.
            </li>
            <li>
              Tuples (<code>items</code> as a list, or <code>prefixItems</code>) follow the same open, partially open and closed rules as
              properties, with <code>additionalItems</code> playing the part of <code>additionalProperties</code>.
            </li>
          </ul>
          <p>
            <code>dependencies</code>, <code>dependentRequired</code>, <code>dependentSchemas</code>, <code>unevaluatedProperties</code>,{' '}
            <code>unevaluatedItems</code>, <code>minContains</code> and <code>maxContains</code> are compared too.
          </p>
          <h3>Protobuf</h3>
          <p>
            Follows the registry's Protobuf <code>SchemaDiff</code>: fields are matched by tag number, scalar types are grouped into
            wire-compatible kinds, and moves in and out of a <code>oneof</code>, removed fields, and changed message types are classified
            the same way the registry does.
          </p>
        </section>

        <section className="section-soft">
          <div className="section wrap">
            <h2>Checked against the registry's own examples</h2>
            <p>
              The Schema Registry repository ships data files of schema pairs with the differences its diff code must report. On 16
              November 2026 the lab's engine was run against all of them:
            </p>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">Suite</th>
                    <th scope="col">Examples</th>
                    <th scope="col">Same verdict</th>
                    <th scope="col">Same difference list and paths</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <th scope="row">JSON Schema</th>
                    <td>139</td>
                    <td>139</td>
                    <td>139</td>
                  </tr>
                  <tr>
                    <th scope="row">Protobuf</th>
                    <td>54</td>
                    <td>50</td>
                    <td>47</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="muted small">
              The seven Protobuf examples that differ all depend on the contents of an imported file registered under another subject, which
              the lab cannot see. Those data files are not redistributed here; the repository's tests use cases written for this project
              that cover the same rules.
            </p>
          </div>
        </section>

        <section className="section wrap">
          <h2>Bringing in a real subject</h2>
          <p>
            Upload or drop <code>.avsc</code>, <code>.json</code> and <code>.proto</code> files; they are added in file-name order. The lab
            also reads what the registry's REST API returns, so you can export a whole subject and load it as one file:
          </p>
          <pre className="code-block">{`SR=https://your-registry:8081
S=orders-value
for v in $(curl -s $SR/subjects/$S/versions | jq '.[]'); do
  curl -s $SR/subjects/$S/versions/$v
done | jq -s . > $S.json`}</pre>
          <p>
            Each response looks like <code>{'{"subject":"orders-value","version":3,"id":42,"schemaType":"JSON","schema":"..."}'}</code>{' '}
            (<code>schemaType</code> is left out for Avro). The versions are loaded in order under the subject's name. Pasting a single
            response into the editor unwraps it as well.
          </p>
        </section>

        <section className="section-soft">
          <div className="section wrap">
            <h2>Limits</h2>
            <ul>
              <li>Schema references between subjects are not resolved. An external JSON Schema <code>$ref</code> is a parse error, and an imported Protobuf type is compared by name only.</li>
              <li>The registry's normalization, rule sets, metadata and <code>confluent:reserved</code> fields are not modeled.</li>
              <li>Where the registry's matching of <code>oneOf</code>/<code>anyOf</code>/<code>allOf</code> branches has more than one valid answer, the lab may pair branches differently and list different compatible differences. The verdict is the same.</li>
              <li>The Avro simulation covers JSON-encoded records, not binary data.</li>
            </ul>
          </div>
        </section>

        <section className="section wrap">
          <h2>Sources</h2>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Used for</th>
                  <th scope="col">Source</th>
                </tr>
              </thead>
              <tbody>
                {SOURCES.map((s) => (
                  <tr key={s.href}>
                    <td>{s.used}</td>
                    <td>
                      <a href={s.href} target="_blank" rel="noreferrer">
                        {s.label}
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted small">All retrieved 16 November 2026. The sample subjects in the lab are synthetic.</p>
        </section>
      </main>
      <Footer />
    </>
  )
}
