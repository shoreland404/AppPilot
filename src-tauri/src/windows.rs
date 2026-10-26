use std::fs;
use std::path::PathBuf;
use std::process::{Command, Output};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AppRecord {
    pub id: String,
    pub name: String,
    pub description: String,
    pub source: String,
    pub icon: Option<String>,
    pub installed: bool,
    pub package_name: Option<String>,
    pub package_scope: Option<String>,
    pub category: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PackageManagerStatus {
    pub apt: bool,
    pub dnf: bool,
    pub pacman: bool,
    pub zypper: bool,
    pub flatpak: bool,
    pub snap: bool,
    pub pkexec: bool,
    pub winget: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AppOverview {
    pub installed_applications: usize,
    pub startup_entries: Option<usize>,
    pub running_processes: Option<usize>,
    pub package_status: PackageManagerStatus,
    pub platform: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DashboardData {
    pub overview: AppOverview,
    pub applications: Vec<AppRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessInfo {
    pub pid: u32,
    pub name: String,
    pub memory_kb: u64,
    pub can_terminate: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StartupEntry {
    pub id: String,
    pub name: String,
    pub path: String,
    pub enabled: bool,
    pub can_manage: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PackageUpdate {
    pub package_name: String,
    pub name: String,
    pub source: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PackageCacheEntry {
    pub source: String,
    pub path: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PackageCacheStatus {
    pub supported: bool,
    pub message: String,
    pub entries: Vec<PackageCacheEntry>,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemDiagnostics {
    pub platform: String,
    pub distribution: String,
    pub release: String,
    pub kernel: Option<String>,
    pub architecture: String,
    pub package_sources: Vec<String>,
    pub notices: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FlatpakCatalogEntry {
    pub app_id: String,
    pub name: String,
    pub description: String,
    pub version: String,
    pub remote: String,
    pub scope: String,
    pub installed: bool,
}

#[derive(Debug)]
struct PackageRow {
    name: String,
    id: String,
    version: String,
    available: String,
    source: String,
}

const WINGET_SOURCE: &str = "WinGet";
const STARTUP_DIR: &str = "Microsoft\\Windows\\Start Menu\\Programs\\Startup";
const APPLICATION_CACHE_TTL: Duration = Duration::from_secs(60);
type ApplicationCache = Mutex<Option<(Instant, Vec<AppRecord>)>>;
static APPLICATION_CACHE: OnceLock<ApplicationCache> = OnceLock::new();

#[tauri::command]
async fn get_dashboard_data() -> Result<DashboardData, String> {
    tauri::async_runtime::spawn_blocking(get_dashboard_data_impl)
        .await
        .map_err(|error| format!("application inventory task failed: {error}"))?
}

fn get_dashboard_data_impl() -> Result<DashboardData, String> {
    let package_status = detect_package_managers();
    let applications = if package_status.winget {
        list_installed_applications()?
    } else {
        Vec::new()
    };
    Ok(DashboardData {
        overview: AppOverview {
            installed_applications: applications.len(),
            startup_entries: None,
            running_processes: None,
            package_status,
            platform: "windows".to_string(),
        },
        applications,
    })
}

#[tauri::command]
async fn get_package_updates() -> Result<Vec<PackageUpdate>, String> {
    tauri::async_runtime::spawn_blocking(get_package_updates_impl)
        .await
        .map_err(|error| format!("update check task failed: {error}"))?
}

#[tauri::command]
async fn get_package_cache_status() -> Result<PackageCacheStatus, String> {
    Ok(PackageCacheStatus {
        supported: false,
        message: "WinGet does not provide a supported cache-cleanup operation. AppPilot will not delete its files manually.".to_string(),
        entries: Vec::new(),
        total_bytes: 0,
    })
}

#[tauri::command]
async fn get_system_diagnostics() -> Result<SystemDiagnostics, String> {
    let winget_available = find_winget().is_some();
    let version_output = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "[Environment]::OSVersion.Version.ToString()",
        ])
        .output()
        .map_err(|error| format!("could not read the Windows version: {error}"))?;
    let release = successful_text("Windows version query", &version_output)?;
    Ok(SystemDiagnostics {
        platform: "Windows".to_string(),
        distribution: "Microsoft Windows".to_string(),
        release,
        kernel: None,
        architecture: std::env::consts::ARCH.to_string(),
        package_sources: if winget_available {
            vec!["WinGet".to_string()]
        } else {
            Vec::new()
        },
        notices: if winget_available {
            Vec::new()
        } else {
            vec!["WinGet is unavailable; install and update actions are disabled.".to_string()]
        },
    })
}

#[tauri::command]
async fn clean_package_cache(_sources: Vec<String>) -> Result<Vec<String>, String> {
    Err("No supported WinGet cache-cleanup command is available.".to_string())
}

fn get_package_updates_impl() -> Result<Vec<PackageUpdate>, String> {
    let output = run_winget(&[
        "upgrade",
        "--accept-source-agreements",
        "--disable-interactivity",
    ])?;
    let text = successful_text("WinGet update check", &output)?;
    Ok(parse_winget_table(&text)?
        .into_iter()
        .filter(|row| !row.available.is_empty() && row.id != "Id")
        .map(|row| PackageUpdate {
            package_name: row.id,
            name: row.name,
            source: WINGET_SOURCE.to_string(),
            version: row.available,
        })
        .collect())
}

#[tauri::command]
async fn search_package_catalog(query: String) -> Result<Vec<FlatpakCatalogEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || search_package_catalog_impl(query))
        .await
        .map_err(|error| format!("catalog search task failed: {error}"))?
}

fn search_package_catalog_impl(query: String) -> Result<Vec<FlatpakCatalogEntry>, String> {
    let query = query.trim();
    if query.chars().count() < 2 {
        return Ok(Vec::new());
    }
    if !detect_package_managers().winget {
        return Err("Install or update 'App Installer' from Microsoft Store to use WinGet, then refresh AppPilot.".to_string());
    }
    let output = run_winget(&[
        "search",
        "--query",
        query,
        "--accept-source-agreements",
        "--disable-interactivity",
    ])?;
    let text = successful_text("WinGet search", &output)?;
    let installed: std::collections::HashSet<String> = list_installed_applications()?
        .into_iter()
        .filter_map(|app| app.package_name)
        .collect();
    Ok(parse_winget_table(&text)?
        .into_iter()
        .filter(|row| !row.id.is_empty() && row.id != "Id")
        .map(|row| FlatpakCatalogEntry {
            app_id: row.id.clone(),
            name: row.name,
            description: String::new(),
            version: row.version,
            remote: if row.source.is_empty() {
                "winget".to_string()
            } else {
                row.source
            },
            scope: "user".to_string(),
            installed: installed.contains(&row.id),
        })
        .collect())
}

#[tauri::command]
async fn update_all_packages() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(update_all_packages_impl)
        .await
        .map_err(|error| format!("bulk update task failed: {error}"))?
}

fn update_all_packages_impl() -> Result<Vec<String>, String> {
    let updates = get_package_updates_impl()?;
    if updates.is_empty() {
        return Ok(Vec::new());
    }
    let output = run_winget(&[
        "upgrade",
        "--all",
        "--silent",
        "--accept-package-agreements",
        "--accept-source-agreements",
        "--disable-interactivity",
    ])?;
    successful_text("WinGet bulk update", &output)?;
    invalidate_application_cache()?;
    let mut sources = Vec::new();
    for update in updates {
        if !sources.contains(&update.source) {
            sources.push(update.source);
        }
    }
    Ok(sources)
}

#[tauri::command]
async fn install_flatpak_application(
    app_id: String,
    remote: String,
    scope: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || install_package_impl(app_id, remote, scope))
        .await
        .map_err(|error| format!("application installation task failed: {error}"))?
}

fn install_package_impl(app_id: String, source: String, scope: String) -> Result<String, String> {
    validate_package_id(&app_id)?;
    validate_winget_source(&source)?;
    if scope != "user" {
        return Err("Windows installs are limited to the current user.".to_string());
    }
    let output = run_winget(&[
        "install",
        "--id",
        &app_id,
        "--exact",
        "--source",
        &source,
        "--scope",
        "user",
        "--accept-package-agreements",
        "--accept-source-agreements",
        "--disable-interactivity",
    ])?;
    successful_text("WinGet installation", &output)?;
    invalidate_application_cache()?;
    Ok(format!("Installed {app_id} with WinGet."))
}

#[tauri::command]
async fn update_package(package_name: String, source: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || update_package_impl(package_name, source))
        .await
        .map_err(|error| format!("package update task failed: {error}"))?
}

fn update_package_impl(package_name: String, source: String) -> Result<String, String> {
    validate_winget_package(&package_name, &source)?;
    ensure_installed_package(&package_name)?;
    let output = run_winget(&[
        "upgrade",
        "--id",
        &package_name,
        "--exact",
        "--silent",
        "--accept-package-agreements",
        "--accept-source-agreements",
        "--disable-interactivity",
    ])?;
    successful_text("WinGet package update", &output)?;
    invalidate_application_cache()?;
    Ok(format!("Updated {package_name} with WinGet."))
}

#[tauri::command]
async fn perform_package_action(app_id: String, action: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || perform_package_action_impl(app_id, action))
        .await
        .map_err(|error| format!("package action task failed: {error}"))?
}

fn perform_package_action_impl(app_id: String, action: String) -> Result<String, String> {
    validate_package_id(&app_id)?;
    if action != "remove" {
        return Err(format!("Unsupported package action: {action}"));
    }
    ensure_installed_package(&app_id)?;
    let output = run_winget(&[
        "uninstall",
        "--id",
        &app_id,
        "--exact",
        "--disable-interactivity",
    ])?;
    successful_text("WinGet uninstall", &output)?;
    invalidate_application_cache()?;
    Ok(format!("Uninstalled {app_id} with WinGet."))
}

#[tauri::command]
async fn reinstall_package(app_id: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || reinstall_package_impl(app_id))
        .await
        .map_err(|error| format!("package reinstall task failed: {error}"))?
}

fn reinstall_package_impl(app_id: String) -> Result<String, String> {
    validate_winget_package(&app_id, WINGET_SOURCE)?;
    ensure_installed_package(&app_id)?;
    let output = run_winget(&[
        "install",
        "--id",
        &app_id,
        "--exact",
        "--force",
        "--accept-package-agreements",
        "--accept-source-agreements",
        "--disable-interactivity",
    ])?;
    successful_text("WinGet package reinstall", &output)?;
    invalidate_application_cache()?;
    Ok(format!("Reinstalled {app_id} with WinGet."))
}

#[tauri::command]
async fn launch_application(app_id: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || launch_application_impl(app_id))
        .await
        .map_err(|error| format!("application launch task failed: {error}"))?
}

