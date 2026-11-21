use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct DistributionFitResult {
    parameters: Vec<f64>,
    y_pred: Vec<f64>,
    sse: f64,
    converged: bool,
    iterations: usize,
}

#[wasm_bindgen]
impl DistributionFitResult {
    #[wasm_bindgen(getter)]
    pub fn parameters(&self) -> Vec<f64> {
        self.parameters.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn y_pred(&self) -> Vec<f64> {
        self.y_pred.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn sse(&self) -> f64 {
        self.sse
    }
    #[wasm_bindgen(getter)]
    pub fn converged(&self) -> bool {
        self.converged
    }
    #[wasm_bindgen(getter)]
    pub fn iterations(&self) -> usize {
        self.iterations
    }
}

#[derive(Clone, Copy)]
enum Model {
    Wesslau,
    FlorySchulz,
    SchulzZimm,
}

impl Model {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "wesslau" => Some(Self::Wesslau),
            "flory_schulz" => Some(Self::FlorySchulz),
            "schulz_zimm" => Some(Self::SchulzZimm),
            _ => None,
        }
    }
    fn parameter_count(self) -> usize {
        match self {
            Self::Wesslau | Self::SchulzZimm => 3,
            Self::FlorySchulz => 2,
        }
    }
}

fn ln_gamma(value: f64) -> f64 {
    const COEFFICIENTS: [f64; 8] = [
        676.5203681218851,
        -1259.1392167224028,
        771.3234287776531,
        -176.6150291621406,
        12.507343278686905,
        -0.13857109526572012,
        9.984369578019572e-6,
        1.5056327351493116e-7,
    ];
    if value < 0.5 {
        return std::f64::consts::PI.ln()
            - (std::f64::consts::PI * value).sin().ln()
            - ln_gamma(1.0 - value);
    }
    let shifted = value - 1.0;
    let mut sum = 0.9999999999998099;
    for (index, coefficient) in COEFFICIENTS.iter().enumerate() {
        sum += coefficient / (shifted + index as f64 + 1.0);
    }
    let t = shifted + 7.5;
    0.5 * (2.0 * std::f64::consts::PI).ln() + (shifted + 0.5) * t.ln() - t + sum.ln()
}

// x is the discrete repeat index k. Continuous mass models use m = M0 + k*M_unit;
// Flory-Schulz is defined directly on k and does not apply that conversion.
fn evaluate(
    model: Model,
    x: f64,
    params: &[f64],
    m0: f64,
    mass_unit: f64,
    x_is_index: bool,
    poisson_limit: bool,
    trials: f64,
    mass_weighted: bool,
) -> f64 {
    let amplitude = params[0].max(0.0);
    match model {
        Model::Wesslau => {
            let alpha = params[1];
            let mu = params[2];
            let mass = if x_is_index { m0 + x * mass_unit } else { x };
            if !mass.is_finite() || mass <= m0 || alpha <= 1.0 || mu <= 0.0 {
                return 0.0;
            }
            let log_alpha = alpha.ln();
            let latent = (mass / m0).ln() / log_alpha;
            let variance = if poisson_limit {
                mu
            } else {
                mu * (1.0 - mu / trials)
            };
            if !variance.is_finite() || variance <= 0.0 {
                return 0.0;
            }
            amplitude / (mass * log_alpha * (2.0 * std::f64::consts::PI * variance).sqrt())
                * (-0.5 * (latent - mu).powi(2) / variance).exp()
        }
        Model::FlorySchulz => {
            let k = x;
            let a = params[1];
            if k < 1.0 || a <= 0.0 || a >= 1.0 {
                return 0.0;
            }
            if mass_weighted {
                amplitude * k * (1.0 - a).powi(2) * ((k - 1.0) * a.ln()).exp()
            } else {
                amplitude * (1.0 - a) * ((k - 1.0) * a.ln()).exp()
            }
        }
        Model::SchulzZimm => {
            let z = params[1];
            let mean = params[2];
            let mass = if x_is_index { m0 + x * mass_unit } else { x };
            if !mass.is_finite() || mass <= 0.0 || z <= 0.0 || mean <= 0.0 {
                return 0.0;
            }
            let log_density =
                z * (z / mean).ln() - ln_gamma(z) + (z - 1.0) * mass.ln() - z * mass / mean;
            amplitude * log_density.exp()
        }
    }
}

