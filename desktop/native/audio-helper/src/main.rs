//! ScreenShare's audio helper: per-application audio capture for the desktop app.
//!
//! Chromium can only capture the whole system mix, which includes the Discord call the
//! presenter is in -- viewers then hear themselves. Windows' process loopback (WASAPI,
//! Windows 10 2004+) captures one process tree at a time, so this helper opens one
//! capture per audio session that isn't excluded, mixes them, and streams the result.
//!
//! Commands (the Electron main process spawns this; see desktop/src/main/audioHelper.ts):
//!   audio-helper sessions [--exclude-pid PID]
//!       One JSON line on stdout: [{"pid":1234,"exe":"chrome.exe","peak":0.42}, ...]
//!   audio-helper capture [--exclude a.exe,b.exe] [--exclude-pid PID]
//!       Raw 48 kHz stereo f32 little-endian PCM on stdout, in 10 ms blocks, until stdin
//!       closes (the app quit or ended the live).

mod drift;
mod policy;

use std::collections::{HashMap, VecDeque};
use std::io::{self, Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, RefreshKind, System};
use wasapi::{
    AudioClient, DeviceEnumerator, Direction, SampleType, SessionState, StreamMode, WaveFormat,
    initialize_mta,
};

use drift::DriftResampler;
use policy::{ExclusionPolicy, ProcessInfo, RootHealth, capture_roots, clamp_all, json_escape, mix_into, roots_to_demote};

const SAMPLE_RATE: usize = 48_000;
const CHANNELS: usize = 2;
/// 10 ms per block written to stdout.
const BLOCK_FRAMES: usize = SAMPLE_RATE / 100;
const BLOCK_SAMPLES: usize = BLOCK_FRAMES * CHANNELS;
/// A source starts feeding the mix once it holds this much (30 ms): capture packets and
/// mixer ticks run on different clocks, and without a little slack they alternate
/// between "nothing yet" and "two packets", which is heard as crackle.
const PRIME_SAMPLES: usize = BLOCK_SAMPLES * 3;
/// The level each source is steered back to (see drift.rs): the same 30 ms cushion.
const TARGET_FRAMES: usize = PRIME_SAMPLES / CHANNELS;
/// Past this (200 ms) the oldest audio is dropped, so a stalled mixer never drifts late.
const MAX_BUFFERED_SAMPLES: usize = SAMPLE_RATE * CHANNELS / 5;
const RESCAN_INTERVAL: Duration = Duration::from_secs(1);
const EVENT_TIMEOUT_MS: u32 = 200;
/// Falling this far behind the wall clock means the PC stalled; restart the schedule.
const MAX_SCHEDULE_LAG: Duration = Duration::from_millis(200);
const MAX_ANCESTRY_DEPTH: usize = 32;
/// A session meter above this is an app playing sound.
const AUDIBLE_PEAK: f32 = 0.001;
/// A captured sample above this (-80 dBFS) is sound rather than silence.
const AUDIBLE_SAMPLE: f32 = 0.0001;
/// An app counts as playing once its meter has shown sound for this long...
const PLAYING_FOR: Duration = Duration::from_secs(2);
/// ...and a capture root silent this long while one plays inside its tree is dropped.
const SILENT_ROOT_AFTER: Duration = Duration::from_secs(3);
/// A capture that delivered sound this recently counts as "ok" in the status.
const RECENT_SOUND: Duration = Duration::from_secs(3);

type Res<T> = Result<T, Box<dyn std::error::Error>>;

struct Args {
    command: String,
    exclude: Vec<String>,
    exclude_pid: Option<u32>,
}