fn launch_application_impl(app_id: String) -> Result<String, String> {
    validate_package_id(&app_id)?;
    let apps = list_installed_applications()?;
    let app = apps
        .iter()
        .find(|app| app.id.eq_ignore_ascii_case(&app_id))
        .ok_or_else(|| "This application is no longer in the WinGet inventory.".to_string())?;
    let mut roots = Vec::new();
    if let Some(path) = std::env::var_os("APPDATA") {
        roots.push(PathBuf::from(path).join("Microsoft\\Windows\\Start Menu\\Programs"));
    }
    if let Some(path) = std::env::var_os("PROGRAMDATA") {
        roots.push(PathBuf::from(path).join("Microsoft\\Windows\\Start Menu\\Programs"));
    }
    let shortcut = find_shortcut(&roots, &app.name)?
        .ok_or_else(|| format!("No Start menu shortcut was found for {}.", app.name))?;
    Command::new("explorer.exe")
        .arg(&shortcut)
        .spawn()
        .map_err(|error| format!("could not launch {}: {error}", app.name))?;
    Ok(format!("Launched {}.", app.name))
}

#[tauri::command]
async fn scan_startup_entries() -> Result<Vec<StartupEntry>, String> {
    tauri::async_runtime::spawn_blocking(scan_startup_entries_impl)
        .await
        .map_err(|error| format!("startup scan task failed: {error}"))?
}

