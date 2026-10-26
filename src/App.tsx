import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { invoke, isTauri } from '@tauri-apps/api/core'
import './App.css'

type PackageStatus = {
  apt: boolean
  flatpak: boolean
  snap: boolean
  pkexec: boolean
  winget: boolean
}

type AppRecord = {
  id: string
  name: string
  description: string
  source: string
  icon: string | null
  installed: boolean
  package_name: string | null
  package_scope: string | null
  category: string
  path: string
}

type Overview = {
  installed_applications: number
  startup_entries: number | null
  running_processes: number | null
  package_status: PackageStatus
  platform: string
}

type Dashboard = {
  overview: Overview
  applications: AppRecord[]
}

type StartupEntry = {
  id: string
  name: string
  path: string
  enabled: boolean
  can_manage: boolean
}

type ProcessInfo = {
  pid: number
  name: string
  memory_kb: number
  can_terminate: boolean
}

type PackageUpdate = {
  package_name: string
  name: string
  source: string
  version: string
}

type FlatpakCatalogEntry = {
  app_id: string
  name: string
  description: string
  version: string
  remote: string
  scope: string
  installed: boolean
}

type Page = 'Overview' | 'Discover' | 'Applications' | 'Updates' | 'Startup apps' | 'Processes' | 'Settings' | 'About'

const navigation: { label: Page; icon: string }[] = [
  { label: 'Overview', icon: '◫' },
  { label: 'Discover', icon: '⌕' },
  { label: 'Applications', icon: '▦' },
  { label: 'Updates', icon: '↻' },
  { label: 'Startup apps', icon: '◷' },
  { label: 'Processes', icon: '⌘' },
]

const utilityNavigation: { label: Page; icon: string }[] = [
  { label: 'Settings', icon: '⚙' },
  { label: 'About', icon: 'ⓘ' },
]

function getErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  return String(error)
}

