use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn spectral_cluster(
    data: &[f64],
    n_samples: usize,
    n_features: usize,
    n_clusters: usize,
    sigma: f64,
    k_neighbors: usize,
) -> Vec<f64> {
    if n_samples == 0 || n_features == 0 || n_clusters == 0 || n_clusters > n_samples {
        return Vec::new();
    }
    if data.len() != n_samples * n_features {
        return Vec::new();
    }
    
    // For large datasets, a k-NN graph instead of the full affinity. What
    // used to be built here was a dense n×n matrix — 191 MiB and one n²
    // multiply per power-iteration step at n = 5000, which is why this
    // kernel took minutes on a set k-means clears in milliseconds. Every
    // row is now a list of (column, weight) pairs; only the k-NN search
    // itself stays O(n²), and it no longer sorts: select_nth_unstable_by
    // keeps the k smallest under the total order (squared distance,
    // index) — a SET no two selection algorithms can disagree about,
    // which is what keeps the Rust and the JS picking the same neighbours.
    let use_knn = n_samples > 500;
    
    let sigma2 = if sigma > 0.0 { sigma * sigma } else { estimate_sigma(&data, n_samples, n_features) };
    let inv_sigma2 = 1.0 / (2.0 * sigma2);
    let mut rows: Vec<Vec<(u32, f64)>> = vec![Vec::new(); n_samples];
    
    if use_knn {
        let k = k_neighbors.min(n_samples - 1).max(1);
        for i in 0..n_samples {
            let mut dists: Vec<(f64, usize)> = Vec::with_capacity(n_samples - 1);
            for j in 0..n_samples {
                if i == j { continue; }
                let mut dist = 0.0;
                for f in 0..n_features {
                    let diff = data[i * n_features + f] - data[j * n_features + f];
                    dist += diff * diff;
                }
                dists.push((dist, j));
            }
            if dists.len() > k {
                dists.select_nth_unstable_by(k, |a, b| {
                    a.0.partial_cmp(&b.0)
                        .unwrap_or(std::cmp::Ordering::Equal)
                        .then(a.1.cmp(&b.1))
                });
                dists.truncate(k);
            }
            for (dist, j) in dists {
                let val = (-dist * inv_sigma2).exp();
                rows[i].push((j as u32, val));
                //The reverse edge in the same move: a k-NN graph is not
                //symmetric on its own, and the affinity is read both ways
                rows[j].push((i as u32, val));
            }
        }
    } else {
        for i in 0..n_samples {
            rows[i].push((i as u32, 1.0));
            for j in (i + 1)..n_samples {
                let mut dist = 0.0;
                for f in 0..n_features {
                    let diff = data[i * n_features + f] - data[j * n_features + f];
                    dist += diff * diff;
                }
                let val = (-dist * inv_sigma2).exp();
                rows[i].push((j as u32, val));
                rows[j].push((i as u32, val));
            }
        }
    }
    
    //Rows sorted by column and free of duplicates — a mutual k-NN pair is
    //pushed from both ends with the same weight — so the CSR order, and
    //with it every sum below, is the same on both sides of the fence.
    let mut row_ptr: Vec<usize> = Vec::with_capacity(n_samples + 1);
    row_ptr.push(0);
    let mut cols: Vec<u32> = Vec::new();
    let mut vals: Vec<f64> = Vec::new();
    let mut degree = vec![0.0; n_samples];
    for i in 0..n_samples {
        rows[i].sort_by(|a, b| a.0.cmp(&b.0));
        rows[i].dedup_by(|a, b| a.0 == b.0);
        let mut sum = 0.0;
        for &(_, w) in &rows[i] {
            sum += w;
        }
        degree[i] = sum.max(1e-10);
    }
    
    // Normalized affinity M = D^(-1/2) * A * D^(-1/2), normalized in place
    // as the CSR is flattened. L = I - M, so the two share their
    // eigenvectors and lambda_L = 1 - lambda_M: spectral partitioning wants
    // the SMALLEST eigenvalues of L, which are the LARGEST of M — and power
    // iteration converges to the largest eigenvalue of whatever matrix it
    // is handed. Running it on L, as this first did, returned the
    // highest-frequency modes of the graph: vectors that oscillate between
    // neighbours and partition nothing.
    for i in 0..n_samples {
        let di = degree[i].sqrt().recip();
        for &(j, w) in &rows[i] {
            let dj = degree[j as usize].sqrt().recip();
            cols.push(j);
            vals.push(w * di * dj);
        }
        row_ptr.push(vals.len());
    }

    // The first n_clusters eigenvectors of M, largest eigenvalue first: they
    // are the n_clusters eigenvectors of L with the SMALLEST eigenvalues —
    // the trivial one included, as Ng-Jordan-Weiss reads its embedding.
    let (_, eigenvectors) = eigendecomposition_sparse(&row_ptr, &cols, &vals, n_samples, n_clusters);
    
    // Normalize rows of eigenvector matrix
    let mut embedding = vec![0.0; n_samples * n_clusters];
    for i in 0..n_samples {
        let mut norm = 0.0;
        for c in 0..n_clusters {
            let val = eigenvectors[i * n_clusters + c];
            embedding[i * n_clusters + c] = val;
            norm += val * val;
        }
        norm = norm.sqrt();
        if norm > 0.0 {
            for c in 0..n_clusters {
                embedding[i * n_clusters + c] /= norm;
            }
        }
    }
    
    // Cluster in embedding space using K-means
    let assignments = kmeans_on_embedding(&embedding, n_samples, n_clusters);
    
    // Compute cluster centers in original space
    let mut counts = vec![0; n_clusters];
    let mut centers = vec![0.0; n_clusters * n_features];
    for i in 0..n_samples {
        let c = assignments[i];
        counts[c] += 1;
        for f in 0..n_features {
            centers[c * n_features + f] += data[i * n_features + f];
        }
    }
    for c in 0..n_clusters {
        if counts[c] > 0 {
            for f in 0..n_features {
                centers[c * n_features + f] /= counts[c] as f64;
            }
        }
    }
    
    // Output: assignments + embedding + centers + counts
    let mut output = Vec::with_capacity(n_samples + n_samples * n_clusters + n_clusters * n_features + n_clusters);
    for i in 0..n_samples {
        output.push(assignments[i] as f64);
    }
    output.extend(embedding);
    output.extend(centers);
    for c in 0..n_clusters {
        output.push(counts[c] as f64);
    }
    
    output
}

