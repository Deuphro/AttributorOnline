/* =========================================================================
   EM / MÉLANGE DE GAUSSIENNES 2D — le même calcul que scripts/emGmm.js.

   Le funnel ajuste ce mélange pour séparer le nuage collé à l'origine
   (|Δppm|, Δppm contre δ) du reste. Le JS sert de référence et de repli ; ce
   noyau existe pour que le même ajustement coûte moins cher sur les gros
   nuages, sans changer la réponse.

   PARITÉ AVANT VITESSE. L'algorithme est reproduit pas à pas : même RNG
   mulberry32, même k-means++ avec 12 passes de Lloyd, même régularisation
   des covariances, même critère BIC. Les tests comparent les deux sorties
   sur les mêmes points ; une divergence doit être un échec, pas une
   « amélioration » silencieuse.

   CONTRAT DE SORTIE (tout en f64) :
     [k, iterations, converged, originComponent, logLikelihood, bic,
      weights (k),
      means (2k),
      covariances (3k : xx, xy, yy),
      counts (k),
      labels (n),
      responsibilities (n*k, ligne par point),
      standardMean (2), standardStd (2)]
   ========================================================================= */

use wasm_bindgen::prelude::*;

#[derive(Clone)]
struct EmResult {
    k: usize,
    weights: Vec<f64>,
    means: Vec<[f64; 2]>,
    covs: Vec<[f64; 3]>,
    responsibilities: Vec<f64>,
    loglik: f64,
    iterations: usize,
    converged: bool,
}

/* mulberry32, bit pour bit celui de emGmm.js. Sans cela, les deux noyaux
   tireraient des centres différents et la parité deviendrait une coïncidence. */
struct Mulberry32 {
    state: u32,
}

impl Mulberry32 {
    fn new(seed: u64) -> Self {
        Self { state: seed as u32 }
    }

    fn next_f64(&mut self) -> f64 {
        self.state = self.state.wrapping_add(0x6D2B_79F5);
        let mut t = self.state;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        ((t ^ (t >> 14)) as f64) / 4294967296.0
    }

    fn next_usize(&mut self, max: usize) -> usize {
        if max == 0 {
            return 0;
        }
        let value = (self.next_f64() * max as f64) as usize;
        value.min(max - 1)
    }
}

fn log_2pi() -> f64 {
    (2.0 * std::f64::consts::PI).ln()
}

fn standardize(data: &[f64], n: usize) -> (Vec<[f64; 2]>, [f64; 2], [f64; 2]) {
    let mut mean = [0.0f64, 0.0];
    for i in 0..n {
        mean[0] += data[2 * i];
        mean[1] += data[2 * i + 1];
    }
    mean[0] /= n as f64;
    mean[1] /= n as f64;

    let mut var = [0.0f64, 0.0];
    let mut cov = 0.0;
    for i in 0..n {
        let dx = data[2 * i] - mean[0];
        let dy = data[2 * i + 1] - mean[1];
        var[0] += dx * dx;
        var[1] += dy * dy;
        cov += dx * dy;
    }
    var[0] /= n as f64;
    var[1] /= n as f64;
    cov /= n as f64;

    let std = [var[0].max(1e-12).sqrt(), var[1].max(1e-12).sqrt()];
    let z = (0..n)
        .map(|i| {
            [
                (data[2 * i] - mean[0]) / std[0],
                (data[2 * i + 1] - mean[1]) / std[1],
            ]
        })
        .collect();
    (z, mean, std)
}

/* k-means++ puis 12 passes de Lloyd, exactement comme l'initialisation JS :
   l'EM ne part donc pas d'un tirage uniforme qui laisserait une composante
   vide au hasard. */
fn kmeans_init(z: &[[f64; 2]], k: usize, rng: &mut Mulberry32) -> Vec<[f64; 2]> {
    let n = z.len();
    let mut centers = Vec::with_capacity(k);
    centers.push(z[rng.next_usize(n)]);
    let mut nearest = vec![f64::INFINITY; n];

    while centers.len() < k {
        let mut total = 0.0;
        for i in 0..n {
            let mut best = f64::INFINITY;
            for center in &centers {
                let dx = z[i][0] - center[0];
                let dy = z[i][1] - center[1];
                let distance = dx * dx + dy * dy;
                if distance < best {
                    best = distance;
                }
            }
            nearest[i] = best;
            total += best;
        }
        let pick = if !(total > 1e-12) {
            rng.next_usize(n)
        } else {
            let mut target = rng.next_f64() * total;
            let mut chosen = n - 1;
            for i in 0..n {
                target -= nearest[i];
                if target <= 0.0 {
                    chosen = i;
                    break;
                }
            }
            chosen
        };
        centers.push(z[pick]);
    }

    let mut labels = vec![0usize; n];
    for _ in 0..12 {
        let mut changed = false;
        for i in 0..n {
            let mut best = 0usize;
            let mut best_distance = f64::INFINITY;
            for (c, center) in centers.iter().enumerate() {
                let dx = z[i][0] - center[0];
                let dy = z[i][1] - center[1];
                let distance = dx * dx + dy * dy;
                if distance < best_distance {
                    best_distance = distance;
                    best = c;
                }
            }
            if labels[i] != best {
                labels[i] = best;
                changed = true;
            }
        }
        let mut sums = vec![[0.0f64, 0.0, 0.0]; centers.len()];
        for i in 0..n {
            let label = labels[i];
            sums[label][0] += z[i][0];
            sums[label][1] += z[i][1];
            sums[label][2] += 1.0;
        }
        for c in 0..centers.len() {
            if sums[c][2] > 0.0 {
                centers[c][0] = sums[c][0] / sums[c][2];
                centers[c][1] = sums[c][1] / sums[c][2];
            }
        }
        if !changed {
            break;
        }
    }
    centers
}

