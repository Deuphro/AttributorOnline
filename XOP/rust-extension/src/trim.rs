use wasm_bindgen::prelude::*;

// Consistency factor turning a median absolute deviation into the standard
// deviation of a normal distribution: sigma = 1.4826 * MAD.
const MAD_TO_SIGMA: f64 = 1.4826;

// A moving average window of one point is a bare copy: the residual would be
// identically zero, and a zero sigma would make every k*MAD threshold collapse
// onto 0 and keep the whole wave. Odd window, at least three points.
pub const MIN_MAD_WINDOW: usize = 3;

//Log-histogram bar density. Six bars per decade is dense enough to show the
//shape of a distribution and coarse enough that consecutive bars are not single
//points. The total bar count is then derived from the span of the data.
const LOG_BINS_PER_DECADE: f64 = 6.0;
//Below this the frame would be unreadable, whatever the span says.
const MIN_LOG_BINS: usize = 8;

/// A trimmed wave plus everything the shell needs to redraw its frame.
#[wasm_bindgen]
pub struct TrimResult {
    points_x: Vec<f64>,
    points_y: Vec<f64>,
    kept_indices: Vec<f64>,
    kept_count: usize,
    total_count: usize,
    low_bound: f64,
    high_bound: f64,
    sigma: f64,
    threshold: f64,
}

#[wasm_bindgen]
impl TrimResult {
    #[wasm_bindgen(getter)] pub fn points_x(&self) -> Vec<f64> { self.points_x.clone() }
    #[wasm_bindgen(getter)] pub fn points_y(&self) -> Vec<f64> { self.points_y.clone() }
    #[wasm_bindgen(getter)] pub fn kept_indices(&self) -> Vec<f64> { self.kept_indices.clone() }
    #[wasm_bindgen(getter)] pub fn kept_count(&self) -> usize { self.kept_count }
    #[wasm_bindgen(getter)] pub fn total_count(&self) -> usize { self.total_count }
    #[wasm_bindgen(getter)] pub fn low_bound(&self) -> f64 { self.low_bound }
    #[wasm_bindgen(getter)] pub fn high_bound(&self) -> f64 { self.high_bound }
    #[wasm_bindgen(getter)] pub fn sigma(&self) -> f64 { self.sigma }
    #[wasm_bindgen(getter)] pub fn threshold(&self) -> f64 { self.threshold }
}

/// One histogram bar: the graph needs centres and counts, nothing else.
#[wasm_bindgen]
pub struct TrimHistogram {
    centres: Vec<f64>,
    counts: Vec<f64>,
    min: f64,
    max: f64,
    //values that could not be placed on the chosen scale (non-positive in log
    //mode): the bar counts then add up to total - dropped, not to total
    dropped: usize,
}

#[wasm_bindgen]
impl TrimHistogram {
    #[wasm_bindgen(getter)] pub fn centres(&self) -> Vec<f64> { self.centres.clone() }
    #[wasm_bindgen(getter)] pub fn counts(&self) -> Vec<f64> { self.counts.clone() }
    #[wasm_bindgen(getter)] pub fn min(&self) -> f64 { self.min }
    #[wasm_bindgen(getter)] pub fn max(&self) -> f64 { self.max }
    #[wasm_bindgen(getter)] pub fn dropped(&self) -> usize { self.dropped }
}

/// Splits a canonical core into its x and y halves. `stride` is the core
/// layout, NOT a subsampling rate: 2 is [x0..xN, y0..yN], 1 is [y0..yN].
fn split<'a>(core: &'a [f64], stride: usize) -> (&'a [f64], &'a [f64]) {
    if stride == 2 {
        let n = core.len() / 2;
        (&core[..n], &core[n..2 * n])
    } else {
        (&core[..], &core[..])
    }
}

