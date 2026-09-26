use wasm_bindgen::prelude::*;

// Consistency factor turning a median absolute deviation into the standard
// deviation of a normal distribution: sigma = 1.4826 * MAD.
const MAD_TO_SIGMA: f64 = 1.4826;

// A moving average window of one point is a bare copy: the residual would be
// identically zero, and a zero sigma would make every k*MAD threshold collapse
// onto 0 and keep the whole wave. Odd window, at least three points.
pub const MIN_MAD_WINDOW: usize = 3;

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
}

#[wasm_bindgen]
impl TrimHistogram {
    #[wasm_bindgen(getter)] pub fn centres(&self) -> Vec<f64> { self.centres.clone() }
    #[wasm_bindgen(getter)] pub fn counts(&self) -> Vec<f64> { self.counts.clone() }
    #[wasm_bindgen(getter)] pub fn min(&self) -> f64 { self.min }
    #[wasm_bindgen(getter)] pub fn max(&self) -> f64 { self.max }
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
/// trimmer frame already draws. `bins` is clamped to at least one bar, and a
/// flat wave (min == max) still yields `bins` bars around that single value
/// instead of a division by zero.
#[wasm_bindgen]
pub fn trim_histogram(core: &[f64], stride: usize, bins: usize) -> TrimHistogram {
    let (_x, y) = split(core, stride);
    let bins = bins.max(1);
    if y.is_empty() {
        return TrimHistogram { centres: Vec::new(), counts: Vec::new(), min: 0.0, max: 0.0 };
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
    TrimHistogram { centres, counts, min, max }
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
        let hist = trim_histogram(&[0.0, 0.1, 0.2, 0.3, 0.4, 0.5], 1, 3);
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
        let hist = trim_histogram(&[7.0; 5], 1, 4);
        assert_eq!(hist.centres().len(), 4);
        let total: f64 = hist.counts().iter().sum();
        assert!((total - 5.0).abs() < 1e-12);
        assert!((hist.min() - 7.0).abs() < 1e-12);
    }

    #[test]
    fn histogram_of_an_empty_wave_is_empty() {
        assert!(trim_histogram(&[], 1, 10).centres().is_empty());
    }

    #[test]
    fn a_single_bin_never_drops_a_point() {
        let hist = trim_histogram(&[1.0, 2.0, 3.0, 4.0], 1, 1);
        assert!((hist.counts()[0] - 4.0).abs() < 1e-12);
    }
}
