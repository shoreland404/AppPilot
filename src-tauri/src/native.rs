use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
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
struct ParsedDesktopEntry {
    name: String,
    description: String,
    icon: Option<String>,
    categories: String,
    package_name: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PackageAction {
    Remove,
    Update,
}

const APT_SOURCE: &str = "APT";
const FLATPAK_SOURCE: &str = "Flatpak";
const SNAP_SOURCE: &str = "Snap";
const LOCAL_SOURCE: &str = "Local";
const SYSTEM_SOURCE: &str = "System";
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
    let applications = scan_applications()?;

    Ok(DashboardData {
        overview: AppOverview {
            installed_applications: applications.len(),
            startup_entries: None,
            running_processes: None,
            package_status: detect_package_managers(),
            platform: "linux".to_string(),
        },
        applications,
    })
}

#[tauri::command]
async fn scan_startup_entries() -> Result<Vec<StartupEntry>, String> {
    tauri::async_runtime::spawn_blocking(scan_startup_entries_impl)
        .await
        .map_err(|error| format!("startup inventory task failed: {error}"))?
}

fn scan_startup_entries_impl() -> Result<Vec<StartupEntry>, String> {
    let home =
        dirs::home_dir().ok_or_else(|| String::from("could not determine the home directory"))?;
    let directories = [
        home.join(".config/autostart"),
        PathBuf::from("/etc/xdg/autostart"),
    ];
    let mut entries = HashMap::new();
    let mut seen_files = HashSet::new();

    for directory in directories {
        if !directory.exists() {
            continue;
        }

        for path in desktop_files_in(&directory)? {
            let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            if !seen_files.insert(file_name.to_string()) {
                continue;
            }
            let Some(parsed) = parse_startup_entry(&path) else {
                continue;
            };

            if let Some((name, path, enabled)) = parsed {
                if !enabled && !is_user_startup_path(&path) {
                    continue;
                }
                let id = path
                    .strip_prefix(home.join(".config/autostart"))
                    .ok()
                    .and_then(Path::to_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| file_name.to_string());
                entries.insert(
                    id.clone(),
                    StartupEntry {
                        id,
                        name,
                        path: path.display().to_string(),
                        enabled,
                        can_manage: is_user_startup_path(&path),
                    },
                );
            }
        }
    }

    let mut result: Vec<StartupEntry> = entries.into_values().collect();
    result.sort_by_key(|entry| entry.name.to_lowercase());
    Ok(result)
}

#[tauri::command]
async fn scan_running_processes() -> Result<Vec<ProcessInfo>, String> {
    tauri::async_runtime::spawn_blocking(scan_running_processes_impl)
        .await
        .map_err(|error| format!("process inventory task failed: {error}"))?
}

fn scan_running_processes_impl() -> Result<Vec<ProcessInfo>, String> {
    let proc_directory = Path::new("/proc");
    let read_dir =
        fs::read_dir(proc_directory).map_err(|error| format!("could not read /proc: {error}"))?;
    let mut processes = Vec::new();
    let current_status = fs::read_to_string("/proc/self/status")
        .map_err(|error| format!("could not verify the current user: {error}"))?;
    let current_uid = effective_uid(&current_status)
        .ok_or_else(|| String::from("could not verify the current user"))?;

    for entry in read_dir {
        let entry = entry.map_err(|error| format!("could not inspect /proc entry: {error}"))?;
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|name| name.parse::<u32>().ok())
        else {
            continue;
        };
        let process_dir = entry.path();
        let Ok(status) = fs::read_to_string(process_dir.join("status")) else {
            continue;
        };

        let mut name = None;
        let mut memory_kb = 0;
        for line in status.lines() {
            if let Some(value) = line.strip_prefix("Name:") {
                name = Some(value.trim().to_string());
            } else if let Some(value) = line.strip_prefix("VmRSS:") {
                memory_kb = value
                    .split_whitespace()
                    .next()
                    .and_then(|amount| amount.parse::<u64>().ok())
                    .unwrap_or(0);
            }
        }
        let Some(name) = name.filter(|name| !name.is_empty()) else {
            continue;
        };
        let Some(owner_uid) = effective_uid(&status) else {
            continue;
        };

        processes.push(ProcessInfo {
            pid,
            name,
            memory_kb,
            can_terminate: owner_uid == current_uid && pid > 1 && pid != std::process::id(),
        });
    }

    processes.sort_by(|left, right| {
        right
            .memory_kb
            .cmp(&left.memory_kb)
            .then(left.name.cmp(&right.name))
    });
    Ok(processes)
}

fn terminate_process_impl(pid: u32) -> Result<String, String> {
    if pid <= 1 || pid == std::process::id() {
        return Err(String::from(
            "this process cannot be terminated by AppPilot",
        ));
    }
    let process_status = fs::read_to_string(format!("/proc/{pid}/status"))
        .map_err(|error| format!("process {pid} is no longer available: {error}"))?;
    let current_status = fs::read_to_string("/proc/self/status")
        .map_err(|error| format!("could not verify the current user: {error}"))?;
    let process_uid = effective_uid(&process_status)
        .ok_or_else(|| format!("could not verify ownership of process {pid}"))?;
    let current_uid = effective_uid(&current_status)
        .ok_or_else(|| String::from("could not verify the current user"))?;
    if process_uid != current_uid {
        return Err(String::from(
            "AppPilot can only stop processes owned by the current user",
        ));
    }

    let output = Command::new("kill")
        .args(["-TERM", "--", &pid.to_string()])
        .output()
        .map_err(|error| format!("could not send a termination signal: {error}"))?;
    ensure_success(&format!("terminating process {pid}"), &output)?;
    Ok(format!("Termination requested for process {pid}."))
}

fn effective_uid(status: &str) -> Option<u32> {
    status
        .lines()
        .find_map(|line| line.strip_prefix("Uid:"))?
        .split_whitespace()
        .nth(1)?
        .parse()
        .ok()
}