fn solve_linear(matrix: &mut [f64], rhs: &mut [f64], n: usize) -> bool {
    for pivot in 0..n {
        let mut best = pivot;
        for row in pivot + 1..n {
            if matrix[row * n + pivot].abs() > matrix[best * n + pivot].abs() {
                best = row;
            }
        }
        if matrix[best * n + pivot].abs() < 1e-18 {
            return false;
        }
        if best != pivot {
            for col in pivot..n {
                matrix.swap(pivot * n + col, best * n + col);
            }
            rhs.swap(pivot, best);
        }
        let diagonal = matrix[pivot * n + pivot];
        for col in pivot..n {
            matrix[pivot * n + col] /= diagonal;
        }
        rhs[pivot] /= diagonal;
        for row in 0..n {
            if row == pivot {
                continue;
            }
            let factor = matrix[row * n + pivot];
            for col in pivot..n {
                matrix[row * n + col] -= factor * matrix[pivot * n + col];
            }
            rhs[row] -= factor * rhs[pivot];
        }
    }
    true
}

fn sum_squares(
    x: &[f64],
    y: &[f64],
    params: &[f64],
    model: Model,
    m0: f64,
    mass_unit: f64,
    x_is_index: bool,
    poisson_limit: bool,
    trials: f64,
    mass_weighted: bool,
    predictions: &mut [f64],
) -> f64 {
    let mut sse = 0.0;
    for index in 0..x.len() {
        let prediction = evaluate(
            model,
            x[index],
            params,
            m0,
            mass_unit,
            x_is_index,
            poisson_limit,
            trials,
            mass_weighted,
        );
        predictions[index] = prediction;
        let residual = prediction - y[index];
        sse += residual * residual;
    }
    sse
}

#[wasm_bindgen]
pub fn distribution_fit(
    x: &[f64],
    y: &[f64],
    model_name: &str,
    initial: &[f64],
    lower: &[f64],
    upper: &[f64],
    m0: f64,
    mass_unit: f64,
    x_is_index: bool,
    poisson_limit: bool,
    trials: f64,
    mass_weighted: bool,
    max_iterations: usize,
) -> Result<DistributionFitResult, JsValue> {
    fit_distribution(
        x,
        y,
        model_name,
        initial,
        lower,
        upper,
        m0,
        mass_unit,
        x_is_index,
        poisson_limit,
        trials,
        mass_weighted,
        max_iterations,
    )
    .map_err(JsValue::from_str)
}

