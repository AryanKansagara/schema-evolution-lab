import { useEffect, useState, type MouseEvent, type ReactNode } from 'react'
import Landing from './Landing.tsx'
import Lab from './Lab.tsx'

export function go(href: string) {
  history.pushState({}, '', href)
  dispatchEvent(new PopStateEvent('popstate'))
  scrollTo(0, 0)
}

export function Link({ href, className, children }: { href: string; className?: string; children: ReactNode }) {
  const onClick = (e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
    e.preventDefault()
    go(href)
  }
  return (
    <a href={href} className={className} onClick={onClick}>
      {children}
    </a>
  )
}

function ThemeToggle() {
  const [mode, setMode] = useState(() => document.documentElement.dataset.themeMode ?? 'light')
  const flip = () => {
    const next = mode === 'dark' ? 'light' : 'dark'
    document.documentElement.dataset.themeMode = next
    localStorage.setItem('themeMode', next)
    setMode(next)
  }
  return (
    <button className="icon-btn" onClick={flip} aria-label={mode === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} title="Toggle theme">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
        {mode === 'dark' ? (
          <>
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M4.900 4.900l1.400 1.400M17.700 17.700l1.400 1.400M2 12h2M20 12h2M4.900 19.100l1.400-1.400M17.700 6.300l1.400-1.400" />
          </>
        ) : (
          <path d="M21 12.800A9 9 0 1 1 11.200 3a7 7 0 0 0 9.800 9.800z" />
        )}
      </svg>
    </button>
  )
}

export function Header({ onDark }: { onDark?: boolean }) {
  return (
    <header className={'topbar' + (onDark ? ' on-dark' : '')}>
      <Link href="/" className="brand">
        <span className="mono-badge" aria-hidden>
          SE
        </span>
        <span>Schema Evolution Lab</span>
      </Link>
      <nav aria-label="Main">
        <Link href="/#modes" className="nav-link hide-sm">
          Modes
        </Link>
        <Link href="/#samples" className="nav-link hide-sm">
          Samples
        </Link>
        <Link href="/app" className="btn btn-primary btn-sm">
          Open the lab
        </Link>
        <ThemeToggle />
      </nav>
    </header>
  )
}

export function Footer({ wide }: { wide?: boolean }) {
  return (
    <footer className={'footer' + (wide ? ' lab-foot' : '')}>
      <div className="wrap">Built by Aryan Kansagara. Independent project, not affiliated with Confluent.</div>
    </footer>
  )
}

export default function App() {
  const [path, setPath] = useState(() => location.pathname)
  useEffect(() => {
    const onPop = () => setPath(location.pathname)
    addEventListener('popstate', onPop)
    return () => removeEventListener('popstate', onPop)
  }, [])
  return path.startsWith('/app') ? <Lab /> : <Landing />
}