/// Median of an ALREADY SORTED slice. Odd and even lengths are both handled:
/// an even length averages the two central values.
fn median(sorted: &[f64]) -> f64 {
    let n = sorted.len();
    if n == 0 {
        return f64::NAN;
    }
    if n % 2 == 1 {
        sorted[n / 2]
    } else {
        0.5 * (sorted[n / 2 - 1] + sorted[n / 2])
    }
}
/// Residual of a centred moving average of width `window`. The ends have no
/// full window, so they borrow the nearest partial average: padding with zeros
/// would invent a step at each border and a false noise floor. The prefix sums
/// keep it O(n) whatever the window width.
pub fn moving_average_residual(y: &[f64], window: usize) -> Vec<f64> {
    let n = y.len();
    if n == 0 {
        return Vec::new();
    }
    let window = window.max(1);
    let half = window / 2;
    let mut prefix = vec![0.0; n + 1];
    for i in 0..n {
        prefix[i + 1] = prefix[i] + y[i];
    }
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let start = i.saturating_sub(half);
        let end = (i + half + 1).min(n);
        let mean = (prefix[end] - prefix[start]) / (end - start) as f64;
        out.push(y[i] - mean);
    }
    out
}

/// Noise estimate on the moving-average residual: 1.4826 * median(|r|).
/// Robust by construction, so a handful of real peaks cannot inflate it the
/// way a standard deviation would.
pub fn residual_sigma(y: &[f64], window: usize) -> f64 {
    let residual = moving_average_residual(y, window);
    if residual.is_empty() {
        return 0.0;
    }
    let mut deviations: Vec<f64> = residual.iter().map(|r| r.abs()).collect();
    deviations.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    MAD_TO_SIGMA * median(&deviations)
}

/// Numeric knobs, one struct so the wasm boundary stays a flat argument list.
pub struct TrimParams {
    pub k: f64,
    pub window: usize,
    pub threshold: f64,
}

impl Default for TrimParams {
    fn default() -> Self {
        TrimParams { k: 5.0, window: 9, threshold: 0.1 }
    }
}

/// The guess the UI asks for when the method is selected or the Guess button
/// is pressed: the low cursor lands on the method threshold. The high bound
/// comes back NaN, meaning "no opinion": the shell then keeps the user cursor.
///
/// madResidual is a RELATIVE test: sigma measures the noise around a level, so
/// the threshold must be `baseline + k*sigma`. Using k*sigma alone would be an
/// absolute cut at 0, and on a spectrum whose baseline sits at 100 it would
/// either cut nothing (k small) or wipe the whole signal (k large). The
/// baseline is the MEDIAN, not the mean: a handful of intense peaks must not
/// drag the level up and hide the noise they sit on.
pub fn guess_bounds(y: &[f64], method: &str, params: &TrimParams) -> (f64, f64) {
    match method {
        "madResidual" => {
            let sigma = residual_sigma(y, params.window);
            (baseline_level(y) + sigma * params.k, f64::NAN)
        }
        "intensityThreshold" => (params.threshold, f64::NAN),
        // passthrough trims nothing: an infinite low bound keeps every point
        _ => (f64::NEG_INFINITY, f64::INFINITY),
    }
}

