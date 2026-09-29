use wasm_bindgen::prelude::*;

// MAD -> sigma of a normal distribution. Reused from trim.rs: the whole point
// of a median-based spread is that a handful of rejected peaks must not
// inflate it, and that constant is where the conversion lives.
const MAD_TO_SIGMA: f64 = 1.4826;

// Below this many measurable peaks there is no population to speak of: a median
// and a MAD over a handful of values are not an estimate of anything, and the
// filter would confidently reject on noise. Below it, EVERYTHING is kept, and
// the node says so in its readout rather than looking like it found nothing
// suspicious.
const MIN_PEAKS_FOR_REFERENCE: usize = 8;

// Half-maximum is a RELATIVE level, so it is taken against the peak's own
// height, never against a global threshold: a peak at 3% of the base peak must
// be judged by its own shape, not by the base peak's.
const HALF: f64 = 0.5;

/// A candidate peak reduced to what the filter decides on.
#[wasm_bindgen]
pub struct RadioDecision {
    points_x: Vec<f64>,
    points_y: Vec<f64>,
    indices: Vec<f64>,
    widths_ppm: Vec<f64>,
    //u8, not bool: wasm-bindgen cannot return a Vec<bool> (bool is not a JsObject).
    //The shell reads 1 as "radio" and 0 as "kept", which is the whole meaning.
    is_radio: Vec<u8>,
    kept_count: usize,
    reference_ppm: f64,
    threshold_ppm: f64,
}
#[wasm_bindgen]
impl RadioDecision {
    #[wasm_bindgen(getter)] pub fn points_x(&self) -> Vec<f64> { self.points_x.clone() }
    #[wasm_bindgen(getter)] pub fn points_y(&self) -> Vec<f64> { self.points_y.clone() }
    #[wasm_bindgen(getter)] pub fn indices(&self) -> Vec<f64> { self.indices.clone() }
    #[wasm_bindgen(getter)] pub fn widths_ppm(&self) -> Vec<f64> { self.widths_ppm.clone() }
    #[wasm_bindgen(getter)] pub fn is_radio(&self) -> Vec<u8> { self.is_radio.clone() }
    #[wasm_bindgen(getter)] pub fn kept_count(&self) -> usize { self.kept_count }
    #[wasm_bindgen(getter)] pub fn reference_ppm(&self) -> f64 { self.reference_ppm }
    #[wasm_bindgen(getter)] pub fn threshold_ppm(&self) -> f64 { self.threshold_ppm }
}

fn median(values: &[f64]) -> f64 {
    if values.is_empty() { return f64::NAN; }
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let n = sorted.len();
    if n % 2 == 1 { sorted[n / 2] } else { 0.5 * (sorted[n / 2 - 1] + sorted[n / 2]) }
}


/// Width at half maximum of the peak standing at `peak`, in ppm of its own m/z.
///
/// The scan is SELF-LIMITING: it walks outwards while the profile stays above
/// half the peak height and stops when it does not. There is no window, and so
/// no window parameter: the signal says where the peak ends, exactly as in the
/// Igor prototype. A width is only defined for a peak standing above its
/// neighbours; a point at or below zero on both sides has no crossing at all,
/// and gets NaN rather than a fabricated number.
fn width_ppm(x: &[f64], y: &[f64], peak: usize) -> f64 {
    let n = y.len();
    if peak >= n { return f64::NAN; }
    let height = y[peak];
    if !height.is_finite() || height <= 0.0 { return f64::NAN; }
    let level = HALF * height;
    let mut left = peak;
    while left > 0 && y[left - 1] > level { left -= 1; }
    let mut right = peak;
    while right + 1 < n && y[right + 1] > level { right += 1; }
    //One point, or every point of the wave: either way the scan ran to a
    //boundary and the "width" is the sampling, not the peak. NaN keeps it out
    //of the reference population instead of dragging it toward the span.
    if left == 0 || right == n - 1 { return f64::NAN; }
    let mass = x[peak];
    if !mass.is_finite() || mass <= 0.0 { return f64::NAN; }
    (x[right] - x[left]) / mass * 1e6
}

