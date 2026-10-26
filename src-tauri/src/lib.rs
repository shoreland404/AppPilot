use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

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
  pub exec: Option<String>,
  pub category: String,
  pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PackageManagerStatus {
  pub apt: bool,
  pub flatpak: bool,
  pub snap: bool,
  pub pkexec: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AppOverview {
  pub discovered: usize,
  pub installed: usize,
  pub updates: usize,
  pub startup_entries: usize,
  pub running_processes: usize,
  pub package_status: PackageManagerStatus,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProcessInfo {
  pub pid: u32,
  pub name: String,
  pub cpu: f32,
  pub memory: f32,
  pub command: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StartupEntry {
  pub id: String,
  pub name: String,
  pub path: String,
}

const APT_SOURCE: &str = "APT";
const FLATPAK_SOURCE: &str = "Flatpak";
const SNAP_SOURCE: &str = "Snap";
const UNKNOWN_SOURCE: &str = "Local";

#[tauri::command]
pub fn get_app_overview() -> Result<AppOverview, String> {
  let apps = scan_applications()?;
  let package_status = detect_package_managers();
  let startup_entries = scan_startup_entries()?;
  let running = scan_running_processes()?;
  let updates = detect_updates(&package_status)?;

  Ok(AppOverview {
    discovered: apps.len(),
    installed: apps.iter().filter(|app| app.installed).count(),
    updates,
    startup_entries: startup_entries.len(),
    running_processes: running.len(),
    package_status,
  })
}

#[tauri::command]
pub fn refresh_applications() -> Result<Vec<AppRecord>, String> {
  scan_applications()
}

#[tauri::command]
pub fn package_manager_status() -> Result<PackageManagerStatus, String> {
  Ok(detect_package_managers())
}

#[tauri::command]
pub fn scan_startup_entries() -> Result<Vec<StartupEntry>, String> {
  let mut entries = Vec::new();
  let dirs = startup_directories();

  for dir in dirs {
    if !dir.exists() {
      continue;
    }
    let Ok(read_dir) = fs::read_dir(&dir) else {
      continue;
    };

    for item in read_dir.flatten() {
      let path = item.path();
      if !path.is_file() || path.extension().and_then(|it| it.to_str()) != Some("desktop") {
        continue;
      }

      let Some((id, name)) = parse_desktop_entry_name(&path) else {
        continue;
      };

      entries.push(StartupEntry {
        id,
        name,
        path: path.display().to_string(),
      });
    }
  }

  entries.sort_by(|a, b| a.name.cmp(&b.name));
  entries.dedup_by(|a, b| a.id == b.id);
  Ok(entries)
}

#[tauri::command]
pub fn scan_running_processes() -> Result<Vec<ProcessInfo>, String> {
  let output = Command::new("ps")
    .args(["-eo", "pid,comm,%cpu,%mem,command", "--no-headers"])
    .output()
    .map_err(|err| format!("failed to inspect running processes: {err}"))?;

  if !output.status.success() {
    return Err(String::from("unable to inspect running processes"));
  }

  let stdout = String::from_utf8_lossy(&output.stdout);
  let mut processes = Vec::new();

  for line in stdout.lines() {
    let trimmed = line.trim();
    if trimmed.is_empty() {
      continue;
    }
    let parts: Vec<&str> = trimmed.split_whitespace().collect();
    if parts.len() < 5 {
      continue;
    }

    let pid = parts[0]
      .parse::<u32>()
      .map_err(|_| format!("invalid process id in line: {line}"))
      .ok();
    let Some(pid) = pid else { continue; };
    let name = parts[1].to_string();
    let cpu = parts[2].parse::<f32>().unwrap_or(0.0);
    let memory = parts[3].parse::<f32>().unwrap_or(0.0);
    let command = trimmed
      .split_once(' ')
      .map(|(_, rest)| rest)
      .unwrap_or("")
      .trim()
      .to_string();

    processes.push(ProcessInfo {
      pid,
      name,
      cpu,
      memory,
      command,
    });
  }

  processes.sort_by(|a, b| b.pid.cmp(&a.pid));
  Ok(processes)
}

#[tauri::command]
pub fn launch_application(app_id: String) -> Result<String, String> {
  let apps = scan_applications()?;
  let app = apps
    .into_iter()
    .find(|entry| entry.id == app_id)
    .ok_or_else(|| format!("application {app_id} not found"))?;

  let Some(exec) = app.exec else {
    return Err(format!("{} does not expose an executable command", app.name));
  };

  let command = parse_exec_command(&exec)?;
  let status = Command::new(&command[0])
    .args(&command[1..])
    .spawn()
    .map_err(|err| format!("failed to launch {}: {err}", app.name))?;

  Ok(format!("started {} with pid {}", app.name, status.id()))
}

#[tauri::command]
pub fn validate_package_id(package_name: String) -> Result<bool, String> {
  let trimmed = package_name.trim();
  if trimmed.is_empty() {
    return Ok(false);
  }

  let re = regex::Regex::new(r"^[A-Za-z0-9][A-Za-z0-9.+_-]*$").unwrap();
  Ok(re.is_match(trimmed))
}

#[tauri::command]
pub fn perform_package_action(package_name: String, action: String, source: String) -> Result<String, String> {
  let package_name = package_name.trim();
  if !validate_package_id(package_name.clone())? {
    return Err(format!("invalid package identifier: {package_name}"));
  }

  let action = action.trim();
  let source = source.trim();
  let status = detect_package_managers();

  if source.eq_ignore_ascii_case(APT_SOURCE) {
    if !status.apt {
      return Err(String::from("APT is not installed or not available on this system."));
    }
    if !status.pkexec {
      return Err(String::from("pkexec is required to perform privileged package operations on this system."));
    }
    let cmd = match action {
      "install" => vec!["pkexec", "apt-get", "install", "-y", package_name],
      "remove" => vec!["pkexec", "apt-get", "remove", "-y", package_name],
      "update" => vec!["pkexec", "apt-get", "update"],
      _ => return Err(format!("unsupported APT action: {action}")),
    };
    let mut child = Command::new(&cmd[0]).args(&cmd[1..]).spawn().map_err(|err| format!("unable to start package action: {err}"))?;
    let exit = child.wait().map_err(|err| format!("package action failed to complete: {err}"))?;
    if !exit.success() {
      return Err(format!("{source} {action} for {package_name} exited with status {}.", exit.code().unwrap_or(1)));
    }
    return Ok(format!("{source} {action} for {package_name} completed successfully."));
  }

  if source.eq_ignore_ascii_case(FLATPAK_SOURCE) {
    if !status.flatpak {
      return Err(String::from("Flatpak is not installed on this system."));
    }
    if !status.pkexec {
      return Err(String::from("pkexec is required to perform Flatpak system operations."));
    }
    let cmd = match action {
      "install" => vec!["pkexec", "flatpak", "install", "-y", package_name],
      "remove" => vec!["pkexec", "flatpak", "uninstall", "-y", package_name],
      "update" => vec!["pkexec", "flatpak", "update", "-y", package_name],
      _ => return Err(format!("unsupported Flatpak action: {action}")),
    };
    let mut child = Command::new(&cmd[0]).args(&cmd[1..]).spawn().map_err(|err| format!("unable to start package action: {err}"))?;
    let exit = child.wait().map_err(|err| format!("package action failed to complete: {err}"))?;
    if !exit.success() {
      return Err(format!("{source} {action} for {package_name} exited with status {}.", exit.code().unwrap_or(1)));
    }
    return Ok(format!("{source} {action} for {package_name} completed successfully."));
  }

  if source.eq_ignore_ascii_case(SNAP_SOURCE) {
    if !status.snap {
      return Err(String::from("Snap is not installed on this system."));
    }
    if !status.pkexec {
      return Err(String::from("pkexec is required to perform Snap system operations."));
    }
    let cmd = match action {
      "install" => vec!["pkexec", "snap", "install", package_name],
      "remove" => vec!["pkexec", "snap", "remove", package_name],
      "update" => vec!["pkexec", "snap", "refresh", package_name],
      _ => return Err(format!("unsupported Snap action: {action}")),
    };
    let mut child = Command::new(&cmd[0]).args(&cmd[1..]).spawn().map_err(|err| format!("unable to start package action: {err}"))?;
    let exit = child.wait().map_err(|err| format!("package action failed to complete: {err}"))?;
    if !exit.success() {
      return Err(format!("{source} {action} for {package_name} exited with status {}.", exit.code().unwrap_or(1)));
    }
    return Ok(format!("{source} {action} for {package_name} completed successfully."));
  }

  Err(format!("package source {source} is not supported"))
}

fn scan_applications() -> Result<Vec<AppRecord>, String> {
  let mut registry: HashMap<String, AppRecord> = HashMap::new();
  for dir in desktop_search_directories() {
    if !dir.exists() {
      continue;
    }
    let read_dir = fs::read_dir(&dir).map_err(|err| format!("failed reading {}: {err}", dir.display()))?;
    for entry in read_dir.flatten() {
      let path = entry.path();
      if !path.is_file() || path.extension().and_then(|ext| ext.to_str()) != Some("desktop") {
        continue;
      }

      let Some(parsed) = parse_desktop_file(&path) else {
        continue;
      };
      let key = parsed.id.clone();
      let existing = registry.get(&key);
      if existing.is_none() {
        registry.insert(key.clone(), parsed.clone());
      } else if parsed.path.starts_with("/usr/") && !existing.unwrap().path.starts_with("/usr/") {
        registry.insert(key, parsed);
      }
    }
  }

  let mut apps: Vec<AppRecord> = registry.into_values().collect();
  apps.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
  Ok(apps)
}

fn parse_desktop_file(path: &Path) -> Option<AppRecord> {
  let content = fs::read_to_string(path).ok()?;
  let mut name = String::new();
  let mut description = String::new();
  let mut icon = None;
  let mut exec = None;
  let mut categories = Vec::new();
  let mut hidden = false;
  let mut no_display = false;
  let mut path_value = path.to_string_lossy().to_string();
  let mut package_name = None;

  for raw_line in content.lines() {
    let line = raw_line.trim();
    if line.is_empty() || line.starts_with('#') {
      continue;
    }
    let Some((key, value)) = line.split_once('=') else {
      continue;
    };
    let normalized_key = key.trim();
    let value = value.trim();
    match normalized_key {
      "Name" => name = unescape_desktop_value(value),
      "Comment" => description = unescape_desktop_value(value),
      "Icon" => icon = Some(unescape_desktop_value(value)),
      "Exec" => exec = Some(unescape_desktop_value(value)),
      "Categories" => categories = value.split(';').filter(|part| !part.is_empty()).map(str::to_string).collect(),
      "Hidden" => hidden = value.eq_ignore_ascii_case("true"),
      "NoDisplay" => no_display = value.eq_ignore_ascii_case("true"),
      "Package" => package_name = Some(value.to_string()),
      _ => {}
    }
  }

  if hidden || no_display || name.is_empty() {
    return None;
  }

  let cleaned_exec = exec.as_ref().map(|value| sanitize_exec(value));
  let source = detect_source_for_path(&path_value);
  let app_id = path.file_stem().and_then(|stem| stem.to_str()).unwrap_or("unknown").to_string();
  let icon_path = resolve_icon_path(icon.as_deref());

  Some(AppRecord {
    id: app_id,
    name: name.trim().to_string(),
    description: if description.is_empty() { String::from("No description available") } else { description },
    source: source.to_string(),
    icon: icon_path,
    installed: true,
    package_name,
    exec: cleaned_exec,
    category: categories.join(", "),
    path: path_value,
  })
}

fn parse_desktop_entry_name(path: &Path) -> Option<(String, String)> {
  let content = fs::read_to_string(path).ok()?;
  let mut name = None;
  for raw_line in content.lines() {
    let line = raw_line.trim();
    if line.is_empty() || line.starts_with('#') {
      continue;
    }
    let Some((key, value)) = line.split_once('=') else {
      continue;
    };
    if key.trim() == "Name" {
      name = Some(unescape_desktop_value(value.trim()));
      break;
    }
  }
  let name = name?;
  let id = path.file_stem()?.to_string_lossy().to_string();
  Some((id, name))
}

fn detect_source_for_path(path: &str) -> &'static str {
  if path.contains("/flatpak/") || path.contains("flatpak") {
    FLATPAK_SOURCE
  } else if path.contains("/snap/") || path.contains("snap") {
    SNAP_SOURCE
  } else if path.starts_with("/usr/") || path.starts_with("/var/lib/dpkg") {
    APT_SOURCE
  } else {
    UNKNOWN_SOURCE
  }
}

fn desktop_search_directories() -> Vec<PathBuf> {
  let mut dirs = vec![
    PathBuf::from("/usr/share/applications"),
    PathBuf::from("/usr/local/share/applications"),
  ];

  if let Some(home) = dirs::home_dir() {
    dirs.push(home.join(".local/share/applications"));
    dirs.push(home.join(".config/autostart"));
  }

  dirs
}

fn startup_directories() -> Vec<PathBuf> {
  let mut dirs = vec![PathBuf::from("/etc/xdg/autostart")];
  if let Some(home) = dirs::home_dir() {
    dirs.push(home.join(".config/autostart"));
  }
  dirs
}

fn resolve_icon_path(name: Option<&str>) -> Option<String> {
  let Some(icon_name) = name else {
    return None;
  };
  let cleaned = icon_name.trim();
  if cleaned.is_empty() || cleaned == "application-default-icon" {
    return None;
  }

  let candidates = [
    format!("{}/.local/share/icons", dirs::home_dir()?.display()),
    "/usr/share/icons".to_string(),
    "/usr/local/share/icons".to_string(),
  ];

  for base in candidates {
    let paths = [
      format!("{base}/hicolor/scalable/apps/{cleaned}.svg"),
      format!("{base}/hicolor/256x256/apps/{cleaned}.png"),
      format!("{base}/hicolor/128x128/apps/{cleaned}.png"),
      format!("{base}/hicolor/48x48/apps/{cleaned}.png"),
      format!("{base}/pixmaps/{cleaned}.png"),
      format!("{base}/pixmaps/{cleaned}.svg"),
    ];
    for candidate in paths {
      if Path::new(&candidate).exists() {
        return Some(candidate);
      }
    }
  }

  Some(cleaned.to_string())
}

fn sanitize_exec(raw: &str) -> String {
  raw
    .replace("%f", "")
    .replace("%F", "")
    .replace("%u", "")
    .replace("%U", "")
    .replace("%i", "")
    .replace("%c", "")
    .replace("%k", "")
    .replace("%d", "")
    .replace("%D", "")
    .replace("%n", "")
    .replace("%N", "")
    .replace("%v", "")
    .replace("%m", "")
    .trim()
    .to_string()
}

fn parse_exec_command(command: &str) -> Result<Vec<String>, String> {
  let cleaned = command.trim();
  if cleaned.is_empty() {
    return Err(String::from("empty command"));
  }

  let split = shlex::split(cleaned).ok_or_else(|| format!("unsupported command line: {cleaned}"))?;
  if split.is_empty() {
    return Err(String::from("no executable found in command"));
  }

  Ok(split)
}

fn unescape_desktop_value(value: &str) -> String {
  value
    .replace("\\n", " ")
    .replace("\\s", " ")
    .replace('\\', "")
    .trim()
    .to_string()
}

fn detect_package_managers() -> PackageManagerStatus {
  let mut status = PackageManagerStatus::default();
  status.apt = command_exists("apt-get");
  status.flatpak = command_exists("flatpak");
  status.snap = command_exists("snap");
  status.pkexec = command_exists("pkexec");
  status
}

fn command_exists(name: &str) -> bool {
  Command::new("sh")
    .arg("-lc")
    .arg(format!("command -v {} >/dev/null 2>&1", name))
    .status()
    .map(|result| result.success())
    .unwrap_or(false)
}

fn detect_updates(status: &PackageManagerStatus) -> Result<usize, String> {
  let mut count = 0usize;
  if status.apt {
    let output = Command::new("apt-get")
      .args(["-s", "upgrade"])
      .output()
      .map_err(|err| format!("failed to inspect APT updates: {err}"))?;
    if output.status.success() {
      let text = String::from_utf8_lossy(&output.stdout);
      let matches = text
        .lines()
        .filter(|line| line.contains("upgraded") || line.contains("newly installed") || line.contains("to upgrade"))
        .count();
      if matches > 0 {
        count += 1;
      }
    }
  }
  if status.flatpak {
    let output = Command::new("flatpak")
      .args(["remote-ls", "--updates"])
      .output()
      .ok();
    if let Some(output) = output {
      if output.status.success() {
        let text = String::from_utf8_lossy(&output.stdout);
        if !text.trim().is_empty() {
          count += 1;
        }
      }
    }
  }
  if status.snap {
    let output = Command::new("snap")
      .args(["refresh", "--list"])
      .output()
      .ok();
    if let Some(output) = output {
      if output.status.success() {
        let text = String::from_utf8_lossy(&output.stdout);
        if !text.trim().is_empty() {
          count += 1;
        }
      }
    }
  }
  Ok(count)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![
      get_app_overview,
      refresh_applications,
      package_manager_status,
      scan_startup_entries,
      scan_running_processes,
      launch_application,
      validate_package_id,
      perform_package_action
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
  fn validates_package_identifiers() {
    assert!(validate_package_id(String::from("firefox")).unwrap());
    assert!(validate_package_id(String::from("org.mozilla.firefox")).unwrap());
    assert!(!validate_package_id(String::from("bad package")).unwrap());
  }

  #[test]
  fn identifies_desktop_entries_but_ignores_hidden() {
    let dir = std::env::temp_dir().join("apppilot-desktop-entry-test");
    let _ = fs::create_dir_all(&dir);
    let path = dir.join("visible.desktop");
    fs::write(
      &path,
      "[Desktop Entry]\nType=Application\nName=Visible App\nComment=Example\nIcon=firefox\nExec=firefox --new-window\n",
    )
    .unwrap();
    let hidden_path = dir.join("hidden.desktop");
    fs::write(
      &hidden_path,
      "[Desktop Entry]\nType=Application\nName=Hidden App\nHidden=true\nExec=true\n",
    )
    .unwrap();

    let visible = parse_desktop_file(&path).unwrap();
    assert_eq!(visible.name, "Visible App");
    assert_eq!(visible.source, "Local");
    assert!(parse_desktop_file(&hidden_path).is_none());
    let _ = fs::remove_dir_all(dir);
  }

  #[test]
  fn parses_exec_commands() {
    let command = parse_exec_command("firefox --new-window --profile /tmp/test").unwrap();
    assert_eq!(command[0], "firefox");
    assert!(command.len() >= 2);
  }
}