/// Median of the values: the robust "where the signal sits" estimate.
fn baseline_level(y: &[f64]) -> f64 {
    let mut values: Vec<f64> = y.iter().copied().filter(|v| !v.is_nan()).collect();
    if values.is_empty() {
        return 0.0;
    }
    values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    median(&values)
}
/// Trims a wave. `method` is one of "passthrough", "madResidual",
/// "intensityThreshold"; an unknown name falls back to passthrough rather than
/// returning nothing, so a stale front end still resolves its flow.
/// `low_bound`/`high_bound` are the user cursors: a non-finite one means "the
/// method decides", and the two are intersected, never overridden.
#[wasm_bindgen]
pub fn trim_wave(
    core: &[f64],
    stride: usize,
    method: &str,
    low_bound: f64,
    high_bound: f64,
    k: f64,
    window: f64,
    threshold: f64,
) -> TrimResult {
    let (x, y) = split(core, stride);
    let params = TrimParams {
        k: if k.is_finite() { k } else { 5.0 },
        window: if window.is_finite() && window >= MIN_MAD_WINDOW as f64 {
            window.round() as usize
        } else {
            9
        },
        threshold: if threshold.is_finite() { threshold } else { 0.1 },
    };
    let method = match method {
        "madResidual" | "intensityThreshold" | "passthrough" => method,
        _ => "passthrough",
    };
    let sigma = if method == "madResidual" { residual_sigma(y, params.window) } else { 0.0 };
    let method_low = guess_bounds(y, method, &params).0;
    // A FINITE cursor is authoritative: it is the value the user placed, and it
    // is what defines the trim. The method only SEEDS an absent cursor (NaN), it
    // is not a permanent floor. Taking max(cursor, method) would make it
    // impossible to drag a bound below the guessed threshold, which is exactly
    // the move the frame exists to allow.
    let low = if low_bound.is_finite() { low_bound } else { method_low };
    let high = high_bound;

    let mut points_x = Vec::new();
    let mut points_y = Vec::new();
    let mut kept_indices = Vec::new();
    for i in 0..y.len() {
        let value = y[i];
        // A NaN compares false against every bound, so it has to be filtered
        // out explicitly or it would silently poison the output.
        if value.is_nan() {
            continue;
        }
        if value < low || (high.is_finite() && value > high) {
            continue;
        }
        points_x.push(if stride == 2 { x[i] } else { i as f64 });
        points_y.push(value);
        kept_indices.push(i as f64);
    }
    let kept_count = points_x.len();
    let total_count = y.len();
    TrimResult {
        points_x,
        points_y,
        kept_indices,
        kept_count,
        total_count,
        low_bound: low,
        high_bound: high,
        sigma,
        threshold: low,
    }
}
/// Histogram of the wave values, in the same "binned value / count" shape the
/// trimmer frame already draws. `scale` is "linear" (evenly spaced values) or
/// "log" (evenly spaced DECADES, i.e. log10 of the value).
///
/// A linear histogram of a spectrum spanning five orders of magnitude is
/// useless: every bar piles into the first one and the rest is empty. Binning
/// evenly in log10 gives one bar per decade fraction, which is what makes the
/// distribution readable.
///
/// In log mode the bar CENTRES are geometric means, so that a log-scaled value
/// axis spaces the bars evenly on screen. Non-positive values have no log10 and
/// are left out of the log histogram; `dropped` reports how many, so the shell
/// can say so instead of silently showing a distribution that does not add up.
#[wasm_bindgen]
pub fn trim_histogram(core: &[f64], stride: usize, bins: usize, scale: &str) -> TrimHistogram {
    let (_x, y) = split(core, stride);
    let bins = bins.max(1);
    if y.is_empty() {
        return TrimHistogram { centres: Vec::new(), counts: Vec::new(), min: 0.0, max: 0.0, dropped: 0 };
    }
    if scale == "log" {
        //A log histogram spread over a fixed bar COUNT is usually useless: 60
        //bars over 2 decades is a third of a decade per bar, and a real spectrum
        //(a tight noise floor plus a few peaks) lands in a handful of them, so
        //the frame comes out mostly EMPTY. What reads well is a fixed density
        //per decade instead, so the bar count follows the span of the data.
        let span = log10_span(y);
        let wanted = if span > 0.0 {
            (span * LOG_BINS_PER_DECADE).round() as usize
        } else {
            0
        };
        // min/max rather than clamp: clamp(low, high) PANICS when low > high, and
        // the caller is free to ask for fewer bars than MIN_LOG_BINS. A panic
        // inside wasm kills the whole worker, not just this call.
        let effective = bins.min(wanted.max(MIN_LOG_BINS));
        return log_histogram(y, effective.max(1));
    }
    let mut min = f64::INFINITY;
    let mut max = f64::NEG_INFINITY;
    for &value in y {
        if value.is_nan() { continue; }
        if value < min { min = value; }
        if value > max { max = value; }
    }
    if !min.is_finite() || !max.is_finite() {
        min = 0.0;
        max = 0.0;
    }
    let width = (max - min) / bins as f64;
    let mut counts = vec![0.0; bins];
    for &value in y {
        if value.is_nan() { continue; }
        // A flat wave has width 0: the clamp keeps the index inside the bins.
        let index = if width > 0.0 {
            (((value - min) / width) as isize).clamp(0, bins as isize - 1) as usize
        } else {
            0
        };
        counts[index] += 1.0;
    }
    let step = if width > 0.0 { width } else { 1.0 };
    let centres = (0..bins).map(|i| min + (i as f64 + 0.5) * step).collect();
    TrimHistogram { centres, counts, min, max, dropped: 0 }
}

