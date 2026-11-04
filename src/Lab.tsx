import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent, type KeyboardEvent } from 'react'
import { Footer, Header } from './App.tsx'
import { analyze, applyFix, detectFormat, type Subject, type Version } from './engine/compat.ts'
import { SAMPLES, STARTERS } from './engine/samples.ts'
import { decodeSubject, encodeSubject } from './engine/share.ts'
import { MODES, type Fix, type Format, type Mode } from './engine/types.ts'
import { DiffPanel, Findings, MatrixTable, PairGrid, SimulatePanel, UpgradePanel, type Focus } from './panels.tsx'

const STORE = 'schemaEvolutionLab'
const FORMATS: { key: Format; label: string }[] = [
  { key: 'AVRO', label: 'Avro' },
  { key: 'JSON', label: 'JSON Schema' },
  { key: 'PROTOBUF', label: 'Protobuf' },
]
const TABS = ['Compatibility', 'Diff', 'Simulate', 'Upgrade order'] as const
type Tab = (typeof TABS)[number]

let idSeq = 0
const newId = () => `v${Date.now().toString(36)}${idSeq++}`

function loadSaved(): Subject | null {
  try {
    const o = JSON.parse(localStorage.getItem(STORE) ?? 'null')
    if (o && Array.isArray(o.versions) && o.versions.length && MODES.includes(o.mode) && FORMATS.some((f) => f.key === o.format)) return { ...o, policy: o.policy === 'LENIENT' ? 'LENIENT' : 'STRICT' }
  } catch {
    /* corrupted storage falls back to a sample */
  }
  return null
}

function initial(): Subject {
  const sample = new URLSearchParams(location.search).get('sample')
  const s = SAMPLES.find((x) => x.key === sample)
  return structuredClone(s?.subject ?? loadSaved() ?? SAMPLES[0].subject)
}

/** Default to the most useful cell: the first rejection under the subject's mode. */
function firstFail(s: Subject): Focus | null {
  const a = analyze(s)
  for (let k = 1; k < s.versions.length; k++) if (a.verdict(k, s.mode) === 'fail') return { kind: 'mode', k, mode: s.mode }
  return null
}

function Editor({ text, onChange, error, warnings, label, onDropFile }: { text: string; onChange: (t: string) => void; error?: string; warnings: string[]; label: string; onDropFile: (files: File[]) => void }) {
  const gutter = useRef<HTMLDivElement>(null)
  const [over, setOver] = useState(false)
  const lines = text.split('\n').length
  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setOver(false)
    if (e.dataTransfer.files.length) onDropFile([...e.dataTransfer.files])
  }
  return (
    <div className={'editor' + (over ? ' over' : '') + (error ? ' has-error' : '')} onDragOver={(e) => { e.preventDefault(); setOver(true) }} onDragLeave={() => setOver(false)} onDrop={onDrop}>
      <div className="gutter" ref={gutter} aria-hidden>
        {Array.from({ length: lines }, (_, i) => (
          <span key={i}>{i + 1}</span>
        ))}
      </div>
      <textarea aria-label={label} spellCheck={false} autoCapitalize="off" autoCorrect="off" wrap="off" value={text} onChange={(e) => onChange(e.target.value)} onScroll={(e) => { if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop }} />
      {(error || warnings.length > 0) && (
        <div className={'editor-status ' + (error ? 'err' : 'warn')} role="status">
          {error ? `Does not parse: ${error}` : warnings.join(' · ')}
        </div>
      )}
    </div>
  )
}