fn fit_distribution(
    x: &[f64],
    y: &[f64],
    model_name: &str,
    initial: &[f64],
    lower: &[f64],
    upper: &[f64],
    m0: f64,
    mass_unit: f64,
    x_is_index: bool,
    poisson_limit: bool,
    trials: f64,
    mass_weighted: bool,
    max_iterations: usize,
) -> Result<DistributionFitResult, &'static str> {
    let model = Model::parse(model_name).ok_or("unknown distribution model")?;
    let count = model.parameter_count();
    if x.len() != y.len()
        || x.len() < count
        || initial.len() != count
        || lower.len() != count
        || upper.len() != count
    {
        return Err("fit arrays must have matching lengths and enough points/parameters");
    }
    if x.iter().chain(y).any(|value| !value.is_finite())
        || initial
            .iter()
            .chain(lower)
            .chain(upper)
            .any(|value| !value.is_finite())
        || lower.iter().zip(upper).any(|(lo, hi)| lo >= hi)
    {
        return Err("fit inputs and bounds must be finite and ordered");
    }
    if !m0.is_finite()
        || m0 <= 0.0
        || !mass_unit.is_finite()
        || mass_unit <= 0.0
        || !trials.is_finite()
        || trials <= 0.0
    {
        return Err("mass and trial settings must be positive and finite");
    }

    let mut params: Vec<f64> = initial
        .iter()
        .enumerate()
        .map(|(index, value)| value.max(lower[index]).min(upper[index]))
        .collect();
    let mut trial_params = params.clone();
    let mut predictions = vec![0.0; x.len()];
    let mut trial_predictions = vec![0.0; x.len()];
    let mut jacobian = vec![0.0; x.len() * count];
    let mut normal = vec![0.0; count * count];
    let mut gradient = vec![0.0; count];
    let mut delta = vec![0.0; count];
    let mut lambda = 1e-3;
    let mut sse = sum_squares(
        x,
        y,
        &params,
        model,
        m0,
        mass_unit,
        x_is_index,
        poisson_limit,
        trials,
        mass_weighted,
        &mut predictions,
    );
    let mut converged = false;
    let mut iterations = 0;

    for iteration in 0..max_iterations.max(1).min(1000) {
        iterations = iteration + 1;
        for parameter in 0..count {
            let step = (params[parameter].abs() * 1e-5).max(1e-7);
            trial_params.copy_from_slice(&params);
            trial_params[parameter] = (params[parameter] + step).min(upper[parameter]);
            let actual_step = trial_params[parameter] - params[parameter];
            if actual_step == 0.0 {
                trial_params[parameter] = (params[parameter] - step).max(lower[parameter]);
            }
            let actual_step = trial_params[parameter] - params[parameter];
            if actual_step == 0.0 {
                continue;
            }
            for index in 0..x.len() {
                let shifted = evaluate(
                    model,
                    x[index],
                    &trial_params,
                    m0,
                    mass_unit,
                    x_is_index,
                    poisson_limit,
                    trials,
                    mass_weighted,
                );
                jacobian[index * count + parameter] = (shifted - predictions[index]) / actual_step;
            }
        }
        normal.fill(0.0);
        gradient.fill(0.0);
        for index in 0..x.len() {
            let residual = y[index] - predictions[index];
            for a in 0..count {
                let ja = jacobian[index * count + a];
                gradient[a] += ja * residual;
                for b in 0..count {
                    normal[a * count + b] += ja * jacobian[index * count + b];
                }
            }
        }
        let gradient_norm = gradient
            .iter()
            .fold(0.0_f64, |norm, value| norm.max(value.abs()));
        if gradient_norm < 1e-10 {
            converged = true;
            break;
        }
        for index in 0..count {
            normal[index * count + index] += lambda * (normal[index * count + index].abs() + 1e-9);
        }
        delta.copy_from_slice(&gradient);
        if !solve_linear(&mut normal, &mut delta, count) {
            lambda *= 10.0;
            if lambda > 1e15 {
                break;
            }
            continue;
        }
        for index in 0..count {
            trial_params[index] = (params[index] + delta[index])
                .max(lower[index])
                .min(upper[index]);
        }
        let trial_sse = sum_squares(
            x,
            y,
            &trial_params,
            model,
            m0,
            mass_unit,
            x_is_index,
            poisson_limit,
            trials,
            mass_weighted,
            &mut trial_predictions,
        );
        if trial_sse.is_finite() && trial_sse < sse {
            let improvement = sse - trial_sse;
            params.copy_from_slice(&trial_params);
            predictions.copy_from_slice(&trial_predictions);
            sse = trial_sse;
            lambda = (lambda * 0.3).max(1e-12);
            if improvement <= 1e-12 * (1.0 + sse)
                || delta
                    .iter()
                    .fold(0.0_f64, |norm, value| norm.max(value.abs()))
                    < 1e-8
            {
                converged = true;
                break;
            }
        } else {
            lambda *= 10.0;
            if lambda > 1e15 {
                break;
            }
        }
    }

    sse = sum_squares(
        x,
        y,
        &params,
        model,
        m0,
        mass_unit,
        x_is_index,
        poisson_limit,
        trials,
        mass_weighted,
        &mut predictions,
    );
    Ok(DistributionFitResult {
        parameters: params,
        y_pred: predictions,
        sse,
        converged,
        iterations,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fit(
        model: &str,
        x: &[f64],
        y: &[f64],
        p0: &[f64],
        lo: &[f64],
        hi: &[f64],
        m0: f64,
        unit: f64,
        weighted: bool,
    ) -> DistributionFitResult {
        fit_distribution(
            x, y, model, p0, lo, hi, m0, unit, true, true, 1e9, weighted, 500,
        )
        .unwrap()
    }

    #[test]
    fn fits_flory_schulz_exactly() {
        let x: Vec<f64> = (1..=12).map(|value| value as f64).collect();
        let y: Vec<f64> = x
            .iter()
            .map(|k| 3.0 * (1.0 - 0.72) * 0.72_f64.powf(k - 1.0))
            .collect();
        let result = fit(
            "flory_schulz",
            &x,
            &y,
            &[1.0, 0.5],
            &[0.0, 1e-6],
            &[100.0, 0.999],
            100.0,
            14.0,
            false,
        );
        assert!(
            (result.parameters[1] - 0.72).abs() < 1e-4,
            "fit a={}",
            result.parameters[1]
        );
        assert!(result.sse < 1e-10, "SSE={}", result.sse);
    }

    #[test]
    fn fits_schulz_zimm_exactly() {
        let x: Vec<f64> = (1..=25).map(|value| value as f64).collect();
        let y: Vec<f64> = x
            .iter()
            .map(|index| {
                let mass = 75.0 + index * 14.0;
                4.0 * ((3.0_f64 * (3.0 / 300.0_f64).ln()) - ln_gamma(3.0) + 2.0 * mass.ln()
                    - mass / 100.0)
                    .exp()
            })
            .collect();
        let result = fit(
            "schulz_zimm",
            &x,
            &y,
            &[1.0, 1.5, 200.0],
            &[0.0, 0.01, 100.0],
            &[100.0, 50.0, 1000.0],
            75.0,
            14.0,
            false,
        );
        assert!(
            (result.parameters[1] - 3.0).abs() < 0.02,
            "fit z={}",
            result.parameters[1]
        );
        assert!(
            (result.parameters[2] - 300.0).abs() < 0.2,
            "fit Mn={}",
            result.parameters[2]
        );
        assert!(result.sse < 1e-8, "SSE={}", result.sse);
    }

    #[test]
    fn rejects_bad_arrays_and_handles_wesslau() {
        assert!(fit_distribution(
            &[1.0],
            &[1.0, 2.0],
            "flory_schulz",
            &[1.0, 0.5],
            &[0.0, 0.0],
            &[2.0, 1.0],
            100.0,
            14.0,
            true,
            true,
            1e9,
            false,
            100
        )
        .is_err());
        let x: Vec<f64> = (1..=20).map(|value| value as f64).collect();
        let y: Vec<f64> = x
            .iter()
            .map(|index| {
                let mass = 80.0 + index * 14.0;
                let latent = (mass / 80.0_f64).ln() / 1.08_f64.ln();
                5.0 / (mass * 1.08_f64.ln() * (2.0 * std::f64::consts::PI * 6.0_f64).sqrt())
                    * (-0.5 * (latent - 6.0).powi(2) / 6.0).exp()
            })
            .collect();
        let result = fit(
            "wesslau",
            &x,
            &y,
            &[1.0, 1.03, 4.0],
            &[0.0, 1.00001, 0.01],
            &[100.0, 2.0, 30.0],
            80.0,
            14.0,
            false,
        );
        assert!(result.parameters[1] > 1.00001 && result.parameters[2] > 0.01);
        assert!(result.y_pred.iter().all(|value| value.is_finite()));
    }

    #[test]
    fn accepts_measured_mass_directly() {
        let x: Vec<f64> = (1..=20).map(|value| 80.0 + value as f64 * 14.0).collect();
        let y: Vec<f64> = x
            .iter()
            .map(|mass| {
                let latent = (mass / 80.0_f64).ln() / 1.08_f64.ln();
                5.0 / (mass * 1.08_f64.ln() * (2.0 * std::f64::consts::PI * 6.0_f64).sqrt())
                    * (-0.5 * (latent - 6.0).powi(2) / 6.0).exp()
            })
            .collect();
        let result = fit_distribution(
            &x,
            &y,
            "wesslau",
            &[1.0, 1.03, 4.0],
            &[0.0, 1.00001, 0.01],
            &[100.0, 2.0, 30.0],
            80.0,
            14.0,
            false,
            true,
            1e9,
            false,
            500,
        )
        .unwrap();
        assert!((result.parameters[1] - 1.08).abs() < 1e-4);
        assert!((result.parameters[2] - 6.0).abs() < 1e-3);
    }
}