fn is_user_startup_path(path: &Path) -> bool {
    dirs::home_dir().is_some_and(|home| {
        let startup_directory = home.join(".config/autostart");
        path.parent() == Some(startup_directory.as_path())
    })
}

fn set_startup_entry_enabled_impl(id: String, enabled: bool) -> Result<String, String> {
    let home =
        dirs::home_dir().ok_or_else(|| String::from("could not determine the home directory"))?;
    let relative = Path::new(&id);
    if relative.as_os_str().is_empty()
        || relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
        || relative
            .extension()
            .and_then(|extension| extension.to_str())
            != Some("desktop")
    {
        return Err(String::from("invalid startup entry identifier"));
    }
    let path = home.join(".config/autostart").join(relative);
    let startup_directory = home.join(".config/autostart");
    if path.parent() != Some(startup_directory.as_path()) {
        return Err(String::from(
            "only startup entries directly inside the user autostart folder can be changed",
        ));
    }
    let metadata = fs::symlink_metadata(&path)
        .map_err(|error| format!("startup entry is no longer available: {error}"))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(String::from(
            "only regular user startup entries can be changed",
        ));
    }
    if !matches!(parse_startup_entry(&path), Some(Some(_))) {
        return Err(String::from(
            "the selected file is not a startup application",
        ));
    }

    let content = fs::read_to_string(&path)
        .map_err(|error| format!("could not read startup entry: {error}"))?;
    let updated = set_startup_desktop_enabled(&content, enabled)?;
    let temporary = path.with_extension(format!("desktop.{}.tmp", std::process::id()));
    let mut temporary_file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|error| format!("could not create a temporary startup entry: {error}"))?;
    if let Err(error) = temporary_file.write_all(updated.as_bytes()) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("could not write startup entry update: {error}"));
    }
    if let Err(error) = fs::set_permissions(&temporary, metadata.permissions()) {
        let _ = fs::remove_file(&temporary);
        return Err(format!(
            "could not preserve startup entry permissions: {error}"
        ));
    }
    drop(temporary_file);
    if let Err(error) = fs::rename(&temporary, &path) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("could not save startup entry update: {error}"));
    }
    Ok(format!(
        "Startup entry {} was {}.",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(""),
        if enabled { "enabled" } else { "disabled" }
    ))
}

fn set_startup_desktop_enabled(content: &str, enabled: bool) -> Result<String, String> {
    let mut lines: Vec<String> = content.lines().map(str::to_string).collect();
    let mut in_desktop_entry = false;
    let mut found_group = false;
    let mut hidden_found = false;
    let mut gnome_enabled_found = false;
    let mut insertion = None;

    for (index, line) in lines.iter_mut().enumerate() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            if in_desktop_entry {
                insertion = Some(index);
                break;
            }
            in_desktop_entry = trimmed == "[Desktop Entry]";
            found_group |= in_desktop_entry;
            continue;
        }
        if !in_desktop_entry {
            continue;
        }
        if let Some((key, _)) = trimmed.split_once('=') {
            match key {
                "Hidden" => {
                    *line = format!("Hidden={}", !enabled);
                    hidden_found = true;
                }
                "X-GNOME-Autostart-enabled" => {
                    *line = format!("X-GNOME-Autostart-enabled={enabled}");
                    gnome_enabled_found = true;
                }
                _ => {}
            }
        }
    }
    if !found_group {
        return Err(String::from(
            "startup entry does not contain a Desktop Entry group",
        ));
    }
    let insertion = insertion.unwrap_or(lines.len());
    let mut settings = Vec::new();
    if !hidden_found {
        settings.push(format!("Hidden={}", !enabled));
    }
    if !gnome_enabled_found {
        settings.push(format!("X-GNOME-Autostart-enabled={enabled}"));
    }
    for (offset, setting) in settings.into_iter().enumerate() {
        lines.insert(insertion + offset, setting);
    }
    Ok(format!("{}\n", lines.join("\n")))
}

#[tauri::command]
async fn get_package_updates() -> Result<Vec<PackageUpdate>, String> {
    tauri::async_runtime::spawn_blocking(get_package_updates_impl)
        .await
        .map_err(|error| format!("package update scan task failed: {error}"))?
}

fn get_package_updates_impl() -> Result<Vec<PackageUpdate>, String> {
    let managers = detect_package_managers();
    let mut updates = Vec::new();

    if managers.apt {
        let output = run_command("apt", &["list", "--upgradable"])?;
        ensure_success("APT update check", &output)?;
        let text = String::from_utf8_lossy(&output.stdout);

        for line in text.lines().skip(1) {
            let mut fields = line.split_whitespace();
            let Some(package_field) = fields.next() else {
                continue;
            };
            let Some(version) = fields.next() else {
                continue;
            };
            let package_name = package_field.split('/').next().unwrap_or(package_field);
            if valid_package_id(package_name) {
                updates.push(PackageUpdate {
                    package_name: package_name.to_string(),
                    name: package_name.to_string(),
                    source: APT_SOURCE.to_string(),
                    version: version.to_string(),
                });
            }
        }
    }

    if managers.flatpak {
        let output = run_command(
            "flatpak",
            &[
                "remote-ls",
                "--updates",
                "--columns=application,name,version",
            ],
        )?;
        ensure_success("Flatpak update check", &output)?;
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            let fields: Vec<&str> = line.split('\t').collect();
            if fields.len() >= 3 && valid_package_id(fields[0].trim()) {
                updates.push(PackageUpdate {
                    package_name: fields[0].trim().to_string(),
                    name: fields[1].trim().to_string(),
                    source: FLATPAK_SOURCE.to_string(),
                    version: fields[2].trim().to_string(),
                });
            }
        }
    }

    if managers.snap {
        let output = run_command("snap", &["refresh", "--list"])?;
        ensure_success("Snap update check", &output)?;
        for line in String::from_utf8_lossy(&output.stdout).lines().skip(1) {
            let fields: Vec<&str> = line.split_whitespace().collect();
            if fields.len() >= 2 && valid_package_id(fields[0]) {
                updates.push(PackageUpdate {
                    package_name: fields[0].to_string(),
                    name: fields[0].to_string(),
                    source: SNAP_SOURCE.to_string(),
                    version: fields[1].to_string(),
                });
            }
        }
    }

    updates.sort_by_key(|update| update.name.to_lowercase());
    Ok(updates)
}

