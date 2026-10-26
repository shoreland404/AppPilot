import { useCallback, useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import './App.css'

type AppRecord = {
  id: string
  name: string
  description: string
  source: string
  icon?: string | null
  installed: boolean
  package_name?: string | null
  exec?: string | null
  category: string
  path: string
}

type OverviewData = {
  discovered: number
  installed: number
  updates: number
  startup_entries: number
  running_processes: number
  package_status: {
    apt: boolean
    flatpak: boolean
    snap: boolean
    pkexec: boolean
  }
}

const navItems = [
  'Overview',
  'Installed Applications',
  'Discover',
  'Updates',
  'Startup Applications',
  'Running Applications',
  'Settings',
  'About AppPilot',
]

function App() {
  const [overview, setOverview] = useState<OverviewData | null>(null)
  const [apps, setApps] = useState<AppRecord[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [sourceFilter, setSourceFilter] = useState('all')
  const [activeSection, setActiveSection] = useState('Overview')
  const [error, setError] = useState<string | null>(null)
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  const load = useCallback(async () => {
    try {
      const [nextOverview, nextApps] = await Promise.all([
        invoke<OverviewData>('get_app_overview'),
        invoke<AppRecord[]>('refresh_applications'),
      ])
      setOverview(nextOverview)
      setApps(nextApps)
      setSelectedId((current) => current ?? nextApps[0]?.id ?? null)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load application data.')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const filteredApps = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return apps.filter((app) => {
      const matchesQuery =
        normalized.length === 0 ||
        app.name.toLowerCase().includes(normalized) ||
        app.description.toLowerCase().includes(normalized) ||
        app.source.toLowerCase().includes(normalized)
      const matchesSource =
        sourceFilter === 'all' ||
        app.source.toLowerCase() === sourceFilter.toLowerCase()
      return matchesQuery && matchesSource
    })
  }, [apps, query, sourceFilter])

  const selectedApp =
    filteredApps.find((app) => app.id === selectedId) ?? apps.find((app) => app.id === selectedId) ?? null

  const handleOpen = async (app: AppRecord) => {
    try {
      const result = await invoke<string>('launch_application', { appId: app.id })
      setError(null)
      window.alert(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to open this application.')
    }
  }

  const handlePackageAction = async (app: AppRecord, action: 'install' | 'remove' | 'update') => {
    try {
      const packageName = app.package_name ?? app.id
      const result = await invoke<string>('perform_package_action', {
        packageName,
        action,
        source: app.source,
      })
      setError(null)
      window.alert(result)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to complete package operation.')
    }
  }

  const sourceCounts = useMemo(
    () => ({
      all: apps.length,
      APT: apps.filter((app) => app.source === 'APT').length,
      Flatpak: apps.filter((app) => app.source === 'Flatpak').length,
      Snap: apps.filter((app) => app.source === 'Snap').length,
      Local: apps.filter((app) => app.source === 'Local').length,
    }),
    [apps],
  )

  return (
    <div className="desktop-shell">
      <aside className="sidebar">
        <div className="brand-block">
          <div className="brand-mark">A</div>
          <div>
            <span className="eyebrow">Linux package center</span>
            <strong>AppPilot</strong>
          </div>
        </div>

        <nav className="nav-list" aria-label="Sidebar navigation">
          {navItems.map((item) => (
            <button
              key={item}
              type="button"
              className={item === activeSection ? 'nav-item active' : 'nav-item'}
              onClick={() => setActiveSection(item)}
            >
              {item}
            </button>
          ))}
        </nav>

        <div className="sidebar-card">
          <span className="stat-label">Package managers</span>
          <div className="package-status">
            <span className={overview?.package_status.apt ? 'online' : 'offline'}>APT</span>
            <span className={overview?.package_status.flatpak ? 'online' : 'offline'}>Flatpak</span>
            <span className={overview?.package_status.snap ? 'online' : 'offline'}>Snap</span>
          </div>
        </div>
      </aside>

      <main className="main-panel">
        <header className="toolbar">
          <label className="search-box" aria-label="Application search">
            <span>⌕</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search applications"
            />
          </label>

          <div className="toolbar-actions">
            <button type="button" className="ghost-button" onClick={() => void load()}>
              Refresh
            </button>
            <button
              type="button"
              className="ghost-button"
              onClick={() => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))}
            >
              {theme === 'dark' ? 'Light mode' : 'Dark mode'}
            </button>
          </div>
        </header>

        {error ? <div className="inline-error">{error}</div> : null}

        {activeSection === 'Overview' || activeSection === 'Updates' ? (
          <section className="overview-grid" aria-label="Overview">
            <div className="summary-card">
              <span className="stat-label">Discovered</span>
              <strong>{overview?.discovered ?? 0}</strong>
            </div>
            <div className="summary-card">
              <span className="stat-label">Installed</span>
              <strong>{overview?.installed ?? 0}</strong>
            </div>
            <div className="summary-card">
              <span className="stat-label">Updates</span>
              <strong>{overview?.updates ?? 0}</strong>
            </div>
            <div className="summary-card">
              <span className="stat-label">Startup apps</span>
              <strong>{overview?.startup_entries ?? 0}</strong>
            </div>
            <div className="summary-card">
              <span className="stat-label">Running</span>
              <strong>{overview?.running_processes ?? 0}</strong>
            </div>
          </section>
        ) : null}

        <section className="catalog-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Catalog</p>
              <h2>{activeSection}</h2>
            </div>

            <label className="select-wrap">
              <span>Source</span>
              <select value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value)}>
                <option value="all">All ({sourceCounts.all})</option>
                <option value="APT">APT ({sourceCounts.APT})</option>
                <option value="Flatpak">Flatpak ({sourceCounts.Flatpak})</option>
                <option value="Snap">Snap ({sourceCounts.Snap})</option>
                <option value="Local">Local ({sourceCounts.Local})</option>
              </select>
            </label>
          </div>

          <div className="app-list">
            {filteredApps.length === 0 ? (
              <div className="empty-state">
                <h3>No matching applications</h3>
                <p>Adjust search, filters, or refresh the package inventory.</p>
              </div>
            ) : (
              filteredApps.map((app) => (
                <button
                  key={app.id}
                  type="button"
                  className={selectedApp?.id === app.id ? 'app-card selected' : 'app-card'}
                  onClick={() => setSelectedId(app.id)}
                >
                  <div className="app-icon" aria-hidden="true">
                    {app.icon && app.icon !== 'unknown' ? (
                      <img src={app.icon} alt="" />
                    ) : (
                      <span>{app.name.slice(0, 2).toUpperCase()}</span>
                    )}
                  </div>

                  <div className="app-text">
                    <div className="app-row">
                      <strong>{app.name}</strong>
                      <span className="source-pill">{app.source}</span>
                    </div>
                    <p>{app.description}</p>
                    <small>{app.category || 'Applications'}</small>
                  </div>
                </button>
              ))
            )}
          </div>
        </section>

        {selectedApp ? (
          <aside className="detail-panel" aria-live="polite">
            <div className="detail-header">
              <div className="app-icon large" aria-hidden="true">
                {selectedApp.icon && selectedApp.icon !== 'unknown' ? (
                  <img src={selectedApp.icon} alt="" />
                ) : (
                  <span>{selectedApp.name.slice(0, 2).toUpperCase()}</span>
                )}
              </div>
              <div>
                <p className="eyebrow">Application</p>
                <h3>{selectedApp.name}</h3>
              </div>
            </div>

            <p className="detail-description">{selectedApp.description}</p>

            <dl className="meta-list">
              <div>
                <dt>Source</dt>
                <dd>{selectedApp.source}</dd>
              </div>
              <div>
                <dt>Package</dt>
                <dd>{selectedApp.package_name ?? selectedApp.id}</dd>
              </div>
              <div>
                <dt>Path</dt>
                <dd>{selectedApp.path}</dd>
              </div>
            </dl>

            <div className="action-row">
              <button type="button" className="primary-button" onClick={() => void handleOpen(selectedApp)}>
                Open
              </button>
              <button type="button" className="soft-button" onClick={() => void handlePackageAction(selectedApp, 'install')}>
                Install
              </button>
              <button type="button" className="soft-button" onClick={() => void handlePackageAction(selectedApp, 'update')}>
                Update
              </button>
              <button type="button" className="danger-button" onClick={() => void handlePackageAction(selectedApp, 'remove')}>
                Remove
              </button>
            </div>
          </aside>
        ) : null}
      </main>
    </div>
  )
}

export default App
