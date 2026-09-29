//! F-KMD — Formula-based Kendrick Mass Defect.
//!
//! The formula gives a reference m/z. The whole transform is two steps, and the
//! second one DEPENDS on the first: it reads the NEW x, not the old one. That
//! ordering is the entire definition, and reversing it is the easy mistake —
//! computing the defects against the original masses would give a different, and
//! meaningless, answer.
//!
//!   1. x' = x * round(mz) / m/z        (the rescaled mass axis)
//!   2. y' = x' - round(x')             (the mass defect of each new x, per index)
//!
//! `round(mz)/m/z` is a CONSTANT for the whole wave, so it is computed once and
//! multiplied in. Doing the division per point would divide n times instead of
//! once for the very same result.

use wasm_bindgen::prelude::*;

/// The scaling factor: round(mz) / m/z.
///
/// A non-finite or non-positive m/z has no scale, and the only honest answer is
/// an empty result: returning 1.0 would quietly pass the input through and the
/// shell would publish a wave whose X axis is not the one that was asked for.
/// Refusing is loud, passing through is silent, and silent is worse.
fn kendrick_factor(mz: f64) -> Option<f64> {
    if !mz.is_finite() || mz <= 0.0 {
        return None;
    }
    let reference = mz.round();
    if reference <= 0.0 {
        return None;
    }
    Some(reference / mz)
}

/// Splits a canonical core into its x and y halves, `[x0..xN, y0..yN]`, the
/// layout a 2D Wave uses. Odd lengths drop the last value rather than panicking:
/// a truncated wave must not take the whole node down.
fn split_xy(core: &[f64]) -> (&[f64], &[f64]) {
    let n = core.len() / 2;
    (&core[..n], &core[n..2 * n])
}