// A gap has to CLEAR THE NOISE before it is read as a population split. A
// unimodal set of widths still has a largest gap, and it is measurement noise:
// acting on it would place the cut in the middle of the real population and
// throw away half the peaks. The factor is high because the gap in a real
// two-population spectrum is orders of magnitude, not a few percent.
const MIN_GAP_OVER_NOISE: f64 = 8.0;

/// A z READ FROM THE DATA, which is a different thing from the 3σ convention.
///
/// The MAD is a spread; the cut has to be somewhere. When the widths form one
/// population the two agree, but when a spectrum is MOSTLY radio - a dirty
/// sample, a failed acquisition - the MAD is inflated by the very peaks the
/// filter should catch, and 3σ then rejects nothing. A gap does not have that
/// failure mode: it measures where the bulk ends whatever lies beyond.
///
/// The cut is read as the largest gap between consecutive sorted widths, in
/// robust sigma, and only when that gap is far larger than the typical spacing
/// between neighbours. Two earlier attempts are worth recording, because both
/// are plausible and both are wrong:
///   - a fixed quantile (90th) lands INSIDE the tight cluster when there is one
///     wide peak in eight, and reports a z of about 1, which would reject the
///     whole cluster;
///   - a ratio to the median width is not scale-free - a comb of near-identical
///     peaks has a vanishing MAD, and the ratio to the outlier explodes.
#[wasm_bindgen]
pub fn anti_radio_guess_z(core: &[f64], stride: usize, points_index: &[f64]) -> f64 {
    let (x, y) = split(core, stride);
    let mut measured: Vec<f64> = Vec::new();
    for i in 0..points_index.len() {
        let idx = points_index[i];
        if !idx.is_finite() { continue; }
        let peak = idx.round();
        if peak < 0.0 || peak >= y.len() as f64 { continue; }
        let w = width_ppm(x, y, peak as usize);
        if w.is_finite() && w > 0.0 { measured.push(w); }
    }
    if measured.len() < MIN_PEAKS_FOR_REFERENCE { return 3.0; }
    measured.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let reference = median(&measured);
    let spread = MAD_TO_SIGMA * median(
        &measured.iter().map(|w| (w - reference).abs()).collect::<Vec<f64>>(),
    );
    //no spread means every measured width is identical: the data say nothing
    //about how far out "far" is, and the convention is the only honest answer
    if !(spread > 0.0) { return 3.0; }
    //the step between each pair of neighbours, in the same robust sigma
    let steps: Vec<f64> = measured.windows(2).map(|w| (w[1] - w[0]) / spread).collect();
    if steps.is_empty() { return 3.0; }
    let mut best_gap = 0.0;
    for s in steps.iter().copied() { if s > best_gap { best_gap = s; } }
    //the typical step is what measurement noise looks like on this spectrum
    let noise = median(&steps);
    if !(best_gap > MIN_GAP_OVER_NOISE * noise) { return 3.0; }
    //HALF the gap: the guess proposes where the wide population STARTS, and a z
    //sitting exactly on the gap would keep everything on the far side of it -
    //which is precisely the population the filter exists to remove. On a real
    //two-population spectrum this is a LARGE z, because the bulk of the widths
    //is extremely tight; that is the honest answer, not an anomaly.
    let z = best_gap / 2.0;
    if z.is_finite() && z > 0.0 { z } else { 3.0 }
}