#[tauri::command]
async fn list_flatpak_catalog() -> Result<Vec<FlatpakCatalogEntry>, String> {
    tauri::async_runtime::spawn_blocking(list_flatpak_catalog_impl)
        .await
        .map_err(|error| format!("Flatpak catalogue task failed: {error}"))?
}

fn list_flatpak_catalog_impl() -> Result<Vec<FlatpakCatalogEntry>, String> {
    let managers = detect_package_managers();
    if !managers.flatpak {
        return Err(String::from(
            "Flatpak is not installed. Install Flatpak and configure a remote to discover applications.",
        ));
    }

    let installed = flatpak_installations(&managers)?;
    let mut catalog = Vec::new();
    for scope in ["system", "user"] {
        let output = run_command(
            "flatpak",
            &[
                "remote-ls",
                if scope == "system" {
                    "--system"
                } else {
                    "--user"
                },
                "--app",
                "--columns=application,name,description,version,origin",
            ],
        )?;
        ensure_success("Flatpak application catalogue", &output)?;
        catalog.extend(parse_flatpak_catalog(
            &String::from_utf8_lossy(&output.stdout),
            scope,
            &installed,
        ));
    }

    catalog.sort_by(|left, right| {
        left.name
            .to_lowercase()
            .cmp(&right.name.to_lowercase())
            .then(left.app_id.cmp(&right.app_id))
            .then(left.scope.cmp(&right.scope))
    });
    Ok(catalog)
}

#[tauri::command]
async fn search_package_catalog(query: String) -> Result<Vec<FlatpakCatalogEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || search_package_catalog_impl(query))
        .await
        .map_err(|error| format!("application search task failed: {error}"))?
}

fn search_package_catalog_impl(query: String) -> Result<Vec<FlatpakCatalogEntry>, String> {
    let query = query.trim().to_lowercase();
    let mut catalog = list_flatpak_catalog_impl()?;
    if !query.is_empty() {
        catalog.retain(|entry| {
            entry.name.to_lowercase().contains(&query)
                || entry.app_id.to_lowercase().contains(&query)
                || entry.description.to_lowercase().contains(&query)
        });
    }
    Ok(catalog)
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

    let apt_packages: Vec<&str> = updates
        .iter()
        .filter(|update| update.source == APT_SOURCE)
        .map(|update| update.package_name.as_str())
        .collect();
    if !apt_packages.is_empty() {
        let mut arguments = vec!["apt-get", "install", "--only-upgrade", "-y", "--"];
        arguments.extend(apt_packages);
        run_privileged_command("pkexec", &arguments)?;
    }

    let flatpak_updates: Vec<&PackageUpdate> = updates
        .iter()
        .filter(|update| update.source == FLATPAK_SOURCE)
        .collect();
    if !flatpak_updates.is_empty() {
        let installed = flatpak_installations(&detect_package_managers())?;
        for scope in ["system", "user"] {
            let package_ids: Vec<&str> = flatpak_updates
                .iter()
                .filter(|update| {
                    flatpak_scope_for(&installed, &update.package_name).as_deref() == Some(scope)
                })
                .map(|update| update.package_name.as_str())
                .collect();
            if package_ids.is_empty() {
                continue;
            }
            let mut arguments = vec!["update"];
            arguments.push(if scope == "system" {
                "--system"
            } else {
                "--user"
            });
            arguments.push("--assumeyes");
            arguments.extend(package_ids);
            if scope == "system" {
                let mut privileged_arguments = vec!["flatpak"];
                privileged_arguments.extend(arguments);
                run_privileged_command("pkexec", &privileged_arguments)?;
            } else {
                let output = Command::new("flatpak")
                    .args(&arguments)
                    .output()
                    .map_err(|error| format!("could not start Flatpak updates: {error}"))?;
                ensure_success("Flatpak bulk update", &output)?;
            }
        }
    }

    let snap_packages: Vec<&str> = updates
        .iter()
        .filter(|update| update.source == SNAP_SOURCE)
        .map(|update| update.package_name.as_str())
        .collect();
    if !snap_packages.is_empty() {
        let mut arguments = vec!["snap", "refresh"];
        arguments.extend(snap_packages);
        run_privileged_command("pkexec", &arguments)?;
    }

    invalidate_application_cache()?;
    Ok(updates
        .iter()
        .map(|update| format!("{} ({})", update.name, update.source))
        .collect())
}

#[tauri::command]
async fn install_flatpak_application(
    app_id: String,
    remote: String,
    scope: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        install_flatpak_application_impl(app_id, remote, scope)
    })
    .await
    .map_err(|error| format!("Flatpak installation task failed: {error}"))?
}

