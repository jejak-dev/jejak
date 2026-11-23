//! Versi semver dengan pra-rilis (mis. `0.1.0-beta.19`).

use std::cmp::Ordering;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Semver {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
    pub pre: Vec<String>,
}

impl Semver {
    pub fn parse(text: &str) -> Option<Semver> {
        let mut s = text.trim();
        s = s.strip_prefix('v').unwrap_or(s);
        if let Some(i) = s.find('+') {
            s = &s[..i]; // metadata build diabaikan
        }
        let (core, pre) = match s.find('-') {
            Some(i) => (&s[..i], s[i + 1..].split('.').map(str::to_string).collect::<Vec<_>>()),
            None => (s, Vec::new()),
        };
        if pre.iter().any(|p| p.is_empty()) {
            return None;
        }
        let parts: Vec<&str> = core.split('.').collect();
        if parts.len() != 3 {
            return None;
        }
        let num = |x: &str| if !x.is_empty() && x.bytes().all(|b| b.is_ascii_digit()) { x.parse::<u64>().ok() } else { None };
        Some(Semver { major: num(parts[0])?, minor: num(parts[1])?, patch: num(parts[2])?, pre })
    }
}

impl std::fmt::Display for Semver {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)?;
        if !self.pre.is_empty() {
            write!(f, "-{}", self.pre.join("."))?;
        }
        Ok(())
    }
}

impl Ord for Semver {
    fn cmp(&self, o: &Self) -> Ordering {
        let c = (self.major, self.minor, self.patch).cmp(&(o.major, o.minor, o.patch));
        if c != Ordering::Equal {
            return c;
        }
        // Rilis penuh lebih baru daripada pra-rilis dengan angka sama.
        match (self.pre.is_empty(), o.pre.is_empty()) {
            (true, false) => return Ordering::Greater,
            (false, true) => return Ordering::Less,
            _ => {}
        }
        for (x, y) in self.pre.iter().zip(&o.pre) {
            if x == y {
                continue;
            }
            return match (x.parse::<u64>(), y.parse::<u64>()) {
                (Ok(i), Ok(j)) => i.cmp(&j),
                (Ok(_), Err(_)) => Ordering::Less, // angka < teks
                (Err(_), Ok(_)) => Ordering::Greater,
                _ => x.cmp(y),
            };
        }
        self.pre.len().cmp(&o.pre.len())
    }
}

impl PartialOrd for Semver {
    fn partial_cmp(&self, o: &Self) -> Option<Ordering> {
        Some(self.cmp(o))
    }
}