export default function Lab() {
  const [subject, setSubject] = useState<Subject>(initial)
  const [selected, setSelected] = useState(() => {
    const f = firstFail(subject)
    return f?.kind === 'mode' ? f.k : subject.versions.length - 1
  })
  const [focus, setFocus] = useState<Focus | null>(() => firstFail(subject))
  const [tab, setTab] = useState<Tab>('Compatibility')
  const [toast, setToast] = useState<{ msg: string; undo?: Subject } | null>(null)
  const dragFrom = useRef<number | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const tablistRef = useRef<HTMLDivElement>(null)
  const timelineRef = useRef<HTMLOListElement>(null)

  const analysis = useMemo(() => analyze(subject), [subject])
  const n = subject.versions.length
  const sel = Math.min(selected, n - 1)
  const version = subject.versions[sel]
  const parsed = analysis.parsed[sel]

  useEffect(() => {
    const t = setTimeout(() => localStorage.setItem(STORE, JSON.stringify(subject)), 250)
    return () => clearTimeout(t)
  }, [subject])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 7000)
    return () => clearTimeout(t)
  }, [toast])

  const load = useCallback((s: Subject, msg?: string, undo?: Subject) => {
    setSubject(s)
    const f = firstFail(s)
    setFocus(f)
    setSelected(f?.kind === 'mode' ? f.k : s.versions.length - 1)
    if (msg) setToast({ msg, undo })
  }, [])

  // Shared links live in the hash. A query sample wins once, then the URL gets cleaned.
  useEffect(() => {
    const fromHash = async () => {
      const m = location.hash.match(/^#s=(.+)$/)
      if (!m) return
      const s = await decodeSubject(m[1])
      if (s) load(s, `Loaded shared subject ${s.name}`)
      else setToast({ msg: 'That share link is damaged, so it could not be loaded.' })
    }
    void fromHash()
    addEventListener('hashchange', fromHash)
    if (location.search.includes('sample=')) history.replaceState({}, '', '/app' + location.hash)
    return () => removeEventListener('hashchange', fromHash)
  }, [load])

  const patch = (p: Partial<Subject>) => setSubject((s) => ({ ...s, ...p }))
  const setVersions = (versions: Version[]) => patch({ versions })
  const editText = (text: string) => setVersions(subject.versions.map((v, i) => (i === sel ? { ...v, text } : v)))

  const addVersion = () => {
    setVersions([...subject.versions, { id: newId(), text: subject.versions[n - 1].text }])
    setSelected(n)
    setFocus(null)
  }
  const removeVersion = (i: number) => {
    if (n === 1) return
    const prev = subject
    setVersions(subject.versions.filter((_, j) => j !== i))
    setSelected(Math.max(0, i >= sel ? Math.min(sel, n - 2) : sel - 1))
    setFocus(null)
    setToast({ msg: `Deleted v${i + 1}`, undo: prev })
  }
  const move = (from: number, to: number) => {
    if (from === to || to < 0 || to >= n) return
    const vs = [...subject.versions]
    const [x] = vs.splice(from, 1)
    vs.splice(to, 0, x)
    setVersions(vs)
    setSelected(to)
    setFocus(null)
  }

  const fix = (f: Fix, k: number) => {
    const prev = subject
    try {
      const text = applyFix(subject.versions[k].text, f)
      const next = { ...subject, versions: subject.versions.map((v, i) => (i === k ? { ...v, text } : v)) }
      setSubject(next)
      setSelected(k)
      setToast({ msg: `v${k + 1}: ${f.label}`, undo: prev })
    } catch (e) {
      setToast({ msg: `That fix could not be applied: ${(e as Error).message}` })
    }
  }

  const setFormat = (format: Format) => {
    if (format === subject.format) return
    load({ ...subject, format, versions: [{ id: newId(), text: STARTERS[format] }] }, `Switched to ${format}, starting from a blank version`, subject)
  }

  const addFiles = async (files: File[]) => {
    const sorted = files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    const read = await Promise.all(sorted.map(async (file) => ({ name: file.name, text: await file.text() })))
    if (!read.length) return
    const format = detectFormat(read[0].name, read[0].text)
    const added = read.map((r) => ({ id: newId(), text: r.text }))
    if (format !== subject.format) {
      load({ ...subject, format, versions: added }, `${read[0].name} is ${format}, so this is now a new ${format} subject`, subject)
      return
    }
    setVersions([...subject.versions, ...added])
    setSelected(n + added.length - 1)
    setFocus(null)
    setToast({ msg: `Added ${read.map((r) => r.name).join(', ')}` })
  }
  const onFiles = (e: ChangeEvent<HTMLInputElement>) => {
    void addFiles([...(e.target.files ?? [])])
    e.target.value = ''
  }

  const share = async () => {
    const hash = await encodeSubject(subject)
    const url = `${location.origin}/app#s=${hash}`
    history.replaceState({}, '', `/app#s=${hash}`)
    try {
      await navigator.clipboard.writeText(url)
      setToast({ msg: 'Share link copied. The whole subject lives in the URL.' })
    } catch {
      setToast({ msg: 'Share link is in the address bar.' })
    }
  }

  const onTimelineKey = (e: KeyboardEvent, i: number) => {
    const delta = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
    if (!delta) return
    e.preventDefault()
    const to = i + delta
    if (to < 0 || to >= n) return
    if (e.altKey) move(i, to)
    else setSelected(to)
    requestAnimationFrame(() => timelineRef.current?.querySelectorAll<HTMLButtonElement>('.tl-node')[to]?.focus())
  }

  const onTabKey = (e: KeyboardEvent) => {
    const i = TABS.indexOf(tab)
    const next = e.key === 'ArrowRight' ? (i + 1) % TABS.length : e.key === 'ArrowLeft' ? (i + TABS.length - 1) % TABS.length : -1
    if (next < 0) return
    e.preventDefault()
    setTab(TABS[next])
    tablistRef.current?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus()
  }

  const accepted = subject.versions.filter((_, k) => analysis.verdict(k, subject.mode) !== 'fail' && analysis.verdict(k, subject.mode) !== 'invalid').length
  const failing = subject.versions.map((_, k) => k).filter((k) => analysis.verdict(k, subject.mode) === 'fail')
  const invalid = subject.versions.filter((_, k) => !analysis.parsed[k].ok).length

  return (
    <>
      <div className="lab-top">
        <Header />
        <div className="wrap-wide subject-bar">
          <label className="field">
            <span>Subject</span>
            <input value={subject.name} onChange={(e) => patch({ name: e.target.value })} spellCheck={false} />
          </label>
          <div className="field">
            <span id="fmt-label">Format</span>
            <div className="seg" role="group" aria-labelledby="fmt-label">
              {FORMATS.map((f) => (
                <button key={f.key} aria-pressed={subject.format === f.key} onClick={() => setFormat(f.key)}>
                  {f.label}
                </button>
              ))}
            </div>
          </div>
          <label className="field">
            <span>Compatibility</span>
            <select value={subject.mode} onChange={(e) => patch({ mode: e.target.value as Mode })}>
              {MODES.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </label>
          {subject.format === 'JSON' && (
            <label className="field" title="STRICT is the registry default. LENIENT allows optional properties on open content models.">
              <span>Policy</span>
              <select value={subject.policy} onChange={(e) => patch({ policy: e.target.value as Subject['policy'] })}>
                <option>STRICT</option>
                <option>LENIENT</option>
              </select>
            </label>
          )}
          <label className="field">
            <span>Sample</span>
            <select
              value=""
              onChange={(e) => {
                const s = SAMPLES.find((x) => x.key === e.target.value)
                if (s) load(structuredClone(s.subject), `Loaded ${s.title}`, subject)
              }}
            >
              <option value="" disabled>
                Load a sample…
              </option>
              {SAMPLES.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.title}
                </option>
              ))}
            </select>
          </label>
          <div className="subject-actions">
            <input ref={fileRef} type="file" hidden multiple accept=".avsc,.json,.proto,application/json,text/plain" onChange={onFiles} />
            <button className="btn btn-ghost btn-sm" onClick={() => fileRef.current?.click()}>
              Upload
            </button>
            <button className="btn btn-primary btn-sm" onClick={share}>
              Share
            </button>
          </div>
        </div>
      </div>

      <main className="wrap-wide lab-main">
        <h1 className="sr-only">Schema Evolution Lab</h1>
        <div className={`summary ${invalid ? 'warn' : failing.length ? 'bad' : 'ok'}`} role="status">
          <strong>
            {invalid ? `${invalid} version${invalid > 1 ? 's do' : ' does'} not parse` : failing.length ? `${failing.map((k) => `v${k + 1}`).join(', ')} rejected under ${subject.mode}` : `Every version passes ${subject.mode}`}
          </strong>
          <span>
            {accepted} of {n} accepted{subject.mode === 'NONE' && ', but NONE checks nothing'}
          </span>
        </div>

        <section aria-label="Version timeline" className="timeline-wrap">
          <ol className="timeline" ref={timelineRef}>
            {subject.versions.map((v, i) => {
              const vd = analysis.verdict(i, subject.mode)
              const isSel = i === sel
              return (
                <li
                  key={v.id}
                  className={`tl ${vd}${isSel ? ' selected' : ''}`}
                  draggable
                  onDragStart={() => (dragFrom.current = i)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    if (dragFrom.current !== null) move(dragFrom.current, i)
                    dragFrom.current = null
                  }}
                >
                  <button className="tl-node" aria-current={isSel ? 'true' : undefined} tabIndex={isSel ? 0 : -1} onClick={() => setSelected(i)} onKeyDown={(e) => onTimelineKey(e, i)} aria-label={`Version ${i + 1}, ${vd === 'fail' ? 'rejected' : vd === 'invalid' ? 'does not parse' : 'accepted'} under ${subject.mode}. Arrow keys select, Alt plus arrows reorder.`}>
                    <span className="tl-dot" aria-hidden>
                      {vd === 'fail' ? '✕' : vd === 'invalid' ? '!' : '✓'}
                    </span>
                    <span className="tl-name">v{i + 1}</span>
                  </button>
                  <div className="tl-tools">
                    <button aria-label={`Move v${i + 1} earlier`} disabled={i === 0} onClick={() => move(i, i - 1)}>
                      ←
                    </button>
                    <button aria-label={`Move v${i + 1} later`} disabled={i === n - 1} onClick={() => move(i, i + 1)}>
                      →
                    </button>
                    <button aria-label={`Delete v${i + 1}`} disabled={n === 1} onClick={() => removeVersion(i)}>
                      ×
                    </button>
                  </div>
                </li>
              )
            })}
            <li className="tl add">
              <button className="tl-node" onClick={addVersion} aria-label="Add a version, starting from the latest">
                <span className="tl-dot" aria-hidden>
                  +
                </span>
                <span className="tl-name">Add</span>
              </button>
            </li>
          </ol>
        </section>

        <div className="lab-grid">
          <section className="card editor-card" aria-label={`Editor for version ${sel + 1}`}>
            <div className="card-head">
              <h2>v{sel + 1}</h2>
              <span className="muted small">Paste, edit, or drop .avsc, .json or .proto files here</span>
            </div>
            <Editor key={version.id} label={`Schema text for version ${sel + 1}`} text={version.text} onChange={editText} error={parsed.ok ? undefined : parsed.error} warnings={parsed.ok ? parsed.warnings : []} onDropFile={(f) => void addFiles(f)} />
          </section>

          <section className="card analysis-card">
            <div className="tabs" role="tablist" aria-label="Analysis" ref={tablistRef} onKeyDown={onTabKey}>
              {TABS.map((t) => (
                <button key={t} role="tab" id={`tab-${t}`} aria-selected={tab === t} aria-controls="tabpanel" tabIndex={tab === t ? 0 : -1} onClick={() => setTab(t)}>
                  {t}
                </button>
              ))}
            </div>
            <div id="tabpanel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
              {tab === 'Compatibility' && (
                <div className="panel-body">
                  <h3>Version × mode</h3>
                  <MatrixTable analysis={analysis} count={n} focus={focus} onFocus={(f) => { setFocus(f); if (f.kind === 'mode') setSelected(f.k) }} activeMode={subject.mode} />
                  <p className="muted small legend">
                    <span>✓ accepted</span> <span>✕ rejected, with the number of incompatibilities</span> <span>– first version</span> Each row assumes every earlier version is registered.
                  </p>
                  <h3>Reader × writer</h3>
                  <PairGrid analysis={analysis} count={n} focus={focus} onFocus={setFocus} />
                  <Findings subject={subject} analysis={analysis} focus={focus} onFix={fix} />
                </div>
              )}
              {tab === 'Diff' && <DiffPanel subject={subject} analysis={analysis} selected={sel} />}
              {tab === 'Simulate' && <SimulatePanel subject={subject} analysis={analysis} selected={sel} />}
              {tab === 'Upgrade order' && <UpgradePanel subject={subject} analysis={analysis} selected={sel} />}
            </div>
          </section>
        </div>
      </main>
      <Footer wide />
      {toast && (
        <div className="toast" role="status">
          <span>{toast.msg}</span>
          {toast.undo && (
            <button
              onClick={() => {
                const u = toast.undo!
                setSubject(u)
                setFocus(firstFail(u))
                setToast(null)
              }}
            >
              Undo
            </button>
          )}
          <button aria-label="Dismiss" onClick={() => setToast(null)}>
            ×
          </button>
        </div>
      )}
    </>
  )
}