fn install_flatpak_application_impl(
    app_id: String,
    remote: String,
    scope: String,
) -> Result<String, String> {
    if !valid_package_id(&app_id) || !valid_package_id(&remote) {
        return Err(String::from(
            "invalid Flatpak application or remote identifier",
        ));
    }
    if !matches!(scope.as_str(), "system" | "user") {
        return Err(String::from("invalid Flatpak installation scope"));
    }

    let catalog = list_flatpak_catalog_impl()?;
    let app = catalog
        .iter()
        .find(|entry| entry.app_id == app_id && entry.remote == remote && entry.scope == scope)
        .ok_or_else(|| {
            String::from(
                "this application is no longer available from the selected Flatpak remote; refresh the catalogue",
            )
        })?;
    if app.installed {
        return Err(format!("{} is already installed.", app.name));
    }

    let arguments = [
        "install",
        if scope == "system" {
            "--system"
        } else {
            "--user"
        },
        "--assumeyes",
        remote.as_str(),
        app_id.as_str(),
    ];
    if scope == "system" {
        if !detect_package_managers().pkexec {
            return Err(String::from(
                "pkexec is required to authorize system Flatpak installations.",
            ));
        }
        let mut privileged_arguments = vec!["flatpak"];
        privileged_arguments.extend(arguments);
        run_privileged_command("pkexec", &privileged_arguments)?;
    } else {
        let output = Command::new("flatpak")
            .args(arguments)
            .output()
            .map_err(|error| format!("could not install the Flatpak application: {error}"))?;
        ensure_success("Flatpak application installation", &output)?;
    }

    invalidate_application_cache()?;
    Ok(format!("{} was installed successfully.", app.name))
}

#[tauri::command]
async fn set_startup_entry_enabled(id: String, enabled: bool) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || set_startup_entry_enabled_impl(id, enabled))
        .await
        .map_err(|error| format!("startup settings task failed: {error}"))?
}

#[tauri::command]
async fn terminate_process(pid: u32) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || terminate_process_impl(pid))
        .await
        .map_err(|error| format!("process action task failed: {error}"))?
}

#[tauri::command]
async fn launch_application(app_id: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || launch_application_impl(app_id))
        .await
        .map_err(|error| format!("application launch task failed: {error}"))?
}

fn launch_application_impl(app_id: String) -> Result<String, String> {
    let path = PathBuf::from(&app_id);
    if !path.is_absolute()
        || !path.is_file()
        || !desktop_search_directories()
            .iter()
            .any(|directory| path.starts_with(directory))
    {
        return Err(String::from(
            "application launcher is no longer available; refresh the list and try again",
        ));
    }
    let parsed = parse_desktop_file(&path).ok_or_else(|| {
        String::from("application launcher is no longer a visible desktop application")
    })?;
    let output = Command::new("gio")
        .arg("launch")
        .arg(&path)
        .output()
        .map_err(|error| format!("could not start the desktop launcher: {error}"))?;
    ensure_success(&format!("launching {}", parsed.name), &output)?;
    Ok(format!("{} started.", parsed.name))
}

#[tauri::command]
async fn perform_package_action(app_id: String, action: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || perform_package_action_impl(app_id, action))
        .await
        .map_err(|error| format!("package action task failed: {error}"))?
}

fn perform_package_action_impl(app_id: String, action: String) -> Result<String, String> {
    let action = match action.as_str() {
        "remove" => PackageAction::Remove,
        _ => {
            return Err(String::from(
                "only removal is supported through this action",
            ))
        }
    };
    let app = scan_applications_uncached()?
        .into_iter()
        .find(|entry| entry.id == app_id)
        .ok_or_else(|| {
            String::from("application is no longer installed; refresh the list and try again")
        })?;
    let package_name = app
        .package_name
        .as_deref()
        .filter(|name| valid_package_id(name))
        .ok_or_else(|| {
            format!(
                "AppPilot cannot safely identify the package for {}.",
                app.name
            )
        })?;

    match app.source.as_str() {
        APT_SOURCE => run_apt_action(package_name, action)?,
        FLATPAK_SOURCE => run_flatpak_action(package_name, app.package_scope.as_deref(), action)?,
        SNAP_SOURCE => run_snap_action(package_name, action)?,
        source => {
            return Err(format!(
                "package operations are not supported for {source} applications"
            ))
        }
    }

    invalidate_application_cache()?;
    Ok(format!("{} was removed successfully.", app.name))
}

#[tauri::command]
async fn update_package(package_name: String, source: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || update_package_impl(package_name, source))
        .await
        .map_err(|error| format!("package update task failed: {error}"))?
}

fn update_package_impl(package_name: String, source: String) -> Result<String, String> {
    if !valid_package_id(&package_name) {
        return Err(String::from("invalid package identifier"));
    }
    let update = get_package_updates_impl()?
        .into_iter()
        .find(|update| update.package_name == package_name && update.source == source)
        .ok_or_else(|| {
            String::from(
                "this package is not currently reported as upgradable; refresh the update list",
            )
        })?;

    match source.as_str() {
        APT_SOURCE => run_apt_action(&package_name, PackageAction::Update)?,
        FLATPAK_SOURCE => {
            let installed = flatpak_installations(&detect_package_managers())?;
            let scope = flatpak_scope_for(&installed, &package_name).ok_or_else(|| {
                String::from("Flatpak no longer reports this application as installed")
            })?;
            run_flatpak_action(&package_name, Some(&scope), PackageAction::Update)?;
        }
        SNAP_SOURCE => run_snap_action(&package_name, PackageAction::Update)?,
        _ => return Err(format!("updates from {source} are not supported")),
    }
    invalidate_application_cache()?;
    Ok(format!(
        "{} was updated to {}.",
        update.name, update.version
    ))
}

fn run_apt_action(package_name: &str, action: PackageAction) -> Result<(), String> {
    let managers = detect_package_managers();
    if !managers.apt {
        return Err(String::from("APT is not available on this system."));
    }
    if !managers.pkexec {
        return Err(String::from(
            "pkexec is required to authorize APT package operations.",
        ));
    }

    let arguments = match action {
        PackageAction::Remove => vec!["apt-get", "remove", "-y", "--", package_name],
        PackageAction::Update => vec![
            "apt-get",
            "install",
            "--only-upgrade",
            "-y",
            "--",
            package_name,
        ],
    };
    run_privileged_command("pkexec", &arguments)
}