fn scan_startup_entries_impl() -> Result<Vec<StartupEntry>, String> {
    let user_directory = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .map(|path| path.join(STARTUP_DIR))
        .ok_or_else(|| "The current user's Startup folder could not be located.".to_string())?;
    let system_directory = std::env::var_os("PROGRAMDATA")
        .map(PathBuf::from)
        .map(|path| path.join(STARTUP_DIR));
    let mut entries = Vec::new();
    for (directory, can_manage) in std::iter::once((user_directory, true))
        .chain(system_directory.into_iter().map(|path| (path, false)))
    {
        let files = match fs::read_dir(&directory) {
            Ok(files) => files,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(format!("could not read {}: {error}", directory.display()));
            }
        };
        for file in files {
            let file = file.map_err(|error| {
                format!(
                    "could not inspect an entry in {}: {error}",
                    directory.display()
                )
            })?;
            let path = file.path();
            if !path.is_file() {
                continue;
            }
            let disabled = path
                .extension()
                .is_some_and(|extension| extension == "disabled");
            let visible_path = if disabled {
                path.with_extension("")
            } else {
                path.clone()
            };
            if !matches!(
                visible_path
                    .extension()
                    .and_then(|extension| extension.to_str()),
                Some("lnk" | "url" | "exe" | "bat" | "cmd")
            ) {
                continue;
            }
            let name = visible_path
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or("Startup item")
                .to_string();
            entries.push(StartupEntry {
                id: format!(
                    "{}:{}",
                    if can_manage { "user" } else { "system" },
                    visible_path
                        .file_name()
                        .and_then(|value| value.to_str())
                        .unwrap_or_default()
                ),
                name,
                path: visible_path.display().to_string(),
                enabled: !disabled,
                can_manage,
            });
        }
    }
    entries.sort_by_key(|entry| entry.name.to_lowercase());
    Ok(entries)
}

