//! van Krevelen — H/C vs O/C scatter plot from formula compositions.
//!
//! Input: a flat array of [C_count, H_count, O_count, ...] per formula
//! Output: flat [x0..xN, y0..yN] where x = O/C, y = H/C
//!
//! Formulas without carbon are skipped (would divide by zero).

use wasm_bindgen::prelude::*;

/// Computes van Krevelen coordinates from formula element counts.
///
/// `core` is a flat array: [C0, H0, O0, C1, H1, O1, ...] — 3 values per formula.
/// Returns flat [x0..xN, y0..yN] where x = O/C, y = H/C.
/// Formulas with C == 0 are omitted from the output.
#[wasm_bindgen]
pub fn vankrevelen_compute(core: &[f64]) -> Vec<f64> {
    if core.len() < 3 {
        return Vec::new();
    }
    let n_formulas = core.len() / 3;
    let mut xs = Vec::with_capacity(n_formulas);
    let mut ys = Vec::with_capacity(n_formulas);

    for i in 0..n_formulas {
        let c = core[i * 3];
        let h = core[i * 3 + 1];
        let o = core[i * 3 + 2];

        if c > 0.0 {
            xs.push(o / c);
            ys.push(h / c);
        }
    }

    let n = xs.len();
    let mut out = Vec::with_capacity(n * 2);
    out.extend_from_slice(&xs);
    out.extend_from_slice(&ys);
    out
}

/// Computes van Krevelen coordinates with optional normalization/scaling.
///
/// `core` is a flat array: [C0, H0, O0, C1, H1, O1, ...] — 3 values per formula.
/// `params` can contain:
///   - scale_x: multiplier for O/C axis (default 1.0)
///   - scale_y: multiplier for H/C axis (default 1.0)
///   - offset_x: additive offset for O/C axis (default 0.0)
///   - offset_y: additive offset for H/C axis (default 0.0)
#[wasm_bindgen]
pub fn vankrevelen_compute_scaled(core: &[f64], params: &[f64]) -> Vec<f64> {
    // params: [scale_x, scale_y, offset_x, offset_y]
    let scale_x = params.get(0).copied().unwrap_or(1.0);
    let scale_y = params.get(1).copied().unwrap_or(1.0);
    let offset_x = params.get(2).copied().unwrap_or(0.0);
    let offset_y = params.get(3).copied().unwrap_or(0.0);

    if core.len() < 3 {
        return Vec::new();
    }
    let n_formulas = core.len() / 3;
    let mut xs = Vec::with_capacity(n_formulas);
    let mut ys = Vec::with_capacity(n_formulas);

    for i in 0..n_formulas {
        let c = core[i * 3];
        let h = core[i * 3 + 1];
        let o = core[i * 3 + 2];

        if c > 0.0 {
            xs.push(o / c * scale_x + offset_x);
            ys.push(h / c * scale_y + offset_y);
        }
    }

    let n = xs.len();
    let mut out = Vec::with_capacity(n * 2);
    out.extend_from_slice(&xs);
    out.extend_from_slice(&ys);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn core_ch(C: &[f64], H: &[f64], O: &[f64]) -> Vec<f64> {
        let mut out = Vec::new();
        for i in 0..C.len() {
            out.push(C[i]);
            out.push(H[i]);
            out.push(O[i]);
        }
        out
    }

    #[test]
    fn simple_ratios() {
        // C6H12O6 -> O/C = 1.0, H/C = 2.0
        let core = core_ch(&[6.0], &[12.0], &[6.0]);
        let out = vankrevelen_compute(&core);
        assert_eq!(out.len(), 2);
        assert!((out[0] - 1.0).abs() < 1e-9); // O/C
        assert!((out[1] - 2.0).abs() < 1e-9); // H/C
    }

    #[test]
    fn multiple_formulas() {
        // C6H12O6, C10H22O5, C0H4O2 (no carbon)
        let core = core_ch(&[6.0, 10.0, 0.0], &[12.0, 22.0, 4.0], &[6.0, 5.0, 2.0]);
        let out = vankrevelen_compute(&core);
        // Only first two have carbon: output is flat [x0,x1, y0,y1]
        assert_eq!(out.len(), 4);
        let n = out.len() / 2;
        assert!((out[0] - 1.0).abs() < 1e-9);     // O/C of first: 6/6
        assert!((out[1] - 0.5).abs() < 1e-9);     // O/C of second: 5/10
        assert!((out[n + 0] - 2.0).abs() < 1e-9); // H/C of first: 12/6
        assert!((out[n + 1] - 2.2).abs() < 1e-9); // H/C of second: 22/10
    }

    #[test]
    fn no_carbon_returns_empty() {
        let core = core_ch(&[0.0, 0.0], &[4.0, 6.0], &[2.0, 3.0]);
        let out = vankrevelen_compute(&core);
        assert!(out.is_empty());
    }

    #[test]
    fn scaling_works() {
        let core = core_ch(&[6.0], &[12.0], &[6.0]);
        // scale_x=2, scale_y=0.5, offset_x=1, offset_y=-1
        let params = [2.0, 0.5, 1.0, -1.0];
        let out = vankrevelen_compute_scaled(&core, &params);
        assert_eq!(out.len(), 2);
        // O/C = 1.0 * 2 + 1 = 3.0
        // H/C = 2.0 * 0.5 - 1 = 0.0
        assert!((out[0] - 3.0).abs() < 1e-9);
        assert!((out[1] - 0.0).abs() < 1e-9);
    }

    #[test]
    fn empty_core_returns_empty() {
        assert!(vankrevelen_compute(&[]).is_empty());
        assert!(vankrevelen_compute(&[1.0]).is_empty());
        assert!(vankrevelen_compute(&[1.0, 2.0]).is_empty());
    }

    #[test]
    fn truncated_core_drops_last() {
        // 4 values = 1 full formula + 1 stray
        let core = vec![6.0, 12.0, 6.0, 999.0];
        let out = vankrevelen_compute(&core);
        assert_eq!(out.len(), 2);
        assert!((out[0] - 1.0).abs() < 1e-9);
        assert!((out[1] - 2.0).abs() < 1e-9);
    }
}