fn run_flatpak_action(
    package_name: &str,
    scope: Option<&str>,
    action: PackageAction,
) -> Result<(), String> {
    let scope =
        scope.ok_or_else(|| String::from("Flatpak installation scope could not be verified."))?;
    let mut arguments = match action {
        PackageAction::Remove => vec!["uninstall"],
        PackageAction::Update => vec!["update"],
    };
    let privileged;
    if scope == "system" {
        privileged = true;
        arguments.push("--system");
    } else if scope == "user" {
        privileged = false;
        arguments.push("--user");
    } else {
        return Err(String::from(
            "Flatpak reported an unknown installation scope.",
        ));
    }
    arguments.extend(["--assumeyes", package_name]);

    if privileged {
        let managers = detect_package_managers();
        if !managers.pkexec {
            return Err(String::from(
                "pkexec is required to authorize system Flatpak operations.",
            ));
        }
        let mut command = vec!["flatpak"];
        command.extend(arguments);
        run_privileged_command("pkexec", &command)
    } else {
        let output = Command::new("flatpak")
            .args(&arguments)
            .output()
            .map_err(|error| format!("could not start Flatpak: {error}"))?;
        ensure_success("Flatpak package operation", &output)
    }
}

fn run_snap_action(package_name: &str, action: PackageAction) -> Result<(), String> {
    let managers = detect_package_managers();
    if !managers.snap {
        return Err(String::from("Snap is not available on this system."));
    }
    if !managers.pkexec {
        return Err(String::from(
            "pkexec is required to authorize Snap package operations.",
        ));
    }
    let verb = match action {
        PackageAction::Remove => "remove",
        PackageAction::Update => "refresh",
    };
    run_privileged_command("pkexec", &["snap", verb, package_name])
}

fn run_privileged_command(program: &str, arguments: &[&str]) -> Result<(), String> {
    let output = Command::new(program)
        .args(arguments)
        .output()
        .map_err(|error| format!("could not start {program}: {error}"))?;
    ensure_success(program, &output)
}

fn ensure_success(context: &str, output: &Output) -> Result<(), String> {
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let detail = if !stderr.is_empty() { stderr } else { stdout };
    if detail.is_empty() {
        Err(format!(
            "{context} failed with exit status {}.",
            output.status
        ))
    } else {
        Err(format!("{context} failed: {detail}"))
    }
}

fn scan_applications() -> Result<Vec<AppRecord>, String> {
    let cache = APPLICATION_CACHE.get_or_init(|| Mutex::new(None));
    let mut cached = cache
        .lock()
        .map_err(|error| format!("application inventory cache is unavailable: {error}"))?;
    if let Some((created, applications)) = cached.as_ref() {
        if created.elapsed() < APPLICATION_CACHE_TTL {
            return Ok(applications.clone());
        }
    }

    let applications = scan_applications_uncached()?;
    *cached = Some((Instant::now(), applications.clone()));
    Ok(applications)
}

fn invalidate_application_cache() -> Result<(), String> {
    if let Some(cache) = APPLICATION_CACHE.get() {
        *cache
            .lock()
            .map_err(|error| format!("application inventory cache is unavailable: {error}"))? =
            None;
    }
    Ok(())
}

fn scan_applications_uncached() -> Result<Vec<AppRecord>, String> {
    let managers = detect_package_managers();
    let flatpak_apps = flatpak_installations(&managers)?;
    let snap_apps = snap_packages(&managers)?;
    let mut registry = HashMap::new();
    let mut candidates = Vec::new();

    for directory in desktop_search_directories() {
        if !directory.exists() {
            continue;
        }
        for path in desktop_files_in(&directory)? {
            let Some(parsed) = parse_desktop_file(&path) else {
                continue;
            };
            let Some(desktop_id) = desktop_id_for_path(&directory, &path) else {
                continue;
            };
            candidates.push((desktop_id, path, parsed));
        }
    }

    let system_paths: Vec<PathBuf> = candidates
        .iter()
        .filter(|(_, path, _)| is_system_desktop_path(path))
        .map(|(_, path, _)| path.clone())
        .collect();
    let dpkg_owners = dpkg_packages_for_paths(&system_paths);

    for (desktop_id, path, parsed) in candidates {
        if registry.contains_key(&desktop_id) {
            continue;
        }
        let dpkg_owner = dpkg_owners.get(&path).cloned();
        let flatpak_id = parsed
            .package_name
            .clone()
            .filter(|name| flatpak_apps.iter().any(|(app_id, _)| app_id == name))
            .or_else(|| {
                flatpak_apps
                    .iter()
                    .any(|(app_id, _)| app_id == &desktop_id)
                    .then(|| desktop_id.clone())
            });
        let snap_id = parsed
            .package_name
            .clone()
            .filter(|name| snap_apps.contains(name))
            .or_else(|| snap_apps.contains(&desktop_id).then(|| desktop_id.clone()));

        let (source, package_name, package_scope) = if let Some(package) = dpkg_owner {
            (APT_SOURCE, Some(package), None)
        } else if let Some(package) = flatpak_id {
            (
                FLATPAK_SOURCE,
                Some(package.clone()),
                flatpak_scope_for(&flatpak_apps, &package),
            )
        } else if let Some(package) = snap_id {
            (SNAP_SOURCE, Some(package), None)
        } else if is_user_desktop_path(&path) {
            (LOCAL_SOURCE, None, None)
        } else {
            (SYSTEM_SOURCE, None, None)
        };

        registry.insert(
            desktop_id,
            AppRecord {
                id: path.display().to_string(),
                name: parsed.name,
                description: parsed.description,
                source: source.to_string(),
                icon: parsed.icon,
                installed: true,
                package_name,
                category: parsed.categories,
                path: path.display().to_string(),
                package_scope,
            },
        );
    }

    let mut apps: Vec<AppRecord> = registry.into_values().collect();
    apps.sort_by_key(|app| app.name.to_lowercase());
    Ok(apps)
}

