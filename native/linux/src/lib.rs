//! Inti cangkang native Linux Jejak. Tanpa GTK: berjalan dan teruji di mesin mana pun.

pub mod bridge;
pub mod l10n;
pub mod locator;
pub mod manifest;
pub mod minisign;
pub mod navigation;
pub mod ready_line;
pub mod ring;
pub mod semver;
pub mod sidecar;
pub mod token;
pub mod update_state;
pub mod updater;

pub use l10n::l;