fn parse_args() -> Res<Args> {
    let mut raw = std::env::args().skip(1);
    let command = raw.next().ok_or("usage: audio-helper <sessions|capture> [options]")?;
    let mut args = Args { command, exclude: Vec::new(), exclude_pid: None };
    while let Some(flag) = raw.next() {
        let value = raw.next().ok_or_else(|| format!("missing value for {flag}"))?;
        match flag.as_str() {
            "--exclude" => {
                args.exclude = value.split(',').filter(|s| !s.is_empty()).map(String::from).collect()
            }
            "--exclude-pid" => args.exclude_pid = Some(value.parse()?),
            other => return Err(format!("unknown option {other}").into()),
        }
    }
    Ok(args)
}

struct ActiveSession {
    pid: u32,
    peak: f32,
}

/// Every non-expired audio session on every output device. Inactive (paused) sessions
/// are kept: once their app starts playing, the capture is already in place.
fn list_sessions() -> Res<Vec<ActiveSession>> {
    let enumerator = DeviceEnumerator::new()?;
    let mut sessions = Vec::new();
    // One device or session that can't be read is skipped, never allowed to fail the
    // whole scan: that kept every app opened afterwards (a game started mid-live) out of
    // the capture while the ones already in it carried on.
    for device in &enumerator.get_device_collection(&Direction::Render)? {
        let Ok(device) = device else { continue };
        let Ok(enumerated) = device.get_iaudiosessionmanager().and_then(|manager| manager.get_audiosessionenumerator())
        else {
            continue;
        };
        let Ok(count) = enumerated.get_count() else { continue };
        for index in 0..count {
            let Ok(control) = enumerated.get_session(index) else { continue };
            if !matches!(control.get_state(), Ok(state) if state != SessionState::Expired) {
                continue;
            }
            let Ok(pid) = control.get_process_id() else { continue };
            let peak = control
                .get_audiometerinformation()
                .and_then(|meter| meter.get_peak_value())
                .unwrap_or(0.0);
            sessions.push(ActiveSession { pid, peak });
        }
    }
    Ok(sessions)
}

fn process_table() -> System {
    System::new_with_specifics(RefreshKind::nothing().with_processes(ProcessRefreshKind::nothing()))
}

fn exe_name(system: &System, pid: u32) -> String {
    system
        .process(Pid::from_u32(pid))
        .map(|process| process.name().to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Parent chain of `pid`, closest first.
fn ancestors(system: &System, pid: u32) -> Vec<u32> {
    let mut chain = Vec::new();
    let mut current = Pid::from_u32(pid);
    while chain.len() < MAX_ANCESTRY_DEPTH {
        let Some(parent) = system.process(current).and_then(|process| process.parent()) else {
            break;
        };
        let parent_pid = parent.as_u32();
        if parent_pid == 0 || chain.contains(&parent_pid) {
            break;
        }
        chain.push(parent_pid);
        current = parent;
    }
    chain
}

fn print_sessions(args: &Args) -> Res<()> {
    let system = process_table();
    let policy = ExclusionPolicy::new(&[], args.exclude_pid);
    let own_pid = std::process::id();
    let entries: Vec<String> = list_sessions()?
        .into_iter()
        .filter(|session| session.pid != own_pid)
        .filter_map(|session| {
            let exe = exe_name(&system, session.pid);
            policy.includes(session.pid, &exe, &ancestors(&system, session.pid)).then(|| {
                format!(
                    "{{\"pid\":{},\"exe\":\"{}\",\"peak\":{:.3}}}",
                    session.pid,
                    json_escape(&exe),
                    session.peak
                )
            })
        })
        .collect();
    println!("[{}]", entries.join(","));
    Ok(())
}

/// One app's capture, shared by its capture thread, the mixer and the scanner.
struct Capture {
    samples: Mutex<VecDeque<f32>>,
    stopped: AtomicBool,
    /// The capture ended with an error rather than being stopped.
    failed: AtomicBool,
    started: Instant,
    /// When the mix last heard sound from it, in ms after `started` plus one; 0 = never.
    audible_at: AtomicU64,
}

impl Capture {
    fn new() -> Self {
        Capture {
            samples: Mutex::new(VecDeque::new()),
            stopped: AtomicBool::new(false),
            failed: AtomicBool::new(false),
            started: Instant::now(),
            audible_at: AtomicU64::new(0),
        }
    }

    fn mark_audible(&self, at: Instant) {
        let ms = at.saturating_duration_since(self.started).as_millis() as u64;
        self.audible_at.store(ms + 1, Ordering::Relaxed);
    }

    /// Last time the capture delivered sound; None until it does.
    fn last_audible(&self) -> Option<Instant> {
        match self.audible_at.load(Ordering::Relaxed) {
            0 => None,
            ms => Some(self.started + Duration::from_millis(ms - 1)),
        }
    }
}

/// The mixer's own state for one capture.
struct MixInput {
    capture: Arc<Capture>,
    primed: bool,
    /// Reads the source at its sound card's pace rather than the mixer's.
    resampler: DriftResampler,
}

fn read_f32_frames(bytes: &mut VecDeque<u8>, block_align: usize, out: &mut Vec<f32>) {
    let whole = bytes.len() / block_align * block_align;
    let drained: Vec<u8> = bytes.drain(..whole).collect();
    out.extend(drained.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])));
}