fn parse_desktop_file(path: &Path) -> Option<ParsedDesktopEntry> {
    let content = fs::read_to_string(path).ok()?;
    let mut in_desktop_entry = false;
    let mut has_desktop_entry = false;
    let mut name = None;
    let mut description = String::new();
    let mut icon = None;
    let mut categories = String::new();
    let mut flatpak_id = None;
    let mut snap_id = None;
    let mut hidden = false;
    let mut no_display = false;
    let mut is_application = false;

    for raw_line in content.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line.starts_with('[') && line.ends_with(']') {
            in_desktop_entry = line == "[Desktop Entry]";
            has_desktop_entry |= in_desktop_entry;
            continue;
        }
        if !in_desktop_entry {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let value = value.trim();
        match key.trim() {
            "Type" => is_application = value == "Application",
            "Name" => name = Some(unescape_desktop_value(value)),
            "Comment" => description = unescape_desktop_value(value),
            "Icon" => icon = Some(unescape_desktop_value(value)),
            "Categories" => {
                categories = value
                    .split(';')
                    .filter(|item| !item.is_empty())
                    .collect::<Vec<_>>()
                    .join(", ")
            }
            "Hidden" => hidden = value.eq_ignore_ascii_case("true"),
            "NoDisplay" => no_display = value.eq_ignore_ascii_case("true"),
            "X-Flatpak" => flatpak_id = Some(value.to_string()),
            "X-SnapInstanceName" => snap_id = Some(value.to_string()),
            _ => {}
        }
    }

    if !has_desktop_entry || !is_application || hidden || no_display {
        return None;
    }
    let name = name?.trim().to_string();
    if name.is_empty() {
        return None;
    }

    Some(ParsedDesktopEntry {
        name,
        description,
        icon,
        categories,
        package_name: flatpak_id.or(snap_id),
    })
}

fn parse_startup_entry(path: &Path) -> Option<Option<(String, PathBuf, bool)>> {
    let content = fs::read_to_string(path).ok()?;
    let mut in_desktop_entry = false;
    let mut is_application = false;
    let mut name = None;
    let mut hidden = false;
    let mut enabled = true;

    for raw_line in content.lines() {
        let line = raw_line.trim();
        if line.starts_with('[') && line.ends_with(']') {
            in_desktop_entry = line == "[Desktop Entry]";
            continue;
        }
        if !in_desktop_entry {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let value = value.trim();
        match key.trim() {
            "Type" => is_application = value == "Application",
            "Name" => name = Some(unescape_desktop_value(value)),
            "Hidden" => hidden = value.eq_ignore_ascii_case("true"),
            "X-GNOME-Autostart-enabled" => enabled = !value.eq_ignore_ascii_case("false"),
            _ => {}
        }
    }

    if !is_application {
        return None;
    }
    Some(Some((
        name?.trim().to_string(),
        path.to_path_buf(),
        !hidden && enabled,
    )))
}

fn desktop_files_in(directory: &Path) -> Result<Vec<PathBuf>, String> {
    let mut pending = vec![directory.to_path_buf()];
    let mut files = Vec::new();
    while let Some(current) = pending.pop() {
        let entries = fs::read_dir(&current)
            .map_err(|error| format!("could not read {}: {error}", current.display()))?;
        for entry in entries {
            let entry = entry
                .map_err(|error| format!("could not inspect {}: {error}", current.display()))?;
            let file_type = entry.file_type().map_err(|error| {
                format!("could not inspect {}: {error}", entry.path().display())
            })?;
            if file_type.is_dir() {
                pending.push(entry.path());
            } else if (file_type.is_file() || (file_type.is_symlink() && entry.path().is_file()))
                && entry
                    .path()
                    .extension()
                    .and_then(|extension| extension.to_str())
                    == Some("desktop")
            {
                files.push(entry.path());
            }
        }
    }
    files.sort();
    Ok(files)
}

fn desktop_id_for_path(directory: &Path, path: &Path) -> Option<String> {
    let relative = path.strip_prefix(directory).ok()?.to_str()?;
    Some(
        relative
            .replace('/', "-")
            .strip_suffix(".desktop")?
            .to_string(),
    )
}

fn desktop_search_directories() -> Vec<PathBuf> {
    let mut directories = Vec::new();
    if let Some(home) = dirs::home_dir() {
        let data_home = std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".local/share"));
        directories.push(data_home.join("applications"));
        directories.push(data_home.join("flatpak/exports/share/applications"));
        directories.push(home.join(".local/share/flatpak/exports/share/applications"));
    }
    directories.push(PathBuf::from("/var/lib/flatpak/exports/share/applications"));
    directories.push(PathBuf::from("/var/lib/snapd/desktop/applications"));

    let data_dirs = std::env::var("XDG_DATA_DIRS")
        .unwrap_or_else(|_| String::from("/usr/local/share:/usr/share"));
    directories.extend(
        data_dirs
            .split(':')
            .filter(|path| !path.is_empty())
            .map(|path| Path::new(path).join("applications")),
    );
    directories
}

fn is_system_desktop_path(path: &Path) -> bool {
    path.starts_with("/usr") || path.starts_with("/var")
}

fn is_user_desktop_path(path: &Path) -> bool {
    dirs::home_dir().is_some_and(|home| path.starts_with(home))
}

fn dpkg_packages_for_paths(paths: &[PathBuf]) -> HashMap<PathBuf, String> {
    let mut owners = HashMap::new();
    for chunk in paths.chunks(128) {
        let Ok(output) = Command::new("dpkg-query")
            .arg("--search")
            .args(chunk)
            .output()
        else {
            break;
        };
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            if let Some((path, package)) = parse_dpkg_owner_line(line) {
                owners.insert(path, package);
            }
        }
    }
    owners
}

