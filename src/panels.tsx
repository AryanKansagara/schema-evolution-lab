import { useEffect, useMemo, useState } from 'react'
import { breaking, canonicalText, explain, lineDiff, MODE_INFO, registryError, structuralChanges, transitionAdvice, type Analysis, type Subject } from './engine/compat.ts'
import { MODES, type Format, type Issue, type Mode, type Fix } from './engine/types.ts'
import { generate, simulate, type SimNote } from './engine/simulate.ts'
import type { AvroSchema } from './engine/avro.ts'

export type Focus = { kind: 'mode'; k: number; mode: Mode } | { kind: 'pair'; reader: number; writer: number }

const short = (m: Mode) => m.replace('BACKWARD', 'BACK').replace('FORWARD', 'FWD').replace('_TRANSITIVE', ' T')

const GLYPH: Record<string, string> = { pass: '✓', fail: '✕', invalid: '!', first: '–' }
const WORD: Record<string, string> = { pass: 'accepted', fail: 'rejected', invalid: 'does not parse', first: 'first version' }

export function MatrixTable({ analysis, count, focus, onFocus, activeMode, compact }: { analysis: Analysis; count: number; focus?: Focus | null; onFocus?: (f: Focus) => void; activeMode?: Mode; compact?: boolean }) {
  return (
    <div className="table-scroll">
      <table className={'matrix' + (compact ? ' compact' : '')}>
        <caption className="sr-only">Registry verdict for each version under each compatibility mode</caption>
        <thead>
          <tr>
            <th scope="col">
              <span className="sr-only">Version</span>
            </th>
            {MODES.map((m) => (
              <th key={m} scope="col" className={m === activeMode ? 'active' : ''} title={m}>
                {compact ? short(m) : m.replace('_', ' ')}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: count }, (_, k) => (
            <tr key={k}>
              <th scope="row">v{k + 1}</th>
              {MODES.map((m) => {
                const vd = analysis.verdict(k, m)
                const n = analysis.breaks(k, m).reduce((s, c) => s + breaking(c.issues).length, 0)
                const selected = focus?.kind === 'mode' && focus.k === k && focus.mode === m
                const title = `v${k + 1} under ${m}: ${WORD[vd]}${n ? `, ${n} incompatibilit${n === 1 ? 'y' : 'ies'}` : ''}`
                return (
                  <td key={m}>
                    {onFocus ? (
                      <button className={`cell ${vd}${selected ? ' selected' : ''}`} title={title} aria-label={title} aria-pressed={selected} onClick={() => onFocus({ kind: 'mode', k, mode: m })}>
                        <span aria-hidden>{GLYPH[vd]}</span>
                        {n > 0 && <small aria-hidden>{n}</small>}
                      </button>
                    ) : (
                      <span className={`cell ${vd}`} title={title}>
                        <span aria-hidden>{GLYPH[vd]}</span>
                        <span className="sr-only">{WORD[vd]}</span>
                      </span>
                    )}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function PairGrid({ analysis, count, focus, onFocus }: { analysis: Analysis; count: number; focus: Focus | null; onFocus: (f: Focus) => void }) {
  return (
    <div className="table-scroll">
      <table className="matrix pairs">
        <caption className="sr-only">Whether the reader version in each row can read data from the writer version in each column</caption>
        <thead>
          <tr>
            <th scope="col" className="corner">
              reader ↓ writer →
            </th>
            {Array.from({ length: count }, (_, w) => (
              <th key={w} scope="col">
                v{w + 1}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: count }, (_, r) => (
            <tr key={r}>
              <th scope="row">v{r + 1}</th>
              {Array.from({ length: count }, (_, w) => {
                if (r === w) return <td key={w} className="diag" aria-label="same version" />
                const issues = analysis.pair(r, w)
                const n = issues ? breaking(issues).length : 0
                const vd = issues === null ? 'invalid' : n ? 'fail' : 'pass'
                const selected = focus?.kind === 'pair' && focus.reader === r && focus.writer === w
                const title = issues === null ? `v${r + 1} / v${w + 1}: a schema does not parse` : `v${r + 1} reading v${w + 1} data: ${n ? `${n} incompatibilit${n === 1 ? 'y' : 'ies'}` : 'compatible'}`
                return (
                  <td key={w}>
                    <button className={`cell ${vd}${selected ? ' selected' : ''}`} title={title} aria-label={title} aria-pressed={selected} onClick={() => onFocus({ kind: 'pair', reader: r, writer: w })}>
                      <span aria-hidden>{GLYPH[vd]}</span>
                    </button>
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function IssueCard({ format, issue, reader, writer, onFix }: { format: Format; issue: Issue; reader: number; writer: number; onFix: (fix: Fix, k: number) => void }) {
  const newer = Math.max(reader, writer)
  const ex = explain(issue, `v${reader + 1}`, `v${writer + 1}`, reader > writer)
  return (
    <article className="issue">
      <header>
        <div>
          <h4>{ex.title}</h4>
          <code className="chip chip-bad">{issue.type}</code>
        </div>
        <span className="direction" title={`Reader v${reader + 1}, writer v${writer + 1}`}>
          v{writer + 1} data <span aria-hidden>→</span>
          <span className="sr-only">read by</span> v{reader + 1} reader
        </span>
      </header>
      <dl>
        <dt>Field</dt>
        <dd>
          <code>{issue.field}</code>
        </dd>
        <dt>Path</dt>
        <dd>
          <code>{issue.path}</code>
          {issue.info && <span className="muted"> · {issue.info}</span>}
        </dd>
        <dt>Who breaks</dt>
        <dd>{ex.who}</dd>
        <dt>Why</dt>
        <dd>{ex.why}</dd>
        <dt>Suggestion</dt>
        <dd>{ex.advice}</dd>
      </dl>
      <details>
        <summary>Registry error</summary>
        <pre className="code-block small">{registryError(format, issue)}</pre>
      </details>
      {issue.fix ? (
        <div className="issue-fix">
          <button className="btn btn-primary btn-sm" onClick={() => onFix(issue.fix!, newer)}>
            Apply fix to v{newer + 1}
          </button>
          <span>{issue.fix.label}</span>
        </div>
      ) : (
        <p className="muted small">No automatic fix for this one: it needs a design decision.</p>
      )}
    </article>
  )
}

export function Findings({ subject, analysis, focus, onFix }: { subject: Subject; analysis: Analysis; focus: Focus | null; onFix: (fix: Fix, k: number) => void }) {
  if (!focus)
    return <div className="empty">Select a matrix cell to see its verdict, explained.</div>
  const n = subject.versions.length
  const checks =
    focus.kind === 'mode'
      ? analysis.checks(focus.k, focus.mode)
      : focus.reader < n && focus.writer < n
        ? [{ reader: focus.reader, writer: focus.writer, issues: analysis.pair(focus.reader, focus.writer) ?? [] }]
        : []
  const title = focus.kind === 'mode' ? `v${focus.k + 1} under ${focus.mode}` : `v${focus.reader + 1} reading v${focus.writer + 1} data`
  const bad = checks.flatMap((c) => breaking(c.issues).map((issue) => ({ issue, c })))
  const notes = checks.flatMap((c) => c.issues.filter((i) => i.compatible).map((issue) => ({ issue, c })))
  const reserves = checks.flatMap((c) => c.issues.filter((i) => i.compatible && i.fix).map((issue) => ({ issue, c })))
  const invalid = focus.kind === 'mode' ? analysis.verdict(focus.k, focus.mode) === 'invalid' : analysis.pair(focus.reader, focus.writer) === null
  return (
    <section className="findings" aria-label="Findings">
      <h3>
        {title}{' '}
        {invalid ? (
          <span className="tag warn">does not parse</span>
        ) : bad.length ? (
          <span className="tag bad">
            ✕ {bad.length} incompatibilit{bad.length === 1 ? 'y' : 'ies'}
          </span>
        ) : (
          <span className="tag ok">✓ compatible</span>
        )}
      </h3>
      {focus.kind === 'mode' && focus.k === 0 && <div className="empty">The first version has nothing to be compatible with.</div>}
      {focus.kind === 'mode' && focus.mode === 'NONE' && focus.k > 0 && <div className="empty">NONE skips the checks, so the registry accepts anything. See the reader × writer grid for what would break.</div>}
      {invalid && <div className="empty">Fix the parse error in the editor first.</div>}
      {bad.map(({ issue, c }, i) => (
        <IssueCard key={i} format={subject.format} issue={issue} reader={c.reader} writer={c.writer} onFix={onFix} />
      ))}
      {reserves.map(({ issue, c }, i) => (
        <div className="hygiene" key={i}>
          <div>
            <b>Compatible, but worth doing:</b> <code>{issue.field}</code> is gone and its tag is not reserved. Reusing it later would corrupt old data.
          </div>
          <button className="btn btn-ghost btn-sm" onClick={() => onFix(issue.fix!, Math.max(c.reader, c.writer))}>
            {issue.fix!.label}
          </button>
        </div>
      ))}
      {notes.length > 0 && (
        <details className="notes">
          <summary>
            {notes.length} compatible change{notes.length === 1 ? '' : 's'}
          </summary>
          <ul>
            {notes.map(({ issue }, i) => (
              <li key={i}>
                <code className="chip">{issue.type}</code> <code>{issue.field}</code> {issue.info && <span className="muted">{issue.info}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}

function VersionSelect({ label, value, count, onChange }: { label: string; value: number; count: number; onChange: (n: number) => void }) {
  return (
    <label className="field-inline">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {Array.from({ length: count }, (_, i) => (
          <option key={i} value={i}>
            v{i + 1}
          </option>
        ))}
      </select>
    </label>
  )
}

export function DiffPanel({ subject, analysis, selected }: { subject: Subject; analysis: Analysis; selected: number }) {
  const n = subject.versions.length
  const [from, setFrom] = useState(Math.max(0, selected - 1))
  const [to, setTo] = useState(selected)
  useEffect(() => {
    setFrom(Math.max(0, selected - 1))
    setTo(selected)
  }, [selected])
  const a = Math.min(from, n - 1), b = Math.min(to, n - 1)
  const pa = analysis.parsed[a], pb = analysis.parsed[b]
  const changes = useMemo(() => (pa?.ok && pb?.ok && a !== b ? structuralChanges(subject.format, pa.schema, pb.schema, subject.policy) : []), [pa, pb, a, b, subject.format, subject.policy])
  const lines = useMemo(() => lineDiff(canonicalText(subject.format, subject.versions[a].text), canonicalText(subject.format, subject.versions[b].text)), [a, b, subject])
  return (
    <div className="panel-body">
      <div className="panel-tools">
        <VersionSelect label="From" value={a} count={n} onChange={setFrom} />
        <span aria-hidden>→</span>
        <VersionSelect label="To" value={b} count={n} onChange={setTo} />
      </div>
      {a === b ? (
        <div className="empty">Pick two different versions.</div>
      ) : !pa?.ok || !pb?.ok ? (
        <div className="empty">One of these versions does not parse, so only the text diff is available.</div>
      ) : changes.length === 0 ? (
        <div className="empty">No structural changes between these versions.</div>
      ) : (
        <ul className="changes">
          {changes.map((c, i) => (
            <li key={i} className={c.kind}>
              <span className="change-mark" aria-label={c.kind}>
                {c.kind === 'added' ? '+' : c.kind === 'removed' ? '−' : '~'}
              </span>
              <code>{c.field}</code>
              <span className="muted">{c.detail}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="linediff" role="table" aria-label="Line diff">
        {lines.map((l, i) => (
          <div key={i} className={`ld ${l.kind}`} role="row">
            <span className="ln">{l.a ?? ''}</span>
            <span className="ln">{l.b ?? ''}</span>
            <span className="mk" aria-hidden>
              {l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}
            </span>
            <span className="tx">{l.text || ' '}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

const NOTE_LABEL: Record<SimNote['kind'], string> = { default: 'default filled', dropped: 'dropped', promoted: 'promoted', union: 'union', 'enum-default': 'enum default', error: 'error' }

function RecordView({ value, marks }: { value: unknown; marks: Map<string, SimNote['kind']> }) {
  const text = JSON.stringify(value, null, 2) ?? 'undefined'
  return (
    <pre className="code-block record">
      {text.split('\n').map((line, i) => {
        const key = line.match(/^\s*"([^"]+)":/)?.[1]
        const kind = key ? marks.get(key) : undefined
        return (
          <span key={i} className={kind ? `mark-${kind}` : undefined}>
            {line}
            {'\n'}
          </span>
        )
      })}
    </pre>
  )
}

export function SimulatePanel({ subject, analysis, selected }: { subject: Subject; analysis: Analysis; selected: number }) {
  const n = subject.versions.length
  const [writer, setWriter] = useState(Math.max(0, selected - 1))
  const [reader, setReader] = useState(selected)
  useEffect(() => {
    setWriter(Math.max(0, selected - 1))
    setReader(selected)
  }, [selected])
  const w = Math.min(writer, n - 1), r = Math.min(reader, n - 1)
  const pw = analysis.parsed[w], pr = analysis.parsed[r]
  const genText = useMemo(() => {
    if (subject.format !== 'AVRO' || !pw?.ok) return ''
    const root = (pw.schema as AvroSchema).root
    return JSON.stringify(generate(root, 'name' in root ? root.name : 'value'), null, 2)
  }, [pw, subject.format])
  const [recordText, setRecordText] = useState(genText)
  useEffect(() => setRecordText(genText), [genText])

  if (subject.format !== 'AVRO')
    return (
      <div className="panel-body">
        <div className="empty">
          Simulation shows Avro's reader/writer resolution. {subject.format === 'JSON' ? 'JSON Schema validates documents and has no resolution step.' : 'Protobuf decodes by tag: unknown tags are kept aside and missing ones read as zero values.'} Open the orders sample to try it.
        </div>
      </div>
    )
  if (!pw?.ok || !pr?.ok) return <div className="panel-body"><div className="empty">Both versions must parse before a record can be resolved.</div></div>

  let record: unknown, recordErr = ''
  try {
    record = JSON.parse(recordText)
  } catch (e) {
    recordErr = (e as Error).message
  }
  let result: ReturnType<typeof simulate> | null = null
  if (!recordErr) {
    try {
      result = simulate(pr.schema as AvroSchema, pw.schema as AvroSchema, record)
    } catch (e) {
      recordErr = `This record does not match the writer schema: ${(e as Error).message}`
    }
  }
  const last = (p: string) => p.split('.').pop()!.replace(/\[\d+\]$/, '')
  const marks = new Map<string, SimNote['kind']>((result?.notes ?? []).filter((x) => x.kind !== 'dropped').map((x) => [last(x.path), x.kind]))
  const drops = new Map<string, SimNote['kind']>((result?.notes ?? []).filter((x) => x.kind === 'dropped').map((x) => [last(x.path), x.kind]))
  return (
    <div className="panel-body">
      <div className="panel-tools">
        <VersionSelect label="Writer" value={w} count={n} onChange={setWriter} />
        <span aria-hidden>→</span>
        <VersionSelect label="Reader" value={r} count={n} onChange={setReader} />
        <button className="btn btn-ghost btn-sm" onClick={() => setRecordText(genText)}>
          Reset record
        </button>
      </div>
      <div className="sim-grid">
        <div>
          <label className="pane-label" htmlFor="sim-record">
            Written with v{w + 1} (editable)
          </label>
          <textarea id="sim-record" className="code-area" spellCheck={false} value={recordText} rows={Math.max(10, recordText.split('\n').length + 1)} onChange={(e) => setRecordText(e.target.value)} />
          {recordErr && <p className="err small">{recordErr}</p>}
          {drops.size > 0 && (
            <div className="sim-drops">
              {[...drops.keys()].map((k) => (
                <code key={k} className="chip chip-bad">
                  − {k}
                </code>
              ))}
            </div>
          )}
        </div>
        <div>
          <span className="pane-label">Read with v{r + 1}</span>
          {result?.ok ? (
            <RecordView value={result.read} marks={marks} />
          ) : (
            <div className="sim-fail">
              <strong>✕ AvroTypeException</strong>
              <p>This record cannot be decoded. A consumer would crash or stop on this offset.</p>
            </div>
          )}
        </div>
      </div>
      {result && result.notes.length > 0 && (
        <ul className="sim-notes">
          {result.notes.map((x, i) => (
            <li key={i}>
              <span className={`tag ${x.kind === 'error' ? 'bad' : x.kind === 'default' || x.kind === 'enum-default' ? 'ok' : x.kind === 'dropped' ? 'warn' : ''}`}>{NOTE_LABEL[x.kind]}</span>
              <code>{x.path}</code>
              <span className="muted">{x.detail}</span>
            </li>
          ))}
        </ul>
      )}
      {result && result.notes.length === 0 && <div className="empty">Identical shape: every field passes through unchanged.</div>}
    </div>
  )
}

export function UpgradePanel({ subject, analysis, selected }: { subject: Subject; analysis: Analysis; selected: number }) {
  const n = subject.versions.length
  const steps = Array.from({ length: Math.max(0, n - 1) }, (_, i) => i + 1)
  return (
    <div className="panel-body">
      <h3>This history, step by step</h3>
      <p className="muted small">Based on what each transition actually allows, whatever the subject's mode is set to.</p>
      {steps.length === 0 && <div className="empty">Add a second version to get an upgrade order.</div>}
      <ol className="steps">
        {steps.map((k) => {
          const parsedOk = analysis.parsed[k]?.ok && analysis.parsed[k - 1]?.ok
          const adv = parsedOk ? transitionAdvice(analysis, k) : null
          return (
            <li key={k} className={k === selected ? 'current' : ''}>
              <span className="step-v">
                v{k} → v{k + 1}
              </span>
              {adv ? (
                <>
                  <span className={`tag ${adv.tone}`}>{adv.order}</span>
                  <span className="muted">{adv.detail}</span>
                </>
              ) : (
                <span className="muted">Does not parse.</span>
              )}
            </li>
          )
        })}
      </ol>
      <h3>By mode</h3>
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">Mode</th>
              <th scope="col">Upgrade first</th>
              <th scope="col">Rollout</th>
              <th scope="col">v{selected + 1}</th>
            </tr>
          </thead>
          <tbody>
            {MODES.map((m) => {
              const vd = analysis.verdict(selected, m)
              return (
                <tr key={m} className={m === subject.mode ? 'row-active' : ''}>
                  <th scope="row">
                    <code>{m}</code>
                  </th>
                  <td>
                    <b>{MODE_INFO[m].order}</b>
                  </td>
                  <td className="muted">
                    {MODE_INFO[m].detail} {MODE_INFO[m].rewind}
                  </td>
                  <td>
                    <span className={`tag ${vd === 'pass' ? 'ok' : vd === 'fail' ? 'bad' : ''}`}>
                      {GLYPH[vd]} {WORD[vd]}
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
