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

mod policy;

use std::collections::{HashMap, VecDeque};
use std::io::{self, Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, RefreshKind, System};
use wasapi::{
    AudioClient, DeviceEnumerator, Direction, SampleType, SessionState, StreamMode, WaveFormat,
    initialize_mta,
};

use policy::{ExclusionPolicy, ProcessInfo, capture_roots, clamp_all, json_escape, mix_into};

const SAMPLE_RATE: usize = 48_000;
const CHANNELS: usize = 2;
/// 10 ms per block written to stdout.
const BLOCK_SAMPLES: usize = SAMPLE_RATE / 100 * CHANNELS;
/// A source starts feeding the mix once it holds this much (30 ms): capture packets and
/// mixer ticks run on different clocks, and without a little slack they alternate
/// between "nothing yet" and "two packets", which is heard as crackle.
const PRIME_SAMPLES: usize = BLOCK_SAMPLES * 3;
/// Past this (200 ms) the oldest audio is dropped, so a stalled mixer never drifts late.
const MAX_BUFFERED_SAMPLES: usize = SAMPLE_RATE * CHANNELS / 5;
const RESCAN_INTERVAL: Duration = Duration::from_secs(1);
const EVENT_TIMEOUT_MS: u32 = 200;
/// Falling this far behind the wall clock means the PC stalled; restart the schedule.
const MAX_SCHEDULE_LAG: Duration = Duration::from_millis(200);
const MAX_ANCESTRY_DEPTH: usize = 32;

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
    for device in &enumerator.get_device_collection(&Direction::Render)? {
        let device = device?;
        let enumerated = device.get_iaudiosessionmanager()?.get_audiosessionenumerator()?;
        for index in 0..enumerated.get_count()? {
            let control = enumerated.get_session(index)?;
            if control.get_state()? == SessionState::Expired {
                continue;
            }
            let peak = control
                .get_audiometerinformation()
                .and_then(|meter| meter.get_peak_value())
                .unwrap_or(0.0);
            sessions.push(ActiveSession { pid: control.get_process_id()?, peak });
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

struct Source {
    samples: Arc<Mutex<VecDeque<f32>>>,
    stopped: Arc<AtomicBool>,
    primed: bool,
}

fn read_f32_frames(bytes: &mut VecDeque<u8>, block_align: usize, out: &mut Vec<f32>) {
    let whole = bytes.len() / block_align * block_align;
    let drained: Vec<u8> = bytes.drain(..whole).collect();
    out.extend(drained.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])));
}

/// One process tree's audio, pushed into `samples` until `stopped` is set or the
/// process goes away.
fn capture_loop(pid: u32, samples: Arc<Mutex<VecDeque<f32>>>, stopped: Arc<AtomicBool>) -> Res<()> {
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
    while !stopped.load(Ordering::Relaxed) {
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
        let mut queue = samples.lock().map_err(|_| "sample queue poisoned")?;
        queue.extend(decoded.iter());
        let overflow = queue.len().saturating_sub(MAX_BUFFERED_SAMPLES);
        queue.drain(..overflow);
    }
    client.stop_stream()?;
    Ok(())
}

fn start_source(pid: u32) -> Source {
    let samples = Arc::new(Mutex::new(VecDeque::new()));
    let stopped = Arc::new(AtomicBool::new(false));
    let (thread_samples, thread_stopped) = (Arc::clone(&samples), Arc::clone(&stopped));
    thread::spawn(move || {
        if let Err(error) = capture_loop(pid, thread_samples, Arc::clone(&thread_stopped)) {
            eprintln!("capture of process {pid} ended: {error}");
        }
        thread_stopped.store(true, Ordering::Relaxed);
    });
    Source { samples, stopped, primed: false }
}

/// Opens captures for newly playing apps and closes the ones that went away or that
/// a parent capture now covers.
fn rescan(sources: &mut HashMap<u32, Source>, policy: &ExclusionPolicy, system: &mut System) -> Res<()> {
    system.refresh_processes(ProcessesToUpdate::All, true);
    let table: Vec<ProcessInfo> = system
        .processes()
        .keys()
        .map(|pid| {
            let pid = pid.as_u32();
            ProcessInfo { pid, exe: exe_name(system, pid), ancestors: ancestors(system, pid) }
        })
        .collect();
    let own_pid = std::process::id();
    let candidates: Vec<(u32, Vec<u32>)> = list_sessions()?
        .into_iter()
        // The capture clients this helper opens show up as a session of its own.
        .filter(|session| session.pid != own_pid)
        .map(|session| (session.pid, ancestors(system, session.pid)))
        .filter(|(pid, chain)| policy.includes(*pid, &exe_name(system, *pid), chain))
        .filter(|(pid, _)| policy.safe_to_capture(*pid, &table))
        .collect();
    let roots = capture_roots(&candidates);

    let debug = std::env::var_os("AUDIO_HELPER_DEBUG").is_some();
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
    for pid in roots {
        sources.entry(pid).or_insert_with(|| {
            if debug {
                eprintln!("capture {pid} ({}) ancestors {:?}", exe_name(system, pid), ancestors(system, pid));
            }
            start_source(pid)
        });
    }
    Ok(())
}

fn mix_block(sources: &mut HashMap<u32, Source>) -> Vec<f32> {
    let mut mix = vec![0.0f32; BLOCK_SAMPLES];
    for source in sources.values_mut() {
        let Ok(mut queue) = source.samples.lock() else { continue };
        if !source.primed {
            source.primed = queue.len() >= PRIME_SAMPLES;
            if !source.primed {
                continue;
            }
        }
        let take = queue.len().min(BLOCK_SAMPLES);
        let chunk: Vec<f32> = queue.drain(..take).collect();
        mix_into(&mut mix, &chunk);
        if queue.is_empty() {
            source.primed = false; // ran dry: build the cushion up again
        }
    }
    clamp_all(&mut mix);
    mix
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
    let mut system = process_table();
    let mut sources: HashMap<u32, Source> = HashMap::new();
    let mut stdout = io::stdout().lock();
    let mut last_scan: Option<Instant> = None;
    let mut schedule_start = Instant::now();
    let mut blocks_written: u32 = 0;

    loop {
        if last_scan.is_none_or(|at| at.elapsed() >= RESCAN_INTERVAL) {
            if let Err(error) = rescan(&mut sources, &policy, &mut system) {
                eprintln!("session scan failed: {error}");
            }
            last_scan = Some(Instant::now());
        }

        let bytes: Vec<u8> = mix_block(&mut sources).iter().flat_map(|s| s.to_le_bytes()).collect();
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
