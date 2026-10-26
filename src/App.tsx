import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { invoke, isTauri } from '@tauri-apps/api/core'
import './App.css'

type PackageStatus = {
  apt: boolean
  dnf: boolean
  pacman: boolean
  zypper: boolean
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

type PackageCacheEntry = {
  source: string
  path: string
  bytes: number
}

type PackageCacheStatus = {
  supported: boolean
  message: string
  entries: PackageCacheEntry[]
  total_bytes: number
}

type SystemDiagnostics = {
  platform: string
  distribution: string
  release: string
  kernel: string | null
  architecture: string
  package_sources: string[]
  notices: string[]
}

type ActivityItem = {
  id: string
  timestamp: string
  action: string
  target: string
  source: string
  successful: boolean
}

type SetupManifest = {
  schema_version: 1
  created_at: string
  packages: PackageReference[]
}

type PackageReference = {
  name: string
  id: string
  source: string
}

type AppCollection = {
  name: string
  package_ids: string[]
  packages?: PackageReference[]
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

type Page = 'Overview' | 'Discover' | 'Applications' | 'Updates' | 'Startup apps' | 'Processes' | 'Tools' | 'Settings' | 'About'

const navigation: { label: Page; icon: string }[] = [
  { label: 'Overview', icon: '◫' },
  { label: 'Discover', icon: '⌕' },
  { label: 'Applications', icon: '▦' },
  { label: 'Updates', icon: '↻' },
  { label: 'Startup apps', icon: '◷' },
  { label: 'Processes', icon: '⌘' },
  { label: 'Tools', icon: '⇧' },
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

function readLocalJson<T>(key: string, fallback: T): T {
  const saved = localStorage.getItem(key)
  if (!saved) return fallback
  try {
    return JSON.parse(saved) as T
  } catch {
    return fallback
  }
}

function updateId(update: PackageUpdate) {
  return `${update.source}:${update.package_name}`
}

function formatMemory(memoryKb: number) {
  if (memoryKb >= 1024 * 1024) return `${(memoryKb / 1024 / 1024).toFixed(1)} GB`
  if (memoryKb >= 1024) return `${(memoryKb / 1024).toFixed(0)} MB`
  return `${memoryKb} KB`
}

function formatBytes(bytes: number) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${bytes} B`
}

function App() {
  const [nativeRuntime] = useState(isTauri)
  const [page, setPage] = useState<Page>('Overview')
  const [overview, setOverview] = useState<Overview | null>(null)
  const [apps, setApps] = useState<AppRecord[]>([])
  const [updates, setUpdates] = useState<PackageUpdate[]>([])
  const [cacheStatus, setCacheStatus] = useState<PackageCacheStatus | null>(null)
  const [diagnostics, setDiagnostics] = useState<SystemDiagnostics | null>(null)
  const [selectedUpdates, setSelectedUpdates] = useState<string[]>([])
  const [selectedRemovalIds, setSelectedRemovalIds] = useState<string[]>([])
  const [ignoredUpdates, setIgnoredUpdates] = useState<string[]>(() => readLocalJson('apppilot-ignored-updates', []))
  const [activity, setActivity] = useState<ActivityItem[]>(() => readLocalJson('apppilot-activity', []))
  const [collections, setCollections] = useState<AppCollection[]>(() => readLocalJson('apppilot-collections', []))
  const [importedManifest, setImportedManifest] = useState<SetupManifest | null>(null)
  const [reminderDays, setReminderDays] = useState<number>(() => Number(localStorage.getItem('apppilot-reminder-days') ?? 0))
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
  const [operationProgress, setOperationProgress] = useState<string | null>(null)
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

  useEffect(() => {
    localStorage.setItem('apppilot-ignored-updates', JSON.stringify(ignoredUpdates))
  }, [ignoredUpdates])

  useEffect(() => {
    localStorage.setItem('apppilot-activity', JSON.stringify(activity.slice(0, 100)))
  }, [activity])

  useEffect(() => {
    localStorage.setItem('apppilot-collections', JSON.stringify(collections))
  }, [collections])

  useEffect(() => {
    localStorage.setItem('apppilot-reminder-days', String(reminderDays))
    if (reminderDays < 1) return
    const dueAt = Number(localStorage.getItem('apppilot-next-reminder') ?? 0)
    const delay = Math.max(0, dueAt - Date.now())
    const timer = window.setTimeout(() => {
      setNotice('Your optional update reminder is due. Open Updates to review available changes; AppPilot will not install anything automatically.')
      localStorage.setItem('apppilot-next-reminder', String(Date.now() + reminderDays * 24 * 60 * 60 * 1000))
    }, delay || reminderDays * 24 * 60 * 60 * 1000)
    if (!dueAt) {
      localStorage.setItem('apppilot-next-reminder', String(Date.now() + reminderDays * 24 * 60 * 60 * 1000))
    }
    return () => window.clearTimeout(timer)
  }, [reminderDays])

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
        if (catalogQuery.trim().length >= 2) {
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
      } else if (page === 'Tools') {
        const [cache, system] = await Promise.allSettled([
          invoke<PackageCacheStatus>('get_package_cache_status'),
          invoke<SystemDiagnostics>('get_system_diagnostics'),
        ])
        const failures: string[] = []
        if (cache.status === 'fulfilled') setCacheStatus(cache.value)
        else failures.push(`Package cache scan: ${getErrorMessage(cache.reason)}`)
        if (system.status === 'fulfilled') setDiagnostics(system.value)
        else failures.push(`System diagnostics: ${getErrorMessage(system.reason)}`)
        if (failures.length) setError(failures.join('\n'))
      }
      setError(null)
      setLastRefresh(new Date())
    } catch (loadError) {
      setError(getErrorMessage(loadError))
    } finally {
      setPageLoading(false)
    }
  }, [catalogQuery, nativeRuntime, page])

  // Native inventory is an external system effect; browser-only mode never calls its IPC commands.
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    if (nativeRuntime) void loadOverview()
  }, [nativeRuntime, loadOverview])

  // Page data is fetched only after a native navigation target becomes active.
  useEffect(() => {
    if (page === 'Discover') {
      if (platform === 'windows' || catalogQuery.trim().length >= 2) return
    }
    const delay = 0
    const timer = window.setTimeout(() => void loadCurrentPage(), delay)
    return () => window.clearTimeout(timer)
  }, [catalogQuery, loadCurrentPage, page, platform])

  useEffect(() => {
    if (!nativeRuntime || page !== 'Discover') return
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
      { name: 'DNF', available: overview?.package_status.dnf ?? false },
      { name: 'Pacman', available: overview?.package_status.pacman ?? false },
      { name: 'Zypper', available: overview?.package_status.zypper ?? false },
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

  const recordActivity = (action: string, target: string, source: string, successful: boolean) => {
    setActivity((current) => [{
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      action,
      target,
      source,
      successful,
    }, ...current].slice(0, 100))
  }

  const exportSetupManifest = (onlyFavorites = false) => {
    const selected = apps.filter((app) =>
      app.package_name
      && app.source !== 'Local'
      && app.source !== 'System'
      && (!onlyFavorites || favoriteAppIds.includes(app.id)),
    )
    const manifest: SetupManifest = {
      schema_version: 1,
      created_at: new Date().toISOString(),
      packages: selected.map((app) => ({
        name: app.name,
        id: app.package_name ?? app.id,
        source: app.source,
      })),
    }
    const url = URL.createObjectURL(new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url
    link.download = 'apppilot-setup.json'
    link.click()
    URL.revokeObjectURL(url)
    setNotice(`Exported ${manifest.packages.length} package references. No application files or personal data were included.`)
  }

  const importSetupManifest = async (file: File) => {
    try {
      const raw: unknown = JSON.parse(await file.text())
      if (
        !raw
        || typeof raw !== 'object'
        || !('schema_version' in raw)
        || raw.schema_version !== 1
        || !('packages' in raw)
        || !Array.isArray(raw.packages)
      ) {
        throw new Error('This is not a supported AppPilot setup manifest.')
      }
      const packages = raw.packages.filter((item): item is SetupManifest['packages'][number] =>
        !!item
        && typeof item === 'object'
        && 'name' in item && typeof item.name === 'string'
        && 'id' in item && typeof item.id === 'string'
        && /^[A-Za-z0-9][A-Za-z0-9.+_-]*$/.test(item.id)
        && 'source' in item && typeof item.source === 'string',
      )
      if (packages.length !== raw.packages.length) {
        throw new Error('The manifest contains invalid package entries and was not imported.')
      }
      setImportedManifest({
        schema_version: 1,
        created_at: 'created_at' in raw && typeof raw.created_at === 'string' ? raw.created_at : '',
        packages,
      })
      setError(null)
      setNotice(`Loaded ${packages.length} package references. Review their availability before restoring anything.`)
    } catch (importError) {
      setError(getErrorMessage(importError))
      setNotice(null)
    }
  }

  const findManifestPackage = async (packageId: string) => {
    try {
      setPageLoading(true)
      const entries = await invoke<FlatpakCatalogEntry[]>('search_package_catalog', { query: packageId })
      setCatalog(entries.filter((entry) => entry.app_id.toLowerCase() === packageId.toLowerCase()))
      setCatalogQuery(packageId)
      setPage('Discover')
      setError(null)
      setNotice(`Showing exact catalogue matches for ${packageId}. Review the source and confirm installation there.`)
    } catch (searchError) {
      setError(getErrorMessage(searchError))
    } finally {
      setPageLoading(false)
    }
  }

  const installPackageReferences = async (packages: PackageReference[], label: string) => {
    const candidates: { reference: PackageReference; entry: FlatpakCatalogEntry }[] = []
    const unavailable: string[] = []
    const alreadyInstalled: string[] = []
    for (const reference of packages) {
      const installedLocally = apps.some((app) =>
        app.package_name?.toLowerCase() === reference.id.toLowerCase()
        && (reference.source === 'Flatpak' || app.source === reference.source),
      )
      if (installedLocally) {
        alreadyInstalled.push(reference.name)
        continue
      }
      try {
        const results = await invoke<FlatpakCatalogEntry[]>('search_package_catalog', { query: reference.id })
        const matches = results.filter((entry) =>
          entry.app_id.toLowerCase() === reference.id.toLowerCase()
          && (reference.source === 'Flatpak' || entry.remote === reference.source),
        )
        if (matches.length === 1 && matches[0].installed) alreadyInstalled.push(reference.name)
        else if (matches.length === 1) candidates.push({ reference, entry: matches[0] })
        else unavailable.push(matches.length === 0
          ? `${reference.name} (${reference.source}): unavailable`
          : `${reference.name} (${reference.source}): multiple sources/scopes; choose it manually in Discover`)
      } catch (searchError) {
        unavailable.push(`${reference.name}: ${getErrorMessage(searchError)}`)
      }
    }
    if (candidates.length === 0) {
      setNotice(`${label}: nothing could be queued. Already installed: ${alreadyInstalled.length}; unavailable or ambiguous: ${unavailable.length}.`)
      setError(unavailable.length ? unavailable.join('\n') : null)
      return
    }
    const preview = candidates.map(({ reference, entry }) =>
      `${reference.name} → ${entry.remote} (${entry.scope === 'user' ? 'current user' : 'system-wide'})`,
    ).join('\n')
    const omitted = unavailable.length
      ? `\n\nNot queued (${unavailable.length}):\n${unavailable.join('\n')}`
      : ''
    if (!window.confirm(`Review ${candidates.length} package(s) for ${label}:\n\n${preview}${omitted}\n\nNothing is installed unless you confirm this queue.`)) return
    setBulkUpdating(true)
    const failures: string[] = []
    for (const [index, { reference, entry }] of candidates.entries()) {
      setOperationProgress(`Installing ${index + 1} of ${candidates.length}: ${reference.name}`)
      try {
        await invoke<string>('install_flatpak_application', {
          appId: entry.app_id,
          remote: entry.remote,
          scope: entry.scope,
        })
        recordActivity('Installed', reference.name, entry.remote, true)
      } catch (installError) {
        failures.push(`${reference.name}: ${getErrorMessage(installError)}`)
        recordActivity('Install failed', reference.name, entry.remote, false)
      }
    }
    setBulkUpdating(false)
    setOperationProgress(null)
    setNotice(`${candidates.length - failures.length} of ${candidates.length} queued package(s) installed. Already installed: ${alreadyInstalled.length}; unavailable or ambiguous: ${unavailable.length}.`)
    setError([...unavailable, ...failures].length ? [...unavailable, ...failures].join('\n') : null)
    await loadOverview()
  }

  const installManifest = (manifest: SetupManifest) => installPackageReferences(manifest.packages, 'this setup manifest')
  const installCollection = (collection: AppCollection) => {
    const packages = collection.packages ?? collection.package_ids.map((id) => ({
      id,
      name: id,
      source: apps.find((app) => app.package_name === id)?.source ?? '',
    }))
    return installPackageReferences(packages, `collection “${collection.name}”`)
  }

  const saveFavoriteCollection = (name: string) => {
    const packages = apps
      .filter((app) => favoriteAppIds.includes(app.id) && app.package_name)
      .map((app) => ({
        name: app.name,
        id: app.package_name ?? app.id,
        source: app.source,
      }))
    if (!name.trim() || packages.length === 0) return
    setCollections((current) => [
      ...current.filter((collection) => collection.name !== name.trim()),
      { name: name.trim(), package_ids: packages.map((item) => item.id), packages },
    ])
    setNotice(`Saved “${name.trim()}” with ${packages.length} package references.`)
  }

  const exportPreferences = () => {
    const preferences = {
      schema_version: 1,
      theme,
      compactMode,
      favoriteAppIds,
      collections,
    }
    const url = URL.createObjectURL(new Blob([JSON.stringify(preferences, null, 2)], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url
    link.download = 'apppilot-preferences.json'
    link.click()
    URL.revokeObjectURL(url)
    setNotice('Exported AppPilot preferences and collections to a local file.')
  }

  const exportDiagnostics = () => {
    if (!diagnostics) return
    const report = {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      platform: diagnostics.platform,
      distribution: diagnostics.distribution,
      release: diagnostics.release,
      kernel: diagnostics.kernel,
      architecture: diagnostics.architecture,
      package_sources: diagnostics.package_sources,
      notices: diagnostics.notices,
    }
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url
    link.download = 'apppilot-diagnostics.json'
    link.click()
    URL.revokeObjectURL(url)
    setNotice('Exported a privacy-reviewed diagnostics summary without personal paths, logs, or package history.')
  }

  const importPreferences = async (file: File) => {
    try {
      const raw: unknown = JSON.parse(await file.text())
      if (!raw || typeof raw !== 'object' || !('schema_version' in raw) || raw.schema_version !== 1) {
        throw new Error('This is not a supported AppPilot preferences file.')
      }
      if ('theme' in raw && (raw.theme === 'dark' || raw.theme === 'light')) setTheme(raw.theme)
      if ('compactMode' in raw && typeof raw.compactMode === 'boolean') setCompactMode(raw.compactMode)
      if ('favoriteAppIds' in raw && Array.isArray(raw.favoriteAppIds)
        && raw.favoriteAppIds.every((id) => typeof id === 'string')) {
        setFavoriteAppIds(raw.favoriteAppIds)
      }
      if ('collections' in raw && Array.isArray(raw.collections)) {
        const validCollections = raw.collections.filter((item): item is AppCollection =>
          !!item && typeof item === 'object'
          && 'name' in item && typeof item.name === 'string'
          && 'package_ids' in item && Array.isArray(item.package_ids)
          && item.package_ids.every((id) => typeof id === 'string'),
        ).map((item) => {
          const packages = 'packages' in item && Array.isArray(item.packages)
            ? item.packages.filter((reference): reference is PackageReference =>
              !!reference && typeof reference === 'object'
              && 'name' in reference && typeof reference.name === 'string'
              && 'id' in reference && typeof reference.id === 'string'
              && /^[A-Za-z0-9][A-Za-z0-9.+_-]*$/.test(reference.id)
              && 'source' in reference && typeof reference.source === 'string',
            )
            : undefined
          return { ...item, packages }
        })
        setCollections(validCollections)
      }
      setNotice('Imported valid AppPilot preferences. Package installation settings are never imported.')
      setError(null)
    } catch (importError) {
      setError(getErrorMessage(importError))
      setNotice(null)
    }
  }

  const cleanPackageCache = async () => {
    if (!cacheStatus?.supported || cacheStatus.entries.length === 0) return
    const sources = cacheStatus.entries.map((entry) => entry.source)
    if (!window.confirm(`Clean the package-manager caches for ${sources.join(', ')} (about ${formatBytes(cacheStatus.total_bytes)})? AppPilot will use each package manager's own cleanup command.`)) return
    try {
      const cleaned = await invoke<string[]>('clean_package_cache', { sources })
      recordActivity('Cleaned cache', formatBytes(cacheStatus.total_bytes), cleaned.join(', '), true)
      setNotice(`Package caches cleaned for ${cleaned.join(', ')}.`)
      setError(null)
      try {
        setCacheStatus(await invoke<PackageCacheStatus>('get_package_cache_status'))
      } catch (refreshError) {
        setError(`Caches were cleaned, but their new sizes could not be checked: ${getErrorMessage(refreshError)}`)
      }
    } catch (cleanupError) {
      recordActivity('Cache cleanup failed', sources.join(', '), 'Package managers', false)
      setError(getErrorMessage(cleanupError))
      setNotice(null)
    }
  }

  const reinstallApplication = async (app: AppRecord) => {
    if (!app.package_name) return
    if (!window.confirm(`Reinstall ${app.name} from ${app.source}? AppPilot will verify that the same package is still installed first.`)) return
    try {
      setPageLoading(true)
      const message = await invoke<string>('reinstall_package', { appId: app.id })
      recordActivity('Reinstalled', app.name, app.source, true)
      setNotice(message)
      setError(null)
      await loadOverview()
    } catch (operationError) {
      recordActivity('Reinstall failed', app.name, app.source, false)
      setError(getErrorMessage(operationError))
      setNotice(null)
    } finally {
      setPageLoading(false)
    }
  }

  const removeSelectedApplications = async () => {
    const selected = filteredApps.filter((app) => selectedRemovalIds.includes(app.id) && app.package_name)
    if (!selected.length) return
    const preview = selected.map((app) => `${app.name} (${app.source}: ${app.package_name})`).join('\n')
    if (!window.confirm(`Review the ${selected.length} exact package(s) to remove:\n\n${preview}\n\nContinue?`)) return
    setBulkUpdating(true)
    const failures: string[] = []
    for (const [index, app] of selected.entries()) {
      setOperationProgress(`Removing ${index + 1} of ${selected.length}: ${app.name}`)
      try {
        await invoke<string>('perform_package_action', { appId: app.id, action: 'remove' })
        recordActivity('Removed', app.name, app.source, true)
      } catch (removeError) {
        failures.push(`${app.name}: ${getErrorMessage(removeError)}`)
        recordActivity('Removal failed', app.name, app.source, false)
      }
    }
    setSelectedRemovalIds([])
    setNotice(`${selected.length - failures.length} of ${selected.length} selected package(s) removed.`)
    setError(failures.length ? failures.join('\n') : null)
    setBulkUpdating(false)
    setOperationProgress(null)
    await loadOverview()
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
      recordActivity('Removed', app.name, app.source, true)
      setNotice(message)
      setError(null)
      await loadOverview()
    } catch (operationError) {
      recordActivity('Removal failed', app.name, app.source, false)
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
      if (!window.confirm(`Update ${update.name} to ${update.version} from ${update.source}?`)) return
      setPageLoading(true)
      setNotice(await invoke<string>('update_package', {
        packageName: update.package_name,
        source: update.source,
      }))
      recordActivity('Updated', update.name, update.source, true)
      setError(null)
      await loadOverview()
    } catch (operationError) {
      recordActivity('Update failed', app.name, app.source, false)
      setError(getErrorMessage(operationError))
      setNotice(null)
    } finally {
      setPageLoading(false)
    }
  }

  const updatePackage = async (update: PackageUpdate) => {
    if (!window.confirm(`Update ${update.name} to ${update.version} from ${update.source}?`)) return
    try {
      setPageLoading(true)
      const message = await invoke<string>('update_package', {
        packageName: update.package_name,
        source: update.source,
      })
      recordActivity('Updated', update.name, update.source, true)
      setNotice(message)
      setError(null)
      await loadCurrentPage()
      await loadOverview()
    } catch (operationError) {
      recordActivity('Update failed', update.name, update.source, false)
      setError(getErrorMessage(operationError))
      setNotice(null)
    } finally {
      setPageLoading(false)
    }
  }

  const updateAllPackages = async () => {
    const selected = updates.filter((update) => selectedUpdates.includes(updateId(update)))
    const sources = [...new Set(selected.map((update) => update.source))]
    if (selected.length === 0 || !window.confirm(`Update ${selected.length} selected packages from ${sources.join(', ')}?`)) return
    try {
      setBulkUpdating(true)
      const completed: string[] = []
      const failures: string[] = []
      for (const [index, update] of selected.entries()) {
        setOperationProgress(`Updating ${index + 1} of ${selected.length}: ${update.name}`)
        try {
          await invoke<string>('update_package', {
            packageName: update.package_name,
            source: update.source,
          })
          completed.push(update.name)
          recordActivity('Updated', update.name, update.source, true)
        } catch (updateError) {
          failures.push(`${update.name}: ${getErrorMessage(updateError)}`)
          recordActivity('Update failed', update.name, update.source, false)
        }
      }
      setSelectedUpdates([])
      setNotice(`${completed.length} package(s) updated${failures.length ? `; ${failures.length} failed` : ''}.`)
      setError(failures.length ? failures.join('\n') : null)
      await loadCurrentPage()
      await loadOverview()
    } catch (updateError) {
      setError(getErrorMessage(updateError))
      setNotice(null)
    } finally {
      setBulkUpdating(false)
      setOperationProgress(null)
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
      recordActivity('Installed', entry.name, entry.remote, true)
      setNotice(message)
      setError(null)
      setCatalog((current) => current.map((candidate) =>
        candidate.app_id === entry.app_id && candidate.scope === entry.scope
          ? { ...candidate, installed: true }
          : candidate,
      ))
      await loadOverview()
    } catch (installError) {
      recordActivity('Install failed', entry.name, entry.remote, false)
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
              selectedRemovalIds={selectedRemovalIds}
              sources={sources}
              sourceFilter={sourceFilter}
              categories={categories}
              categoryFilter={categoryFilter}
              favoritesOnly={favoritesOnly}
              favoriteAppIds={favoriteAppIds}
              wingetAvailable={overview?.package_status.winget ?? false}
              platform={platform}
              onFilter={setSourceFilter}
              onCategoryFilter={setCategoryFilter}
              onToggleFavorites={() => setFavoritesOnly((current) => !current)}
              onToggleFavorite={toggleFavorite}
              onLaunch={openApplication}
              onManage={manageApplication}
              onUpdate={updateApplication}
              onReinstall={reinstallApplication}
              onRemoveSelected={removeSelectedApplications}
              onToggleRemoval={(id) => setSelectedRemovalIds((current) =>
                current.includes(id) ? current.filter((selectedId) => selectedId !== id) : [...current, id],
              )}
              onSelectVisibleRemoval={(ids) => setSelectedRemovalIds(ids)}
              operationProgress={operationProgress}
              bulkBusy={bulkUpdating}
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
                : Boolean(overview && Object.entries(overview.package_status)
                  .filter(([name]) => name !== 'winget' && name !== 'pkexec')
                  .some(([, available]) => available))}
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
            <UpdatesPage
              error={error}
              loading={pageLoading || bulkUpdating}
              progress={operationProgress}
              updates={updates.filter((update) => !ignoredUpdates.includes(updateId(update)))}
              deferredCount={updates.filter((update) => ignoredUpdates.includes(updateId(update))).length}
              selectedUpdates={selectedUpdates}
              onToggleUpdate={(id) => setSelectedUpdates((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])}
              onSelectAll={(ids) => setSelectedUpdates(ids)}
              onIgnore={(id) => setIgnoredUpdates((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])}
              onUpdate={updatePackage}
              onUpdateAll={updateAllPackages}
            />
          ) : null}

          {page === 'Startup apps' ? (
            <StartupPage entries={startupEntries} error={error} loading={pageLoading} platform={platform} onToggle={toggleStartupEntry} />
          ) : null}

          {page === 'Processes' ? (
            <ProcessesPage error={error} processes={processes} loading={pageLoading} platform={platform} onStop={stopProcess} />
          ) : null}

          {page === 'Tools' ? (
            <ToolsPage
              activity={activity}
              apps={apps}
              collections={collections}
              cacheStatus={cacheStatus}
              diagnostics={diagnostics}
              ignoredUpdates={ignoredUpdates}
              importedManifest={importedManifest}
              packageStatus={overview?.package_status ?? null}
              platform={platform}
              reminderDays={reminderDays}
              bulkBusy={bulkUpdating}
              operationProgress={operationProgress}
              onExportManifest={exportSetupManifest}
              onImportManifest={importSetupManifest}
              onImportPreferences={importPreferences}
              onFindPackage={findManifestPackage}
              onSaveCollection={saveFavoriteCollection}
              onExportPreferences={exportPreferences}
              onReminderDays={setReminderDays}
              onCleanCache={cleanPackageCache}
              onExportDiagnostics={exportDiagnostics}
              onInstallManifest={installManifest}
              onInstallCollection={installCollection}
              onUnignore={(id) => setIgnoredUpdates((current) => current.filter((item) => item !== id))}
            />
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
  apps, allApps, wingetAvailable, error, loading, query, selectedApp, selectedId, selectedRemovalIds, sources, sourceFilter,
  categories, categoryFilter, favoritesOnly, favoriteAppIds, sortOrder, onSortOrder, onClearFilters, platform,
  onFilter, onLaunch, onManage, onQuery, onSelect, onUpdate,
  onCategoryFilter, onToggleFavorites, onToggleFavorite, onReinstall, onRemoveSelected, onToggleRemoval,
  onSelectVisibleRemoval, operationProgress, bulkBusy,
}: {
  apps: AppRecord[]
  allApps: AppRecord[]
  wingetAvailable: boolean
  error: string | null
  loading: boolean
  query: string
  selectedApp: AppRecord | null
  selectedId: string | null
  selectedRemovalIds: string[]
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
  onReinstall: (app: AppRecord) => void
  onRemoveSelected: () => void
  onToggleRemoval: (id: string) => void
  onSelectVisibleRemoval: (ids: string[]) => void
  operationProgress: string | null
  bulkBusy: boolean
  onQuery: (query: string) => void
  onSelect: (id: string) => void
}) {
  const removableApps = apps.filter((app) => app.package_name
    && ['APT', 'DNF', 'Pacman', 'Zypper', 'Flatpak', 'Snap', 'WinGet'].includes(app.source))
  const selectedVisibleIds = removableApps.filter((app) => selectedRemovalIds.includes(app.id)).map((app) => app.id)
  const allVisibleSelected = removableApps.length > 0 && selectedVisibleIds.length === removableApps.length
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
            {removableApps.length ? (
              <div className="bulk-removal-toolbar">
                <label><input
                  checked={allVisibleSelected}
                  disabled={bulkBusy}
                  onChange={() => onSelectVisibleRemoval(allVisibleSelected
                    ? selectedRemovalIds.filter((id) => !removableApps.some((app) => app.id === id))
                    : [...new Set([...selectedRemovalIds, ...removableApps.map((app) => app.id)])])}
                  type="checkbox"
                /> Select removable apps ({selectedVisibleIds.length}/{removableApps.length})</label>
                <button className="danger-link" disabled={bulkBusy || selectedVisibleIds.length === 0} onClick={onRemoveSelected} type="button">
                  Remove selected
                </button>
                {operationProgress ? <span role="status">{operationProgress}</span> : null}
              </div>
            ) : null}
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
              <div className={`application-row${selectedId === app.id ? ' selected' : ''}`} key={app.id}>
                <button
                  aria-pressed={selectedId === app.id}
                  className="application-row-select"
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
                {removableApps.some((candidate) => candidate.id === app.id) ? <input
                  aria-label={`Select ${app.name} for bulk removal`}
                  checked={selectedRemovalIds.includes(app.id)}
                  disabled={bulkBusy}
                  onChange={() => onToggleRemoval(app.id)}
                  type="checkbox"
                /> : null}
              </div>
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
              {selectedApp.package_name && ['APT', 'DNF', 'Pacman', 'Zypper', 'Flatpak', 'Snap', 'WinGet'].includes(selectedApp.source) ? (
                <>
                  <div className="detail-actions">
                    <button className="secondary-button" onClick={() => onUpdate(selectedApp)} type="button">Check for update</button>
                    {['APT', 'DNF', 'Pacman', 'Zypper', 'WinGet'].includes(selectedApp.source)
                      ? <button className="secondary-button" disabled={bulkBusy} onClick={() => onReinstall(selectedApp)} type="button">Reinstall</button>
                      : <span className="action-note">Reinstall is not exposed for {selectedApp.source}; the provider cannot safely target this exact package.</span>}
                    <button className="danger-link" onClick={() => onManage(selectedApp)} type="button">Uninstall</button>
                  </div>
                  <p className="action-note">Version rollback is unavailable for {selectedApp.source} because AppPilot cannot verify a safe target version.</p>
                </>
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
          : 'Search installed Linux package sources and install using their native package manager.'}
      />
      <section className="content-card">
        <div className="catalog-toolbar">
          <div className="list-heading">
            <div><h2>Available applications</h2><p>{isWindows ? 'Search by app name or package ID. Results come directly from WinGet.' : 'Search APT, DNF, Pacman, Zypper, Flatpak and Snap sources available on this system.'}</p></div>
            <span className="result-count">{loading ? '…' : entries.length}</span>
          </div>
          <label className="catalog-search">
            <span aria-hidden="true">⌕</span>
            <input
              aria-label="Search available applications"
              onChange={(event) => onQuery(event.target.value)}
              placeholder={isWindows ? 'Type at least 2 letters to search WinGet' : 'Type 2+ letters to search available sources'}
              type="search"
              value={query}
            />
          </label>
        </div>
        {loading ? <LoadingState label={isWindows ? 'Searching WinGet…' : 'Searching configured package sources…'} /> : entries.length === 0 ? (
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
                : query.length < 2
                  ? 'Enter at least two letters to search installed package sources.'
                  : 'No configured source returned a matching application. Check the package integrations in Settings.'}
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

function UpdatesPage({ updates, loading, error, progress, selectedUpdates, deferredCount, onUpdate, onUpdateAll, onToggleUpdate, onSelectAll, onIgnore }: {
  updates: PackageUpdate[]
  loading: boolean
  error: string | null
  progress: string | null
  selectedUpdates: string[]
  deferredCount: number
  onUpdate: (update: PackageUpdate) => void
  onUpdateAll: () => void
  onToggleUpdate: (id: string) => void
  onSelectAll: (ids: string[]) => void
  onIgnore: (id: string) => void
}) {
  const visibleIds = updates.map(updateId)
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedUpdates.includes(id))
  const visibleSelectedCount = selectedUpdates.filter((id) => visibleIds.includes(id)).length
  return (
    <>
      <PageHeading
        eyebrow="SOFTWARE MAINTENANCE"
        title="Updates"
        description="Available updates reported by the package managers installed on this system."
        action={updates.length > 0 ? <button className="primary-button" disabled={loading || visibleSelectedCount === 0} onClick={onUpdateAll} type="button">Update selected ({visibleSelectedCount})</button> : undefined}
      />
      <section className="content-card">
        <div className="list-heading"><div><h2>Available updates</h2><p>Read directly from configured package sources; each selected action is confirmed before it runs.</p></div><span className="result-count">{loading ? 'Checking…' : updates.length}</span></div>
        {progress ? <div className="operation-progress" role="status">{progress}</div> : null}
        {loading ? <LoadingState label="Checking configured package sources…" /> : error ? (
          <EmptyState title="Update check is unavailable" description="Resolve the package-manager error above and refresh the check." />
        ) : updates.length === 0 ? (
          <EmptyState title={deferredCount ? 'No visible updates' : 'Everything is up to date'} description={deferredCount ? `${deferredCount} update(s) are deferred. Restore them in Tools when you are ready.` : 'No available upgrades were reported by the package managers.'} />
        ) : (
          <div className="data-list">
            <div className="updates-select-all">
              <label><input checked={allSelected} onChange={() => onSelectAll(allSelected ? [] : visibleIds)} type="checkbox" /> Select all visible ({updates.length})</label>
              <span>{visibleSelectedCount} selected</span>
            </div>
            {updates.map((update) => (
              <div className="data-row update-row" key={`${update.source}:${update.package_name}`}>
                <input aria-label={`Select update for ${update.name}`} checked={selectedUpdates.includes(updateId(update))} onChange={() => onToggleUpdate(updateId(update))} type="checkbox" />
                <AppGlyph name={update.name} />
                <div className="data-row-main"><strong>{update.name}</strong><small>{update.package_name} · {update.source} · available {update.version}</small></div>
                <span className="version-tag">{update.version}</span>
                <button className="secondary-button update-button" onClick={() => onUpdate(update)} type="button">Update</button>
                <button aria-label={`Defer update for ${update.name}`} className="text-button" onClick={() => onIgnore(updateId(update))} type="button">Defer</button>
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

function ToolsPage({
  activity, apps, collections, ignoredUpdates, importedManifest, packageStatus, cacheStatus, diagnostics, platform, reminderDays,
  onExportManifest, onImportManifest, onImportPreferences, onFindPackage, onSaveCollection, onExportPreferences,
  onReminderDays, onUnignore, onCleanCache, onExportDiagnostics, onInstallManifest, onInstallCollection, bulkBusy, operationProgress,
}: {
  activity: ActivityItem[]
  apps: AppRecord[]
  collections: AppCollection[]
  ignoredUpdates: string[]
  importedManifest: SetupManifest | null
  packageStatus: PackageStatus | null
  cacheStatus: PackageCacheStatus | null
  diagnostics: SystemDiagnostics | null
  platform: string
  reminderDays: number
  bulkBusy: boolean
  operationProgress: string | null
  onExportManifest: (onlyFavorites?: boolean) => void
  onImportManifest: (file: File) => void
  onImportPreferences: (file: File) => void
  onFindPackage: (id: string) => void
  onSaveCollection: (name: string) => void
  onExportPreferences: () => void
  onReminderDays: (days: number) => void
  onUnignore: (id: string) => void
  onCleanCache: () => void
  onExportDiagnostics: () => void
  onInstallManifest: (manifest: SetupManifest) => void
  onInstallCollection: (collection: AppCollection) => void
}) {
  const [collectionName, setCollectionName] = useState('')
  const integrations: [string, boolean][] = platform === 'windows'
    ? [['WinGet', packageStatus?.winget ?? false]]
    : [
      ['APT', packageStatus?.apt ?? false],
      ['DNF', packageStatus?.dnf ?? false],
      ['Pacman', packageStatus?.pacman ?? false],
      ['Zypper', packageStatus?.zypper ?? false],
      ['Flatpak', packageStatus?.flatpak ?? false],
      ['Snap', packageStatus?.snap ?? false],
    ]
  const installed = (item: SetupManifest['packages'][number]) => apps.some((app) =>
    app.package_name?.toLowerCase() === item.id.toLowerCase() && app.source === item.source,
  )

  return (
    <>
      <PageHeading eyebrow="WORKSPACE TOOLS" title="Tools" description="Move your setup, organize software, and understand the package sources available on this computer." />
      <div className="tools-grid">
        <section className="content-card tool-card">
          <div className="list-heading"><div><h2>Setup manifest</h2><p>Save package references, not application binaries or personal data.</p></div></div>
          <div className="tool-actions">
            <button className="secondary-button" onClick={() => onExportManifest(false)} type="button">Export installed apps</button>
            <button className="secondary-button" onClick={() => onExportManifest(true)} type="button">Export favorites</button>
            <label className="secondary-button file-button">Review a manifest<input accept="application/json,.json" onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) onImportManifest(file)
              event.currentTarget.value = ''
            }} type="file" /></label>
          </div>
          {importedManifest ? (
            <div className="manifest-preview">
              <strong>Restore preview · {importedManifest.packages.length} packages</strong>
              <p>Already installed on this device: {importedManifest.packages.filter(installed).length}. AppPilot checks package IDs and sources against the live catalog before a confirmed install queue.</p>
              <button className="secondary-button cache-clean-button" disabled={bulkBusy} onClick={() => onInstallManifest(importedManifest)} type="button">Review and install available packages</button>
              {operationProgress ? <p className="tool-footnote" role="status">{operationProgress}</p> : null}
              <div className="manifest-items">
                {importedManifest.packages.map((item) => (
                  <div className="manifest-item" key={`${item.source}:${item.id}`}>
                    <span><strong>{item.name}</strong><small>{item.id} · {item.source}</small></span>
                    {installed(item)
                      ? <span className="installed-status"><i />Installed</span>
                      : <button className="text-button" onClick={() => onFindPackage(item.id)} type="button">Find package</button>}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </section>

        <section className="content-card tool-card">
          <div className="list-heading"><div><h2>Collections</h2><p>Save a named set from your favorites for easier setup planning.</p></div></div>
          <form className="collection-form" onSubmit={(event) => {
            event.preventDefault()
            onSaveCollection(collectionName)
            setCollectionName('')
          }}>
            <input aria-label="Collection name" maxLength={48} onChange={(event) => setCollectionName(event.target.value)} placeholder="e.g. Work essentials" value={collectionName} />
            <button className="secondary-button" disabled={!collectionName.trim()} type="submit">Save favorites</button>
          </form>
          {collections.length ? <div className="collection-list">{collections.map((collection) => (
            <div className="integration-row" key={collection.name}>
              <span>{collection.name}<small className="tool-subline">{collection.packages?.length ?? collection.package_ids.length} package references</small></span>
              <button className="text-button" disabled={bulkBusy} onClick={() => onInstallCollection(collection)} type="button">Review install queue</button>
            </div>
          ))}</div> : <p className="tool-footnote">Favorite a few installed apps first, then save them here as a collection.</p>}
          <div className="tool-actions">
            <button className="secondary-button" onClick={onExportPreferences} type="button">Export preferences</button>
            <label className="secondary-button file-button">Import preferences<input accept="application/json,.json" onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) onImportPreferences(file)
              event.currentTarget.value = ''
            }} type="file" /></label>
          </div>
        </section>

        <section className="content-card tool-card">
          <div className="list-heading"><div><h2>Package source check</h2><p>Availability is detected locally; missing providers are never assumed.</p></div></div>
          <div className="integration-list">{integrations.map(([name, available]) => (
            <div className="integration-row" key={name}><span>{name}</span><span className={`integration-status${available ? ' online' : ''}`}><i />{available ? 'Available' : 'Not installed'}</span></div>
          ))}</div>
          <p className="tool-footnote">Linux distribution: {platform === 'linux' ? 'Native package support depends on the detected package tools above.' : 'Windows package actions use WinGet for the current account.'}</p>
        </section>

        <section className="content-card tool-card">
          <div className="list-heading"><div><h2>System diagnostics</h2><p>Read-only system information to help identify supported package sources.</p></div></div>
          {diagnostics ? (
            <>
              <div className="integration-list">
                <div className="integration-row"><span>Platform</span><strong>{diagnostics.platform}</strong></div>
                <div className="integration-row"><span>Distribution</span><strong>{diagnostics.distribution}</strong></div>
                <div className="integration-row"><span>Release</span><strong>{diagnostics.release}</strong></div>
                {diagnostics.kernel ? <div className="integration-row"><span>Kernel</span><strong>{diagnostics.kernel}</strong></div> : null}
                <div className="integration-row"><span>Architecture</span><strong>{diagnostics.architecture}</strong></div>
                <div className="integration-row"><span>Detected package tools</span><strong>{diagnostics.package_sources.join(', ') || 'None'}</strong></div>
              </div>
              {diagnostics.notices.map((message) => <p className="tool-footnote" key={message}>{message}</p>)}
              <button className="secondary-button cache-clean-button" onClick={onExportDiagnostics} type="button">Export diagnostics summary</button>
            </>
          ) : <p className="tool-footnote">Collecting read-only system information…</p>}
        </section>

        <section className="content-card tool-card">
          <div className="list-heading"><div><h2>Package cache storage</h2><p>{cacheStatus?.message ?? 'Inspecting package-manager cache locations…'}</p></div></div>
          {cacheStatus?.entries.length ? (
            <>
              <div className="integration-list">{cacheStatus.entries.map((entry) => (
                <div className="integration-row" key={entry.source}><span>{entry.source}<small className="tool-subline">{entry.path}</small></span><strong>{formatBytes(entry.bytes)}</strong></div>
              ))}</div>
              <div className="cache-total"><span>Estimated total</span><strong>{formatBytes(cacheStatus.total_bytes)}</strong></div>
            </>
          ) : null}
          {cacheStatus?.supported ? <button className="secondary-button cache-clean-button" onClick={onCleanCache} type="button">Review and clean caches</button> : <p className="tool-footnote">Cleanup is unavailable unless the system exposes a supported package-manager command.</p>}
        </section>

        <section className="content-card tool-card">
          <div className="list-heading"><div><h2>Update reminders</h2><p>Remind while AppPilot is open. Packages are never installed automatically.</p></div></div>
          <label className="reminder-setting">Check-in reminder
            <select onChange={(event) => onReminderDays(Number(event.target.value))} value={reminderDays}>
              <option value={0}>Off</option>
              <option value={1}>Every day</option>
              <option value={7}>Every week</option>
              <option value={30}>Every month</option>
            </select>
          </label>
        </section>

        <section className="content-card tool-card">
          <div className="list-heading"><div><h2>Deferred updates</h2><p>Hidden from the update list on this device until restored.</p></div><span className="result-count">{ignoredUpdates.length}</span></div>
          {ignoredUpdates.length ? <div className="collection-list">{ignoredUpdates.map((id) => (
            <div className="integration-row" key={id}><span>{id}</span><button className="text-button" onClick={() => onUnignore(id)} type="button">Restore</button></div>
          ))}</div> : <p className="tool-footnote">No updates have been deferred.</p>}
        </section>

        <section className="content-card tool-card">
          <div className="list-heading"><div><h2>Recent AppPilot actions</h2><p>Stored locally on this device. The history is limited to 100 entries.</p></div><span className="result-count">{activity.length}</span></div>
          {activity.length ? <div className="collection-list">{activity.slice(0, 10).map((item) => (
            <div className="integration-row" key={item.id}>
              <span>{item.action} · {item.target}<small className="tool-subline">{item.source} · {new Date(item.timestamp).toLocaleString()}</small></span>
              <span className={`integration-status${item.successful ? ' online' : ''}`}><i />{item.successful ? 'Done' : 'Failed'}</span>
            </div>
          ))}</div> : <p className="tool-footnote">Install, update and removal actions will appear here.</p>}
        </section>
      </div>
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
      ['DNF', packageStatus?.dnf],
      ['Pacman', packageStatus?.pacman],
      ['Zypper', packageStatus?.zypper],
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
