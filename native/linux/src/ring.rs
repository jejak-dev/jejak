use std::collections::VecDeque;
use std::sync::Mutex;

/// Penyangga baris berkapasitas tetap (stderr sidecar), aman lintas thread.
pub struct LineRing {
    cap: usize,
    lines: Mutex<VecDeque<String>>,
}

impl LineRing {
    pub fn new(cap: usize) -> Self {
        Self { cap: cap.max(1), lines: Mutex::new(VecDeque::new()) }
    }
    pub fn append(&self, line: String) {
        let mut g = self.lines.lock().unwrap();
        while g.len() >= self.cap {
            g.pop_front();
        }
        g.push_back(line);
    }
    pub fn snapshot(&self) -> Vec<String> {
        self.lines.lock().unwrap().iter().cloned().collect()
    }
    pub fn summary(&self, max_lines: usize) -> String {
        let all = self.snapshot();
        let start = all.len().saturating_sub(max_lines);
        all[start..].join("\n")
    }
}
