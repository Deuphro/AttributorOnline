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

/// A trimmed wave. Deliberately minimal: the bounds are echoed for the shell,
/// but nothing method-related lives here, because trim_apply is a pure
/// two-bounds primitive.
#[wasm_bindgen]
pub struct TrimResult {
    points_x: Vec<f64>,
    points_y: Vec<f64>,
    kept_indices: Vec<f64>,
    kept_count: usize,
    total_count: usize,
    low_bound: f64,
    high_bound: f64,
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

/// The guess, on the raw values. Kept as a named function because the tests
/// state the rule in these terms: madResidual is a RELATIVE test, so the
/// threshold is `baseline + k*sigma`, never the absolute `k*sigma`. Using the
/// latter would cut at 0 and either trim nothing or wipe the signal, depending
/// on the baseline. The baseline is the MEDIAN so that a few intense peaks
/// cannot drag the level up and hide the noise they sit on.
pub fn guess_bounds(y: &[f64], method: &str, params: &TrimParams) -> f64 {
    match method {
        "madResidual" => baseline_level(y) + residual_sigma(y, params.window) * params.k,
        "intensityThreshold" => params.threshold,
        _ => f64::NEG_INFINITY,
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
/// Where the SELECTED method wants the low cursor to sit, as a single number.
///
/// Deliberately returns one f64 and allocates nothing: the shell only needs the
/// threshold, and the previous design had it call the full trim and throw away
/// every kept point but that number - three vectors built, three clones out of
/// wasm, megabytes through postMessage, all discarded.
///
/// An unknown method name falls back to passthrough (an infinite low bound),
/// so a stale front end still resolves its flow.
#[wasm_bindgen]
pub fn trim_guess(core: &[f64], stride: usize, method: &str, k: f64, window: f64, threshold: f64) -> f64 {
    let (_x, y) = split(core, stride);
    guess_bounds(y, method, &normalise_params(k, window, threshold))
}

/// Applies the two bounds and returns the surviving points. This is a pure
/// primitive: it knows NOTHING about methods, parameters or guesses. Where the
/// bounds come from is the shell's business (trim_guess, or the user dragging a
/// cursor), which is what keeps the two roles from getting confused.
#[wasm_bindgen]
pub fn trim_apply(core: &[f64], stride: usize, low_bound: f64, high_bound: f64) -> TrimResult {
    let (x, y) = split(core, stride);
    // A non-finite bound means "no cut on that side".
    let low = low_bound;
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
    }
}

/// Clamps the incoming knobs into the range each estimator can survive: a
/// window below MIN_MAD_WINDOW collapses the residual to zero, and a
/// non-finite k or threshold would poison the threshold itself.
fn normalise_params(k: f64, window: f64, threshold: f64) -> TrimParams {
    TrimParams {
        k: if k.is_finite() { k } else { 5.0 },
        window: if window.is_finite() && window >= MIN_MAD_WINDOW as f64 {
            window.round() as usize
        } else {
            9
        },
        threshold: if threshold.is_finite() { threshold } else { 0.1 },
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

    // ---- trim_apply: a pure two-bounds primitive, no method knowledge ----

    #[test]
    fn apply_keeps_only_what_lies_between_the_bounds() {
        let core = core_xy(&[0.0, 1.0, 2.0], &[1.0, 2.0, 3.0]);
        let out = trim_apply(&core, 2, 1.5, 2.5);
        assert_eq!(out.kept_count(), 1);
        assert_eq!(out.total_count(), 3);
        assert_eq!(out.points_x, vec![1.0]);
        assert_eq!(out.points_y, vec![2.0]);
    }

    #[test]
    fn apply_takes_no_arguments_about_methods_at_all() {
        // signature-level proof that the trim and the guess cannot be confused:
        // there is no method, no k, no window, no threshold in here
        let out = trim_apply(&[1.0, 2.0, 3.0], 1, 2.0, f64::NAN);
        assert_eq!(out.kept_count(), 2);
    }

    #[test]
    fn a_non_finite_bound_means_no_cut_on_that_side() {
        let y = [1.0, 2.0, 3.0];
        let low = trim_apply(&y, 1, f64::NEG_INFINITY, f64::NAN);
        assert_eq!(low.kept_count(), 3, "an infinite low bound keeps everything");
        let high = trim_apply(&y, 1, 2.0, f64::INFINITY);
        assert_eq!(high.kept_count(), 2, "an infinite high bound caps nothing");
    }

    #[test]
    fn a_user_cursor_can_go_below_the_method_guess() {
        // the regression this split was made for: with the old combined call a
        // method floor made it impossible to drag BELOW the guessed threshold
        let y = [0.05, 0.2, 0.4, 0.9];
        let guess = trim_guess(&y, 1, "intensityThreshold", 5.0, 9.0, 0.4);
        assert_eq!(trim_apply(&y, 1, guess, f64::NAN).kept_count(), 2);
        // dragging to 0.1 cuts LESS than the 0.4 guess, because the cursor - not
        // the method - defines the trim now
        assert_eq!(trim_apply(&y, 1, 0.1, f64::NAN).kept_count(), 3);
        // and a cursor below the smallest value keeps everything
        assert_eq!(trim_apply(&y, 1, -1.0, f64::NAN).kept_count(), 4);
    }

    #[test]
    fn apply_reports_the_bounds_it_used() {
        let out = trim_apply(&[1.0, 2.0], 1, 1.5, 2.5);
        assert!((out.low_bound - 1.5).abs() < 1e-12);
        assert!((out.high_bound - 2.5).abs() < 1e-12);
    }

    #[test]
    fn apply_preserves_the_x_column_and_the_indices() {
        let core = core_xy(&[10.0, 20.0, 30.0], &[1.0, 6.0, 9.0]);
        let out = trim_apply(&core, 2, 5.0, f64::NAN);
        assert_eq!(out.points_x, vec![20.0, 30.0]);
        assert_eq!(out.points_y, vec![6.0, 9.0]);
        assert_eq!(out.kept_indices, vec![1.0, 2.0]);
    }

    #[test]
    fn apply_reports_the_index_when_there_is_no_x_column() {
        let out = trim_apply(&[1.0, 2.0], 1, f64::NEG_INFINITY, f64::NAN);
        assert_eq!(out.points_x, vec![0.0, 1.0]);
    }

    #[test]
    fn apply_never_keeps_a_nan() {
        // a NaN compares false against every bound, so it has to be filtered
        let out = trim_apply(&[1.0, f64::NAN, 2.0], 1, f64::NEG_INFINITY, f64::NAN);
        assert_eq!(out.kept_count(), 2);
        assert_eq!(out.total_count(), 3);
    }

    #[test]
    fn apply_of_an_empty_wave_is_empty() {
        let out = trim_apply(&[], 1, f64::NEG_INFINITY, f64::NAN);
        assert_eq!(out.kept_count(), 0);
        assert_eq!(out.total_count(), 0);
    }

    // ---- trim_guess: where the SELECTED method wants the cursor ----

    #[test]
    fn guess_of_passthrough_is_infinite_so_nothing_is_cut() {
        let y = [1.0, 2.0, 3.0];
        assert_eq!(trim_guess(&y, 1, "passthrough", 5.0, 9.0, 0.1), f64::NEG_INFINITY);
    }

    #[test]
    fn guess_of_an_unknown_method_falls_back_to_passthrough() {
        // a stale front end must still resolve its flow, not return nothing
        let y = [1.0, 2.0, 3.0];
        assert_eq!(trim_guess(&y, 1, "nope", 5.0, 9.0, 0.1), f64::NEG_INFINITY);
    }

    #[test]
    fn guess_of_intensity_threshold_is_the_threshold_itself() {
        let y = [0.05, 0.2, 0.4, 0.9];
        assert!((trim_guess(&y, 1, "intensityThreshold", 5.0, 9.0, 0.25) - 0.25).abs() < 1e-12);
    }

    #[test]
    fn guess_of_mad_is_baseline_plus_k_times_sigma() {
        // the RELATIVE rule: never the absolute k*sigma
        let y = [1.0, 1.02, 0.99, 1.01, 1.0, 0.98, 1.03, 1.0, 0.99];
        let params = TrimParams { k: 5.0, window: 3, threshold: 0.1 };
        let expected = baseline_level(&y) + 5.0 * residual_sigma(&y, 3);
        let got = trim_guess(&y, 1, "madResidual", 5.0, 3.0, 0.1);
        assert!((got - expected).abs() < 1e-12);
        assert!((got - guess_bounds(&y, "madResidual", &params)).abs() < 1e-12);
    }

    #[test]
    fn guess_follows_a_raised_baseline() {
        // the same noise sitting on a level of 1000: the threshold must move with
        // it, an absolute k*sigma would either keep everything or wipe the signal
        let flat = [1000.0, 1000.02, 999.99, 1000.01, 1000.0, 999.98, 1000.03, 1000.0, 999.99];
        let low = trim_guess(&flat, 1, "madResidual", 5.0, 3.0, 0.1);
        assert!(low > 1000.0, "the threshold must sit ABOVE the baseline");
        assert!(trim_apply(&flat, 1, low, f64::NAN).kept_count() < flat.len());
    }

    #[test]
    fn guess_ignores_a_few_peaks() {
        // a median baseline is unmoved by a minority of huge values
        let y = [10.0, 10.0, 10.0, 10.0, 10.0, 1000.0, 2000.0, 3000.0];
        assert!((baseline_level(&y) - 10.0).abs() < 1e-12);
    }

    #[test]
    fn baseline_of_an_empty_or_all_nan_wave_is_zero() {
        assert_eq!(baseline_level(&[]), 0.0);
        assert_eq!(baseline_level(&[f64::NAN, f64::NAN]), 0.0);
    }

    #[test]
    fn a_window_below_the_minimum_does_not_collapse_the_residual() {
        // window 1 would make the residual identically zero and every k*sigma
        // threshold collapse onto the baseline, so it is clamped up
        let y = [1.0, 1.02, 0.99, 1.01, 1.0, 0.98, 1.03, 1.0, 0.99];
        let clamped = trim_guess(&y, 1, "madResidual", 5.0, 1.0, 0.1);
        let at_min = trim_guess(&y, 1, "madResidual", 5.0, 3.0, 0.1);
        assert!((clamped - at_min).abs() < 1e-12);
    }

    #[test]
    fn a_non_finite_k_falls_back_to_five() {
        let y = [1.0, 1.02, 0.99, 1.01, 1.0, 0.98, 1.03, 1.0, 0.99];
        let nan_k = trim_guess(&y, 1, "madResidual", f64::NAN, 9.0, 0.1);
        let five = trim_guess(&y, 1, "madResidual", 5.0, 9.0, 0.1);
        assert!((nan_k - five).abs() < 1e-12);
    }

    // ---- the noise estimators ----

    #[test]
    fn residual_of_a_constant_wave_is_zero() {
        for r in moving_average_residual(&[2.0; 10], 5) {
            assert!(r.abs() < 1e-12);
        }
    }

    #[test]
    fn mad_sigma_is_robust_against_a_single_spike() {
        let clean = [1.0, 1.01, 0.99, 1.0, 1.02, 0.98, 1.0, 1.01, 0.99];
        let spiky = [1000.0, 1.01, 0.99, 1.0, 1.02, 0.98, 1.0, 1.01, 0.99];
        let a = residual_sigma(&clean, 3);
        let b = residual_sigma(&spiky, 3);
        assert!((b - a).abs() <= 0.5 * a + 1e-12);
    }

    #[test]
    fn mad_guess_cuts_a_quiet_wave_entirely_but_keeps_a_signal() {
        // flat noise around 1: baseline + 5 sigma is ABOVE the whole wave
        let quiet = [1.0, 1.02, 0.99, 1.01, 1.0, 0.98, 1.03, 1.0, 0.99];
        let low = trim_guess(&quiet, 1, "madResidual", 5.0, 3.0, 0.1);
        assert_eq!(trim_apply(&quiet, 1, low, f64::NAN).kept_count(), 0);

        // a signal rising well above its own noise keeps its top
        let signal = [1.0, 1.01, 0.99, 1.0, 1.02, 0.98, 1.0, 5.0, 9.0, 12.0];
        let low = trim_guess(&signal, 1, "madResidual", 5.0, 3.0, 0.1);
        let out = trim_apply(&signal, 1, low, f64::NAN);
        assert!(out.kept_count() > 0);
        assert!(out.kept_count() < signal.len());
    }

    #[test]
    fn median_reads_an_already_sorted_slice() {
        assert!((median(&[1.0, 2.0, 3.0]) - 2.0).abs() < 1e-12);
        assert!((median(&[1.0, 2.0, 3.0, 4.0]) - 2.5).abs() < 1e-12);
    }

    // ---- trim_histogram ----

    #[test]
    fn linear_histogram_counts_sum_to_the_wave_length() {
        let hist = trim_histogram(&[0.0, 0.1, 0.2, 0.3, 0.4, 0.5], 1, 3, "linear");
        assert_eq!(hist.centres().len(), 3);
        let total: f64 = hist.counts().iter().sum();
        assert!((total - 6.0).abs() < 1e-12);
        for c in hist.counts() {
            assert!((c - 2.0).abs() < 1e-12);
        }
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
        let y = [1.0, 5.0, 1e1, 5e1, 1e2, 5e2, 1e3, 5e3, 1e4, 5e4, 1e5, 5e5, 1e6];
        let hist = trim_histogram(&y, 1, 60, "log");
        assert_eq!(hist.centres().len(), 36);
        let total: f64 = hist.counts().iter().sum();
        assert!((total - 13.0).abs() < 1e-12);
        // the 13 values occupy 13 distinct bars: one per value, no collision
        let occupied = hist.counts().iter().filter(|c| **c > 0.0).count();
        assert_eq!(occupied, 13);
        let logs: Vec<f64> = hist.centres().iter().map(|c| c.log10()).collect();
        let gap = logs[1] - logs[0];
        for i in 1..logs.len() - 1 {
            assert!(((logs[i + 1] - logs[i]) - gap).abs() < 1e-9);
        }
    }

    #[test]
    fn the_log_bar_count_follows_the_span_not_the_request() {
        let wide = [1e0, 1e6];
        assert_eq!(trim_histogram(&wide, 1, 60, "log").centres().len(), 36);
        assert_eq!(trim_histogram(&wide, 1, 10, "log").centres().len(), 10);
    }

    #[test]
    fn a_narrow_spectrum_still_gets_a_readable_number_of_bars() {
        assert_eq!(trim_histogram(&[100.0, 200.0], 1, 60, "log").centres().len(), MIN_LOG_BINS);
    }

    #[test]
    fn asking_for_fewer_bars_than_the_floor_does_not_panic() {
        // a wasm panic kills the whole worker, not just the call
        for asked in 1..=4 {
            let hist = trim_histogram(&[1.0, 1e6], 1, asked, "log");
            assert_eq!(hist.centres().len(), asked);
        }
    }

    #[test]
    fn log_bin_centres_are_geometric() {
        let hist = trim_histogram(&[1.0, 1e4], 1, 4, "log");
        let expected = [0.5f64, 1.5, 2.5, 3.5].map(|e| 10f64.powf(e));
        for (got, want) in hist.centres().iter().zip(expected.iter()) {
            assert!((got / want - 1.0).abs() < 1e-9);
        }
    }

    #[test]
    fn log_centres_are_not_the_arithmetic_midpoint() {
        let hist = trim_histogram(&[1.0, 1e4], 1, 1, "log");
        let naive = 0.5 * (1.0 + 1e4);
        let centre = hist.centres()[0];
        assert!((centre / naive - 1.0).abs() > 0.9);
        assert!((centre / 100.0 - 1.0).abs() < 1e-9);
    }

    #[test]
    fn log_histogram_drops_non_positive_values() {
        let hist = trim_histogram(&[1.0, 0.0, -5.0, f64::NAN, 1e3], 1, 4, "log");
        let total: f64 = hist.counts().iter().sum();
        assert!((total - 2.0).abs() < 1e-12);
        assert_eq!(hist.dropped(), 3);
    }

    #[test]
    fn log_histogram_of_a_flat_positive_wave_keeps_everything() {
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
        let hist = trim_histogram(&[-1.0, 0.0, 1.0], 1, 4, "linear");
        let total: f64 = hist.counts().iter().sum();
        assert!((total - 3.0).abs() < 1e-12);
        assert_eq!(hist.dropped(), 0);
    }
}
