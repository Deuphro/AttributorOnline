use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn kmeans_cluster(
    data: &[f64],
    n_samples: usize,
    n_features: usize,
    n_clusters: usize,
    max_iter: usize,
    seed: u64,
) -> Vec<f64> {
    if n_samples == 0 || n_features == 0 || n_clusters == 0 || n_clusters > n_samples {
        return Vec::new();
    }
    if data.len() != n_samples * n_features {
        return Vec::new();
    }

    let mut rng = SimpleRng::new(seed);
    
    // K-means++ initialization
    let mut centroids = vec![0.0; n_clusters * n_features];
    let mut assignments = vec![0; n_samples];
    
    // First centroid: random sample
    let first_idx = rng.next_usize(n_samples);
    for j in 0..n_features {
        centroids[j] = data[first_idx * n_features + j];
    }
    
    // Remaining centroids: k-means++
    for c in 1..n_clusters {
        let mut distances = vec![f64::INFINITY; n_samples];
        for i in 0..n_samples {
            for prev_c in 0..c {
                let mut dist = 0.0;
                for j in 0..n_features {
                    let diff = data[i * n_features + j] - centroids[prev_c * n_features + j];
                    dist += diff * diff;
                }
                if dist < distances[i] {
                    distances[i] = dist;
                }
            }
        }
        
        // Weighted random selection
        let sum: f64 = distances.iter().sum();
        let mut r = rng.next_f64() * sum;
        let mut chosen = 0;
        for i in 0..n_samples {
            r -= distances[i];
            if r <= 0.0 {
                chosen = i;
                break;
            }
        }
        for j in 0..n_features {
            centroids[c * n_features + j] = data[chosen * n_features + j];
        }
    }
    
    // Main loop
    for _ in 0..max_iter {
        // Assign points to nearest centroid
        let mut changed = false;
        for i in 0..n_samples {
            let mut best_c = 0;
            let mut best_dist = f64::INFINITY;
            for c in 0..n_clusters {
                let mut dist = 0.0;
                for j in 0..n_features {
                    let diff = data[i * n_features + j] - centroids[c * n_features + j];
                    dist += diff * diff;
                }
                if dist < best_dist {
                    best_dist = dist;
                    best_c = c;
                }
            }
            if assignments[i] != best_c {
                assignments[i] = best_c;
                changed = true;
            }
        }
        
        if !changed {
            break;
        }
        
        // Update centroids
        let mut counts = vec![0; n_clusters];
        let mut new_centroids = vec![0.0; n_clusters * n_features];
        
        for i in 0..n_samples {
            let c = assignments[i];
            counts[c] += 1;
            for j in 0..n_features {
                new_centroids[c * n_features + j] += data[i * n_features + j];
            }
        }
        
        for c in 0..n_clusters {
            if counts[c] > 0 {
                for j in 0..n_features {
                    centroids[c * n_features + j] = new_centroids[c * n_features + j] / counts[c] as f64;
                }
            } else {
                // Reassign empty cluster to a random point
                let idx = rng.next_usize(n_samples);
                for j in 0..n_features {
                    centroids[c * n_features + j] = data[idx * n_features + j];
                }
            }
        }
    }
    
    // Compute cluster statistics
    let mut counts = vec![0; n_clusters];
    let mut cluster_means = vec![0.0; n_clusters * n_features];
    let mut cluster_vars = vec![0.0; n_clusters * n_features];
    
    for i in 0..n_samples {
        let c = assignments[i];
        counts[c] += 1;
        for j in 0..n_features {
            cluster_means[c * n_features + j] += data[i * n_features + j];
        }
    }
    
    for c in 0..n_clusters {
        if counts[c] > 0 {
            for j in 0..n_features {
                cluster_means[c * n_features + j] /= counts[c] as f64;
            }
        }
    }
    
    for i in 0..n_samples {
        let c = assignments[i];
        for j in 0..n_features {
            let diff = data[i * n_features + j] - cluster_means[c * n_features + j];
            cluster_vars[c * n_features + j] += diff * diff;
        }
    }
    
    for c in 0..n_clusters {
        if counts[c] > 1 {
            for j in 0..n_features {
                cluster_vars[c * n_features + j] /= (counts[c] - 1) as f64;
            }
        }
    }
    
    // Output format:
    // assignments: n_samples (u32 as f64)
    // centroids: n_clusters * n_features
    // cluster_means: n_clusters * n_features
    // cluster_vars: n_clusters * n_features
    // counts: n_clusters (u32 as f64)
    let mut output = Vec::with_capacity(
        n_samples + 
        n_clusters * n_features * 3 + 
        n_clusters
    );
    
    for i in 0..n_samples {
        output.push(assignments[i] as f64);
    }
    output.extend(centroids);
    output.extend(cluster_means);
    output.extend(cluster_vars);
    for c in 0..n_clusters {
        output.push(counts[c] as f64);
    }
    
    output
}

struct SimpleRng {
    state: u64,
}

impl SimpleRng {
    fn new(seed: u64) -> Self {
        Self { state: seed.wrapping_add(1) }
    }
    
    fn next_u64(&mut self) -> u64 {
        self.state = self.state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        self.state
    }
    
    fn next_f64(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 * (1.0 / 9007199254740992.0)
    }
    
    fn next_usize(&mut self, max: usize) -> usize {
        (self.next_f64() * max as f64) as usize
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_kmeans_simple() {
        // Two clear clusters
        let data = vec![
            1.0, 1.0,
            1.1, 1.1,
            0.9, 0.9,
            -1.0, -1.0,
            -1.1, -1.1,
            -0.9, -0.9,
        ];
        let result = kmeans_cluster(&data, 6, 2, 2, 100, 42);
        assert!(!result.is_empty());
        // 6 assignments + 2*2 centroids + 2*2 means + 2*2 vars + 2 counts = 6 + 4 + 4 + 4 + 2 = 20
        assert_eq!(result.len(), 6 + 2*2*3 + 2);
        
        // Check assignments are 0 or 1
        for i in 0..6 {
            assert!(result[i] == 0.0 || result[i] == 1.0);
        }
    }

    #[test]
    fn test_kmeans_invalid() {
        let data = vec![1.0, 2.0];
        let result = kmeans_cluster(&data, 0, 2, 2, 100, 42);
        assert!(result.is_empty());
        
        let result = kmeans_cluster(&data, 1, 2, 3, 100, 42); // n_clusters > n_samples
        assert!(result.is_empty());
    }
}