#[tauri::command]
async fn set_startup_entry_enabled(id: String, enabled: bool) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || set_startup_entry_enabled_impl(id, enabled))
        .await
        .map_err(|error| format!("startup change task failed: {error}"))?
}

fn set_startup_entry_enabled_impl(id: String, enabled: bool) -> Result<String, String> {
    let filename = id.strip_prefix("user:").ok_or_else(|| {
        "Only startup shortcuts owned by the current user can be changed.".to_string()
    })?;
    if PathBuf::from(filename)
        .file_name()
        .and_then(|name| name.to_str())
        != Some(filename)
    {
        return Err("The selected startup item has an invalid identifier.".to_string());
    }
    let directory = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .map(|path| path.join(STARTUP_DIR))
        .ok_or_else(|| "The current user's Startup folder could not be located.".to_string())?;
    let original = directory.join(filename);
    let disabled = original.with_extension(format!(
        "{}.disabled",
        original
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
    ));
    let (source, destination) = if enabled {
        (&disabled, &original)
    } else {
        (&original, &disabled)
    };
    if !source.starts_with(&directory) || !source.is_file() {
        return Err("The selected startup shortcut no longer exists.".to_string());
    }
    fs::rename(source, destination)
        .map_err(|error| format!("could not change startup item: {error}"))?;
    Ok(format!(
        "{} {} at sign-in.",
        if enabled { "Enabled" } else { "Disabled" },
        original
            .file_stem()
            .and_then(|name| name.to_str())
            .unwrap_or("startup item")
    ))
}

#[tauri::command]
async fn scan_running_processes() -> Result<Vec<ProcessInfo>, String> {
    tauri::async_runtime::spawn_blocking(scan_running_processes_impl)
        .await
        .map_err(|error| format!("process scan task failed: {error}"))?
}

