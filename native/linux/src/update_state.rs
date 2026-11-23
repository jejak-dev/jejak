//! Keadaan pembaruan yang dilihat UI beserta aturan transisinya (sama dengan macOS dan Windows).

use serde_json::{json, Map, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Idle,
    Checking,
    Available,
    Downloading,
    Installing,
    Ready,
    Error,
}

impl Phase {
    pub fn name(self) -> &'static str {
        match self {
            Phase::Idle => "idle",
            Phase::Checking => "checking",
            Phase::Available => "available",
            Phase::Downloading => "downloading",
            Phase::Installing => "installing",
            Phase::Ready => "ready",
            Phase::Error => "error",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Status {
    pub state: Phase,
    pub version: Option<String>,
    pub notes: Option<String>,
    pub date: Option<String>,
    pub downloaded: u64,
    pub total: Option<u64>,
    pub error: Option<String>,
    pub last_check: Option<u64>,
}

impl Default for Status {
    fn default() -> Self {
        Status { state: Phase::Idle, version: None, notes: None, date: None, downloaded: 0, total: None, error: None, last_check: None }
    }
}

impl Status {
    /// Bentuk JSON untuk jembatan (`updater_status`), kunci camelCase.
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("state".into(), json!(self.state.name()));
        m.insert("downloaded".into(), json!(self.downloaded));
        if let Some(v) = &self.version { m.insert("version".into(), json!(v)); }
        if let Some(v) = &self.notes { m.insert("notes".into(), json!(v)); }
        if let Some(v) = &self.date { m.insert("date".into(), json!(v)); }
        if let Some(v) = self.total { m.insert("total".into(), json!(v)); }
        if let Some(v) = &self.error { m.insert("error".into(), json!(v)); }
        if let Some(v) = self.last_check { m.insert("lastCheck".into(), json!(v)); }
        Value::Object(m)
    }

    pub fn start_check(&mut self, at: u64) -> bool {
        if !matches!(self.state, Phase::Idle | Phase::Error) {
            return false;
        }
        self.state = Phase::Checking;
        self.version = None;
        self.notes = None;
        self.date = None;
        self.downloaded = 0;
        self.total = None;
        self.error = None;
        self.last_check = Some(at);
        true
    }

    pub fn finish_check(&mut self, at: u64, version: Option<String>, notes: Option<String>, date: Option<String>) -> bool {
        if self.state != Phase::Checking {
            return false;
        }
        self.last_check = Some(at);
        self.error = None;
        match version {
            Some(v) => {
                self.state = Phase::Available;
                self.version = Some(v);
                self.notes = notes;
                self.date = date;
            }
            None => {
                self.state = Phase::Idle;
                self.version = None;
                self.notes = None;
                self.date = None;
            }
        }
        true
    }

    pub fn start_download(&mut self) -> bool {
        if self.state != Phase::Available {
            return false;
        }
        self.state = Phase::Downloading;
        self.downloaded = 0;
        self.total = None;
        self.error = None;
        true
    }

    pub fn progress(&mut self, downloaded: u64, total: Option<u64>) -> bool {
        if self.state != Phase::Downloading {
            return false;
        }
        self.downloaded = downloaded;
        self.total = total;
        true
    }

    pub fn finish_download(&mut self) -> bool {
        if self.state != Phase::Downloading {
            return false;
        }
        self.state = Phase::Installing;
        true
    }

    pub fn finish_install(&mut self) -> bool {
        if self.state != Phase::Installing {
            return false;
        }
        self.state = Phase::Ready;
        true
    }

    pub fn fail(&mut self, at: u64, message: String) {
        if self.state == Phase::Checking {
            self.last_check = Some(at);
        }
        self.state = Phase::Error;
        self.error = Some(message);
    }

    pub fn drop_pending(&mut self) -> bool {
        if self.state != Phase::Available {
            return false;
        }
        self.state = Phase::Idle;
        self.version = None;
        self.notes = None;
        self.date = None;
        true
    }
}