///
/// `z` is the ONE knob, and it is a statistical convention rather than a fitted
/// setting: a peak is "radio" when its width sits z robust sigma above the
/// median width of the spectrum. Since the reference is measured on the data in
/// hand, the filter follows the instrument's actual resolution instead of a
/// hard-coded one, and the false-positive rate stays a property of the spread
/// rather than of how many peaks the spectrum happens to contain.
#[wasm_bindgen]
pub fn anti_radio_filter(core: &[f64], stride: usize, points_x: &[f64], points_y: &[f64], points_index: &[f64], z: f64) -> RadioDecision {
    let n = points_x.len();
    let (x, y) = split(core, stride);
    let mut widths = vec![f64::NAN; n];
    for i in 0..n {
        let idx = points_index.get(i).copied().unwrap_or(f64::NAN);
        if !idx.is_finite() { continue; }
        let peak = idx.round();
        if peak < 0.0 || peak >= y.len() as f64 { continue; }
        widths[i] = width_ppm(x, y, peak as usize);
    }
    let measured: Vec<f64> = widths.iter().copied().filter(|w| w.is_finite() && *w > 0.0).collect();
    let (reference, threshold) = if measured.len() >= MIN_PEAKS_FOR_REFERENCE {
        let reference = median(&measured);
        let deviations: Vec<f64> = measured.iter().map(|w| (w - reference).abs()).collect();
        let spread = MAD_TO_SIGMA * median(&deviations);
        let z = if z.is_finite() { z } else { 3.0 };
        (reference, reference + z * spread)
    } else {
        //No population: the honest answer is "no verdict", encoded as a
        //threshold above every measured width so nothing is rejected.
        (f64::NAN, f64::INFINITY)
    };
    let mut out_x = Vec::new(); let mut out_y = Vec::new(); let mut out_idx = Vec::new();
    let mut is_radio = vec![0u8; n];
    for i in 0..n {
        let radio = widths[i].is_finite() && widths[i] > threshold;
        is_radio[i] = u8::from(radio);
        if !radio {
            out_x.push(points_x[i]);
            out_y.push(points_y[i]);
            out_idx.push(points_index.get(i).copied().unwrap_or(f64::NAN));
        }
    }
    let kept_count = out_x.len();

    RadioDecision { points_x: out_x, points_y: out_y, indices: out_idx, widths_ppm: widths, is_radio, kept_count, reference_ppm: reference, threshold_ppm: threshold }
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
#[cfg(test)]
mod tests {
    use super::*;

    /// A profile with sharp peaks at 400, 900 and 1400, plus one `wide` blob at
    /// `blob_at`. The blob is what the filter must find and the sharp ones what
    /// it must not touch: a test that only checks the blob is also satisfied by
    /// a filter that rejects everything, so `kept_count` is asserted too.
    ///
    /// `width` is a sigma in POINTS, and the apex is added ONCE: a generator
    /// that writes the centre twice doubles its height without widening it, the
    /// half-height level rises with it, and every peak collapses to a one-sample
    /// spike with no measurable width at all.
    fn spectrum(blob_at: usize, blob_width: usize) -> (Vec<f64>, Vec<f64>) {
        let n = 3000;
        let mut x = Vec::with_capacity(n);
        let mut y = vec![0.0; n];
        for i in 0..n { x.push(100.0 + i as f64 * 0.001); }
        for (centre, amp, width) in [(300usize, 1000.0f64, 3usize), (600, 980.0, 3), (900, 960.0, 3), (1200, 940.0, 3), (1500, 920.0, 3), (1800, 900.0, 3), (2100, 880.0, 3), (blob_at, 900.0, blob_width)] {
            for d in 0..=4 * width {
                let shape = (-((d * d) as f64) / (2.0 * (width * width) as f64)).exp() * amp;
                if centre + d < n { y[centre + d] += shape; }
                if d > 0 && centre >= d { y[centre - d] += shape; }
            }
        }
        (x, y)
    }

    fn core(x: &[f64], y: &[f64]) -> Vec<f64> {
        let mut c = x.to_vec();
        c.extend_from_slice(y);
        c
    }

    #[test]
    fn the_threshold_is_built_from_the_observed_widths() {
        // Nine sharp peaks: only above MIN_PEAKS_FOR_REFERENCE does a median
        // and a MAD describe a population at all.
        let (x, y) = spectrum(2500, 40);
        let c = core(&x, &y);
        let cands: Vec<usize> = vec![300, 600, 900, 1200, 1500, 1800, 2100, 2500];
        let px: Vec<f64> = cands.iter().map(|&i| x[i]).collect();
        let py: Vec<f64> = cands.iter().map(|&i| y[i]).collect();
        let pi: Vec<f64> = cands.iter().map(|&i| i as f64).collect();
        let d = anti_radio_filter(&c, 2, &px, &py, &pi, 3.0);
        assert!(d.reference_ppm.is_finite(), "eight peaks clears MIN_PEAKS_FOR_REFERENCE, so a reference must exist");
        assert!(d.threshold_ppm > d.reference_ppm, "the threshold sits above the median width");
        assert_eq!(d.is_radio[7], 1, "the blob is the wide one and must go");
        assert_eq!(d.kept_count, 7, "only the blob is dropped");
    }

    #[test]
    fn too_few_peaks_rejects_nothing() {
        let (x, y) = spectrum(2500, 40);
        let c = core(&x, &y);
        //one sharp peak and the blob: two measurable widths, far below the
        //minimum, so the filter has no population and must decline to judge
        let d = anti_radio_filter(&c, 2, &[x[300], x[2500]], &[y[300], y[2500]], &[300.0, 2500.0], 3.0);
        assert_eq!(d.kept_count, 2, "no population, no verdict, nothing dropped");
        assert!(!d.threshold_ppm.is_finite());
    }

    #[test]
    fn a_peak_at_a_wave_edge_has_no_measurable_width() {
        let n = 500;
        let x: Vec<f64> = (0..n).map(|i| 100.0 + i as f64 * 0.001).collect();
        let y: Vec<f64> = (0..n).map(|d| if d < 5 { 1000.0 - 100.0 * d as f64 } else { 0.0 }).collect();
        let c = core(&x, &y);
        let d = anti_radio_filter(&c, 2, &[x[0]], &[y[0]], &[0.0], 3.0);
        assert!(d.widths_ppm[0].is_nan(), "a scan that ran to the border is not a width");
    }

    #[test]
    fn an_out_of_range_index_is_refused_not_clamped() {
        let (x, y) = spectrum(2500, 40);
        let c = core(&x, &y);
        let d = anti_radio_filter(&c, 2, &[x[300]], &[y[300]], &[99999.0], 3.0);
        assert!(d.widths_ppm[0].is_nan(), "an index past the wave cannot be measured");
        assert_eq!(d.kept_count, 1, "an unmeasurable peak is KEPT, never dropped on a guess");
    }

    #[test]
    fn the_guess_reads_a_finite_z_from_the_population() {
        let (x, y) = spectrum(2500, 40);
        let c = core(&x, &y);
        let idx: Vec<f64> = vec![300.0, 600.0, 900.0, 1200.0, 1500.0, 1800.0, 2100.0, 2500.0];
        let z = anti_radio_guess_z(&c, 2, &idx);
        assert!(z.is_finite() && z > 0.0, "a guess must always return a usable z, got {z}");
        //Seven tight widths and one 15x wider: the gap is real, and the z that
        //puts the cut between the two populations is necessarily LARGE, because
        //the bulk is extremely tight. The property that matters is not the size
        //but that the guessed z DOES separate the two groups.
        let d = anti_radio_filter(&c, 2, &idx.iter().map(|&i| x[i as usize]).collect::<Vec<f64>>(), &idx.iter().map(|&i| y[i as usize]).collect::<Vec<f64>>(), &idx, z);
        assert_eq!(d.kept_count, 7, "the guessed z must keep the seven sharp peaks and drop the wide one");
    }

    #[test]
    fn the_guess_ignores_a_gap_that_is_only_noise() {
        //A perfectly regular comb: every width within a fraction of a percent
        //of its neighbours. The largest gap here is measurement noise, and
        //acting on it would cut the real population in half.
        let n = 500;
        let x: Vec<f64> = (0..n).map(|i| 100.0 + i as f64 * 0.001).collect();
        let mut y = vec![0.0; n];
        for c in (50..n - 50).step_by(20) {
            for d in 0..=4usize { y[c + d] = 1000.0 - 100.0 * d as f64; if c >= d { y[c - d] = 1000.0 - 100.0 * d as f64; } }
        }
        let c = core(&x, &y);
        let idx: Vec<f64> = (50..n - 50).step_by(20).map(|i| i as f64).collect();
        //the convention, because a noise gap is not evidence of a second
        //population: everything must survive
        assert_eq!(anti_radio_guess_z(&c, 2, &idx), 3.0);
    }

    #[test]
    fn the_guess_falls_back_to_the_convention_without_a_population() {
        let (x, y) = spectrum(2500, 40);
        let c = core(&x, &y);
        //a single peak: nothing to read a quantile from
        assert_eq!(anti_radio_guess_z(&c, 2, &[300.0]), 3.0);
    }

}
