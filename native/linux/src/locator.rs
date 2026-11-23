use crate::l10n::l;
use std::path::{Path, PathBuf};

#[cfg(target_arch = "aarch64")]
pub const TRIPLE: &str = "aarch64-unknown-linux-gnu";
#[cfg(not(target_arch = "aarch64"))]
pub const TRIPLE: &str = "x86_64-unknown-linux-gnu";

fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p).map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false)
}

/// `JEJAK_SIDECAR` menang; lalu kandidat relatif ke folder executable.
pub fn locate(exe_dir: &Path, env: &dyn Fn(&str) -> Option<String>) -> Result<PathBuf, String> {
    if let Some(v) = env("JEJAK_SIDECAR").filter(|v| !v.is_empty()) {
        let p = PathBuf::from(&v);
        return if is_executable(&p) {
            Ok(p)
        } else {
            Err(l("locator.env_missing", "JEJAK_SIDECAR menunjuk berkas yang tak ada: %@", &[&v]))
        };
    }
    let candidates = [
        exe_dir.join("jejak"),
        exe_dir.join(format!("jejak-{TRIPLE}")),
        exe_dir.join("binaries/jejak"),
        exe_dir.join("../lib/jejak/jejak"),
    ];
    for c in &candidates {
        if is_executable(c) {
            return Ok(c.clone());
        }
    }
    let tried = candidates.iter().map(|c| c.display().to_string()).collect::<Vec<_>>().join(", ");
    Err(l("locator.not_found", "binary sidecar tak ditemukan. Dicoba: %@", &[&tried]))
}