/* Inverse d'une covariance symétrique 2×2, stockée [xx, xy, yy]. La
   régularisation reprend celle du JS : sans elle, une composante quasi
   ponctuelle rendrait le déterminant nul et le logarithme infini. */
fn invert_covariance(cov: &[f64; 3]) -> ([f64; 3], f64) {
    let mut a = cov[0];
    let mut b = cov[1];
    let mut d = cov[2];
    let mut det = a * d - b * b;
    if !(det > 1e-12) || !det.is_finite() {
        a += 1e-6;
        d += 1e-6;
        b = 0.0;
        det = a * d;
    }
    ([d / det, -b / det, a / det], det.ln())
}

fn log_gaussian(x: f64, y: f64, mean: &[f64; 2], inverse: &[f64; 3], log_det: f64) -> f64 {
    let dx = x - mean[0];
    let dy = y - mean[1];
    let q = inverse[0] * dx * dx + 2.0 * inverse[1] * dx * dy + inverse[2] * dy * dy;
    -log_2pi() - 0.5 * log_det - 0.5 * q
}

fn run_em(
    z: &[[f64; 2]],
    k: usize,
    max_iterations: usize,
    tolerance: f64,
    rng: &mut Mulberry32,
) -> EmResult {
    let n = z.len();
    let centers = kmeans_init(z, k, rng);

    let mut weights = vec![1.0 / k as f64; k];
    let mut means = centers;

    let mut global_xx = 0.0;
    let mut global_xy = 0.0;
    let mut global_yy = 0.0;
    for point in z {
        global_xx += point[0] * point[0];
        global_xy += point[0] * point[1];
        global_yy += point[1] * point[1];
    }
    global_xx /= n as f64;
    global_xy /= n as f64;
    global_yy /= n as f64;
    let mut covs = vec![[global_xx.max(1e-3), global_xy, global_yy.max(1e-3)]; k];

    let mut responsibilities = vec![0.0f64; n * k];
    let mut log_densities = vec![0.0f64; k];
    let mut previous = f64::NEG_INFINITY;
    let mut log_likelihood = 0.0;
    let mut converged = false;
    let mut iterations = 0;

    for iteration in 1..=max_iterations {
        iterations = iteration;
        let inverses: Vec<([f64; 3], f64)> =
            covs.iter().map(invert_covariance).collect();

        log_likelihood = 0.0;
        for i in 0..n {
            let mut max_log = f64::NEG_INFINITY;
            for c in 0..k {
                let value = weights[c].max(1e-300).ln()
                    + log_gaussian(z[i][0], z[i][1], &means[c], &inverses[c].0, inverses[c].1);
                log_densities[c] = value;
                if value > max_log {
                    max_log = value;
                }
            }
            let mut total = 0.0;
            for c in 0..k {
                total += (log_densities[c] - max_log).exp();
            }
            let log_sum = max_log + total.ln();
            log_likelihood += log_sum;
            for c in 0..k {
                responsibilities[i * k + c] = (log_densities[c] - log_sum).exp();
            }
        }

        for c in 0..k {
            let mut mass = 0.0;
            let mut mean_x = 0.0;
            let mut mean_y = 0.0;
            for i in 0..n {
                let r = responsibilities[i * k + c];
                mass += r;
                mean_x += r * z[i][0];
                mean_y += r * z[i][1];
            }
            if mass < 1e-10 {
                let point = z[rng.next_usize(n)];
                means[c] = point;
                weights[c] = 1e-3;
                covs[c] = [0.5, 0.0, 0.5];
                continue;
            }
            mean_x /= mass;
            mean_y /= mass;
            let mut var_x = 0.0;
            let mut var_y = 0.0;
            let mut cov_xy = 0.0;
            for i in 0..n {
                let r = responsibilities[i * k + c];
                let dx = z[i][0] - mean_x;
                let dy = z[i][1] - mean_y;
                var_x += r * dx * dx;
                var_y += r * dy * dy;
                cov_xy += r * dx * dy;
            }
            var_x /= mass;
            var_y /= mass;
            cov_xy /= mass;
            let regularization = 1e-6;
            means[c] = [mean_x, mean_y];
            covs[c] = [var_x + regularization, cov_xy, var_y + regularization];
            weights[c] = mass / n as f64;
        }

        let weight_sum: f64 = weights.iter().sum();
        if weight_sum > 0.0 {
            for weight in weights.iter_mut() {
                *weight /= weight_sum;
            }
        }

        if previous.is_finite()
            && (log_likelihood - previous).abs() <= tolerance * (1.0 + log_likelihood.abs())
        {
            converged = true;
            break;
        }
        previous = log_likelihood;
    }

    EmResult {
        k,
        weights,
        means,
        covs,
        responsibilities,
        loglik: log_likelihood,
        iterations,
        converged,
    }
}