/// Span in decades of the strictly positive values, 0.0 when there is none.
fn log10_span(y: &[f64]) -> f64 {
    let mut lo = f64::INFINITY;
    let mut hi = f64::NEG_INFINITY;
    for &value in y {
        if value.is_nan() || value <= 0.0 {
            continue;
        }
        let lg = value.log10();
        if lg < lo { lo = lg; }
        if lg > hi { hi = lg; }
    }
    if !lo.is_finite() || !hi.is_finite() {
        return 0.0;
    }
    hi - lo
}

/// Evenly spaced bins in log10(value). Falls back to a single bin when the data
/// has no spread in log space, rather than dividing by zero.
fn log_histogram(y: &[f64], bins: usize) -> TrimHistogram {
    let mut lo = f64::INFINITY;
    let mut hi = f64::NEG_INFINITY;
    let mut dropped = 0usize;
    for &value in y {
        if value.is_nan() || value <= 0.0 {
            //no log10: zero, negatives and NaN cannot be placed on a log axis
            dropped += 1;
            continue;
        }
        let lg = value.log10();
        if lg < lo { lo = lg; }
        if lg > hi { hi = lg; }
    }
    if !lo.is_finite() || !hi.is_finite() {
        return TrimHistogram { centres: Vec::new(), counts: Vec::new(), min: 0.0, max: 0.0, dropped };
    }
    let width = (hi - lo) / bins as f64;
    let mut counts = vec![0.0; bins];
    for &value in y {
        if value.is_nan() || value <= 0.0 { continue; }
        let index = if width > 0.0 {
            (((value.log10() - lo) / width) as isize).clamp(0, bins as isize - 1) as usize
        } else {
            0
        };
        counts[index] += 1.0;
    }
    let step = if width > 0.0 { width } else { 1.0 };
    //geometric centre of the decade interval, NOT its arithmetic middle: the
    //value axis is log-scaled, so only the geometric mean lands where the bar
    //appears at the centre of its slot
    let centres = (0..bins)
        .map(|i| 10f64.powf(lo + (i as f64 + 0.5) * step))
        .collect();
    TrimHistogram { centres, counts, min: 10f64.powf(lo), max: 10f64.powf(hi), dropped }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn core_xy(x: &[f64], y: &[f64]) -> Vec<f64> {
        let mut core = x.to_vec();
        core.extend_from_slice(y);
        core
    }

    #[test]
    fn passthrough_keeps_everything() {
        let core = core_xy(&[0.0, 1.0, 2.0], &[1.0, 2.0, 3.0]);
        let out = trim_wave(&core, 2, "passthrough", f64::NAN, f64::NAN, 5.0, 9.0, 0.1);
        assert_eq!(out.kept_count(), 3);
        assert_eq!(out.total_count(), 3);
    }

    #[test]
    fn unknown_method_falls_back_to_passthrough() {
        let core = core_xy(&[0.0, 1.0], &[4.0, 5.0]);
        let out = trim_wave(&core, 2, "nope", f64::NAN, f64::NAN, 5.0, 9.0, 0.1);
        assert_eq!(out.kept_count(), 2);
    }

    #[test]
    fn intensity_threshold_drops_the_low_tail() {
        let y = [0.05, 0.2, 0.4, 0.9];
        let out = trim_wave(&y, 1, "intensityThreshold", f64::NAN, f64::NAN, 5.0, 9.0, 0.1);
        assert_eq!(out.total_count(), 4);
        assert_eq!(out.kept_count(), 3);
        // dropped points are reported by index, so the shell can highlight them
        assert_eq!(out.kept_indices(), vec![1.0, 2.0, 3.0]);
        assert!((out.threshold() - 0.1).abs() < 1e-12);
    }

    #[test]
    fn a_user_cursor_clips_the_method_threshold() {
        let y = [0.05, 0.2, 0.4, 0.9];
        let out = trim_wave(&y, 1, "intensityThreshold", 0.3, 0.5, 5.0, 9.0, 0.1);
        // 0.3 is stricter than the 0.1 method threshold, and 0.5 caps the top
        assert_eq!(out.kept_count(), 1);
        assert!((out.low_bound() - 0.3).abs() < 1e-12);
    }

    #[test]
    fn a_user_cursor_wins_over_the_method_threshold() {
        // The method threshold (0.1) is only a SEED. Once the user has placed a
        // cursor at -1, that cursor defines the trim: taking max(cursor, method)
        // here would make it impossible to drag below the guessed threshold.
        let y = [0.05, 0.2, 0.4, 0.9];
        let out = trim_wave(&y, 1, "intensityThreshold", -1.0, f64::NAN, 5.0, 9.0, 0.1);
        assert_eq!(out.kept_count(), 4);
        assert!((out.low_bound - (-1.0)).abs() < 1e-12);
    }

    #[test]
    fn an_absent_cursor_takes_the_method_threshold() {
        // NaN cursor = "the method decides", which is what the Guess button sends
        let y = [0.05, 0.2, 0.4, 0.9];
        let out = trim_wave(&y, 1, "intensityThreshold", f64::NAN, f64::NAN, 5.0, 9.0, 0.1);
        assert_eq!(out.kept_count(), 3);
        assert!((out.low_bound - 0.1).abs() < 1e-12);
    }

    #[test]
    fn a_high_cursor_above_the_maximum_keeps_everything() {
        let y = [1.0, 2.0, 3.0];
        let out = trim_wave(&y, 1, "passthrough", f64::NAN, 1e9, 5.0, 9.0, 0.1);
        assert_eq!(out.kept_count(), 3);
    }

    #[test]
    fn mad_residual_trims_a_quiet_wave_but_not_a_spiky_one() {
        // flat noise around 1: baseline + 5 sigma is ABOVE the whole wave, so
        // the method correctly drops all of it
        let quiet = [1.0, 1.02, 0.99, 1.01, 1.0, 0.98, 1.03, 1.0, 0.99];
        let out = trim_wave(&quiet, 1, "madResidual", f64::NAN, f64::NAN, 5.0, 3.0, 0.1);
        assert!(out.sigma() > 0.0);
        assert_eq!(out.kept_count(), 0);

        // a monotone ramp has a flat residual plateau, so its sigma is tiny and
        // the threshold lands on its own median: the low half goes, the top
        // half carries the signal and MUST survive
        let ramp = [0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0];
        let out = trim_wave(&ramp, 1, "madResidual", f64::NAN, f64::NAN, 5.0, 3.0, 0.1);
        assert!(out.kept_count() > 0);
        assert!(out.kept_count() < ramp.len());
        //the survivors are the TOP of the ramp, in order
        let last = out.points_y[out.kept_count - 1];
        assert!((last - 8.0).abs() < 1e-12);

        // and a signal rising well above its own noise keeps its top half only
        let signal = [1.0, 1.01, 0.99, 1.0, 1.02, 0.98, 1.0, 5.0, 9.0, 12.0];
        let out = trim_wave(&signal, 1, "madResidual", f64::NAN, f64::NAN, 5.0, 3.0, 0.1);
        assert!(out.kept_count() > 0);
        assert!(out.kept_count() < signal.len());
    }

    #[test]
    fn mad_sigma_is_robust_against_a_single_spike() {
        let clean = [1.0, 1.01, 0.99, 1.0, 1.02, 0.98, 1.0, 1.01, 0.99];
        let spiky = [1000.0, 1.01, 0.99, 1.0, 1.02, 0.98, 1.0, 1.01, 0.99];
        let a = residual_sigma(&clean, 3);
        let b = residual_sigma(&spiky, 3);
        // a median ignores the spike: sigma barely moves
        assert!((b - a).abs() <= 0.5 * a + 1e-12);
    }

    #[test]
    fn mad_guess_is_baseline_plus_k_times_sigma() {
        let y = [1.0, 1.02, 0.99, 1.01, 1.0, 0.98, 1.03, 1.0, 0.99];
        let params = TrimParams { k: 5.0, window: 3, threshold: 0.1 };
        let (low, high) = guess_bounds(&y, "madResidual", &params);
        let expected = baseline_level(&y) + 5.0 * residual_sigma(&y, 3);
        assert!((low - expected).abs() < 1e-12);
        assert!(high.is_nan());
    }

    #[test]
    fn mad_guess_follows_a_raised_baseline() {
        //the same noise, sitting on a level of 1000: the threshold must move
        //with it, an absolute k*sigma would keep the entire signal
        let flat = [1000.0, 1000.02, 999.99, 1000.01, 1000.0, 999.98, 1000.03, 1000.0, 999.99];
        let params = TrimParams { k: 5.0, window: 3, threshold: 0.1 };
        let (low, _high) = guess_bounds(&flat, "madResidual", &params);
        assert!(low > 1000.0, "the threshold must sit ABOVE the baseline");
        let out = trim_wave(&flat, 1, "madResidual", f64::NAN, f64::NAN, 5.0, 3.0, 0.1);
        //only the points above baseline + 5 sigma survive, and on flat noise
        //that is a strict subset: the method still does something
        assert!(out.kept_count() < flat.len());
    }

    #[test]
    fn baseline_ignores_a_few_peaks() {
        //a median is unmoved by a minority of huge values, a mean would jump
        let y = [10.0, 10.0, 10.0, 10.0, 10.0, 1000.0, 2000.0, 3000.0];
        assert!((baseline_level(&y) - 10.0).abs() < 1e-12);
    }

    #[test]
    fn baseline_of_an_empty_or_all_nan_wave_is_zero() {
        assert_eq!(baseline_level(&[]), 0.0);
        assert_eq!(baseline_level(&[f64::NAN, f64::NAN]), 0.0);
    }

    #[test]
    fn residual_of_a_constant_wave_is_zero() {
        for r in moving_average_residual(&[2.0; 10], 5) {
            assert!(r.abs() < 1e-12);
        }
    }

    #[test]
    fn median_reads_an_already_sorted_slice() {
        assert!((median(&[1.0, 2.0, 3.0]) - 2.0).abs() < 1e-12);
        assert!((median(&[1.0, 2.0, 3.0, 4.0]) - 2.5).abs() < 1e-12);
    }

    #[test]
    fn nans_are_never_kept() {
        let out = trim_wave(&[1.0, f64::NAN, 2.0], 1, "passthrough", f64::NAN, f64::NAN, 5.0, 9.0, 0.1);
        assert_eq!(out.kept_count(), 2);
        assert_eq!(out.total_count(), 3);
    }

    #[test]
    fn xy_output_carries_the_original_x() {
        let core = core_xy(&[10.0, 20.0, 30.0], &[1.0, 6.0, 9.0]);
        let out = trim_wave(&core, 2, "intensityThreshold", f64::NAN, f64::NAN, 5.0, 9.0, 5.0);
        assert_eq!(out.points_x(), vec![20.0, 30.0]);
        assert_eq!(out.points_y(), vec![6.0, 9.0]);
    }

    #[test]
    fn stride_one_reports_the_index_as_x() {
        let out = trim_wave(&[1.0, 2.0], 1, "passthrough", f64::NAN, f64::NAN, 5.0, 9.0, 0.1);
        assert_eq!(out.points_x(), vec![0.0, 1.0]);
    }

    #[test]
    fn an_empty_wave_resolves_empty() {
        let out = trim_wave(&[], 1, "passthrough", f64::NAN, f64::NAN, 5.0, 9.0, 0.1);
        assert_eq!(out.kept_count(), 0);
        assert_eq!(out.total_count(), 0);
    }

    #[test]
    fn histogram_counts_sum_to_the_wave_length() {
        let hist = trim_histogram(&[0.0, 0.1, 0.2, 0.3, 0.4, 0.5], 1, 3, "linear");
        assert_eq!(hist.centres().len(), 3);
        let total: f64 = hist.counts().iter().sum();
        assert!((total - 6.0).abs() < 1e-12);
        // 0..0.5 over 3 bars of 1/6: the bins catch 0, 0.1 / 0.2, 0.3 / 0.4, 0.5,
        // and the maximum is clamped INTO the top bar rather than dropped
        assert!((hist.counts()[0] - 2.0).abs() < 1e-12);
        assert!((hist.counts()[1] - 2.0).abs() < 1e-12);
        assert!((hist.counts()[2] - 2.0).abs() < 1e-12);
    }

    #[test]
    fn histogram_survives_a_flat_wave() {
        let hist = trim_histogram(&[7.0; 5], 1, 4, "linear");
        assert_eq!(hist.centres().len(), 4);
        let total: f64 = hist.counts().iter().sum();
        assert!((total - 5.0).abs() < 1e-12);
        assert!((hist.min() - 7.0).abs() < 1e-12);
    }

    #[test]
    fn histogram_of_an_empty_wave_is_empty() {
        assert!(trim_histogram(&[], 1, 10, "linear").centres().is_empty());
    }

    #[test]
    fn a_single_bin_never_drops_a_point() {
        let hist = trim_histogram(&[1.0, 2.0, 3.0, 4.0], 1, 1, "linear");
        assert!((hist.counts()[0] - 4.0).abs() < 1e-12);
    }

    #[test]
    fn log_bins_are_evenly_spaced_in_decades() {
        // 6 decades, 6 bars per decade: 36 bars. The values are spread over the
        // decades, so they must land in MANY different bars - that is what
        // distinguishes a log histogram from a linear one, where they would all
        // pile into the first bar.
        let y = [1.0, 5.0, 1e1, 5e1, 1e2, 5e2, 1e3, 5e3, 1e4, 5e4, 1e5, 5e5, 1e6];
        let hist = trim_histogram(&y, 1, 60, "log");
        assert_eq!(hist.centres().len(), 36);
        let total: f64 = hist.counts().iter().sum();
        assert!((total - 13.0).abs() < 1e-12);
        // the 13 values occupy 13 distinct bars: one per value, no collision
        let occupied = hist.counts().iter().filter(|c| **c > 0.0).count();
        assert_eq!(occupied, 13);
        // and every bar centre sits a sixth of a decade from the next
        let logs: Vec<f64> = hist.centres().iter().map(|c| c.log10()).collect();
        let gap = logs[1] - logs[0];
        for i in 1..logs.len() - 1 {
            assert!(((logs[i + 1] - logs[i]) - gap).abs() < 1e-9);
        }
    }

    #[test]
    fn asking_for_fewer_bars_than_the_floor_does_not_panic() {
        // a wasm panic kills the whole worker, not just the call: asking for
        // fewer bars than MIN_LOG_BINS must clamp, not explode
        for asked in 1..=4 {
            let hist = trim_histogram(&[1.0, 1e6], 1, asked, "log");
            assert_eq!(hist.centres().len(), asked, "the caller's ceiling must win");
        }
    }

    #[test]
    fn the_log_bar_count_follows_the_span_not_the_request() {
        // 6 decades at 6 bars per decade = 36 bars, NOT the 60 that were asked
        // for: a fixed count over a narrow spectrum is what makes the frame look
        // empty
        let wide = [1e0, 1e6];
        let hist = trim_histogram(&wide, 1, 60, "log");
        assert_eq!(hist.centres().len(), 36);
        // and the request stays an upper bound
        let capped = trim_histogram(&wide, 1, 10, "log");
        assert_eq!(capped.centres().len(), 10);
    }

    #[test]
    fn a_narrow_spectrum_still_gets_a_readable_number_of_bars() {
        // 100..200 is barely a third of a decade: the density rule would ask for
        // 2 bars, which is unreadable, so the floor applies
        let narrow = [100.0, 200.0];
        let hist = trim_histogram(&narrow, 1, 60, "log");
        assert_eq!(hist.centres().len(), MIN_LOG_BINS);
    }

    #[test]
    fn log_bin_centres_are_geometric() {
        // 1..1e4 is 4 decades, over 4 bins: one decade per bin, so the centres sit
        // half a decade inside each slot, i.e. 10^0.5, 10^1.5, 10^2.5, 10^3.5.
        // The arithmetic middle of a bin would land in the wrong slot entirely.
        let hist = trim_histogram(&[1.0, 1e4], 1, 4, "log");
        let expected = [0.5f64, 1.5, 2.5, 3.5].map(|e| 10f64.powf(e));
        for (got, want) in hist.centres().iter().zip(expected.iter()) {
            assert!((got / want - 1.0).abs() < 1e-9);
        }
    }

    #[test]
    fn log_centres_are_not_the_arithmetic_midpoint() {
        // guard against the obvious wrong implementation: a 1..1e4 bin must not
        // be centred at (1+1e4)/2, which on a log axis renders near the top
        let hist = trim_histogram(&[1.0, 1e4], 1, 1, "log");
        let naive = 0.5 * (1.0 + 1e4);
        let centre = hist.centres()[0];
        assert!((centre / naive - 1.0).abs() > 0.9);
        // the geometric centre of 1..1e4 is 100
        assert!((centre / 100.0 - 1.0).abs() < 1e-9);
    }

    #[test]
    fn log_histogram_drops_non_positive_values() {
        // zero and negatives have no log10: they are excluded, and `dropped`
        // says so instead of the counts silently failing to add up
        let hist = trim_histogram(&[1.0, 0.0, -5.0, f64::NAN, 1e3], 1, 4, "log");
        let total: f64 = hist.counts().iter().sum();
        assert!((total - 2.0).abs() < 1e-12);
        assert_eq!(hist.dropped(), 3);
    }

    #[test]
    fn log_histogram_of_a_flat_positive_wave_is_one_bin() {
        let hist = trim_histogram(&[7.0; 5], 1, 4, "log");
        let total: f64 = hist.counts().iter().sum();
        assert!((total - 5.0).abs() < 1e-12);
        assert_eq!(hist.dropped(), 0);
    }

    #[test]
    fn log_histogram_with_no_positive_value_is_empty() {
        let hist = trim_histogram(&[0.0, -1.0, -2.0], 1, 4, "log");
        assert!(hist.centres().is_empty());
        assert_eq!(hist.dropped(), 3);
    }

    #[test]
    fn linear_scale_keeps_zero_and_negatives() {
        // the opposite contract: a linear histogram must NOT discard anything
        let hist = trim_histogram(&[-1.0, 0.0, 1.0], 1, 4, "linear");
        let total: f64 = hist.counts().iter().sum();
        assert!((total - 3.0).abs() < 1e-12);
        assert_eq!(hist.dropped(), 0);
    }
}