fn scan_running_processes_impl() -> Result<Vec<ProcessInfo>, String> {
    let script = "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-CimInstance Win32_Process | ForEach-Object { $owner = $_.GetOwner(); [pscustomobject]@{ pid = $_.ProcessId; name = $_.Name; memory_kb = [long]($_.WorkingSetSize / 1KB); owner = if ($owner.ReturnValue -eq 0) { \"$($owner.Domain)\\$($owner.User)\" } else { '' } } } | ConvertTo-Json -Compress";
    let output = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .output()
        .map_err(|error| format!("could not inspect Windows processes: {error}"))?;
    let text = successful_text("Windows process scan", &output)?;
    let values: serde_json::Value =
        serde_json::from_str(&text).map_err(|error| format!("invalid process data: {error}"))?;
    let rows = values.as_array().cloned().unwrap_or_else(|| vec![values]);
    let current_user = std::env::var("USERDOMAIN")
        .unwrap_or_default()
        .to_lowercase()
        + "\\"
        + &std::env::var("USERNAME").unwrap_or_default().to_lowercase();
    let current_pid = std::process::id();
    let mut processes: Vec<ProcessInfo> = rows
        .iter()
        .filter_map(|row| {
            let pid = row.get("pid")?.as_u64()? as u32;
            let owner = row
                .get("owner")?
                .as_str()
                .unwrap_or_default()
                .to_lowercase();
            Some(ProcessInfo {
                pid,
                name: row.get("name")?.as_str()?.to_string(),
                memory_kb: row.get("memory_kb")?.as_u64().unwrap_or_default(),
                can_terminate: pid > 4 && pid != current_pid && owner == current_user,
            })
        })
        .collect();
    processes.sort_by_key(|process| std::cmp::Reverse(process.memory_kb));
    Ok(processes)
}

#[tauri::command]
async fn terminate_process(pid: u32) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || terminate_process_impl(pid))
        .await
        .map_err(|error| format!("process termination task failed: {error}"))?
}

fn terminate_process_impl(pid: u32) -> Result<String, String> {
    if pid <= 4 || pid == std::process::id() {
        return Err("This system process cannot be stopped from AppPilot.".to_string());
    }
    let process = scan_running_processes_impl()?
        .into_iter()
        .find(|process| process.pid == pid)
        .ok_or_else(|| "The process is no longer running.".to_string())?;
    if !process.can_terminate {
        return Err("Only processes owned by the current user can be stopped.".to_string());
    }
    let output = Command::new("taskkill.exe")
        .args(["/PID", &pid.to_string()])
        .output()
        .map_err(|error| format!("could not request process termination: {error}"))?;
    successful_text("Process termination", &output)?;
    Ok(format!("Requested termination of {}.", process.name))
}

fn list_installed_applications() -> Result<Vec<AppRecord>, String> {
    let cache = APPLICATION_CACHE.get_or_init(|| Mutex::new(None));
    if let Some((created, apps)) = cache
        .lock()
        .map_err(|_| "Windows application cache is unavailable.".to_string())?
        .as_ref()
    {
        if created.elapsed() < APPLICATION_CACHE_TTL {
            return Ok(apps.clone());
        }
    }

    let apps = scan_installed_applications()?;
    *cache
        .lock()
        .map_err(|_| "Windows application cache is unavailable.".to_string())? =
        Some((Instant::now(), apps.clone()));
    Ok(apps)
}

fn scan_installed_applications() -> Result<Vec<AppRecord>, String> {
    let output = run_winget(&[
        "list",
        "--accept-source-agreements",
        "--disable-interactivity",
    ])?;
    let text = successful_text("WinGet installed application scan", &output)?;
    let mut apps: Vec<AppRecord> = parse_winget_table(&text)?
        .into_iter()
        .filter(|row| !row.id.is_empty() && row.id != "Id" && row.id != "<unknown>")
        .map(|row| AppRecord {
            id: row.id.clone(),
            name: row.name,
            description: String::new(),
            source: WINGET_SOURCE.to_string(),
            icon: None,
            installed: true,
            package_name: Some(row.id),
            package_scope: None,
            category: "Application".to_string(),
            path: "Windows Start menu".to_string(),
        })
        .collect();
    apps.sort_by_key(|app| app.name.to_lowercase());
    apps.dedup_by(|left, right| left.id.eq_ignore_ascii_case(&right.id));
    Ok(apps)
}