/// One process tree's audio, pushed into `source.samples` until it is stopped or the
/// process goes away.
fn capture_loop(pid: u32, source: &Capture) -> Res<()> {
    initialize_mta().ok()?;
    let format = WaveFormat::new(32, 32, &SampleType::Float, SAMPLE_RATE, CHANNELS, None);
    let block_align = format.get_blockalign() as usize;
    let mut client = AudioClient::new_application_loopback_client(pid, true)?;
    let mode = StreamMode::EventsShared { autoconvert: true, buffer_duration_hns: 0 };
    client.initialize_client(&format, &Direction::Capture, &mode)?;
    let event = client.set_get_eventhandle()?;
    let capture = client.get_audiocaptureclient()?;
    client.start_stream()?;

    let mut bytes = VecDeque::new();
    let mut decoded = Vec::new();
    while !source.stopped.load(Ordering::Relaxed) {
        // A timeout only means the app is silent right now.
        let _ = event.wait_for_event(EVENT_TIMEOUT_MS);
        while capture.get_next_packet_size()?.unwrap_or(0) > 0 {
            capture.read_from_device_to_deque(&mut bytes)?;
        }
        decoded.clear();
        read_f32_frames(&mut bytes, block_align, &mut decoded);
        if decoded.is_empty() {
            continue;
        }
        let mut queue = source.samples.lock().map_err(|_| "sample queue poisoned")?;
        queue.extend(decoded.iter());
        let overflow = queue.len().saturating_sub(MAX_BUFFERED_SAMPLES);
        queue.drain(..overflow);
    }
    client.stop_stream()?;
    Ok(())
}

fn start_source(pid: u32) -> Arc<Capture> {
    let capture = Arc::new(Capture::new());
    let thread_capture = Arc::clone(&capture);
    thread::spawn(move || {
        if let Err(error) = capture_loop(pid, &thread_capture) {
            eprintln!("capture of process {pid} ended: {error}");
            thread_capture.failed.store(true, Ordering::Relaxed);
        }
        thread_capture.stopped.store(true, Ordering::Relaxed);
    });
    capture
}

/// What the helper learns about the apps over one capture.
#[derive(Default)]
struct Health {
    /// Since when each session's meter has been showing sound, by pid.
    playing_since: HashMap<u32, Instant>,
    /// Roots that failed, or stayed silent while an app inside them played, with why:
    /// the apps under them are captured on their own from then on.
    dropped: HashMap<u32, &'static str>,
    /// The last status line printed, so only changes are reported.
    last_status: String,
}

/// One app's state in the status line, best first when several processes share a name.
fn state_rank(state: &str) -> usize {
    ["ok", "covered", "quiet", "muted", "silent", "failed"].iter().position(|s| *s == state).unwrap_or(9)
}

