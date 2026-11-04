import { useEffect, useMemo, useRef, useState } from 'react'
import { analyze, breaking } from './engine/compat.ts'
import { SAMPLES } from './engine/samples.ts'
import type { Issue, Mode } from './engine/types.ts'

const TEAL = '#38cced'
const RED = '#ff4d78'
const BLUE = '#4da1ff'
const STEP_MS = 3400
const HERO_MODES: Mode[] = ['BACKWARD', 'FORWARD', 'FULL']

interface Ev {
  x: number
  lane: number
  v: number
  dead: number
  vy: number
  y: number
  speed: number
}

/** The stream is driven by the real engine: each version goes through checks for the chosen mode. */
export default function Hero() {
  const subject = SAMPLES[0].subject
  const analysis = useMemo(() => analyze(subject), [subject])
  const count = subject.versions.length
  const [mode, setMode] = useState<Mode>('BACKWARD')
  const reduced = useMemo(() => matchMedia('(prefers-reduced-motion: reduce)').matches, [])
  // Reduced motion rests on the version that breaks.
  const [cur, setCur] = useState(reduced ? 3 : 0)
  const ref = useRef<HTMLCanvasElement>(null)
  const state = useRef({ cur, mode })
  state.current = { cur, mode }

  const verdicts = useMemo(() => subject.versions.map((_, i) => analysis.verdict(i, mode)), [analysis, mode, subject])
  const firstIssue: Issue | undefined = useMemo(() => {
    for (const c of analysis.breaks(cur, mode)) return breaking(c.issues)[0]
    return undefined
  }, [analysis, cur, mode])
  const verdict = verdicts[cur]
  const failed = verdict === 'fail'

  useEffect(() => {
    if (reduced) return
    const t = setInterval(() => setCur((c) => (c + 1) % count), STEP_MS)
    return () => clearInterval(t)
  }, [count, reduced])

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = Math.min(devicePixelRatio || 1, 2)
    let w = 0, h = 0
    const fit = () => {
      const r = canvas.getBoundingClientRect()
      w = r.width
      h = r.height
      canvas.width = w * dpr
      canvas.height = h * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      if (reduced) draw(0)
    }
    const evs: Ev[] = []
    let last = 0, spawn = 0, raf = 0, glow = 0
    const laneY = (lane: number) => h * (0.2 + 0.2 * lane)
    const verdictOf = (v: number, m: Mode) => analysis.verdict(v, m) === 'fail'

    if (reduced) {
      for (let i = 0; i < 9; i++) evs.push({ x: 20 + i * 44, lane: i % 4, v: 3, dead: 0, vy: 0, y: 0, speed: 0 })
    }

    function pill(x: number, y: number, label: string, color: string, alpha: number) {
      if (!ctx) return
      ctx.globalAlpha = alpha
      ctx.fillStyle = color + '26'
      ctx.strokeStyle = color
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.roundRect(x - 19, y - 11, 38, 22, 11)
      ctx.fill()
      ctx.stroke()
      ctx.fillStyle = '#fff'
      ctx.font = '500 11px "JetBrains Mono", monospace'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(label, x, y + 0.5)
      ctx.globalAlpha = 1
    }

    function draw(dt: number) {
      if (!ctx) return
      const { cur: c, mode: m } = state.current
      const gx = w * 0.56
      const isBad = verdictOf(c, m)
      glow += ((isBad ? 1 : 0) - glow) * Math.min(1, dt / 220)
      ctx.clearRect(0, 0, w, h)

      // lanes
      ctx.strokeStyle = 'rgba(255,255,255,.07)'
      ctx.lineWidth = 1
      for (let l = 0; l < 4; l++) {
        ctx.beginPath()
        ctx.setLineDash([3, 7])
        ctx.moveTo(0, laneY(l))
        ctx.lineTo(w, laneY(l))
        ctx.stroke()
      }
      ctx.setLineDash([])

      // events
      for (const e of evs) {
        if (!reduced) {
          if (e.dead > 0) {
            e.dead += dt
            e.vy += dt * 0.0016
            e.y += e.vy * dt
            e.x -= dt * 0.05
          } else {
            const wasBefore = e.x < gx - 26
            e.x += e.speed * dt
            if (wasBefore && e.x >= gx - 26 && verdictOf(e.v, m)) {
              e.dead = 1
              e.vy = -0.12
            }
          }
        }
        const y = laneY(e.lane) + e.y
        const bad = e.dead > 0
        const alpha = bad ? Math.max(0, 1 - e.dead / 900) : Math.min(1, Math.min(e.x + 19, w - e.x) / 40)
        const color = bad ? RED : e.x > gx ? TEAL : BLUE
        if (alpha > 0) pill(e.x, y, `v${e.v + 1}`, color, alpha)
      }
      for (let i = evs.length - 1; i >= 0; i--) if (evs[i].x > w + 30 || evs[i].dead > 900) evs.splice(i, 1)

      // the gate
      const r = Math.round(0x38 + (0xff - 0x38) * glow), g = Math.round(0xcc + (0x4d - 0xcc) * glow), b = Math.round(0xed + (0x78 - 0xed) * glow)
      const color = `rgb(${r},${g},${b})`
      const grad = ctx.createLinearGradient(gx - 70, 0, gx + 4, 0)
      grad.addColorStop(0, `rgba(${r},${g},${b},0)`)
      grad.addColorStop(1, `rgba(${r},${g},${b},.28)`)
      ctx.fillStyle = grad
      ctx.fillRect(gx - 70, 10, 70, h - 32)
      ctx.fillStyle = color
      ctx.shadowColor = color
      ctx.shadowBlur = 22
      ctx.beginPath()
      ctx.roundRect(gx - 3, 10, 6, h - 32, 3)
      ctx.fill()
      ctx.shadowBlur = 0
    }

    function frame(t: number) {
      const dt = Math.min(48, t - last || 16)
      last = t
      spawn -= dt
      if (spawn <= 0) {
        spawn = 300 + Math.random() * 240
        // Travel to the gate takes one step, so what spawns now is the version the gate shows next.
        evs.push({ x: -24, lane: Math.floor(Math.random() * 4), v: (state.current.cur + 1) % count, dead: 0, vy: 0, y: 0, speed: (w * 0.56) / STEP_MS })
      }
      draw(dt)
      raf = requestAnimationFrame(frame)
    }

    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(canvas)
    if (!reduced) {
      // Warm up, so the stream is already flowing on first paint.
      for (let i = 0; i < 8; i++) evs.push({ x: (w * 0.5 * i) / 8, lane: i % 4, v: 0, dead: 0, vy: 0, y: 0, speed: (w * 0.56) / STEP_MS })
      raf = requestAnimationFrame(frame)
    }
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [analysis, count, reduced])

  return (
    <div className={'gate-card' + (failed ? ' is-bad' : '')}>
      <div className="gate-head">
        <span className="gate-subject">
          <span className="dot" aria-hidden /> orders-value
        </span>
        <div className="seg seg-dark" role="group" aria-label="Compatibility mode for the demo">
          {HERO_MODES.map((m) => (
            <button key={m} aria-pressed={mode === m} onClick={() => setMode(m)}>
              {m}
            </button>
          ))}
        </div>
      </div>
      <div className="gate-stage">
        <canvas ref={ref} aria-hidden />
        <span className="gate-label left">producers</span>
        <span className="gate-label mid">schema gate</span>
        <span className="gate-label right">consumers</span>
      </div>
      <ol className="gate-versions" aria-label="Versions">
        {verdicts.map((vd, i) => (
          <li key={i}>
            <button className={`gv ${vd}${i === cur ? ' cur' : ''}`} onClick={() => setCur(i)} aria-label={`Version ${i + 1}: ${vd === 'fail' ? 'rejected' : 'accepted'} under ${mode}`}>
              <span aria-hidden>{vd === 'fail' ? '✕' : '✓'}</span> v{i + 1}
            </button>
          </li>
        ))}
      </ol>
      <div className="gate-readout" aria-live="polite">
        {failed && firstIssue ? (
          <>
            <strong className="bad">v{cur + 1} rejected under {mode}</strong>
            <code>{firstIssue.type}</code>
            <span>{firstIssue.message}</span>
          </>
        ) : (
          <>
            <strong className="ok">{cur === 0 ? 'v1 registered' : `v${cur + 1} accepted under ${mode}`}</strong>
            <span>{cur === 0 ? 'The first version has nothing to be compatible with.' : 'Records keep flowing and consumers decode them.'}</span>
          </>
        )}
      </div>
    </div>
  )
}