fn invalidate_application_cache() -> Result<(), String> {
    *APPLICATION_CACHE
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| "Windows application cache is unavailable.".to_string())? = None;
    Ok(())
}

fn parse_winget_table(output: &str) -> Result<Vec<PackageRow>, String> {
    let lines: Vec<&str> = output.lines().collect();
    let no_results = lines.iter().any(|line| {
        let line = line.trim().to_ascii_lowercase();
        [
            "no package found matching",
            "no installed package found matching",
            "no applicable upgrade found",
        ]
        .iter()
        .any(|message| line.contains(message))
    });
    if no_results {
        return Ok(Vec::new());
    }
    let Some((header_index, header)) = lines
        .iter()
        .enumerate()
        .find(|(_, line)| line.contains("Name") && line.contains("Id") && line.contains("Version"))
    else {
        return Err(
            "AppPilot could not read WinGet's response. Check that App Installer is up to date and uses an English package table."
                .to_string(),
        );
    };
    let char_positions: Vec<usize> = ["Id", "Version", "Available", "Match", "Source"]
        .into_iter()
        .filter_map(|column| header.find(column))
        .collect();
    if char_positions.len() < 2 {
        return Err("AppPilot could not read WinGet's package table.".to_string());
    }
    let name_end = header.find("Id").unwrap_or_default();
    let id_start = name_end;
    let version_start = header.find("Version").unwrap_or(output.len());
    let available_start = header.find("Available");
    let source_start = header.find("Source");
    let rows: Vec<PackageRow> = lines
        .iter()
        .skip(header_index + 1)
        .filter(|line| {
            !line.trim().is_empty()
                && !line.chars().all(|character| {
                    character.is_whitespace() || matches!(character, '-' | '─' | '━')
                })
        })
        .filter_map(|line| {
            let name = char_slice(line, 0, name_end).trim().to_string();
            let id = char_slice(line, id_start, version_start).trim().to_string();
            if name.is_empty() || id.is_empty() {
                return None;
            }
            let match_start = header.find("Match");
            let version_end = [available_start, match_start, source_start]
                .into_iter()
                .flatten()
                .min()
                .unwrap_or(usize::MAX);
            let version = char_slice(line, version_start, version_end)
                .trim()
                .to_string();
            let available = if let Some(start) = available_start {
                char_slice(line, start, source_start.unwrap_or(usize::MAX))
                    .trim()
                    .to_string()
            } else {
                String::new()
            };
            let source = source_start
                .map(|start| char_slice(line, start, usize::MAX).trim().to_string())
                .unwrap_or_default();
            Some(PackageRow {
                name,
                id,
                version,
                available,
                source,
            })
        })
        .collect();
    Ok(rows)
}

fn char_slice(value: &str, start: usize, end: usize) -> String {
    value
        .chars()
        .skip(start)
        .take(end.saturating_sub(start))
        .collect()
}

fn find_shortcut(directories: &[PathBuf], name: &str) -> Result<Option<PathBuf>, String> {
    let expected = normalize_name(name);
    let mut pending = directories.to_vec();
    let mut depth = 0;
    while !pending.is_empty() && depth < 4 {
        let current = std::mem::take(&mut pending);
        for directory in current {
            let entries = match fs::read_dir(&directory) {
                Ok(entries) => entries,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => {
                    return Err(format!(
                        "could not inspect Start menu folder {}: {error}",
                        directory.display()
                    ));
                }
            };
            for entry in entries {
                let entry = entry.map_err(|error| {
                    format!(
                        "could not inspect an entry in {}: {error}",
                        directory.display()
                    )
                })?;
                let path = entry.path();
                if path.is_dir() {
                    pending.push(path);
                } else if path
                    .extension()
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("lnk"))
                    && path
                        .file_stem()
                        .and_then(|stem| stem.to_str())
                        .is_some_and(|stem| normalize_name(stem) == expected)
                {
                    return Ok(Some(path));
                }
            }
        }
        depth += 1;
    }
    Ok(None)
}