#[wasm_bindgen]
pub fn gmm2d_em(
    data: &[f64],
    n_samples: usize,
    max_components: usize,
    requested_k: usize,
    max_iter: usize,
    tolerance: f64,
    seed: u64,
) -> Vec<f64> {
    let n = n_samples;
    if n == 0 || data.len() != n * 2 {
        return Vec::new();
    }
    if data.iter().any(|value| !value.is_finite()) {
        return Vec::new();
    }

    /* LE CAS D'UN SEUL POINT EST RENDU TEL QUEL, comme en JS : un mélange n'y
       a pas de sens, mais un appelant qui a un point doit obtenir une
       composante, pas un vecteur vide. */
    if n == 1 {
        let x = data[0];
        let y = data[1];
        let mut output = Vec::with_capacity(20);
        output.extend_from_slice(&[1.0, 0.0, 1.0, 0.0, 0.0, 0.0]);
        output.push(1.0);
        output.push(x);
        output.push(y);
        output.extend_from_slice(&[1.0, 0.0, 1.0]);
        output.push(1.0);
        output.push(0.0);
        output.push(1.0);
        output.extend_from_slice(&[x, y, 1.0, 1.0]);
        return output;
    }

    let (z, mean, std) = standardize(data, n);

    let cap = if max_components > 0 { max_components } else { 6 };
    let requested = requested_k > 0;
    let max_k = 1.max(
        cap.min(n - 1)
            .min(if requested { requested_k } else { cap }),
    );
    let candidates: Vec<usize> = if requested {
        vec![requested_k.min(max_k)]
    } else {
        (1..=max_k).collect()
    };

    let max_iterations = if max_iter > 0 { max_iter } else { 400 };
    let tolerance = if tolerance > 0.0 { tolerance } else { 1e-7 };

    let mut best: Option<(EmResult, f64)> = None;
    for &components in &candidates {
        let mut rng = Mulberry32::new(seed);
        let fit = run_em(&z, components, max_iterations, tolerance, &mut rng);
        let parameters = 6.0 * components as f64 - 1.0;
        let bic = -2.0 * fit.loglik + parameters * (n as f64).ln();
        if best.as_ref().map_or(true, |current| bic < current.1) {
            best = Some((fit, bic));
        }
    }
    let (fit, bic) = match best {
        Some(value) => value,
        None => return Vec::new(),
    };

    let means: Vec<[f64; 2]> = fit
        .means
        .iter()
        .map(|m| [mean[0] + m[0] * std[0], mean[1] + m[1] * std[1]])
        .collect();
    let covariances: Vec<[f64; 3]> = fit
        .covs
        .iter()
        .map(|c| {
            [
                c[0] * std[0] * std[0],
                c[1] * std[0] * std[1],
                c[2] * std[1] * std[1],
            ]
        })
        .collect();

    let mut labels = vec![0usize; n];
    let mut counts = vec![0usize; fit.k];
    for i in 0..n {
        let mut label = 0usize;
        let mut best_responsibility = -1.0;
        for c in 0..fit.k {
            let responsibility = fit.responsibilities[i * fit.k + c];
            if responsibility > best_responsibility {
                best_responsibility = responsibility;
                label = c;
            }
        }
        labels[i] = label;
        counts[label] += 1;
    }

    let mut origin_component = 0usize;
    let mut origin_distance = f64::INFINITY;
    for (c, m) in means.iter().enumerate() {
        let distance = (m[0] * m[0] + m[1] * m[1]).sqrt();
        if distance < origin_distance {
            origin_distance = distance;
            origin_component = c;
        }
    }

    let k = fit.k;
    let mut output = Vec::with_capacity(10 + 7 * k + n + n * k);
    output.push(k as f64);
    output.push(fit.iterations as f64);
    output.push(if fit.converged { 1.0 } else { 0.0 });
    output.push(origin_component as f64);
    output.push(fit.loglik);
    output.push(bic);
    output.extend_from_slice(&fit.weights);
    for m in &means {
        output.push(m[0]);
        output.push(m[1]);
    }
    for c in &covariances {
        output.push(c[0]);
        output.push(c[1]);
        output.push(c[2]);
    }
    for &count in &counts {
        output.push(count as f64);
    }
    for &label in &labels {
        output.push(label as f64);
    }
    output.extend_from_slice(&fit.responsibilities);
    output.push(mean[0]);
    output.push(mean[1]);
    output.push(std[0]);
    output.push(std[1]);
    output
}