fn parse_dpkg_owner_line(line: &str) -> Option<(PathBuf, String)> {
    let (package_field, path_field) = line.split_once(": ")?;
    let package = package_field
        .split(',')
        .map(str::trim)
        .find(|package| valid_package_id(package))?;
    Some((PathBuf::from(path_field.trim()), package.to_string()))
}

fn flatpak_installations(
    managers: &PackageManagerStatus,
) -> Result<HashSet<(String, String)>, String> {
    let mut apps = HashSet::new();
    if !managers.flatpak {
        return Ok(HashSet::new());
    }
    let output = Command::new("flatpak")
        .args(["list", "--app", "--columns=application,installation"])
        .output()
        .map_err(|error| format!("could not inspect installed Flatpak applications: {error}"))?;
    ensure_success("Flatpak application inventory", &output)?;
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let mut fields = line.split('\t');
        if let (Some(app_id), Some(scope)) = (fields.next(), fields.next()) {
            let app_id = app_id.trim();
            let scope = scope.trim();
            if valid_package_id(app_id) && matches!(scope, "user" | "system") {
                apps.insert((app_id.to_string(), scope.to_string()));
            }
        }
    }
    Ok(apps)
}

fn parse_flatpak_catalog(
    output: &str,
    scope: &str,
    installed: &HashSet<(String, String)>,
) -> Vec<FlatpakCatalogEntry> {
    output
        .lines()
        .filter_map(|line| {
            let fields: Vec<&str> = line.split('\t').collect();
            if fields.len() < 5 {
                return None;
            }
            let app_id = fields[0].trim();
            let name = fields[1].trim();
            let remote = fields[4].trim();
            if !valid_package_id(app_id)
                || name.is_empty()
                || !valid_package_id(remote)
                || !matches!(scope, "user" | "system")
            {
                return None;
            }

            Some(FlatpakCatalogEntry {
                app_id: app_id.to_string(),
                name: name.to_string(),
                description: fields[2].trim().to_string(),
                version: fields[3].trim().to_string(),
                remote: remote.to_string(),
                scope: scope.to_string(),
                installed: installed.contains(&(app_id.to_string(), scope.to_string())),
            })
        })
        .collect()
}

fn flatpak_scope_for(installed: &HashSet<(String, String)>, app_id: &str) -> Option<String> {
    ["system", "user"]
        .into_iter()
        .find(|scope| installed.contains(&(app_id.to_string(), (*scope).to_string())))
        .map(str::to_string)
}

fn snap_packages(managers: &PackageManagerStatus) -> Result<HashSet<String>, String> {
    let mut apps = HashSet::new();
    if !managers.snap {
        return Ok(apps);
    }
    let output = Command::new("snap")
        .args(["list"])
        .output()
        .map_err(|error| format!("could not inspect installed Snap applications: {error}"))?;
    ensure_success("Snap application inventory", &output)?;
    for line in String::from_utf8_lossy(&output.stdout).lines().skip(1) {
        if let Some(package) = line
            .split_whitespace()
            .next()
            .filter(|name| valid_package_id(name))
        {
            apps.insert(package.to_string());
        }
    }
    Ok(apps)
}

fn detect_package_managers() -> PackageManagerStatus {
    PackageManagerStatus {
        apt: executable_in_path("apt"),
        flatpak: executable_in_path("flatpak"),
        snap: executable_in_path("snap"),
        pkexec: executable_in_path("pkexec"),
        winget: false,
    }
}

fn executable_in_path(name: &str) -> bool {
    std::env::var_os("PATH")
        .into_iter()
        .flat_map(|paths| std::env::split_paths(&paths).collect::<Vec<_>>())
        .any(|directory| directory.join(name).is_file())
}

fn run_command(program: &str, arguments: &[&str]) -> Result<Output, String> {
    Command::new(program)
        .args(arguments)
        .output()
        .map_err(|error| format!("could not run {program}: {error}"))
}

fn valid_package_id(package_name: &str) -> bool {
    let mut characters = package_name.chars();
    characters
        .next()
        .is_some_and(|character| character.is_ascii_alphanumeric())
        && characters
            .all(|character| character.is_ascii_alphanumeric() || ".+_-".contains(character))
}

