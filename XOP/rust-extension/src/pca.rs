use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn pca_project(
    data: &[f64],
    n_samples: usize,
    n_features: usize,
    n_components: usize,
) -> Vec<f64> {
    if n_samples == 0 || n_features == 0 || n_components == 0 || n_components > n_features {
        return Vec::new();
    }
    if data.len() != n_samples * n_features {
        return Vec::new();
    }

    // Center the data
    let mut means = vec![0.0; n_features];
    for i in 0..n_samples {
        for j in 0..n_features {
            means[j] += data[i * n_features + j];
        }
    }
    for j in 0..n_features {
        means[j] /= n_samples as f64;
    }

    let mut centered = vec![0.0; n_samples * n_features];
    for i in 0..n_samples {
        for j in 0..n_features {
            centered[i * n_features + j] = data[i * n_features + j] - means[j];
        }
    }

    // Compute covariance matrix (n_features x n_features)
    let mut cov = vec![0.0; n_features * n_features];
    for i in 0..n_features {
        for j in 0..n_features {
            let mut sum = 0.0;
            for k in 0..n_samples {
                sum += centered[k * n_features + i] * centered[k * n_features + j];
            }
            cov[i * n_features + j] = sum / (n_samples - 1) as f64;
        }
    }

    // Eigen decomposition using power iteration for top n_components
    // For simplicity and robustness, we use a simple eigenvalue solver
    let (eigenvalues, eigenvectors) = eigendecomposition(&cov, n_features, n_components);

    // Project data onto principal components
    let mut output = Vec::with_capacity(n_samples * n_components + n_components * n_features + n_features);
    
    // Projected data: n_samples x n_components
    for i in 0..n_samples {
        for c in 0..n_components {
            let mut val = 0.0;
            for j in 0..n_features {
                val += centered[i * n_features + j] * eigenvectors[j * n_components + c];
            }
            output.push(val);
        }
    }

    // Principal components (eigenvectors): n_features x n_components
    for c in 0..n_components {
        for j in 0..n_features {
            output.push(eigenvectors[j * n_components + c]);
        }
    }

    // Explained variance (eigenvalues): n_components
    for c in 0..n_components {
        output.push(eigenvalues[c]);
    }

    // Mean vector: n_features
    output.extend(means);

    output
}

fn eigendecomposition(cov: &[f64], n: usize, k: usize) -> (Vec<f64>, Vec<f64>) {
    // Simple power iteration for top-k eigenvectors
    // This is a basic implementation - for production use a proper eigensolver
    let mut eigenvectors = vec![0.0; n * k];
    let mut eigenvalues = vec![0.0; k];
    
    // Work on a copy of the covariance matrix
    let mut a = cov.to_vec();
    
    for comp in 0..k {
        // Power iteration
        let mut v = vec![1.0; n];
        // Random initialization to avoid getting stuck
        for i in 0..n {
            v[i] = (i as f64 * 0.123 + comp as f64 * 0.456).sin().abs() + 0.1;
        }
        normalize(&mut v);
        
        let mut lambda = 0.0;
        for _ in 0..100 {
            // v = A * v
            let mut av = vec![0.0; n];
            for i in 0..n {
                let mut sum = 0.0;
                for j in 0..n {
                    sum += a[i * n + j] * v[j];
                }
                av[i] = sum;
            }
            
            // lambda = v^T * A * v
            let mut new_lambda = 0.0;
            for i in 0..n {
                new_lambda += v[i] * av[i];
            }
            
            normalize(&mut av);
            
            // Check convergence
            let mut diff = 0.0;
            for i in 0..n {
                diff += (av[i] - v[i]).abs();
            }
            v = av;
            
            if (new_lambda - lambda).abs() < 1e-10 && diff < 1e-10 {
                lambda = new_lambda;
                break;
            }
            lambda = new_lambda;
        }
        
        eigenvalues[comp] = lambda;
        for i in 0..n {
            eigenvectors[i * k + comp] = v[i];
        }
        
        // Deflate the matrix: A = A - lambda * v * v^T
        for i in 0..n {
            for j in 0..n {
                a[i * n + j] -= lambda * v[i] * v[j];
            }
        }
    }
    
    (eigenvalues, eigenvectors)
}

fn normalize(v: &mut [f64]) {
    let mut norm = 0.0;
    for x in v.iter() {
        norm += x * x;
    }
    norm = norm.sqrt();
    if norm > 0.0 {
        for x in v.iter_mut() {
            *x /= norm;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pca_simple() {
        // Two clear clusters in 2D
        let data = vec![
            1.0, 1.0,
            1.1, 1.1,
            0.9, 0.9,
            -1.0, -1.0,
            -1.1, -1.1,
            -0.9, -0.9,
        ];
        let result = pca_project(&data, 6, 2, 1);
        assert!(!result.is_empty());
        // 6 samples * 1 component + 1 component * 2 features + 1 eigenvalue + 2 means = 6 + 2 + 1 + 2 = 11
        assert_eq!(result.len(), 6 * 1 + 1 * 2 + 1 + 2);
    }

    #[test]
    fn test_pca_invalid() {
        let data = vec![1.0, 2.0, 3.0];
        let result = pca_project(&data, 0, 2, 1);
        assert!(result.is_empty());
        
        let result = pca_project(&data, 1, 2, 3); // n_components > n_features
        assert!(result.is_empty());
    }
}