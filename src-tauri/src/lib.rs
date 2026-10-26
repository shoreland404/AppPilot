#[cfg(target_os = "linux")]
mod native;
#[cfg(target_os = "windows")]
mod windows;

#[cfg(target_os = "linux")]
pub use native::run;
#[cfg(target_os = "windows")]
pub use windows::run;

#[cfg(not(any(target_os = "linux", target_os = "windows")))]
compile_error!("AppPilot currently supports Linux and Windows desktop builds.");