/// Prints `status {"apps":[{"exe":..,"state":..}]}` to stderr when it changed; the app
/// forwards it to admins (see desktop/src/main/audioHelper.ts). States: "ok" captured and
/// sounding, "covered" heard through a parent's capture, "quiet" captured while silent,
/// "muted" playing but its capture silent, "silent"/"failed" dropped as a root.
fn report_status(
    system: &System,
    candidates: &[(u32, Vec<u32>)],
    roots: &[u32],
    sources: &HashMap<u32, Arc<Capture>>,
    health: &mut Health,
    now: Instant,
) {
    let mut best: HashMap<String, (String, &'static str)> = HashMap::new();
    for (pid, _) in candidates {
        let exe = exe_name(system, *pid);
        if exe.is_empty() {
            continue;
        }
        let state = if let Some(reason) = health.dropped.get(pid) {
            *reason
        } else if !roots.contains(pid) {
            "covered"
        } else if sources.get(pid).and_then(|source| source.last_audible()).is_some_and(|at| now - at < RECENT_SOUND) {
            "ok"
        } else if health.playing_since.get(pid).is_some_and(|since| now - *since >= PLAYING_FOR) {
            "muted"
        } else {
            "quiet"
        };
        let key = exe.to_lowercase();
        let better = best.get(&key).is_none_or(|(_, current)| state_rank(state) < state_rank(current));
        if better {
            best.insert(key, (exe, state));
        }
    }
    let mut apps: Vec<(String, &'static str)> = best.into_values().collect();
    apps.sort();
    let entries: Vec<String> = apps
        .iter()
        .map(|(exe, state)| format!("{{\"exe\":\"{}\",\"state\":\"{}\"}}", json_escape(exe), state))
        .collect();
    let line = format!("status {{\"apps\":[{}]}}", entries.join(","));
    if line != health.last_status {
        eprintln!("{line}");
        health.last_status = line;
    }
}

/// Opens captures for newly playing apps and closes the ones that went away or that
/// a parent capture now covers.
fn rescan(sources: &mut HashMap<u32, Arc<Capture>>, policy: &ExclusionPolicy, system: &mut System, health: &mut Health) -> Res<()> {
    // Names and parents only. The default refresh also reads every process's CPU, memory,
    // disk and path, which took 1.8-6 s with every core busy (a game running) -- and while
    // this ran on the mixer's thread, the live's sound stopped for that long.
    system.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
    let table: Vec<ProcessInfo> = system
        .processes()
        .keys()
        .map(|pid| {
            let pid = pid.as_u32();
            ProcessInfo { pid, exe: exe_name(system, pid), ancestors: ancestors(system, pid) }
        })
        .collect();
    let own_pid = std::process::id();
    let now = Instant::now();
    // The capture clients this helper opens show up as a session of its own.
    let sessions: Vec<ActiveSession> = list_sessions()?.into_iter().filter(|session| session.pid != own_pid).collect();
    for session in &sessions {
        if session.peak > AUDIBLE_PEAK {
            health.playing_since.entry(session.pid).or_insert(now);
        } else {
            health.playing_since.remove(&session.pid);
        }
    }
    let candidates: Vec<(u32, Vec<u32>)> = sessions
        .iter()
        .map(|session| (session.pid, ancestors(system, session.pid)))
        .filter(|(pid, chain)| policy.includes(*pid, &exe_name(system, *pid), chain))
        .filter(|(pid, _)| policy.safe_to_capture(*pid, &table))
        .collect();

    let debug = std::env::var_os("AUDIO_HELPER_DEBUG").is_some();

    // A capture that failed, or that stays silent while an app inside its tree keeps
    // playing, isn't carrying that tree (Windows gives silence, not an error, for what
    // it can't capture): drop it and capture the apps under it on their own.
    for (pid, source) in sources.iter() {
        if source.failed.load(Ordering::Relaxed) {
            health.dropped.entry(*pid).or_insert("failed");
        }
    }
    let running: Vec<RootHealth> = sources
        .iter()
        .filter(|(_, source)| !source.stopped.load(Ordering::Relaxed))
        .map(|(pid, source)| RootHealth { pid: *pid, silent_for: now - source.last_audible().unwrap_or(source.started) })
        .collect();
    let playing: Vec<(u32, Vec<u32>)> = candidates
        .iter()
        .filter(|(pid, _)| health.playing_since.get(pid).is_some_and(|since| now - *since >= PLAYING_FOR))
        .cloned()
        .collect();
    for pid in roots_to_demote(&running, &playing, SILENT_ROOT_AFTER) {
        if debug {
            eprintln!("dropping silent root {pid} ({}): capturing the apps under it instead", exe_name(system, pid));
        }
        health.dropped.entry(pid).or_insert("silent");
    }
    let eligible: Vec<(u32, Vec<u32>)> =
        candidates.iter().filter(|(pid, _)| !health.dropped.contains_key(pid)).cloned().collect();
    let roots = capture_roots(&eligible);

    sources.retain(|pid, source| {
        let keep = roots.contains(pid) && !source.stopped.load(Ordering::Relaxed);
        if !keep {
            source.stopped.store(true, Ordering::Relaxed);
            if debug {
                eprintln!("stop capturing {pid} ({})", exe_name(system, *pid));
            }
        }
        keep
    });
    for pid in &roots {
        sources.entry(*pid).or_insert_with(|| {
            if debug {
                eprintln!("capture {pid} ({}) ancestors {:?}", exe_name(system, *pid), ancestors(system, *pid));
            }
            start_source(*pid)
        });
    }
    report_status(system, &candidates, &roots, sources, health, now);
    Ok(())
}

fn mix_block(inputs: &mut HashMap<u32, MixInput>) -> Vec<f32> {
    let mut mix = vec![0.0f32; BLOCK_SAMPLES];
    for source in inputs.values_mut() {
        let Ok(mut queue) = source.capture.samples.lock() else { continue };
        if !source.primed {
            source.primed = queue.len() >= PRIME_SAMPLES;
            if !source.primed {
                continue;
            }
        }
        let chunk = source.resampler.pull(&mut queue, BLOCK_FRAMES, TARGET_FRAMES);
        if chunk.iter().any(|sample| sample.abs() > AUDIBLE_SAMPLE) {
            source.capture.mark_audible(Instant::now());
        }
        mix_into(&mut mix, &chunk);
        if chunk.len() < BLOCK_SAMPLES {
            // Ran dry: build the cushion up again.
            source.primed = false;
            source.resampler.restart();
        }
    }
    clamp_all(&mut mix);
    mix
}

/// The captures the mixer should read: (pid, capture) for every capture root.
type Roster = Vec<(u32, Arc<Capture>)>;

/// Brings the mixer's inputs in line with the latest roster. A capture it already reads
/// keeps its cushion and resampler; a new one starts priming.
fn apply_roster(inputs: &mut HashMap<u32, MixInput>, roster: Roster) {
    inputs.retain(|pid, input| roster.iter().any(|(p, capture)| p == pid && Arc::ptr_eq(capture, &input.capture)));
    for (pid, capture) in roster {
        inputs.entry(pid).or_insert_with(|| MixInput { capture, primed: false, resampler: DriftResampler::new() });
    }
}

/// Finds the apps to capture, once a second, on a thread of its own: scanning processes
/// and audio sessions can take a long while on a busy PC, and the mixer must never wait
/// for it -- every 10 ms block it holds back is a gap in the live's sound.
fn scan_loop(policy: ExclusionPolicy, rosters: mpsc::Sender<Roster>) {
    if let Err(error) = initialize_mta().ok() {
        eprintln!("session scanner failed to start: {error}");
        return;
    }
    let mut system = process_table();
    let mut sources: HashMap<u32, Arc<Capture>> = HashMap::new();
    let mut health = Health::default();
    loop {
        if let Err(error) = rescan(&mut sources, &policy, &mut system, &mut health) {
            eprintln!("session scan failed: {error}");
        }
        let roster = sources.iter().map(|(pid, capture)| (*pid, Arc::clone(capture))).collect();
        if rosters.send(roster).is_err() {
            return; // the mixer is gone
        }
        thread::sleep(RESCAN_INTERVAL);
    }
}

fn run_capture(args: &Args) -> Res<()> {
    // The app closes our stdin when it stops the live or quits; nothing else should
    // keep this process alive and capturing.
    thread::spawn(|| {
        let mut sink = [0u8; 64];
        while matches!(io::stdin().read(&mut sink), Ok(n) if n > 0) {}
        std::process::exit(0);
    });

    let policy = ExclusionPolicy::new(&args.exclude, args.exclude_pid);
    let (roster_sender, rosters) = mpsc::channel();
    thread::spawn(move || scan_loop(policy, roster_sender));

    let mut inputs: HashMap<u32, MixInput> = HashMap::new();
    let mut stdout = io::stdout().lock();
    let mut schedule_start = Instant::now();
    let mut blocks_written: u32 = 0;

    loop {
        if let Some(roster) = rosters.try_iter().last() {
            apply_roster(&mut inputs, roster);
        }

        let bytes: Vec<u8> = mix_block(&mut inputs).iter().flat_map(|s| s.to_le_bytes()).collect();
        if stdout.write_all(&bytes).and_then(|()| stdout.flush()).is_err() {
            return Ok(()); // the app stopped reading
        }

        blocks_written += 1;
        let due = schedule_start + Duration::from_millis(10) * blocks_written;
        let now = Instant::now();
        if due > now {
            thread::sleep(due - now);
        } else if now - due > MAX_SCHEDULE_LAG {
            schedule_start = now;
            blocks_written = 0;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_capture_remembers_when_it_was_last_heard() {
        let capture = Capture::new();
        assert_eq!(capture.last_audible(), None);

        let heard = capture.started + Duration::from_millis(1500);
        capture.mark_audible(heard);

        assert_eq!(capture.last_audible(), Some(heard));
    }

    #[test]
    fn the_roster_keeps_a_running_input_and_its_cushion() {
        let kept = Arc::new(Capture::new());
        let mut inputs = HashMap::new();
        apply_roster(&mut inputs, vec![(1, Arc::clone(&kept))]);
        inputs.get_mut(&1).unwrap().primed = true;

        apply_roster(&mut inputs, vec![(1, Arc::clone(&kept))]);

        assert!(inputs[&1].primed);
    }

    #[test]
    fn the_roster_adds_new_captures_and_drops_gone_or_replaced_ones() {
        let gone = Arc::new(Capture::new());
        let replaced = Arc::new(Capture::new());
        let mut inputs = HashMap::new();
        apply_roster(&mut inputs, vec![(1, gone), (2, replaced)]);
        inputs.get_mut(&2).unwrap().primed = true;

        let fresh = Arc::new(Capture::new());
        let added = Arc::new(Capture::new());
        apply_roster(&mut inputs, vec![(2, Arc::clone(&fresh)), (3, Arc::clone(&added))]);

        let mut pids: Vec<u32> = inputs.keys().copied().collect();
        pids.sort();
        assert_eq!(pids, vec![2, 3]);
        assert!(Arc::ptr_eq(&inputs[&2].capture, &fresh));
        assert!(!inputs[&2].primed, "a new capture under an old pid primes from scratch");
    }
}

fn main() {
    let result = parse_args().and_then(|args| {
        initialize_mta().ok()?;
        match args.command.as_str() {
            "sessions" => print_sessions(&args),
            "capture" => run_capture(&args),
            other => Err(format!("unknown command {other}").into()),
        }
    });
    if let Err(error) = result {
        eprintln!("audio-helper: {error}");
        std::process::exit(1);
    }
}
