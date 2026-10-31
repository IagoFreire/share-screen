//! Clock-drift compensation for each captured app.
//!
//! The mixer writes a block every 10 ms by the wall clock -- the clock the video is
//! stamped with -- while each WASAPI capture delivers samples at its sound card's rate.
//! The two differ by tens of ppm. Read at a fixed rate, a source's queue therefore crept
//! up (its sound falling further behind the picture, toward the 200 ms cap) or ran dry
//! (a 30 ms dropout while it primed again), every few minutes to an hour.
//!
//! Each source is read through a tiny resampler instead, whose speed follows how much
//! the source holds: a hair faster while it holds more than the target, a hair slower
//! while it holds less. At most 500 ppm off, the pitch change is far below hearing.

use std::collections::VecDeque;

/// Interleaved stereo, as everywhere in the helper.
pub const CHANNELS: usize = 2;
/// The furthest the read speed may stray from 1:1.
const MAX_RATIO_DEVIATION: f64 = 0.0005;
/// Speed change per unit of relative queue error (a queue 25% over target hits the cap).
const GAIN: f64 = 0.002;
/// How much of each new queue reading enters the smoothed level, per 10 ms block: about
/// a second's average, so capture packets landing just before or after a block don't
/// wobble the speed.
const SMOOTHING: f64 = 0.01;

pub struct DriftResampler {
    /// Fractional read position into the front frame of the queue.
    position: f64,
    /// Smoothed queue level, in frames; None until the first reading.
    smoothed_frames: Option<f64>,
}

impl DriftResampler {
    pub fn new() -> Self {
        Self { position: 0.0, smoothed_frames: None }
    }

    /// Starts reading from the front again, after the source ran dry and primed anew.
    /// The level estimate is kept: the clock difference it reflects hasn't changed.
    pub fn restart(&mut self) {
        self.position = 0.0;
    }

    /// Input frames consumed per output frame for a source holding `queued_frames`.
    fn ratio(&mut self, queued_frames: usize, target_frames: usize) -> f64 {
        let queued = queued_frames as f64;
        let smoothed = match self.smoothed_frames {
            Some(level) => level + (queued - level) * SMOOTHING,
            None => queued,
        };
        self.smoothed_frames = Some(smoothed);
        let error = (smoothed - target_frames as f64) / target_frames as f64;
        1.0 + (error * GAIN).clamp(-MAX_RATIO_DEVIATION, MAX_RATIO_DEVIATION)
    }

    /// Reads up to `frames` stereo frames from `queue` at the drift-corrected speed,
    /// interpolating between neighbouring samples. Returns fewer when the source runs dry.
    pub fn pull(&mut self, queue: &mut VecDeque<f32>, frames: usize, target_frames: usize) -> Vec<f32> {
        let available = queue.len() / CHANNELS;
        let ratio = self.ratio(available, target_frames);
        let mut out = Vec::with_capacity(frames * CHANNELS);
        for i in 0..frames {
            let at = self.position + i as f64 * ratio;
            let index = at.floor() as usize;
            // Interpolation needs the frame after this one too.
            if index + 1 >= available {
                break;
            }
            let weight = (at - index as f64) as f32;
            for channel in 0..CHANNELS {
                let a = queue[index * CHANNELS + channel];
                let b = queue[(index + 1) * CHANNELS + channel];
                out.push(a + (b - a) * weight);
            }
        }
        let produced = out.len() / CHANNELS;
        let advanced = self.position + produced as f64 * ratio;
        let consumed = (advanced.floor() as usize).min(available);
        self.position = advanced - consumed as f64;
        queue.drain(..consumed * CHANNELS);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BLOCK: usize = 480;
    const TARGET: usize = 1440;

    /// `frames` stereo frames whose left channel counts up from `from`.
    fn ramp(from: usize, frames: usize) -> VecDeque<f32> {
        (from..from + frames).flat_map(|n| [n as f32, -(n as f32)]).collect()
    }

    #[test]
    fn reads_straight_through_when_the_queue_is_on_target() {
        let mut resampler = DriftResampler::new();
        let mut queue = ramp(0, TARGET);

        let out = resampler.pull(&mut queue, BLOCK, TARGET);

        assert_eq!(out, ramp(0, BLOCK).into_iter().collect::<Vec<_>>());
        assert_eq!(queue.len() / CHANNELS, TARGET - BLOCK);
    }

    #[test]
    fn speeds_up_a_little_when_holding_too_much_and_slows_when_too_little() {
        let mut fuller = DriftResampler::new();
        let mut emptier = DriftResampler::new();

        assert!(fuller.ratio(TARGET * 2, TARGET) > 1.0);
        assert!(fuller.ratio(TARGET * 10, TARGET) <= 1.0 + MAX_RATIO_DEVIATION);
        assert!(emptier.ratio(TARGET / 2, TARGET) < 1.0);
    }

    #[test]
    fn returns_what_it_has_when_the_source_runs_dry() {
        let mut resampler = DriftResampler::new();
        let mut queue = ramp(0, 100);

        let out = resampler.pull(&mut queue, BLOCK, TARGET);

        assert!(out.len() / CHANNELS < BLOCK);
        assert!(queue.len() / CHANNELS <= 1);
    }

    /// Ten minutes of a sound card running `ppm` off the mixer's clock: the queue must
    /// stay near its target and never run dry, where a fixed-rate read drifts by
    /// `ppm` x 600 s (180 ms at 300 ppm).
    fn simulate(ppm: f64) -> (usize, usize, usize) {
        let mut resampler = DriftResampler::new();
        let mut queue = ramp(0, TARGET);
        let mut produced = TARGET as f64;
        let mut next_value = TARGET;
        let (mut lowest, mut highest, mut short_pulls) = (usize::MAX, 0, 0);
        for _ in 0..60_000 {
            produced += BLOCK as f64 * (1.0 + ppm * 1e-6);
            let whole = produced.floor() as usize - next_value;
            queue.extend(ramp(next_value, whole));
            next_value += whole;
            let level = queue.len() / CHANNELS;
            lowest = lowest.min(level);
            highest = highest.max(level);
            if resampler.pull(&mut queue, BLOCK, TARGET).len() < BLOCK * CHANNELS {
                short_pulls += 1;
            }
        }
        (lowest, highest, short_pulls)
    }

    #[test]
    fn holds_a_fast_sound_card_near_the_target() {
        let (_, highest, short_pulls) = simulate(300.0);

        assert_eq!(short_pulls, 0);
        assert!(highest < TARGET + 2 * BLOCK, "queue grew to {highest} frames");
    }

    #[test]
    fn holds_a_slow_sound_card_near_the_target() {
        let (lowest, _, short_pulls) = simulate(-300.0);

        assert_eq!(short_pulls, 0);
        assert!(lowest > TARGET - 2 * BLOCK, "queue fell to {lowest} frames");
    }
}