/// Applies the F-KMD transform to a canonical core.
///
/// Returns a FLAT, non-interleaved `[x'0..x'N, y'0..y'N]` — the same layout the
/// input came in, so the shell can hand it straight to `Wave.fromCoordinates`
/// without a second reshape.
///
/// The output y is the DEFECT, and the input y (the intensities) is not carried
/// over: the caller asked for one value per point, and the defect is that value.
/// Intensities stay reachable on the input wave, which the caller still holds.
#[wasm_bindgen]
pub fn fkmd(core: &[f64], mz: f64) -> Vec<f64> {
    let factor = match kendrick_factor(mz) {
        Some(factor) => factor,
        None => return Vec::new(),
    };
    let (x, _y) = split_xy(core);
    let n = x.len();
    if n == 0 {
        return Vec::new();
    }
    let mut out = vec![0.0; n * 2];
    for i in 0..n {
        let scaled = x[i] * factor;
        out[i] = scaled;
        //the defect reads the NEW x: this is the step that depends on the first
        out[n + i] = scaled - scaled.round();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn core_xy(x: &[f64], y: &[f64]) -> Vec<f64> {
        let mut core = x.to_vec();
        core.extend_from_slice(y);
        core
    }

    /// The factor alone, for a given m/z, to check the arithmetic in isolation.
    fn factor(mz: f64) -> f64 {
        kendrick_factor(mz).expect("a valid m/z has a factor")
    }

    // ---- the factor ----

    #[test]
    fn factor_is_round_over_mz() {
        // 181.0707 rounds to 181
        assert!((factor(181.0707) - 181.0 / 181.0707).abs() < 1e-12);
        //an already integral m/z is its own reference: factor 1, identity
        assert!((factor(12.0) - 1.0).abs() < 1e-12);
        //a fractional m/z below .5 rounds DOWN, above .5 rounds UP
        assert!((factor(4.2) - 4.0 / 4.2).abs() < 1e-12);
        assert!((factor(4.8) - 5.0 / 4.8).abs() < 1e-12);
    }

    #[test]
    fn an_integer_mz_is_the_identity() {
        //factor 1: the x pass through and the y becomes the plain defect
        let core = core_xy(&[12.0, 13.0], &[5.0, 6.0]);
        let out = fkmd(&core, 12.0);
        assert_eq!(out[0], 12.0);
        assert_eq!(out[1], 13.0);
        assert_eq!(out[2], 12.0 - 12.0);
        assert_eq!(out[3], 13.0 - 13.0);
    }

    #[test]
    fn a_refused_mz_returns_nothing_rather_than_the_input() {
        //the shell must be able to tell "no result" from "result identical to
        //the input", so a bad m/z gives an EMPTY output
        for bad in [0.0, -1.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            let core = core_xy(&[100.0, 200.0], &[1.0, 2.0]);
            assert!(fkmd(&core, bad).is_empty(), "mz {} must be refused", bad);
        }
    }

    #[test]
    fn an_empty_core_gives_an_empty_result() {
        assert!(fkmd(&[], 181.0).is_empty());
        //a single trailing y with no x: nothing to transform
        assert!(fkmd(&[1.0], 181.0).is_empty());
    }

    // ---- the two steps ----

    #[test]
    fn x_is_rescaled_by_the_constant_factor() {
        let mz = 181.0707;
        let core = core_xy(&[181.0707, 362.1414, 100.0], &[1.0, 2.0, 3.0]);
        let out = fkmd(&core, mz);
        let k = factor(mz);
        assert_eq!(out.len(), 6);
        assert!((out[0] - 181.0707 * k).abs() < 1e-9);
        assert!((out[1] - 362.1414 * k).abs() < 1e-9);
        assert!((out[2] - 100.0 * k).abs() < 1e-9);
    }

    #[test]
    fn y_is_the_defect_of_the_new_x() {
        let mz = 181.0707;
        let core = core_xy(&[100.0, 250.0, 700.0], &[7.0, 8.0, 9.0]);
        let out = fkmd(&core, mz);
        for i in 0..3 {
            let scaled = out[i]; // the NEW x, read back from the output
            assert!((out[3 + i] - (scaled - scaled.round())).abs() < 1e-12);
        }
    }

    #[test]
    fn the_defect_is_measured_against_the_new_x_not_the_old_one() {
        // The old x and the new x have DIFFERENT defects. Reading the old one
        // would be the classic mistake, and this test is what pins the order:
        // the two results must NOT coincide here.
        let mz = 181.0707;
        let x = 100.0;
        let core = core_xy(&[x], &[1.0]);
        let out = fkmd(&core, mz);
        let new_defect = out[1];
        let old_defect = x - x.round();
        assert!((new_defect - old_defect).abs() > 1e-6, "the two must differ");
        //and the new defect is the small one, which is the whole point
        assert!(new_defect.abs() <= 0.5);
    }

    #[test]
    fn the_input_y_is_not_carried_over() {
        //the caller asked for one value per point, and it is the defect
        let core = core_xy(&[100.0, 250.0], &[7.0, 8.0]);
        let out = fkmd(&core, 181.0707);
        assert!(!out.iter().any(|v| *v == 7.0 || *v == 8.0));
    }

    #[test]
    fn the_output_layout_is_flat_not_interleaved() {
        let core = core_xy(&[100.0, 250.0, 700.0], &[1.0, 1.0, 1.0]);
        let out = fkmd(&core, 181.0707);
        assert_eq!(out.len(), 6);
        //the first half is all masses, the second all defects
        for i in 0..3 {
            assert!(out[i] > 1.0, "x half is a mass");
            assert!(out[3 + i].abs() <= 0.5, "y half is a defect");
        }
    }

    #[test]
    fn an_odd_length_core_does_not_panic() {
        //a truncated core must not take the whole node down. Three values hold
        //ONE whole point plus a stray, so the stray is dropped and ONE point
        //comes out: the kernel never guesses which half a lone value belonged to.
        let core = vec![100.0, 250.0, 999.0];
        let out = fkmd(&core, 181.0707);
        assert_eq!(out.len(), 2);
        //six values: three whole points, no stray
        let core = vec![100.0, 250.0, 1.0, 400.0, 600.0, 2.0];
        assert_eq!(fkmd(&core, 181.0707).len(), 6);
        //seven values: three whole points plus a stray, which is dropped
        let core = vec![100.0, 250.0, 1.0, 400.0, 600.0, 2.0, 999.0];
        assert_eq!(fkmd(&core, 181.0707).len(), 6);
    }
}
