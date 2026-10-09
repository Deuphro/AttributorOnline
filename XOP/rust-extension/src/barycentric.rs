use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn barycentric_project(
    compositions: &[u32],
    n_compositions: usize,
    k: usize,
) -> Vec<f64> {
    if n_compositions == 0 || k < 3 || compositions.len() != n_compositions * k {
        return Vec::new();
    }

    let mut output = Vec::with_capacity((n_compositions + k) * 2);

    let two_pi = 2.0 * std::f64::consts::PI;

    for comp_idx in 0..n_compositions {
        let offset = comp_idx * k;

        let sum: u32 = compositions[offset..offset + k].iter().sum();
        if sum == 0 {
            output.push(0.0);
            output.push(0.0);
            continue;
        }

        let sum_f = sum as f64;
        let mut rx = 0.0;
        let mut ry = 0.0;

        for i in 0..k {
            let xi = compositions[offset + i] as f64 / sum_f;
            let theta = two_pi * i as f64 / k as f64 + std::f64::consts::FRAC_PI_2;
            rx += xi * theta.cos();
            ry += xi * theta.sin();
        }

        output.push(rx);
        output.push(ry);
    }

    for i in 0..k {
        let theta = two_pi * i as f64 / k as f64 + std::f64::consts::FRAC_PI_2;
        output.push(theta.cos());
        output.push(theta.sin());
    }

    output
}

#[wasm_bindgen]
pub fn barycentric_project_f64(
    compositions: &[f64],
    n_compositions: usize,
    k: usize,
) -> Vec<f64> {
    if n_compositions == 0 || k < 3 || compositions.len() != n_compositions * k {
        return Vec::new();
    }

    let mut output = Vec::with_capacity((n_compositions + k) * 2);

    let two_pi = 2.0 * std::f64::consts::PI;

    for comp_idx in 0..n_compositions {
        let offset = comp_idx * k;

        let sum: f64 = compositions[offset..offset + k].iter().sum();
        if sum == 0.0 {
            output.push(0.0);
            output.push(0.0);
            continue;
        }

        let mut rx = 0.0;
        let mut ry = 0.0;

        for i in 0..k {
            let xi = compositions[offset + i] / sum;
            let theta = two_pi * i as f64 / k as f64 + std::f64::consts::FRAC_PI_2;
            rx += xi * theta.cos();
            ry += xi * theta.sin();
        }

        output.push(rx);
        output.push(ry);
    }

    for i in 0..k {
        let theta = two_pi * i as f64 / k as f64 + std::f64::consts::FRAC_PI_2;
        output.push(theta.cos());
        output.push(theta.sin());
    }

    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_k3_equilateral() {
        let compositions = vec![1, 1, 1, 2, 1, 0];
        let result = barycentric_project(&compositions, 2, 3);
        assert_eq!(result.len(), (2 + 3) * 2);

        // [1,1,1] -> center (0,0)
        let rx0 = result[0];
        let ry0 = result[1];
        assert!((rx0 - 0.0).abs() < 1e-10);
        assert!((ry0 - 0.0).abs() < 1e-10);

        // [2,1,0] with k=3: theta0=90°, theta1=210°, theta2=330°
        // sum=3, x0=2/3, x1=1/3, x2=0
        // Rx = 2/3*0 + 1/3*cos(210°) = 1/3*(-√3/2) = -√3/6 ≈ -0.288675
        // Ry = 2/3*1 + 1/3*sin(210°) = 2/3 + 1/3*(-1/2) = 1/2 = 0.5
        let rx1 = result[2];
        let ry1 = result[3];
        assert!((rx1 - (-0.2886751345948129)).abs() < 1e-10);
        assert!((ry1 - 0.5).abs() < 1e-10);
    }

    #[test]
    fn test_k4_square() {
        let compositions = vec![1, 1, 1, 1];
        let result = barycentric_project(&compositions, 1, 4);
        assert_eq!(result.len(), (1 + 4) * 2);

        let rx0 = result[0];
        let ry0 = result[1];
        assert!((rx0 - 0.0).abs() < 1e-10);
        assert!((ry0 - 0.0).abs() < 1e-10);
    }

    #[test]
    fn test_single_element_dominant() {
        let compositions = vec![100, 1, 1];
        let result = barycentric_project(&compositions, 1, 3);
        let rx = result[0];
        let ry = result[1];

        // [100,1,1] sum=102: near pole 0 at (0,1)
        // Rx ≈ 0, Ry ≈ 100/102*1 + 1/102*(-1/2) + 1/102*(-1/2) = 100/102 - 1/102 = 99/102
        assert!((rx - 0.0).abs() < 0.01);
        assert!((ry - 99.0/102.0).abs() < 0.01);
    }

    #[test]
    fn test_poles_on_unit_circle() {
        let compositions = vec![1, 0, 0];
        let result = barycentric_project(&compositions, 1, 3);
        let pole_start = 1 * 2; // n_compositions * 2

        for i in 0..3 {
            let px = result[pole_start + i * 2];
            let py = result[pole_start + i * 2 + 1];
            let radius = (px * px + py * py).sqrt();
            assert!((radius - 1.0).abs() < 1e-10);
        }
    }

    #[test]
    fn test_invalid_inputs() {
        assert!(barycentric_project(&[], 0, 3).is_empty());
        assert!(barycentric_project(&[1, 2], 1, 3).is_empty());
        assert!(barycentric_project(&[1, 2, 3], 1, 2).is_empty());
    }

    #[test]
    fn test_f64_version() {
        let compositions = vec![1.0, 1.0, 1.0];
        let result = barycentric_project_f64(&compositions, 1, 3);
        assert_eq!(result.len(), (1 + 3) * 2);

        let rx = result[0];
        let ry = result[1];
        assert!((rx - 0.0).abs() < 1e-10);
        assert!((ry - 0.0).abs() < 1e-10);
    }
}