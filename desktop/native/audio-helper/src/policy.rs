//! Pure rules for the capture: which audio sessions go into the live mix, and how
//! their samples are combined. Kept free of Windows APIs so `cargo test` covers them.

/// Which processes stay out of the live: by executable name (the user's list, e.g.
/// Discord) and by process tree (the ScreenShare app itself, so watching someone while
/// broadcasting never echoes back).
pub struct ExclusionPolicy {
    excluded_exes: Vec<String>,
    excluded_root_pid: Option<u32>,
}

impl ExclusionPolicy {
    pub fn new(excluded_exes: &[String], excluded_root_pid: Option<u32>) -> Self {
        Self {
            excluded_exes: excluded_exes.iter().map(|exe| exe.to_lowercase()).collect(),
            excluded_root_pid,
        }
    }

    /// `ancestors` is the parent chain of `pid`, closest first.
    pub fn includes(&self, pid: u32, exe: &str, ancestors: &[u32]) -> bool {
        // pid 0 is the "System Sounds" session; process loopback can't target it.
        if pid == 0 {
            return false;
        }
        if let Some(root) = self.excluded_root_pid {
            if pid == root || ancestors.contains(&root) {
                return false;
            }
        }
        let exe = exe.to_lowercase();
        !self.excluded_exes.iter().any(|excluded| *excluded == exe)
    }
}

/// One running process: what the exclusion rules need to know about it.
pub struct ProcessInfo {
    pub pid: u32,
    pub exe: String,
    /// Parent chain, closest first.
    pub ancestors: Vec<u32>,
}

impl ExclusionPolicy {
    /// Windows' process loopback only offers "this process and everything under it". So
    /// a process may be captured only if nothing below it is excluded -- otherwise, say,
    /// capturing explorer.exe's system sounds would also carry the Discord it launched.
    pub fn safe_to_capture(&self, pid: u32, table: &[ProcessInfo]) -> bool {
        table
            .iter()
            .filter(|process| process.ancestors.contains(&pid))
            .all(|process| self.includes(process.pid, &process.exe, &process.ancestors))
    }
}

/// Process loopback captures a whole process tree, so a candidate whose ancestor is also
/// a candidate would be heard twice. Returns only the topmost candidates.
pub fn capture_roots(candidates: &[(u32, Vec<u32>)]) -> Vec<u32> {
    let pids: Vec<u32> = candidates.iter().map(|(pid, _)| *pid).collect();
    candidates
        .iter()
        .filter(|(_, ancestors)| !ancestors.iter().any(|ancestor| pids.contains(ancestor)))
        .map(|(pid, _)| *pid)
        .collect()
}

/// Adds `source` into `mix`, sample by sample; `source` may be shorter (a source that
/// had less audio ready than one block).
pub fn mix_into(mix: &mut [f32], source: &[f32]) {
    for (out, sample) in mix.iter_mut().zip(source) {
        *out += sample;
    }
}

/// Keeps the summed mix inside [-1, 1] so loud overlaps clip instead of wrapping.
pub fn clamp_all(mix: &mut [f32]) {
    for sample in mix.iter_mut() {
        *sample = sample.clamp(-1.0, 1.0);
    }
}

pub fn json_escape(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '"' => escaped.push_str("\\\""),
            '\\' => escaped.push_str("\\\\"),
            c if (c as u32) < 0x20 => escaped.push_str(&format!("\\u{:04x}", c as u32)),
            c => escaped.push(c),
        }
    }
    escaped
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy() -> ExclusionPolicy {
        ExclusionPolicy::new(&["Discord.exe".to_string()], Some(100))
    }

    #[test]
    fn excludes_listed_apps_regardless_of_case() {
        assert!(!policy().includes(42, "discord.exe", &[1]));
        assert!(!policy().includes(42, "DISCORD.EXE", &[1]));
    }

    #[test]
    fn excludes_the_app_itself_and_its_children() {
        assert!(!policy().includes(100, "ScreenShare.exe", &[1]));
        assert!(!policy().includes(101, "ScreenShare.exe", &[100, 1]));
    }

    #[test]
    fn includes_everything_else() {
        assert!(policy().includes(42, "chrome.exe", &[7, 1]));
    }

    #[test]
    fn never_includes_the_system_sounds_session() {
        assert!(!policy().includes(0, "", &[]));
    }

    fn process(pid: u32, exe: &str, ancestors: &[u32]) -> ProcessInfo {
        ProcessInfo { pid, exe: exe.to_string(), ancestors: ancestors.to_vec() }
    }

    #[test]
    fn refuses_a_parent_whose_tree_holds_an_excluded_app() {
        // explorer (5) launched Discord (6): capturing explorer's tree would carry Discord.
        let table = vec![process(5, "explorer.exe", &[1]), process(6, "Discord.exe", &[5, 1])];
        assert!(!policy().safe_to_capture(5, &table));
    }

    #[test]
    fn refuses_a_parent_of_the_app_itself() {
        let table = vec![process(5, "explorer.exe", &[1]), process(100, "ScreenShare.exe", &[5, 1])];
        assert!(!policy().safe_to_capture(5, &table));
    }

    #[test]
    fn allows_a_parent_whose_children_are_all_included() {
        let table = vec![process(7, "chrome.exe", &[1]), process(8, "chrome.exe", &[7, 1])];
        assert!(policy().safe_to_capture(7, &table));
    }

    #[test]
    fn keeps_only_the_topmost_process_of_a_tree() {
        let candidates = vec![(10, vec![1]), (11, vec![10, 1]), (20, vec![1])];
        let mut roots = capture_roots(&candidates);
        roots.sort();
        assert_eq!(roots, vec![10, 20]);
    }

    #[test]
    fn mixes_by_summing_and_tolerates_short_sources() {
        let mut mix = vec![0.1, 0.2, 0.3, 0.4];
        mix_into(&mut mix, &[0.5, 0.5]);
        assert_eq!(mix, vec![0.6, 0.7, 0.3, 0.4]);
    }

    #[test]
    fn clamps_overlapping_peaks() {
        let mut mix = vec![1.5, -2.0, 0.25];
        clamp_all(&mut mix);
        assert_eq!(mix, vec![1.0, -1.0, 0.25]);
    }

    #[test]
    fn escapes_names_for_json() {
        assert_eq!(json_escape(r#"a"b\c"#), r#"a\"b\\c"#);
    }
}