function getInitialTheme(): 'dark' | 'light' {
  const saved = localStorage.getItem('apppilot-theme')
  if (saved === 'dark' || saved === 'light') return saved
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function getInitialCompactMode() {
  return localStorage.getItem('apppilot-compact-mode') === 'true'
}

function getInitialGuideVisibility() {
  return localStorage.getItem('apppilot-guide-dismissed') !== 'true'
}

function getInitialSortOrder(): 'name-asc' | 'name-desc' {
  return localStorage.getItem('apppilot-sort-order') === 'name-desc' ? 'name-desc' : 'name-asc'
}

function getInitialFavorites(): string[] {
  const saved = localStorage.getItem('apppilot-favorites')
  if (!saved) return []
  try {
    const parsed: unknown = JSON.parse(saved)
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

function formatMemory(memoryKb: number) {
  if (memoryKb >= 1024 * 1024) return `${(memoryKb / 1024 / 1024).toFixed(1)} GB`
  if (memoryKb >= 1024) return `${(memoryKb / 1024).toFixed(0)} MB`
  return `${memoryKb} KB`
}

function App() {
  const [nativeRuntime] = useState(isTauri)
  const [page, setPage] = useState<Page>('Overview')
  const [overview, setOverview] = useState<Overview | null>(null)
  const [apps, setApps] = useState<AppRecord[]>([])
  const [updates, setUpdates] = useState<PackageUpdate[]>([])
  const [catalog, setCatalog] = useState<FlatpakCatalogEntry[]>([])
  const [startupEntries, setStartupEntries] = useState<StartupEntry[]>([])
  const [processes, setProcesses] = useState<ProcessInfo[]>([])
  const [selectedAppId, setSelectedAppId] = useState<string | null>(null)
  const [favoriteAppIds, setFavoriteAppIds] = useState<string[]>(getInitialFavorites)
  const [query, setQuery] = useState('')
  const [catalogQuery, setCatalogQuery] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('All categories')
  const [favoritesOnly, setFavoritesOnly] = useState(false)
  const [sourceFilter, setSourceFilter] = useState('All sources')
  const [theme, setTheme] = useState<'dark' | 'light'>(getInitialTheme)
  const [compactMode, setCompactMode] = useState(getInitialCompactMode)
  const [guideVisible, setGuideVisible] = useState(getInitialGuideVisibility)
  const [sortOrder, setSortOrder] = useState<'name-asc' | 'name-desc'>(getInitialSortOrder)
  const [loading, setLoading] = useState(nativeRuntime)
  const [pageLoading, setPageLoading] = useState(false)
  const [bulkUpdating, setBulkUpdating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)
  const platform = overview?.platform ?? 'linux'
  const catalogSearchSequence = useRef(0)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('apppilot-theme', theme)
  }, [theme])

  useEffect(() => {
    document.documentElement.dataset.density = compactMode ? 'compact' : 'comfortable'
    localStorage.setItem('apppilot-compact-mode', String(compactMode))
  }, [compactMode])

  useEffect(() => {
    localStorage.setItem('apppilot-favorites', JSON.stringify(favoriteAppIds))
  }, [favoriteAppIds])

  useEffect(() => {
    localStorage.setItem('apppilot-sort-order', sortOrder)
  }, [sortOrder])

  const loadOverview = useCallback(async () => {
    try {
      const dashboard = await invoke<Dashboard>('get_dashboard_data')
      setOverview(dashboard.overview)
      setApps(dashboard.applications)
      setFavoriteAppIds((current) => current.filter((id) => dashboard.applications.some((app) => app.id === id)))
      setSelectedAppId((current) => (current && dashboard.applications.some((app) => app.id === current) ? current : dashboard.applications[0]?.id ?? null))
      setError(null)
      setLastRefresh(new Date())
    } catch (loadError) {
      setError(getErrorMessage(loadError))
    } finally {
      setLoading(false)
    }
  }, [])

  const loadCurrentPage = useCallback(async () => {
    if (!nativeRuntime || page === 'Overview' || page === 'Applications' || page === 'Settings' || page === 'About') return
    try {
      if (page === 'Discover') {
        if (platform === 'windows') {
          setCatalog([])
        } else {
          setCatalog(await invoke<FlatpakCatalogEntry[]>('list_flatpak_catalog'))
        }
      } else if (page === 'Updates') {
        setUpdates(await invoke<PackageUpdate[]>('get_package_updates'))
      } else if (page === 'Startup apps') {
        const entries = await invoke<StartupEntry[]>('scan_startup_entries')
        setStartupEntries(entries)
        setOverview((current) => current ? { ...current, startup_entries: entries.filter((entry) => entry.enabled).length } : current)
      } else if (page === 'Processes') {
        const items = await invoke<ProcessInfo[]>('scan_running_processes')
        setProcesses(items)
        setOverview((current) => current ? { ...current, running_processes: items.length } : current)
      }
      setError(null)
      setLastRefresh(new Date())
    } catch (loadError) {
      setError(getErrorMessage(loadError))
    } finally {
      setPageLoading(false)
    }
  }, [nativeRuntime, page, platform])

  // Native inventory is an external system effect; browser-only mode never calls its IPC commands.
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    if (nativeRuntime) void loadOverview()
  }, [nativeRuntime, loadOverview])

  // Page data is fetched only after a native navigation target becomes active.
  useEffect(() => {
    if (page === 'Discover' && platform === 'windows') {
      return
    }
    const delay = page === 'Discover' ? 300 : 0
    const timer = window.setTimeout(() => void loadCurrentPage(), delay)
    return () => window.clearTimeout(timer)
  }, [catalogQuery, loadCurrentPage, page, platform])

  useEffect(() => {
    if (!nativeRuntime || platform !== 'windows' || page !== 'Discover') return
    if (catalogQuery.trim().length < 2) {
      return
    }
    const requestSequence = ++catalogSearchSequence.current
    const timer = window.setTimeout(() => {
      void invoke<FlatpakCatalogEntry[]>('search_package_catalog', { query: catalogQuery })
        .then((entries) => {
          if (requestSequence !== catalogSearchSequence.current) return
          setCatalog(entries)
          setError(null)
          setLastRefresh(new Date())
        })
        .catch((searchError: unknown) => {
          if (requestSequence === catalogSearchSequence.current) setError(getErrorMessage(searchError))
        })
        .finally(() => {
          if (requestSequence === catalogSearchSequence.current) setPageLoading(false)
        })
    }, 300)
    return () => {
      window.clearTimeout(timer)
      catalogSearchSequence.current += 1
    }
  }, [catalogQuery, nativeRuntime, page, platform])

  const sources = useMemo(
    () => ['All sources', ...Array.from(new Set(apps.map((app) => app.source))).sort()],
    [apps],
  )
  const categories = useMemo(
    () => ['All categories', ...Array.from(new Set(apps.flatMap((app) => app.category.split(',').map((category) => category.trim()).filter(Boolean)))).sort()],
    [apps],
  )
  const filteredApps = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return apps.filter((app) => {
      const matchesSearch =
        !normalized ||
        app.name.toLowerCase().includes(normalized) ||
        app.description.toLowerCase().includes(normalized) ||
        app.category.toLowerCase().includes(normalized) ||
        app.package_name?.toLowerCase().includes(normalized)
      const matchesCategory = categoryFilter === 'All categories' || app.category.split(',').some((category) => category.trim() === categoryFilter)
      const matchesFavorite = !favoritesOnly || favoriteAppIds.includes(app.id)
      return matchesSearch
        && matchesCategory
        && matchesFavorite
        && (sourceFilter === 'All sources' || app.source === sourceFilter)
    }).sort((left, right) => {
      const comparison = left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
      return sortOrder === 'name-asc' ? comparison : -comparison
    })
  }, [apps, categoryFilter, favoriteAppIds, favoritesOnly, query, sortOrder, sourceFilter])
  const filteredCatalog = useMemo(() => {
    const normalized = catalogQuery.trim().toLowerCase()
    if (!normalized) return catalog
    return catalog.filter((entry) =>
      entry.name.toLowerCase().includes(normalized)
      || entry.app_id.toLowerCase().includes(normalized)
      || entry.description.toLowerCase().includes(normalized),
    )
  }, [catalog, catalogQuery])
  const selectedApp = apps.find((app) => app.id === selectedAppId) ?? null
  const packageSources = platform === 'windows'
    ? [{ name: 'WinGet', available: overview?.package_status.winget ?? false }]
    : [
      { name: 'APT', available: overview?.package_status.apt ?? false },
      { name: 'Flatpak', available: overview?.package_status.flatpak ?? false },
      { name: 'Snap', available: overview?.package_status.snap ?? false },
    ]

  const dismissGuide = () => {
    setGuideVisible(false)
    localStorage.setItem('apppilot-guide-dismissed', 'true')
  }

  const toggleFavorite = (appId: string) => {
    setFavoriteAppIds((current) => current.includes(appId)
      ? current.filter((id) => id !== appId)
      : [...current, appId])
  }

  const refresh = () => {
    if (page === 'Overview' || page === 'Applications') {
      setLoading(true)
      void loadOverview()
    } else if (page === 'Discover' && platform === 'windows') {
      if (catalogQuery.trim().length < 2) return
      setPageLoading(true)
      void invoke<FlatpakCatalogEntry[]>('search_package_catalog', { query: catalogQuery })
        .then((entries) => { setCatalog(entries); setError(null); setLastRefresh(new Date()) })
        .catch((searchError: unknown) => setError(getErrorMessage(searchError)))
        .finally(() => setPageLoading(false))
    } else {
      setPageLoading(true)
      void loadCurrentPage()
    }
  }

  const navigateTo = useCallback((nextPage: Page) => {
    setPage(nextPage)
    setError(null)
    setNotice(null)
    if (nextPage === 'Discover' && platform === 'windows' && catalogQuery.trim().length < 2) {
      setPageLoading(false)
    } else if (nextPage === 'Discover' || nextPage === 'Updates' || nextPage === 'Startup apps' || nextPage === 'Processes') {
      setPageLoading(true)
    }
  }, [catalogQuery, platform])

  const openApplication = async (app: AppRecord) => {
    try {
      const message = await invoke<string>('launch_application', { appId: app.id })
      setError(null)
      setNotice(message)
    } catch (launchError) {
      setError(getErrorMessage(launchError))
      setNotice(null)
    }
  }

  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      const target = event.target
      const isTyping = target instanceof HTMLElement
        && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
      if (((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') || (event.key === '/' && !isTyping)) {
        event.preventDefault()
        navigateTo('Applications')
        searchRef.current?.focus()
      } else if (event.key === 'Escape' && document.activeElement === searchRef.current) {
        setQuery('')
        searchRef.current?.blur()
      }
    }
    window.addEventListener('keydown', handleShortcut)
    return () => window.removeEventListener('keydown', handleShortcut)
  }, [navigateTo])

  const manageApplication = async (app: AppRecord) => {
    if (!window.confirm(`Remove ${app.name} from this computer?`)) return
    try {
      setLoading(true)
      const message = await invoke<string>('perform_package_action', { appId: app.id, action: 'remove' })
      setNotice(message)
      setError(null)
      await loadOverview()
    } catch (operationError) {
      setError(getErrorMessage(operationError))
      setNotice(null)
    } finally {
      setLoading(false)
    }
  }

  const updateApplication = async (app: AppRecord) => {
    try {
      const availableUpdates = await invoke<PackageUpdate[]>('get_package_updates')
      const update = availableUpdates.find(
        (candidate) => candidate.package_name === app.package_name && candidate.source === app.source,
      )
      if (!update) {
        setNotice(`No update is currently available for ${app.name}.`)
        setError(null)
        return
      }
      setPageLoading(true)
      setNotice(await invoke<string>('update_package', {
        packageName: update.package_name,
        source: update.source,
      }))
      setError(null)
      await loadOverview()
    } catch (operationError) {
      setError(getErrorMessage(operationError))
      setNotice(null)
    } finally {
      setPageLoading(false)
    }
  }

  const updatePackage = async (update: PackageUpdate) => {
    try {
      setPageLoading(true)
      const message = await invoke<string>('update_package', {
        packageName: update.package_name,
        source: update.source,
      })
      setNotice(message)
      setError(null)
      await loadCurrentPage()
      await loadOverview()
    } catch (operationError) {
      setError(getErrorMessage(operationError))
      setNotice(null)
    } finally {
      setPageLoading(false)
    }
  }

  const updateAllPackages = async () => {
    const sources = [...new Set(updates.map((update) => update.source))]
    if (!window.confirm(`Install all ${updates.length} available updates from ${sources.join(', ')}?`)) return
    try {
      setBulkUpdating(true)
      const completed = await invoke<string[]>('update_all_packages')
      setNotice(completed.length ? `Update completed for: ${completed.join(', ')}.` : 'No updates were available.')
      setError(null)
      await loadCurrentPage()
      await loadOverview()
    } catch (updateError) {
      setError(getErrorMessage(updateError))
      setNotice(null)
    } finally {
      setBulkUpdating(false)
    }
  }

  const installCatalogApp = async (entry: FlatpakCatalogEntry) => {
    const scopeDescription = entry.scope === 'user' ? 'your user account' : 'all users on this system'
    if (!window.confirm(`Install ${entry.name} from ${entry.remote} for ${scopeDescription}?`)) return
    try {
      setPageLoading(true)
      const message = await invoke<string>('install_flatpak_application', {
        appId: entry.app_id,
        remote: entry.remote,
        scope: entry.scope,
      })
      setNotice(message)
      setError(null)
      setCatalog((current) => current.map((candidate) =>
        candidate.app_id === entry.app_id && candidate.scope === entry.scope
          ? { ...candidate, installed: true }
          : candidate,
      ))
      await loadOverview()
    } catch (installError) {
      setError(getErrorMessage(installError))
      setNotice(null)
    } finally {
      setPageLoading(false)
    }
  }

  const toggleStartupEntry = async (entry: StartupEntry) => {
    const nextEnabled = !entry.enabled
    if (!window.confirm(`${nextEnabled ? 'Enable' : 'Disable'} ${entry.name} ${nextEnabled ? 'at' : 'on'} login?`)) return
    try {
      const message = await invoke<string>('set_startup_entry_enabled', { id: entry.id, enabled: nextEnabled })
      setNotice(message)
      setError(null)
      const entries = await invoke<StartupEntry[]>('scan_startup_entries')
      setStartupEntries(entries)
      setOverview((current) => current ? { ...current, startup_entries: entries.filter((item) => item.enabled).length } : current)
    } catch (startupError) {
      setError(getErrorMessage(startupError))
      setNotice(null)
    }
  }

  const stopProcess = async (process: ProcessInfo) => {
    if (!window.confirm(`Request termination of ${process.name} (PID ${process.pid})? Unsaved work may be lost.`)) return
    try {
      setPageLoading(true)
      setNotice(await invoke<string>('terminate_process', { pid: process.pid }))
      setError(null)
      const items = await invoke<ProcessInfo[]>('scan_running_processes')
      setProcesses(items)
      setOverview((current) => current ? { ...current, running_processes: items.length } : current)
    } catch (processError) {
      setError(getErrorMessage(processError))
      setNotice(null)
    } finally {
      setPageLoading(false)
    }
  }

  const toggleTheme = () => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))

  if (!nativeRuntime) {
    return (
      <div className="runtime-page">
        <div className="runtime-card">
          <div className="brand-mark large-mark">A</div>
          <p className="eyebrow">AppPilot desktop manager</p>
          <h1>Open the native desktop app</h1>
          <p>
            AppPilot reads installed applications and system status from your computer. This browser preview does not have
            access to desktop package managers, so no sample data or simulated actions are shown.
          </p>
          <div className="runtime-command">
            <span>From the project folder, run</span>
            <code>npm run tauri:dev</code>
          </div>
          <p className="runtime-footnote">
            If startup fails, install the native prerequisites for your operating system listed in the README and try again.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="app-frame">
      <aside className="sidebar">
        <a className="brand" href="#" onClick={(event) => { event.preventDefault(); setPage('Overview') }}>
          <span className="brand-mark">A</span>
          <span className="brand-copy">
            <strong>AppPilot</strong>
            <small>{platform === 'windows' ? 'Windows app manager' : 'Linux app manager'}</small>
          </span>
        </a>

        <div className="sidebar-caption">WORKSPACE</div>
        <nav className="navigation" aria-label="Main navigation">
          {navigation.map((item) => (
            <button
              className={`nav-button${page === item.label ? ' active' : ''}`}
              key={item.label}
              type="button"
              aria-current={page === item.label ? 'page' : undefined}
              onClick={() => navigateTo(item.label)}
            >
              <span className="nav-icon" aria-hidden="true">{item.icon}</span>
              <span>{item.label}</span>
              {item.label === 'Updates' && updates.length > 0 ? <span className="nav-count">{updates.length}</span> : null}
            </button>
          ))}
        </nav>

        <div className="sidebar-caption utility-caption">PREFERENCES</div>
        <nav className="navigation" aria-label="Preferences">
          {utilityNavigation.map((item) => (
            <button
              className={`nav-button${page === item.label ? ' active' : ''}`}
              key={item.label}
              type="button"
              aria-current={page === item.label ? 'page' : undefined}
              onClick={() => navigateTo(item.label)}
            >
              <span className="nav-icon" aria-hidden="true">{item.icon}</span>
              <span>{item.label}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <div className="source-card">
            <div className="source-card-heading">
                <span className={`status-dot${packageSources.some((source) => source.available) ? '' : ' unavailable'}`} />
              <span>Package sources</span>
            </div>
            <div className="source-chips">
              {packageSources.map((source) => (
                  <span className={`source-chip${source.available ? ' available' : ''}`} key={source.name}>
                    <i />{source.name}
                  </span>
              ))}
            </div>
          </div>
          <div className="sidebar-footnote">No background scans or telemetry</div>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="breadcrumbs"><span>AppPilot</span><b>/</b><strong>{page}</strong></div>
          <div className="topbar-actions">
            <label className="global-search">
              <span aria-hidden="true">⌕</span>
              <input
                ref={searchRef}
                aria-label="Search applications"
                placeholder="Search applications"
                type="search"
                value={query}
                onChange={(event) => { setQuery(event.target.value); if (page !== 'Applications') navigateTo('Applications') }}
              />
              <kbd>Ctrl K /</kbd>
            </label>
            <button aria-label="Refresh data" className="icon-button" disabled={loading || pageLoading} onClick={refresh} type="button">
              <span className={loading || pageLoading ? 'spinning' : ''}>↻</span>
            </button>
            <button aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`} className="icon-button" onClick={toggleTheme} type="button">
              {theme === 'dark' ? '☼' : '◐'}
            </button>
            <div className="avatar" title="Local desktop session">A</div>
          </div>
        </header>

        <div className="page-content">
          {error ? (
            <div className="alert alert-error" role="alert">
              <span aria-hidden="true">!</span><p>{error}</p>
              <button aria-label="Dismiss error" onClick={() => setError(null)} type="button">×</button>
            </div>
          ) : null}
          {notice ? (
            <div className="alert alert-success" role="status">
              <span aria-hidden="true">✓</span><p>{notice}</p>
              <button aria-label="Dismiss notification" onClick={() => setNotice(null)} type="button">×</button>
            </div>
          ) : null}

          {guideVisible && page === 'Overview' ? (
            <section aria-label="Getting started" className="getting-started">
              <div className="getting-started-heading">
                <div><span className="eyebrow">A QUICK START</span><h2>Everything you need, in one place.</h2></div>
                <button aria-label="Dismiss getting started guide" className="icon-button" onClick={dismissGuide} type="button">×</button>
              </div>
              <div className="getting-started-steps">
                <button onClick={() => navigateTo('Applications')} type="button"><span>01</span><strong>Open an app</strong><small>Find software already on your computer.</small></button>
                <button onClick={() => navigateTo('Discover')} type="button"><span>02</span><strong>Find something new</strong><small>Search your configured software sources.</small></button>
                <button onClick={() => navigateTo('Updates')} type="button"><span>03</span><strong>Stay up to date</strong><small>Review available updates before installing.</small></button>
              </div>
            </section>
          ) : null}

          {page === 'Overview' ? (
            <OverviewPage
              apps={apps}
              error={error}
              loading={loading}
              overview={overview}
              lastRefresh={lastRefresh}
              platform={platform}
              onNavigate={navigateTo}
              onSelectApp={(app) => { setSelectedAppId(app.id); navigateTo('Applications') }}
            />
          ) : null}

          {page === 'Applications' ? (
            <ApplicationsPage
              apps={filteredApps}
              allApps={apps}
              error={error}
              loading={loading}
              query={query}
              selectedApp={selectedApp}
              selectedId={selectedAppId}
              sources={sources}
              sourceFilter={sourceFilter}
              categories={categories}
              categoryFilter={categoryFilter}
              favoritesOnly={favoritesOnly}
              favoriteAppIds={favoriteAppIds}
              wingetAvailable={overview?.package_status.winget ?? false}
              onFilter={setSourceFilter}
              onCategoryFilter={setCategoryFilter}
              onToggleFavorites={() => setFavoritesOnly((current) => !current)}
              onToggleFavorite={toggleFavorite}
              onLaunch={openApplication}
              onManage={manageApplication}
              onUpdate={updateApplication}
              onQuery={setQuery}
              onSelect={setSelectedAppId}
              sortOrder={sortOrder}
              onSortOrder={setSortOrder}
              onClearFilters={() => { setQuery(''); setSourceFilter('All sources'); setCategoryFilter('All categories'); setFavoritesOnly(false) }}
            />
          ) : null}

          {page === 'Discover' ? (
            <DiscoverPage
              canInstallSystem={overview?.package_status.pkexec ?? false}
              platform={platform}
              packageAvailable={platform === 'windows'
                ? overview?.package_status.winget ?? false
                : overview?.package_status.flatpak ?? false}
              entries={filteredCatalog}
              loading={pageLoading}
              query={catalogQuery}
              onInstall={installCatalogApp}
              onQuery={(value) => {
                setCatalogQuery(value)
                if (platform === 'windows' && value.trim().length < 2) {
                  setCatalog([])
                  setPageLoading(false)
                } else {
                  setPageLoading(true)
                }
              }}
            />
          ) : null}

          {page === 'Updates' ? (
            <UpdatesPage error={error} loading={pageLoading || bulkUpdating} updates={updates} onUpdate={updatePackage} onUpdateAll={updateAllPackages} />
          ) : null}

          {page === 'Startup apps' ? (
            <StartupPage entries={startupEntries} error={error} loading={pageLoading} platform={platform} onToggle={toggleStartupEntry} />
          ) : null}

          {page === 'Processes' ? (
            <ProcessesPage error={error} processes={processes} loading={pageLoading} platform={platform} onStop={stopProcess} />
          ) : null}

          {page === 'Settings' ? (
            <SettingsPage
              theme={theme}
              compactMode={compactMode}
              packageStatus={overview?.package_status ?? null}
              platform={platform}
              onTheme={toggleTheme}
              onCompactMode={() => setCompactMode((current) => !current)}
            />
          ) : null}

          {page === 'About' ? <AboutPage platform={platform} /> : null}

          <footer className="page-footer">
            <span>AppPilot <span className="footer-version">v0.2.0</span></span>
            <span>{lastRefresh ? `Last refreshed ${lastRefresh.toLocaleTimeString()}` : 'Waiting for the desktop system'}</span>
          </footer>
        </div>
      </main>
    </div>
  )
}

function PageHeading({ eyebrow, title, description, action }: {
  eyebrow: string
  title: string
  description: string
  action?: ReactNode
}) {
  return (
    <div className="page-heading">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p className="heading-description">{description}</p>
      </div>
      {action}
    </div>
  )
}

function OverviewPage({
  apps, error, loading, overview, lastRefresh, platform, onNavigate, onSelectApp,
}: {
  apps: AppRecord[]
  error: string | null
  loading: boolean
  overview: Overview | null
  lastRefresh: Date | null
  platform: string
  onNavigate: (page: Page) => void
  onSelectApp: (app: AppRecord) => void
}) {
  return (
    <>
      <PageHeading
        eyebrow="YOUR DESKTOP, AT A GLANCE"
        title="Good to see you."
        description={`A clear view of the applications and software sources on this ${platform === 'windows' ? 'Windows' : 'Linux'} system.`}
        action={<span className="live-badge"><i />Live system data</span>}
      />
      <section className="welcome-banner">
        <div className="welcome-copy">
          <span className="banner-kicker">APP LIBRARY</span>
          <h2>Your apps, all in one place.</h2>
          <p>Browse installed software, check updates and see what starts with your session.</p>
          <button className="banner-button" onClick={() => onNavigate('Applications')} type="button">
            Browse applications <span>→</span>
          </button>
        </div>
        <div aria-hidden="true" className="banner-art">
          <span className="orbit orbit-one" />
          <span className="orbit orbit-two" />
          <span className="art-tile tile-back">▦</span>
          <span className="art-tile tile-front">A</span>
          <span className="art-spark">✦</span>
        </div>
      </section>

      <div className="section-title-row">
        <div><h2>System overview</h2><p>Current state reported by your desktop</p></div>
        {lastRefresh ? <span className="updated-label">Updated {lastRefresh.toLocaleTimeString()}</span> : null}
      </div>
      <section aria-label="System overview" className="metric-grid">
        <MetricCard label="Installed apps" value={loading ? null : overview?.installed_applications ?? null} loading={loading} icon="▦" detail="Applications found on this device" tone="blue" />
        <MetricCard label="Startup apps" value={loading ? null : overview?.startup_entries ?? null} loading={loading} icon="◷" detail="Scanned when you open this page" tone="violet" />
        <MetricCard label="Running processes" value={loading ? null : overview?.running_processes ?? null} loading={loading} icon="⌘" detail="Scanned when you open this page" tone="green" />
      </section>

      <section className="section-block">
        <div className="section-title-row">
          <div><h2>Installed applications</h2><p>Applications discovered on this system</p></div>
          <button className="text-button" onClick={() => onNavigate('Applications')} type="button">View all <span>→</span></button>
        </div>
        {loading ? <LoadingState label="Reading installed desktop applications…" /> : error ? (
          <EmptyState title="Live inventory is unavailable" description="AppPilot could not finish reading the desktop inventory. Use refresh after resolving the error above." />
        ) : apps.length === 0 ? (
          <EmptyState title="No desktop applications found" description="AppPilot could not find launchers in the standard Linux application directories." />
        ) : (
          <div className="recent-app-grid">
            {apps.slice(0, 4).map((app) => (
              <button className="recent-app-card" key={app.id} onClick={() => onSelectApp(app)} type="button">
                <AppGlyph name={app.name} />
                <span className="recent-app-info">
                  <strong>{app.name}</strong>
                  <small>{app.source} <i /> {app.category.split(',')[0] || 'Application'}</small>
                </span>
                <span className="card-arrow">↗</span>
              </button>
            ))}
          </div>
        )}
      </section>
    </>
  )
}

function MetricCard({ label, value, icon, detail, tone, loading }: {
  label: string
  value: number | null
  icon: string
  detail: string
  tone: string
  loading: boolean
}) {
  return (
    <article className="metric-card">
      <div className={`metric-icon ${tone}`}>{icon}</div>
      <div className="metric-copy">
        <span>{label}</span>
        <strong>{value === null ? loading ? <span className="skeleton-number" /> : '—' : value}</strong>
        <small>{detail}</small>
      </div>
      <span aria-hidden="true" className="metric-decoration">↗</span>
    </article>
  )
}

function ApplicationsPage({
  apps, allApps, wingetAvailable, error, loading, query, selectedApp, selectedId, sources, sourceFilter,
  categories, categoryFilter, favoritesOnly, favoriteAppIds, sortOrder, onSortOrder, onClearFilters, platform,
  onFilter, onLaunch, onManage, onQuery, onSelect, onUpdate,
  onCategoryFilter, onToggleFavorites, onToggleFavorite,
}: {
  apps: AppRecord[]
  allApps: AppRecord[]
  wingetAvailable: boolean
  error: string | null
  loading: boolean
  query: string
  selectedApp: AppRecord | null
  selectedId: string | null
  sources: string[]
  sourceFilter: string
  categories: string[]
  categoryFilter: string
  favoritesOnly: boolean
  favoriteAppIds: string[]
  sortOrder: 'name-asc' | 'name-desc'
  onSortOrder: (order: 'name-asc' | 'name-desc') => void
  onClearFilters: () => void
  platform: string
  onFilter: (source: string) => void
  onCategoryFilter: (category: string) => void
  onToggleFavorites: () => void
  onToggleFavorite: (id: string) => void
  onLaunch: (app: AppRecord) => void
  onManage: (app: AppRecord) => void
  onUpdate: (app: AppRecord) => void
  onQuery: (query: string) => void
  onSelect: (id: string) => void
}) {
  return (
    <>
      <PageHeading eyebrow="SOFTWARE LIBRARY" title="Applications" description={`Installed applications discovered on this ${platform === 'windows' ? 'Windows' : 'Linux'} computer.`} />
      <section className="library-card">
        <div className="library-toolbar">
          <div className="library-count">{loading ? 'Scanning…' : `${apps.length} ${apps.length === 1 ? 'application' : 'applications'}`}</div>
          <div className="library-filters">
            <label className="filter-search">
              <span aria-hidden="true">⌕</span>
              <input aria-label="Filter applications" onChange={(event) => onQuery(event.target.value)} placeholder="Filter by name" type="search" value={query} />
            </label>
            <label className="select-control">
              <span className="sr-only">Filter by source</span>
              <select onChange={(event) => onFilter(event.target.value)} value={sourceFilter}>
                {sources.map((source) => <option key={source} value={source}>{source}</option>)}
              </select>
            </label>
            <label className="select-control">
              <span className="sr-only">Filter by category</span>
              <select onChange={(event) => onCategoryFilter(event.target.value)} value={categoryFilter}>
                {categories.map((category) => <option key={category} value={category}>{category}</option>)}
              </select>
            </label>
            <label className="select-control">
              <span className="sr-only">Sort applications</span>
              <select onChange={(event) => onSortOrder(event.target.value as 'name-asc' | 'name-desc')} value={sortOrder}>
                <option value="name-asc">Name: A to Z</option>
                <option value="name-desc">Name: Z to A</option>
              </select>
            </label>
            <button
              aria-pressed={favoritesOnly}
              className={`secondary-button favorites-filter${favoritesOnly ? ' active' : ''}`}
              onClick={onToggleFavorites}
              type="button"
            >
              <span aria-hidden="true">★</span> Favorites ({favoriteAppIds.length})
            </button>
          </div>
        </div>
        <div className="application-layout">
          <div className="application-list" aria-label="Installed applications">
            {loading ? <LoadingState label="Scanning your application launchers…" /> : error ? (
              <EmptyState title="Application inventory is unavailable" description="Resolve the backend error above and refresh the scan." />
            ) : apps.length === 0 ? (
              <div className="filtered-empty-state">
                <EmptyState
                  title={allApps.length === 0
                    ? platform === 'windows' && !wingetAvailable ? 'WinGet is not available yet' : 'Nothing to show yet'
                    : 'No matching applications'}
                  description={allApps.length === 0
                    ? platform === 'windows' && !wingetAvailable
                      ? "Install or update 'App Installer' from Microsoft Store, then refresh AppPilot to manage Windows applications."
                      : 'No installed applications were reported by the available package source.'
                    : 'Try another search or source filter.'}
                />
                {allApps.length > 0 ? <button className="text-button" onClick={onClearFilters} type="button">Clear all filters</button> : null}
              </div>
            ) : apps.map((app) => (
              <button
                aria-pressed={selectedId === app.id}
                className={`application-row${selectedId === app.id ? ' selected' : ''}`}
                key={app.id}
                onClick={() => onSelect(app.id)}
                type="button"
              >
                <AppGlyph name={app.name} />
                <span className="application-row-copy">
                  <strong>{app.name}</strong>
                  <small>{app.category.split(',')[0] || 'Application'}</small>
                </span>
                <span className={`source-tag ${app.source.toLowerCase()}`}>{app.source}</span>
              </button>
            ))}
          </div>
          {selectedApp ? (
            <aside className="application-detail">
              <div className="detail-topline"><span className="eyebrow">APPLICATION DETAILS</span><span className="installed-status"><i />Installed</span></div>
              <AppGlyph large name={selectedApp.name} />
              <h2>{selectedApp.name}</h2>
              <p className="detail-description">{selectedApp.description || 'No description is provided by this desktop launcher.'}</p>
              <dl className="detail-metadata">
                <div><dt>Source</dt><dd><span className={`source-tag ${selectedApp.source.toLowerCase()}`}>{selectedApp.source}</span></dd></div>
                <div><dt>Package</dt><dd>{selectedApp.package_name ?? 'Not identified'}</dd></div>
                {selectedApp.package_scope ? <div><dt>Install scope</dt><dd>{selectedApp.package_scope}</dd></div> : null}
                <div><dt>Category</dt><dd>{selectedApp.category || 'Uncategorized'}</dd></div>
                <div><dt>{selectedApp.source === 'WinGet' ? 'Package source' : 'Launcher file'}</dt><dd className="path-value" title={selectedApp.path}>{selectedApp.path}</dd></div>
              </dl>
              <button className="primary-button launch-button" onClick={() => onLaunch(selectedApp)} type="button">
                <span>▶</span> Launch application
              </button>
              <button
                aria-pressed={favoriteAppIds.includes(selectedApp.id)}
                className={`secondary-button favorite-toggle${favoriteAppIds.includes(selectedApp.id) ? ' active' : ''}`}
                onClick={() => onToggleFavorite(selectedApp.id)}
                type="button"
              >
                <span aria-hidden="true">{favoriteAppIds.includes(selectedApp.id) ? '★' : '☆'}</span>
                {favoriteAppIds.includes(selectedApp.id) ? 'Remove from favorites' : 'Add to favorites'}
              </button>
              {selectedApp.package_name && ['APT', 'Flatpak', 'Snap', 'WinGet'].includes(selectedApp.source) ? (
                <div className="detail-actions">
                  <button className="secondary-button" onClick={() => onUpdate(selectedApp)} type="button">Check for update</button>
                  <button className="danger-link" onClick={() => onManage(selectedApp)} type="button">Uninstall</button>
                </div>
              ) : (
                <p className="action-note">Package actions are unavailable because this launcher is not linked to a verified package.</p>
              )}
            </aside>
          ) : null}
        </div>
      </section>
    </>
  )
}

function DiscoverPage({
  canInstallSystem, entries, loading, query, onInstall, onQuery, platform, packageAvailable,
}: {
  canInstallSystem: boolean
  entries: FlatpakCatalogEntry[]
  loading: boolean
  query: string
  onInstall: (entry: FlatpakCatalogEntry) => void
  onQuery: (query: string) => void
  platform: string
  packageAvailable: boolean
}) {
  const isWindows = platform === 'windows'
  return (
    <>
      <PageHeading
        eyebrow="SOFTWARE CATALOGUE"
        title="Discover"
        description={isWindows
          ? 'Search the live WinGet catalogue and install a verified package for your account.'
          : 'Browse applications from Flatpak remotes configured on this computer.'}
      />
      <section className="content-card">
        <div className="catalog-toolbar">
          <div className="list-heading">
            <div><h2>Available applications</h2><p>{isWindows ? 'Search by app name or package ID. Results come directly from WinGet.' : 'Only results reported by your configured Flatpak remotes are shown.'}</p></div>
            <span className="result-count">{loading ? '…' : entries.length}</span>
          </div>
          <label className="catalog-search">
            <span aria-hidden="true">⌕</span>
            <input
              aria-label="Search available applications"
              onChange={(event) => onQuery(event.target.value)}
              placeholder={isWindows ? 'Type at least 2 letters to search WinGet' : 'Search name, description or app ID'}
              type="search"
              value={query}
            />
          </label>
        </div>
        {loading ? <LoadingState label={isWindows ? 'Searching WinGet…' : 'Checking configured Flatpak remotes…'} /> : entries.length === 0 ? (
          <EmptyState
            title={isWindows && !packageAvailable
              ? 'WinGet is not available yet'
              : query ? 'No matching applications' : isWindows ? 'Search for an application to begin' : 'No applications found in your Flatpak remotes'}
            description={isWindows && !packageAvailable
              ? "Install or update 'App Installer' from Microsoft Store, then refresh this page."
              : query
              ? 'Try a different name or package ID.'
              : isWindows
                ? 'Enter at least two letters above. AppPilot only shows packages returned by the configured WinGet sources.'
                : 'Install Flatpak and add an application remote such as Flathub, then refresh this page.'}
          />
        ) : (
          <div className="catalog-list">
            {entries.map((entry) => {
              const systemInstallUnavailable = entry.scope === 'system' && !canInstallSystem
              return (
                <article className="catalog-entry" key={`${entry.scope}:${entry.remote}:${entry.app_id}`}>
                  <AppGlyph name={entry.name} />
                  <div className="catalog-entry-copy">
                    <strong>{entry.name}</strong>
                    <small>{entry.app_id} · {entry.remote} · {entry.scope === 'user' ? 'Current user' : 'System-wide'}</small>
                    {entry.description ? <p>{entry.description}</p> : null}
                  </div>
                  {entry.version ? <span className="version-tag">{entry.version}</span> : null}
                  {entry.installed ? (
                    <span className="installed-status"><i />Installed</span>
                  ) : (
                    <button
                      className="secondary-button update-button"
                      disabled={loading || systemInstallUnavailable}
                      onClick={() => onInstall(entry)}
                      title={systemInstallUnavailable ? 'pkexec is required for system-wide installations' : undefined}
                      type="button"
                    >
                      Install
                    </button>
                  )}
                </article>
              )
            })}
          </div>
        )}
      </section>
    </>
  )
}

function UpdatesPage({ updates, loading, error, onUpdate, onUpdateAll }: {
  updates: PackageUpdate[]
  loading: boolean
  error: string | null
  onUpdate: (update: PackageUpdate) => void
  onUpdateAll: () => void
}) {
  return (
    <>
      <PageHeading
        eyebrow="SOFTWARE MAINTENANCE"
        title="Updates"
        description="Available updates reported by the package managers installed on this system."
        action={updates.length > 0 ? <button className="primary-button" disabled={loading} onClick={onUpdateAll} type="button">Update all ({updates.length})</button> : undefined}
      />
      <section className="content-card">
        <div className="list-heading"><div><h2>Available updates</h2><p>Read directly from {updates.some((update) => update.source === 'WinGet') ? 'WinGet' : 'APT, Flatpak and Snap'}.</p></div><span className="result-count">{loading ? 'Checking…' : updates.length}</span></div>
        {loading ? <LoadingState label="Checking configured package sources…" /> : error ? (
          <EmptyState title="Update check is unavailable" description="Resolve the package-manager error above and refresh the check." />
        ) : updates.length === 0 ? (
          <EmptyState title="Everything is up to date" description="No available upgrades were reported by the package managers." />
        ) : (
          <div className="data-list">
            {updates.map((update) => (
              <div className="data-row update-row" key={`${update.source}:${update.package_name}`}>
                <AppGlyph name={update.name} />
                <div className="data-row-main"><strong>{update.name}</strong><small>{update.package_name} · {update.source}</small></div>
                <span className="version-tag">{update.version}</span>
                <button className="secondary-button update-button" onClick={() => onUpdate(update)} type="button">Update</button>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  )
}

function StartupPage({ entries, loading, error, onToggle, platform }: {
  entries: StartupEntry[]
  loading: boolean
  error: string | null
  onToggle: (entry: StartupEntry) => void
  platform: string
}) {
  return (
    <>
      <PageHeading eyebrow="SESSION CONFIGURATION" title="Startup apps" description={platform === 'windows'
        ? 'Inspect shortcuts launched when you sign in. Only shortcuts in your personal Startup folder can be changed.'
        : 'Inspect startup entries and control user-owned launchers. System entries are read-only.'} />
      <section className="content-card">
        <div className="list-heading"><div><h2>Session startup</h2><p>{platform === 'windows' ? 'Read from your personal and shared Startup folders.' : 'Read from your user and system autostart folders.'}</p></div><span className="result-count">{loading ? '…' : entries.length}</span></div>
        {loading ? <LoadingState label="Reading autostart entries…" /> : error ? (
          <EmptyState title="Startup inventory is unavailable" description="Resolve the backend error above and refresh the scan." />
        ) : entries.length === 0 ? (
          <EmptyState title="No startup applications found" description={platform === 'windows' ? 'No shortcuts were found in the standard Windows Startup folders.' : 'There are no enabled autostart desktop entries in the standard XDG locations.'} />
        ) : (
          <div className="data-list">
            {entries.map((entry) => (
              <div className="data-row" key={entry.id}>
                <AppGlyph name={entry.name} />
                <div className="data-row-main"><strong>{entry.name}</strong><small className="path-value" title={entry.path}>{entry.path}</small></div>
                {entry.can_manage ? (
                  <button className={`secondary-button startup-toggle${entry.enabled ? '' : ' disabled'}`} disabled={loading} onClick={() => onToggle(entry)} type="button">
                    {entry.enabled ? 'Disable' : 'Enable'}
                  </button>
                ) : <span className={entry.enabled ? 'enabled-tag' : 'source-tag'}>{entry.enabled ? <><i />Enabled · system</> : 'Disabled · system'}</span>}
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  )
}

function ProcessesPage({ processes, loading, error, onStop, platform }: {
  processes: ProcessInfo[]
  loading: boolean
  error: string | null
  onStop: (process: ProcessInfo) => void
  platform: string
}) {
  return (
    <>
      <PageHeading eyebrow="LIVE SYSTEM ACTIVITY" title="Processes" description={platform === 'windows'
        ? 'Processes visible to your account, with owner checks before a stop request is allowed.'
        : 'Processes currently visible to your user, read from the Linux /proc filesystem.'} />
      <section className="content-card">
        <div className="list-heading"><div><h2>Running processes</h2><p>Resident memory is reported by the kernel.</p></div><span className="result-count">{loading ? '…' : processes.length}</span></div>
        {loading ? <LoadingState label="Reading live process information…" /> : error ? (
          <EmptyState title="Process information is unavailable" description="Resolve the system access error above and refresh the scan." />
        ) : processes.length === 0 ? (
          <EmptyState title="No process information available" description={platform === 'windows' ? 'AppPilot could not read any process entries visible to your account.' : 'AppPilot could not read any process entries from /proc.'} />
        ) : (
          <div className="process-table-wrap">
            <table className="process-table">
              <thead><tr><th>Process</th><th>PID</th><th>Memory (RSS)</th><th>Action</th></tr></thead>
              <tbody>
                {processes.slice(0, 150).map((process) => (
                  <tr key={process.pid}>
                    <td><span className="process-name"><i />{process.name}</span></td>
                    <td className="numeric-cell">{process.pid}</td>
                    <td className="numeric-cell">{formatMemory(process.memory_kb)}</td>
                    <td><button aria-label={`Stop ${process.name}, PID ${process.pid}`} className="process-stop" disabled={loading || !process.can_terminate} onClick={() => onStop(process)} title={process.can_terminate ? 'Request graceful termination' : 'Only processes owned by your user can be stopped'} type="button">Stop</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {processes.length > 150 ? <p className="table-footnote">Showing the 150 processes with the highest resident memory out of {processes.length}.</p> : null}
          </div>
        )}
      </section>
    </>
  )
}

function SettingsPage({ theme, compactMode, packageStatus, platform, onTheme, onCompactMode }: {
  theme: 'dark' | 'light'
  compactMode: boolean
  packageStatus: PackageStatus | null
  platform: string
  onTheme: () => void
  onCompactMode: () => void
}) {
  const integrations: [string, boolean | undefined][] = platform === 'windows'
    ? [['WinGet', packageStatus?.winget]]
    : [
      ['APT', packageStatus?.apt],
      ['Flatpak', packageStatus?.flatpak],
      ['Snap', packageStatus?.snap],
    ]
  return (
    <>
      <PageHeading eyebrow="APP PREFERENCES" title="Settings" description="Tune the AppPilot desktop experience and inspect system integrations." />
      <section className="settings-grid">
        <div className="content-card setting-card">
          <div className="setting-symbol">◐</div>
          <div className="setting-copy"><h2>Appearance</h2><p>Choose a comfortable look for your desktop session.</p></div>
          <button aria-pressed={theme === 'light'} className="toggle-control" onClick={onTheme} type="button"><span />{theme === 'dark' ? 'Dark theme' : 'Light theme'}</button>
        </div>
        <div className="content-card setting-card">
          <div className="setting-symbol">≡</div>
          <div className="setting-copy"><h2>Library spacing</h2><p>Fit more application rows on screen without reducing text size.</p></div>
          <button aria-pressed={compactMode} className="toggle-control" onClick={onCompactMode} type="button"><span />{compactMode ? 'Compact' : 'Comfortable'}</button>
        </div>
        <div className="content-card integration-card">
          <div className="list-heading"><div><h2>Package integrations</h2><p>Availability detected from executable paths.</p></div></div>
          {integrations.map(([source, available]) => (
            <div className="integration-row" key={source}><span>{source}</span><span className={available ? 'integration-status online' : 'integration-status'}><i />{available ? 'Available' : 'Not installed'}</span></div>
          ))}
          {platform !== 'windows' ? <div className="integration-row"><span>Privilege prompt</span><span className={packageStatus?.pkexec ? 'integration-status online' : 'integration-status'}><i />{packageStatus?.pkexec ? 'pkexec available' : 'pkexec unavailable'}</span></div> : null}
        </div>
        <div className="content-card privacy-card">
          <span className="privacy-icon">◎</span><div><h2>Privacy by design</h2><p>Application inventory, process details and package actions stay on this computer. AppPilot does not send telemetry.</p></div>
        </div>
      </section>
    </>
  )
}

function AboutPage({ platform }: { platform: string }) {
  return (
    <>
      <PageHeading eyebrow="ABOUT THIS APPLICATION" title="AppPilot" description="A native desktop application manager, built to keep system data local and actions transparent." />
      <section className="about-card content-card">
        <div className="about-brand"><span className="brand-mark large-mark">A</span><div><h2>AppPilot</h2><p>{platform === 'windows' ? 'Windows app manager' : 'Linux app manager'} · Version 0.2.0</p></div></div>
        <p>AppPilot discovers installed applications, shows package-source integrations available on this system and provides clear access to startup entries, running processes and package updates.</p>
        <div className="about-facts"><div><span>Desktop shell</span><strong>Tauri 2</strong></div><div><span>Interface</span><strong>React + TypeScript</strong></div><div><span>Native layer</span><strong>Rust · {platform === 'windows' ? 'Windows' : 'Linux'}</strong></div></div>
        <p className="about-note">{platform === 'windows'
          ? 'Windows package actions use exact WinGet identifiers and run in the current user context.'
          : 'Package actions are limited to packages AppPilot can identify from local system metadata. Privileged operations require the system authorization prompt.'}</p>
      </section>
    </>
  )
}

function AppGlyph({ name, large = false }: { name: string; large?: boolean }) {
  const initials = name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? '').join('')
  const hue = Array.from(name).reduce((sum, character) => sum + character.charCodeAt(0), 0) % 5
  return <span aria-hidden="true" className={`app-glyph hue-${hue}${large ? ' glyph-large' : ''}`}>{initials || '·'}</span>
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return <div className="empty-state"><span className="empty-icon">⌕</span><h3>{title}</h3><p>{description}</p></div>
}

function LoadingState({ label }: { label: string }) {
  return <div aria-live="polite" className="loading-state"><span className="loading-spinner" />{label}</div>
}

export default App
