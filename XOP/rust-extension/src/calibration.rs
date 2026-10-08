use wasm_bindgen::prelude::*;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum CalibMode {
    Linear,
    Quadratic,
    Cubic,
    Linear2D,
    Quadratic2D,
    Cubic2D,
}

impl CalibMode {
    fn from_str(s: &str) -> Option<Self> {
        match s {
            "linear" => Some(CalibMode::Linear),
            "quadratic" => Some(CalibMode::Quadratic),
            "cubic" => Some(CalibMode::Cubic),
            "linear2d" => Some(CalibMode::Linear2D),
            "quadratic2d" => Some(CalibMode::Quadratic2D),
            "cubic2d" => Some(CalibMode::Cubic2D),
            _ => None,
        }
    }
    fn k(&self) -> usize {
        match self {
            CalibMode::Linear => 2,
            CalibMode::Quadratic => 3,
            CalibMode::Cubic => 4,
            CalibMode::Linear2D => 3,
            CalibMode::Quadratic2D => 6,
            CalibMode::Cubic2D => 10,
        }
    }
}

#[wasm_bindgen]
pub struct CalibrationFitResult {
    coeffs: Vec<f64>,
    rmse: f64,
}

#[wasm_bindgen]
impl CalibrationFitResult {
    #[wasm_bindgen(getter)]
    pub fn coeffs(&self) -> Vec<f64> {
        self.coeffs.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn rmse(&self) -> f64 {
        self.rmse
    }
}

/// Fits a polynomial calibration from reference points.
///
/// `ref_x` are the measured m/z values (from the spectrum).
/// `ref_y` are the true m/z values (from the formula collection).
/// `mode` selects the polynomial degree: "linear" (a*x+b), "quadratic" (a*x^2+b*x+c), "cubic" (a*x^3+b*x^2+c*x+d).
///
/// Returns coefficients in descending order for quadratic/cubic:
/// - linear: [a, b]           → y = a*x + b
/// - quadratic: [a, b, c]     → y = a*x^2 + b*x + c
/// - cubic: [a, b, c, d]      → y = a*x^3 + b*x^2 + c*x + d
#[wasm_bindgen]
pub fn calibration_fit(ref_x: &[f64], ref_y: &[f64], mode: &str) -> CalibrationFitResult {
    let n = ref_x.len();
    if n < 2 || n != ref_y.len() {
        return CalibrationFitResult { coeffs: vec![1.0, 0.0], rmse: 0.0 };
    }

    let mode = match CalibMode::from_str(mode) {
        Some(m) => m,
        None => return CalibrationFitResult { coeffs: vec![1.0, 0.0], rmse: 0.0 },
    };
    if matches!(mode, CalibMode::Linear2D | CalibMode::Quadratic2D | CalibMode::Cubic2D) {
        // 2D modes don't belong in the 1D polynomial fit: they are handled by
        // `calibration_fit_2d`.
        return CalibrationFitResult { coeffs: vec![1.0, 0.0], rmse: 0.0 };
    }
    let k = mode.k();

    // Build design matrix X (n x k) and target Y (n)
    // For linear:      X = [x, 1]
    // For quadratic:   X = [x^2, x, 1]
    // For cubic:       X = [x^3, x^2, x, 1]
    let mut xtx = vec![0.0; k * k];
    let mut xty = vec![0.0; k];

    for i in 0..n {
        let xi = ref_x[i];
        let yi = ref_y[i];
        if !xi.is_finite() || !yi.is_finite() {
            continue;
        }

        // Build row of X for this point
        let mut row = vec![0.0; k];
        match mode {
            CalibMode::Linear => {
                row[0] = xi;
                row[1] = 1.0;
            }
            CalibMode::Quadratic => {
                row[0] = xi * xi;
                row[1] = xi;
                row[2] = 1.0;
            }
            CalibMode::Cubic => {
                row[0] = xi * xi * xi;
                row[1] = xi * xi;
                row[2] = xi;
                row[3] = 1.0;
            }
            CalibMode::Linear2D | CalibMode::Quadratic2D | CalibMode::Cubic2D => {
                // 2D modes don't belong in the 1D polynomial fit: they are
                // handled by `calibration_fit_2d`.
                return CalibrationFitResult { coeffs: vec![1.0, 0.0], rmse: 0.0 };
            }
        }

        // X^T X
        for a in 0..k {
            for b in 0..k {
                xtx[a * k + b] += row[a] * row[b];
            }
            // X^T Y
            xty[a] += row[a] * yi;
        }
    }

    // Solve X^T X * coeffs = X^T Y using Gaussian elimination
    let coeffs = match gaussian_elimination(&mut xtx, &mut xty, k) {
        Ok(c) => c,
        Err(_) => return CalibrationFitResult { coeffs: vec![1.0, 0.0], rmse: 0.0 },
    };

    // Compute RMSE
    let mut rmse = 0.0;
    let mut valid = 0;
    for i in 0..n {
        let xi = ref_x[i];
        let yi = ref_y[i];
        if !xi.is_finite() || !yi.is_finite() {
            continue;
        }
        let pred = match mode {
            CalibMode::Linear => coeffs[0] * xi + coeffs[1],
            CalibMode::Quadratic => coeffs[0] * xi * xi + coeffs[1] * xi + coeffs[2],
            CalibMode::Cubic => coeffs[0] * xi * xi * xi + coeffs[1] * xi * xi + coeffs[2] * xi + coeffs[3],
            CalibMode::Linear2D | CalibMode::Quadratic2D | CalibMode::Cubic2D => {
                // 2D modes don't belong in the 1D polynomial fit: they are
                // handled by `calibration_fit_2d`.
                return CalibrationFitResult { coeffs: vec![1.0, 0.0], rmse: 0.0 };
            }
        };
        rmse += (pred - yi).powi(2);
        valid += 1;
    }
    if valid > 0 {
        rmse = (rmse / valid as f64).sqrt();
    }

    CalibrationFitResult { coeffs, rmse }
}

/// Applies calibration coefficients to an array of x values.
///
/// `x` is the input array of measured m/z values.
/// `coeffs` are the calibration coefficients from `calibration_fit`.
/// `mode` must match the mode used for fitting.
#[wasm_bindgen]
pub fn calibration_apply(x: &[f64], coeffs: &[f64], mode: &str) -> Vec<f64> {
    let mode = match CalibMode::from_str(mode) {
        Some(m) => m,
        None => return x.to_vec(),
    };

    if coeffs.len() < mode.k() {
        return x.to_vec();
    }

    let mut out = Vec::with_capacity(x.len());
    for &xi in x {
        if !xi.is_finite() {
            out.push(f64::NAN);
            continue;
        }
        let y = match mode {
            CalibMode::Linear => coeffs[0] * xi + coeffs[1],
            CalibMode::Quadratic => coeffs[0] * xi * xi + coeffs[1] * xi + coeffs[2],
            CalibMode::Cubic => coeffs[0] * xi * xi * xi + coeffs[1] * xi * xi + coeffs[2] * xi + coeffs[3],
            _ => xi,
        };
        out.push(y);
    }
    out
}

/// 2D calibration: fits error_ppm = f(measured_mz, intensity)
///
/// `measured_mz` - measured m/z values from spectrum
/// `intensity` - intensity values at those m/z
/// `error_ppm` - error in ppm (measured - true) / true * 1e6
/// `mode` - "linear2d", "quadratic2d", "cubic2d"
///
/// Returns coefficients for error_ppm surface:
/// - linear2d: [a, b, c]           → error = a*mz + b*intensity + c
/// - quadratic2d: [a, b, c, d, e, f] → error = a*mz² + b*int² + c*mz*int + d*mz + e*int + f
/// - cubic2d: 10 coeffs (full 3rd order)
#[wasm_bindgen]
pub fn calibration_fit_2d(measured_mz: &[f64], intensity: &[f64], error_ppm: &[f64], mode: &str) -> CalibrationFitResult {
    let n = measured_mz.len();
    if n < 3 || n != intensity.len() || n != error_ppm.len() {
        return CalibrationFitResult { coeffs: vec![0.0, 0.0, 0.0], rmse: 0.0 };
    }

    let mode = match CalibMode::from_str(mode) {
        Some(m) => m,
        None => return CalibrationFitResult { coeffs: vec![0.0, 0.0, 0.0], rmse: 0.0 },
    };
    let k = mode.k();

    // Build design matrix X (n x k) and target Y (n)
    // For linear2d:      X = [mz, intensity, 1]
    // For quadratic2d:   X = [mz², int², mz*int, mz, int, 1]
    // For cubic2d:       X = [mz³, mz²*int, mz*int², int³, mz², mz*int, int², mz, int, 1]
    let mut xtx = vec![0.0; k * k];
    let mut xty = vec![0.0; k];

    for i in 0..n {
        let x = measured_mz[i];
        let y = intensity[i];
        let z = error_ppm[i];
        if !x.is_finite() || !y.is_finite() || !z.is_finite() {
            continue;
        }

        let mut row = vec![0.0; k];
        match mode {
            CalibMode::Linear2D => {
                row[0] = x;
                row[1] = y;
                row[2] = 1.0;
            }
            CalibMode::Quadratic2D => {
                row[0] = x * x;
                row[1] = y * y;
                row[2] = x * y;
                row[3] = x;
                row[4] = y;
                row[5] = 1.0;
            }
            CalibMode::Cubic2D => {
                row[0] = x * x * x;
                row[1] = x * x * y;
                row[2] = x * y * y;
                row[3] = y * y * y;
                row[4] = x * x;
                row[5] = x * y;
                row[6] = y * y;
                row[7] = x;
                row[8] = y;
                row[9] = 1.0;
            }
            _ => continue,
        }

        // X^T X
        for a in 0..k {
            for b in 0..k {
                xtx[a * k + b] += row[a] * row[b];
            }
            // X^T Y
            xty[a] += row[a] * z;
        }
    }

    // Solve X^T X * coeffs = X^T Y using Gaussian elimination
    let coeffs = match gaussian_elimination(&mut xtx, &mut xty, k) {
        Ok(c) => c,
        Err(_) => return CalibrationFitResult { coeffs: vec![0.0; k], rmse: 0.0 },
    };

    // Compute RMSE
    let mut rmse = 0.0;
    let mut valid = 0;
    for i in 0..n {
        let x = measured_mz[i];
        let y = intensity[i];
        let z = error_ppm[i];
        if !x.is_finite() || !y.is_finite() || !z.is_finite() {
            continue;
        }
        let pred = match mode {
            CalibMode::Linear2D => coeffs[0] * x + coeffs[1] * y + coeffs[2],
            CalibMode::Quadratic2D => coeffs[0] * x * x + coeffs[1] * y * y + coeffs[2] * x * y + coeffs[3] * x + coeffs[4] * y + coeffs[5],
            CalibMode::Cubic2D => coeffs[0] * x * x * x + coeffs[1] * x * x * y + coeffs[2] * x * y * y + coeffs[3] * y * y * y
                + coeffs[4] * x * x + coeffs[5] * x * y + coeffs[6] * y * y + coeffs[7] * x + coeffs[8] * y + coeffs[9],
            _ => 0.0,
        };
        rmse += (pred - z).powi(2);
        valid += 1;
    }
    if valid > 0 {
        rmse = (rmse / valid as f64).sqrt();
    }

    CalibrationFitResult { coeffs, rmse }
}

/// Applies 2D calibration: corrected_mz = measured_mz / (1 + error_ppm/1e6)
///
/// `x` - measured m/z array
/// `y` - intensity array (same length as x)
/// `coeffs` - coefficients from calibration_fit_2d
/// `mode` - must match mode used for fitting
#[wasm_bindgen]
pub fn calibration_apply_2d(x: &[f64], y: &[f64], coeffs: &[f64], mode: &str) -> Vec<f64> {
    let mode = match CalibMode::from_str(mode) {
        Some(m) => m,
        None => return x.to_vec(),
    };

    if coeffs.len() < mode.k() || x.len() != y.len() {
        return x.to_vec();
    }

    let mut out = Vec::with_capacity(x.len());
    for i in 0..x.len() {
        let xi = x[i];
        let yi = y[i];
        if !xi.is_finite() || !yi.is_finite() {
            out.push(f64::NAN);
            continue;
        }
        let error_ppm = match mode {
            CalibMode::Linear2D => coeffs[0] * xi + coeffs[1] * yi + coeffs[2],
            CalibMode::Quadratic2D => coeffs[0] * xi * xi + coeffs[1] * yi * yi + coeffs[2] * xi * yi + coeffs[3] * xi + coeffs[4] * yi + coeffs[5],
            CalibMode::Cubic2D => coeffs[0] * xi * xi * xi + coeffs[1] * xi * xi * yi + coeffs[2] * xi * yi * yi + coeffs[3] * yi * yi * yi
                + coeffs[4] * xi * xi + coeffs[5] * xi * yi + coeffs[6] * yi * yi + coeffs[7] * xi + coeffs[8] * yi + coeffs[9],
            _ => 0.0,
        };
        let corrected = xi / (1.0 + error_ppm / 1e6);
        out.push(corrected);
    }
    out
}

/// Gaussian elimination to solve A * x = b.
/// A is k x k (stored row-major), b is k. Modifies A and b in place.
/// Returns the solution vector x on success, or Err(()) if singular.
fn gaussian_elimination(a: &mut [f64], b: &mut [f64], k: usize) -> Result<Vec<f64>, ()> {
    // Augmented matrix: k x (k+1)
    let mut m = vec![0.0; k * (k + 1)];
    for i in 0..k {
        for j in 0..k {
            m[i * (k + 1) + j] = a[i * k + j];
        }
        m[i * (k + 1) + k] = b[i];
    }

    for col in 0..k {
        // Pivot: find row with max absolute value in this column
        let mut pivot = col;
        for row in (col + 1)..k {
            if m[row * (k + 1) + col].abs() > m[pivot * (k + 1) + col].abs() {
                pivot = row;
            }
        }
        if m[pivot * (k + 1) + col].abs() < 1e-12 {
            return Err(());
        }
        if pivot != col {
            for j in col..=k {
                m.swap(col * (k + 1) + j, pivot * (k + 1) + j);
            }
        }

        // Normalize pivot row
        let piv_val = m[col * (k + 1) + col];
        for j in col..=k {
            m[col * (k + 1) + j] /= piv_val;
        }

        // Eliminate other rows
        for row in 0..k {
            if row == col {
                continue;
            }
            let factor = m[row * (k + 1) + col];
            if factor == 0.0 {
                continue;
            }
            for j in col..=k {
                m[row * (k + 1) + j] -= factor * m[col * (k + 1) + j];
            }
        }
    }

    // Extract solution
    let mut x = vec![0.0; k];
    for i in 0..k {
        x[i] = m[i * (k + 1) + k];
    }
    Ok(x)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn linear_exact_fit() {
        // y = 2x + 1
        let x = vec![1.0, 2.0, 3.0, 4.0];
        let y = vec![3.0, 5.0, 7.0, 9.0];
        let result = calibration_fit(&x, &y, "linear");
        assert!((result.coeffs[0] - 2.0).abs() < 1e-10);
        assert!((result.coeffs[1] - 1.0).abs() < 1e-10);
        assert!(result.rmse < 1e-10);
    }

    #[test]
    fn quadratic_exact_fit() {
        // y = x^2 + 2x + 1 = (x+1)^2
        let x = vec![1.0, 2.0, 3.0, 4.0];
        let y = vec![4.0, 9.0, 16.0, 25.0];
        let result = calibration_fit(&x, &y, "quadratic");
        assert!((result.coeffs[0] - 1.0).abs() < 1e-10);
        assert!((result.coeffs[1] - 2.0).abs() < 1e-10);
        assert!((result.coeffs[2] - 1.0).abs() < 1e-10);
        assert!(result.rmse < 1e-10);
    }

    #[test]
    fn cubic_exact_fit() {
        // y = x^3
        let x = vec![1.0, 2.0, 3.0, 4.0];
        let y = vec![1.0, 8.0, 27.0, 64.0];
        let result = calibration_fit(&x, &y, "cubic");
        assert!((result.coeffs[0] - 1.0).abs() < 1e-10);
        assert!(result.coeffs[1].abs() < 1e-10);
        assert!(result.coeffs[2].abs() < 1e-10);
        assert!(result.coeffs[3].abs() < 1e-10);
        assert!(result.rmse < 1e-10);
    }

    #[test]
    fn linear_apply() {
        let coeffs = vec![2.0, 1.0]; // y = 2x + 1
        let x = vec![1.0, 2.0, 3.0];
        let out = calibration_apply(&x, &coeffs, "linear");
        assert!((out[0] - 3.0).abs() < 1e-10);
        assert!((out[1] - 5.0).abs() < 1e-10);
        assert!((out[2] - 7.0).abs() < 1e-10);
    }

    #[test]
    fn quadratic_apply() {
        let coeffs = vec![1.0, 2.0, 1.0]; // y = x^2 + 2x + 1
        let x = vec![1.0, 2.0, 3.0];
        let out = calibration_apply(&x, &coeffs, "quadratic");
        assert!((out[0] - 4.0).abs() < 1e-10);
        assert!((out[1] - 9.0).abs() < 1e-10);
        assert!((out[2] - 16.0).abs() < 1e-10);
    }

    #[test]
    fn cubic_apply() {
        let coeffs = vec![1.0, 0.0, 0.0, 0.0]; // y = x^3
        let x = vec![1.0, 2.0, 3.0];
        let out = calibration_apply(&x, &coeffs, "cubic");
        assert!((out[0] - 1.0).abs() < 1e-10);
        assert!((out[1] - 8.0).abs() < 1e-10);
        assert!((out[2] - 27.0).abs() < 1e-10);
    }

    #[test]
    fn apply_handles_nan() {
        let coeffs = vec![1.0, 0.0];
        let x = vec![1.0, f64::NAN, 3.0];
        let out = calibration_apply(&x, &coeffs, "linear");
        assert!((out[0] - 1.0).abs() < 1e-10);
        assert!(out[1].is_nan());
        assert!((out[2] - 3.0).abs() < 1e-10);
    }

    #[test]
    fn insufficient_points_returns_identity() {
        let x = vec![1.0];
        let y = vec![2.0];
        let result = calibration_fit(&x, &y, "linear");
        assert_eq!(result.coeffs, vec![1.0, 0.0]);
    }

    #[test]
    fn unknown_mode_returns_identity() {
        let x = vec![1.0, 2.0, 3.0];
        let y = vec![3.0, 5.0, 7.0];
        let result = calibration_fit(&x, &y, "unknown");
        assert_eq!(result.coeffs, vec![1.0, 0.0]);
    }
}