fn estimate_sigma(data: &[f64], n_samples: usize, n_features: usize) -> f64 {
    // Estimate sigma from median distance to 5th nearest neighbor
    let mut all_dists = Vec::new();
    let sample_size = n_samples.min(100);
    for i in 0..sample_size {
        let mut dists = Vec::new();
        for j in 0..n_samples {
            if i == j { continue; }
            let mut dist = 0.0;
            for f in 0..n_features {
                let diff = data[i * n_features + f] - data[j * n_features + f];
                dist += diff * diff;
            }
            dists.push(dist);
        }
        dists.sort_by(|a, b| a.partial_cmp(b).unwrap());
        if dists.len() >= 5 {
            all_dists.push(dists[4].sqrt());
        } else if !dists.is_empty() {
            all_dists.push(dists[dists.len() / 2].sqrt());
        }
    }
    if all_dists.is_empty() {
        1.0
    } else {
        all_dists.sort_by(|a, b| a.partial_cmp(b).unwrap());
        all_dists[all_dists.len() / 2].max(1e-6)
    }
}

//Orthogonalized power iteration for the LARGEST eigenvalues of M, read from
//the CSR — the same mathematics as the dense eigendecomposition_symmetric
//this replaces, with one difference invisible in the result: the rank-1
//deflations are applied to y ON THE WAY OUT (y -= lambda_c v_c (v_c·v))
//instead of being subtracted from an n×n matrix first. Same operator, same
//order of operations as the JS, O(nnz) per iteration instead of O(n²) — at
//n = 5000 that is the difference between seconds and minutes.
//
//The deflation does two jobs: it removes what was already found, so the
//next iteration converges to the NEXT eigenvector instead of the same one
//again, and the orthogonalization that follows keeps the arithmetic honest
//while the eigenvalues are still only approximately converged.
fn eigendecomposition_sparse(
    row_ptr: &[usize],
    cols: &[u32],
    vals: &[f64],
    n: usize,
    k: usize,
) -> (Vec<f64>, Vec<f64>) {
    let mut eigenvectors = vec![0.0; n * k];
    let mut eigenvalues = vec![0.0; k];

    for comp in 0..k {
        // Deterministic initialization, unchanged
        let mut v = vec![0.0; n];
        for i in 0..n {
            v[i] = ((i as f64 + comp as f64 * 10.0) * 0.12345).sin() + 0.5;
        }
        orthogonalize(&mut v, &eigenvectors, n, k, comp);
        normalize(&mut v);

        let mut lambda = 0.0;
        for _ in 0..200 {
            // y = (M - sum_c lambda_c v_c v_c^T) * v, without the matrix
            let mut av = matvec(row_ptr, cols, vals, &v);
            for c in 0..comp {
                let mut dot = 0.0;
                for i in 0..n {
                    dot += eigenvectors[i * k + c] * v[i];
                }
                let lc = eigenvalues[c];
                for i in 0..n {
                    av[i] -= lc * eigenvectors[i * k + c] * dot;
                }
            }

            // Rayleigh quotient
            let mut new_lambda = 0.0;
            for i in 0..n {
                new_lambda += v[i] * av[i];
            }

            normalize(&mut av);
            orthogonalize(&mut av, &eigenvectors, n, k, comp);
            normalize(&mut av);

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
    }

    (eigenvalues, eigenvectors)
}

//y = A·x over the CSR, one row at a time, entries in ascending column
//order — the order the JS sums in as well, which is what lets the two
//implementations agree on the arithmetic they share.
fn matvec(row_ptr: &[usize], cols: &[u32], vals: &[f64], x: &[f64]) -> Vec<f64> {
    let n = row_ptr.len() - 1;
    let mut out = vec![0.0; n];
    for i in 0..n {
        let mut sum = 0.0;
        for idx in row_ptr[i]..row_ptr[i + 1] {
            sum += vals[idx] * x[cols[idx] as usize];
        }
        out[i] = sum;
    }
    out
}

//Make v orthogonal to the first `comp` columns of the basis found so far.
fn orthogonalize(v: &mut [f64], basis: &[f64], n: usize, k: usize, comp: usize) {
    for prev in 0..comp {
        let mut dot = 0.0;
        for i in 0..n {
            dot += v[i] * basis[i * k + prev];
        }
        for i in 0..n {
            v[i] -= dot * basis[i * k + prev];
        }
    }
}

fn kmeans_on_embedding(embedding: &[f64], n_samples: usize, n_clusters: usize) -> Vec<usize> {
    let n_features = n_clusters; // embedding dimension = n_clusters
    let mut assignments = vec![0; n_samples];
    
    // Simple random initialization
    let mut centroids = vec![0.0; n_clusters * n_features];
    for c in 0..n_clusters {
        let idx = (c * n_samples / n_clusters).min(n_samples - 1);
        for f in 0..n_features {
            centroids[c * n_features + f] = embedding[idx * n_features + f];
        }
    }
    
    for _ in 0..100 {
        let mut changed = false;
        for i in 0..n_samples {
            let mut best_c = 0;
            let mut best_dist = f64::INFINITY;
            for c in 0..n_clusters {
                let mut dist = 0.0;
                for f in 0..n_features {
                    let diff = embedding[i * n_features + f] - centroids[c * n_features + f];
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
        if !changed { break; }
        
        let mut counts = vec![0; n_clusters];
        let mut new_centroids = vec![0.0; n_clusters * n_features];
        for i in 0..n_samples {
            let c = assignments[i];
            counts[c] += 1;
            for f in 0..n_features {
                new_centroids[c * n_features + f] += embedding[i * n_features + f];
            }
        }
        for c in 0..n_clusters {
            if counts[c] > 0 {
                for f in 0..n_features {
                    centroids[c * n_features + f] = new_centroids[c * n_features + f] / counts[c] as f64;
                }
            }
        }
    }
    
    assignments
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
    fn test_spectral_simple() {
        // Two clear clusters
        let data = vec![
            1.0, 1.0,
            1.1, 1.1,
            0.9, 0.9,
            -1.0, -1.0,
            -1.1, -1.1,
            -0.9, -0.9,
        ];
        let result = spectral_cluster(&data, 6, 2, 2, 1.0, 5);
        assert!(!result.is_empty());
        // 6 assignments + 6*2 embedding + 2*2 centers + 2 counts = 6 + 12 + 4 + 2 = 24
        assert_eq!(result.len(), 6 + 6*2 + 2*2 + 2);
        
        for i in 0..6 {
            assert!(result[i] == 0.0 || result[i] == 1.0);
        }
    }

    #[test]
    fn test_spectral_invalid() {
        let data = vec![1.0, 2.0];
        let result = spectral_cluster(&data, 0, 2, 2, 1.0, 5);
        assert!(result.is_empty());
        
        let result = spectral_cluster(&data, 1, 2, 3, 1.0, 5); // n_clusters > n_samples
        assert!(result.is_empty());
    }
}
