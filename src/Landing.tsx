import { useMemo } from 'react'
import { Footer, Header, Link } from './App.tsx'
import Hero from './Hero.tsx'
import { analyze, breaking, explain, MODE_INFO } from './engine/compat.ts'
import { SAMPLES } from './engine/samples.ts'
import { MODES } from './engine/types.ts'
import { MatrixTable } from './panels.tsx'

function Feature({ n, title, body }: { n: string; title: string; body: string }) {
  return (
    <div className="feature">
      <span className="feature-n" aria-hidden>
        {n}
      </span>
      <h3>{title}</h3>
      <p>{body}</p>
    </div>
  )
}

export default function Landing() {
  const orders = SAMPLES[0].subject
  const a = useMemo(() => analyze(orders), [orders])
  const issue = breaking(a.pair(3, 2) ?? [])[0]
  const ex = explain(issue, 'v4', 'v3', true)
  return (
    <>
      <div className="hero">
        <Header onDark />
        <div className="wrap hero-grid">
          <div className="hero-copy">
            <p className="eyebrow">Schema Registry compatibility, for a whole subject</p>
            <h1>
              Catch the breaking schema <em>before the registry does.</em>
            </h1>
            <p className="lead">
              A 409 tells you a schema was rejected. It does not tell you which side breaks, what to change, or who upgrades first. Paste a subject's version history and see all of it, across all seven modes.
            </p>
            <div className="hero-cta">
              <Link href="/app" className="btn btn-primary">
                Check your schemas
              </Link>
              <Link href="/app?sample=orders" className="btn btn-outline-light">
                Try the orders topic
              </Link>
            </div>
            <p className="hero-note">Avro, JSON Schema, Protobuf. Runs in your browser, so nothing is uploaded.</p>
          </div>
          <Hero />
        </div>
      </div>

      <main>
        <section className="section wrap">
          <p className="eyebrow">From error type to fix</p>
          <h2>The registry's answer, translated.</h2>
          <div className="translate">
            <div className="translate-col">
              <span className="translate-tag">What you get from the API</span>
              <pre className="code-block">{`HTTP 409 Conflict
{
  "error_code": 409,
  "message": "Schema being registered is
    incompatible with an earlier schema for
    subject \\"orders-value\\", details:
    [{errorType:'${issue.type}', ...}]"
}`}</pre>
            </div>
            <div className="translate-col">
              <span className="translate-tag">What you get here</span>
              <div className="issue-preview">
                <strong>{ex.title}</strong>
                <code className="chip chip-bad">{issue.type}</code>
                <p>
                  <b>{issue.field}</b> at <code>{issue.path}</code>
                </p>
                <p>{ex.who}</p>
                <p className="muted">{ex.why}</p>
                <div className="fix-line">
                  <span className="muted">Apply fix:</span> {issue.fix?.label}
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="section-soft">
          <div className="section wrap">
            <div className="features">
              <Feature n="01" title="Version × mode matrix" body="All seven compatibility modes against every version, plus a reader × writer grid, so a transitive failure points at the exact old version that causes it." />
              <Feature n="02" title="One-click fixes" body="Add a default, keep a union branch, move a changed type to a fresh Protobuf tag. Each fix edits the new version, and the verdicts update right away." />
              <Feature n="03" title="Resolution you can watch" body="Generate an Avro record from the writer, or paste your own, and see the reader fill defaults, drop fields and promote types, line by line." />
              <Feature n="04" title="Rules from the source" body="Error types, messages and compatible-change sets follow Schema Registry's own diff code, including the open content model trap and STRICT vs LENIENT." />
            </div>
          </div>
        </section>

        <section className="section wrap" id="modes">
          <p className="eyebrow">Who upgrades first</p>
          <h2>Each mode implies a rollout order.</h2>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Mode</th>
                  <th scope="col">What gets checked</th>
                  <th scope="col">Upgrade first</th>
                  <th scope="col">Rewinding</th>
                </tr>
              </thead>
              <tbody>
                {MODES.map((m) => (
                  <tr key={m}>
                    <th scope="row">
                      <code>{m}</code>
                    </th>
                    <td>{MODE_INFO[m].checks}</td>
                    <td>
                      <b>{MODE_INFO[m].order}</b>
                    </td>
                    <td className="muted">{MODE_INFO[m].rewind}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="section-soft" id="samples">
          <div className="section wrap">
            <p className="eyebrow">Three histories, three formats</p>
            <h2>Open one, then swap in your own.</h2>
            <div className="sample-grid">
              {SAMPLES.map((s) => {
                const an = analyze(s.subject)
                return (
                  <Link key={s.key} href={`/app?sample=${s.key}`} className="sample-card">
                    <span className="chip">{s.subject.format === 'JSON' ? 'JSON Schema' : s.subject.format === 'AVRO' ? 'Avro' : 'Protobuf'}</span>
                    <h3>{s.title}</h3>
                    <p>{s.blurb}</p>
                    <MatrixTable analysis={an} count={s.subject.versions.length} compact />
                    <span className="sample-go">Open in the lab →</span>
                  </Link>
                )
              })}
            </div>
          </div>
        </section>

        <section className="cta">
          <div className="wrap">
            <h2>Find out before you register.</h2>
            <Link href="/app" className="btn btn-primary">
              Open the lab
            </Link>
          </div>
        </section>
      </main>
      <Footer />
    </>
  )
}