fn normalize_name(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn validate_package_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.starts_with('-')
        || !id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || ".-_+".contains(character))
    {
        return Err("Invalid package identifier.".to_string());
    }
    Ok(())
}

fn validate_winget_package(package_name: &str, source: &str) -> Result<(), String> {
    validate_package_id(package_name)?;
    if source.eq_ignore_ascii_case(WINGET_SOURCE) {
        Ok(())
    } else {
        Err(format!("Unsupported package source: {source}"))
    }
}

fn validate_winget_source(source: &str) -> Result<(), String> {
    if source.is_empty()
        || source.len() > 64
        || source.starts_with('-')
        || !source
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._-".contains(character))
    {
        return Err(format!("Unsupported package source: {source}"));
    }
    Ok(())
}

fn ensure_installed_package(package_id: &str) -> Result<(), String> {
    if list_installed_applications()?
        .iter()
        .any(|app| app.id.eq_ignore_ascii_case(package_id))
    {
        Ok(())
    } else {
        Err(format!(
            "WinGet no longer reports {package_id} as installed. Refresh the application list and try again."
        ))
    }
}

fn run_winget(arguments: &[&str]) -> Result<Output, String> {
    Command::new("winget")
        .args(arguments)
        .output()
        .map_err(|error| {
            format!(
                "WinGet is unavailable. Install or update 'App Installer' from Microsoft Store, then try again. ({error})"
            )
        })
}

fn successful_text(context: &str, output: &Output) -> Result<String, String> {
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if output.status.success() {
        return Ok(text);
    }
    let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if detail.is_empty() {
        format!("{context} failed with status {}.", output.status)
    } else {
        format!("{context} failed: {detail}")
    })
}

fn detect_package_managers() -> PackageManagerStatus {
    let winget = Command::new("winget")
        .arg("--version")
        .output()
        .is_ok_and(|output| output.status.success());
    PackageManagerStatus {
        winget,
        ..PackageManagerStatus::default()
    }
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_dashboard_data,
            scan_startup_entries,
            scan_running_processes,
            get_package_updates,
            get_package_cache_status,
            clean_package_cache,
            get_system_diagnostics,
            update_all_packages,
            search_package_catalog,
            install_flatpak_application,
            set_startup_entry_enabled,
            terminate_process,
            launch_application,
            perform_package_action,
            reinstall_package,
            update_package
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_winget_table_rows_with_optional_update_columns() {
        let output = concat!(
            "Name                          Id                  Version       Available     Source\n",
            "--------------------------------------------------------------------------------------\n",
            "Example Editor                Example.Editor      1.2.0         1.3.0         winget\n",
            "Reader                         Reader.App          4.0.0                       winget\n",
        );
        let rows = parse_winget_table(output).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].id, "Example.Editor");
        assert_eq!(rows[0].available, "1.3.0");
        assert_eq!(rows[1].source, "winget");
    }

    #[test]
    fn recognizes_empty_winget_results_without_hiding_unreadable_output() {
        assert!(
            parse_winget_table("No package found matching input criteria.")
                .unwrap()
                .is_empty()
        );
        assert!(parse_winget_table("WinGet failed unexpectedly").is_err());
    }

    #[test]
    fn rejects_package_ids_that_could_become_options_or_commands() {
        assert!(validate_package_id("Microsoft.VisualStudioCode").is_ok());
        assert!(validate_package_id("bad package").is_err());
        assert!(validate_package_id("-silent").is_err());
        assert!(validate_package_id("$(calc)").is_err());
    }
}
