// Mencegah jendela konsol tambahan muncul di Windows saat rilis.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
  jejak_desktop_lib::run();
}