fn unescape_desktop_value(value: &str) -> String {
    value
        .replace("\\n", " ")
        .replace("\\s", " ")
        .replace("\\t", "\t")
        .replace("\\r", "\r")
        .replace("\\\\", "\\")
        .trim()
        .to_string()
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_dashboard_data,
            scan_startup_entries,
            scan_running_processes,
            get_package_updates,
            update_all_packages,
            list_flatpak_catalog,
            search_package_catalog,
            install_flatpak_application,
            set_startup_entry_enabled,
            terminate_process,
            launch_application,
            perform_package_action,
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
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temporary_directory() -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("apppilot-test-{nonce}"));
        fs::create_dir_all(&directory).unwrap();
        directory
    }

    #[test]
    fn validates_package_identifiers_without_shell_interpretation() {
        assert!(valid_package_id("firefox"));
        assert!(valid_package_id("org.mozilla.firefox"));
        assert!(valid_package_id("libexample++"));
        assert!(!valid_package_id(""));
        assert!(!valid_package_id("bad package"));
        assert!(!valid_package_id("$(touch /tmp/unsafe)"));
        assert!(!valid_package_id("-leading-option"));
    }

    #[test]
    fn parses_flatpak_catalog_entries_and_install_scope() {
        let installed = HashSet::from([(String::from("org.example.Editor"), String::from("user"))]);
        let output = concat!(
            "org.example.Editor\tExample Editor\tA code editor\t1.2.3\tflathub\n",
            "org.example.Reader\tExample Reader\t\t2.0\tflathub\n",
            "invalid app\tIgnored\tDescription\t1\tflathub\n",
            "org.example.BadRemote\tIgnored\tDescription\t1\tbad remote\n",
        );

        let entries = parse_flatpak_catalog(output, "user", &installed);
        assert_eq!(entries.len(), 2);
        assert!(entries[0].installed);
        assert_eq!(entries[0].scope, "user");
        assert_eq!(entries[1].description, "");
        assert!(!entries[1].installed);
        assert!(parse_flatpak_catalog(output, "invalid", &installed).is_empty());
    }

    #[test]
    fn parses_batched_dpkg_ownership_lines() {
        assert_eq!(
            parse_dpkg_owner_line(
                "desktop-package, second-package: /usr/share/applications/editor.desktop"
            ),
            Some((
                PathBuf::from("/usr/share/applications/editor.desktop"),
                String::from("desktop-package")
            ))
        );
        assert_eq!(
            parse_dpkg_owner_line("unknown: no path"),
            Some((PathBuf::from("no path"), String::from("unknown")))
        );
        assert!(parse_dpkg_owner_line("line without a separator").is_none());
        assert!(parse_dpkg_owner_line("bad package!: /tmp/app.desktop").is_none());
    }

    #[test]
    fn toggles_startup_desktop_flags_without_changing_other_groups() {
        let content = concat!(
            "[Desktop Entry]\n",
            "Type=Application\n",
            "Name=Sample\n",
            "Hidden=true\n",
            "X-GNOME-Autostart-enabled=false\n",
            "\n[Desktop Action Open]\n",
            "Name=Open\n",
        );
        let enabled = set_startup_desktop_enabled(content, true).unwrap();
        assert!(enabled.contains("Hidden=false\n"));
        assert!(enabled.contains("X-GNOME-Autostart-enabled=true\n"));
        assert!(enabled.contains("[Desktop Action Open]\nName=Open\n"));

        let disabled =
            set_startup_desktop_enabled("[Desktop Entry]\nType=Application\n", false).unwrap();
        assert!(disabled.contains("Hidden=true\n"));
        assert!(disabled.contains("X-GNOME-Autostart-enabled=false\n"));
        assert!(set_startup_desktop_enabled("[Desktop Action Open]\nName=Open\n", false).is_err());
    }

    #[test]
    fn reads_effective_user_ids_from_proc_status() {
        let status = "Name:\tapp\nUid:\t1000\t1001\t1002\t1003\n";
        assert_eq!(effective_uid(status), Some(1001));
        assert_eq!(effective_uid("Name:\tapp\n"), None);
    }

    #[test]
    fn chooses_system_scope_when_an_application_is_installed_twice() {
        let installed = HashSet::from([
            (String::from("org.example.App"), String::from("user")),
            (String::from("org.example.App"), String::from("system")),
        ]);
        assert_eq!(
            flatpak_scope_for(&installed, "org.example.App").as_deref(),
            Some("system")
        );
    }

    #[test]
    fn desktop_parser_only_reads_the_default_application_group() {
        let directory = temporary_directory();
        let path = directory.join("visible.desktop");
        fs::write(
      &path,
      "[Desktop Entry]\nType=Application\nName=Visible App\nComment=Example\\nDescription\nIcon=firefox\nCategories=Utility;Development;\nExec=ignored\n\n[Desktop Action NewWindow]\nName=Wrong Name\n",
    )
    .unwrap();
        let parsed = parse_desktop_file(&path).unwrap();
        assert_eq!(parsed.name, "Visible App");
        assert_eq!(parsed.description, "Example Description");
        assert_eq!(parsed.categories, "Utility, Development");
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn desktop_parser_ignores_hidden_nodisplay_and_non_application_entries() {
        let directory = temporary_directory();
        for (file, flags) in [
            ("hidden", "Hidden=true"),
            ("nodisplay", "NoDisplay=true"),
            ("link", "Type=Link"),
        ] {
            let path = directory.join(format!("{file}.desktop"));
            fs::write(
                &path,
                format!("[Desktop Entry]\nType=Application\nName=Entry\n{flags}\n"),
            )
            .unwrap();
            assert!(parse_desktop_file(&path).is_none());
        }
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn recursive_desktop_file_scanner_includes_desktop_symlinks_without_following_directories() {
        let directory = temporary_directory();
        let nested = directory.join("nested");
        fs::create_dir_all(&nested).unwrap();
        let file = nested.join("app.desktop");
        fs::write(&file, "[Desktop Entry]\nType=Application\nName=Nested\n").unwrap();
        let symlink = directory.join("linked.desktop");
        std::os::unix::fs::symlink(&file, &symlink).unwrap();
        let files = desktop_files_in(&directory).unwrap();
        assert_eq!(files, vec![symlink, file]);
        assert_eq!(
            desktop_id_for_path(&directory, &nested.join("org.example.App.desktop")),
            Some(String::from("nested-org.example.App"))
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn parses_enabled_and_disabled_startup_entries() {
        let directory = temporary_directory();
        let enabled = directory.join("enabled.desktop");
        let disabled = directory.join("disabled.desktop");
        fs::write(
            &enabled,
            "[Desktop Entry]\nType=Application\nName=Enabled\n",
        )
        .unwrap();
        fs::write(
            &disabled,
            "[Desktop Entry]\nType=Application\nName=Disabled\nX-GNOME-Autostart-enabled=false\n",
        )
        .unwrap();
        assert_eq!(parse_startup_entry(&enabled).unwrap().unwrap().0, "Enabled");
        assert!(parse_startup_entry(&enabled).unwrap().unwrap().2);
        assert!(!parse_startup_entry(&disabled).unwrap().unwrap().2);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn package_update_output_contains_only_valid_identifiers() {
        assert!(valid_package_id("com.example.App"));
        assert!(!valid_package_id("com.example.App; rm -rf /"));
    }
}
