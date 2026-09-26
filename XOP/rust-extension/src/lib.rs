#![allow(unused)]
use wasm_bindgen::prelude::*;
mod persistence;
mod trim;
pub use persistence::{
    classify_persistence_0d, persistent_homology_0d_waves, PersistenceAnalysis,
    PersistenceClassification,
};
pub use trim::{trim_histogram, trim_wave, TrimHistogram, TrimResult};

#[wasm_bindgen]
pub fn compute(a: i32,b: i32) -> i32{
    println!("Hello, world!");
    let mut c=0;
    for k in 0..a {
        for i in 0..b {
            c=c+0b1//=k+i;
        }
    }
    return c;
}

#[wasm_bindgen]
pub fn add(a: i32,b: i32) -> i32{
    a + b
}

#[wasm_bindgen]
pub fn arrust(data: &mut [f64]){
    for value in data.iter_mut(){
        *value += 1.0;
    }
}

#[wasm_bindgen]
pub fn add_scalar(data: &mut [f64], scalar: f64){
    for value in data.iter_mut(){
        *value += scalar;
    }
}

#[wasm_bindgen]
pub fn bench(n: u64) -> u64{
    let mut sum=0;
    for k in 0..n{
        for i in 0..n{
            sum+=1
        }
    }
    return sum
}

//on veut énumérer les coordonnées d'une tableau nd
#[wasm_bindgen]
pub fn sieve() -> String {
    let a="Hello World !";
    println!("{}",a);
    a.to_string()
}

//on veut faire un tableau de zéros
#[wasm_bindgen]
pub fn zeros_matrix(n: usize) -> Vec<i32> {
    vec![0; n * n]
}

/// Computes 0D persistent homology on a 1D sequence of values (Y values).
/// Supports sublevel (default) and superlevel set filtration.
/// Returns a flat, non-interleaved vector with four contiguous blocks:
/// [births..., deaths..., birth_indices..., death_indices...].
#[wasm_bindgen]
pub fn persistent_homology_0d(data: &[f64], mode: &str) -> Vec<f64> {
    let n = data.len();
    if n == 0 {
        return Vec::new();
    }

    let is_superlevel = mode == "superlevel";

    // Union-Find data structures
    let mut parent: Vec<usize> = (0..n).collect();
    let mut birth_val: Vec<f64> = data.to_vec();
    let mut birth_idx: Vec<usize> = (0..n).collect();

    fn find(parent: &mut [usize], mut i: usize) -> usize {
        let mut root = i;
        while root != parent[root] {
            root = parent[root];
        }
        while i != root {
            let next = parent[i];
            parent[i] = root;
            i = next;
        }
        root
    }

    struct Edge {
        u: usize,
        v: usize,
        weight: f64,
    }

    let mut edges: Vec<Edge> = Vec::with_capacity(n - 1);
    for i in 0..(n - 1) {
        let w = if is_superlevel {
            data[i].min(data[i + 1])
        } else {
            data[i].max(data[i + 1])
        };
        edges.push(Edge { u: i, v: i + 1, weight: w });
    }

    if is_superlevel {
        edges.sort_by(|a, b| b.weight.partial_cmp(&a.weight).unwrap_or(std::cmp::Ordering::Equal));
    } else {
        edges.sort_by(|a, b| a.weight.partial_cmp(&b.weight).unwrap_or(std::cmp::Ordering::Equal));
    }

    let mut pairs: Vec<(f64, f64, usize, usize)> = Vec::with_capacity(n - 1);

    for edge in edges {
        let ru = find(&mut parent, edge.u);
        let rv = find(&mut parent, edge.v);

        if ru != rv {
            let bu = birth_val[ru];
            let bv = birth_val[rv];

            let u_is_older = if is_superlevel {
                bu > bv || (bu == bv && ru < rv)
            } else {
                bu < bv || (bu == bv && ru < rv)
            };

            let death = edge.weight;
            let death_idx = if is_superlevel {
                if data[edge.u] <= data[edge.v] { edge.u } else { edge.v }
            } else {
                if data[edge.u] >= data[edge.v] { edge.u } else { edge.v }
            };

            if u_is_older {
                //At a plateau edge, a component born at this exact filtration
                //level merges immediately and has no interval of persistence.
                if bv == death {
                    pairs.push((bu, death, birth_idx[ru], death_idx));
                } else if bv < death || (is_superlevel && bv > death) {
                    pairs.push((bv, death, birth_idx[rv], death_idx));
                }
                parent[rv] = ru;
            } else {
                if bu == death {
                    pairs.push((bv, death, birth_idx[rv], death_idx));
                } else if bu < death || (is_superlevel && bu > death) {
                    pairs.push((bu, death, birth_idx[ru], death_idx));
                }
                parent[ru] = rv;
            }
        }
    }

    // A superlevel component containing the global maximum never dies. Add it
    // explicitly as (birth=max, death=0), so downstream classifiers keep the
    // most intense original point regardless of their threshold.
    if is_superlevel {
        let mut maximum_idx = 0;
        for i in 1..n {
            if data[i] > data[maximum_idx] {
                maximum_idx = i;
            }
        }
        pairs.push((data[maximum_idx], 0.0, maximum_idx, maximum_idx));
    }

    let pair_count = pairs.len();
    let mut result = Vec::with_capacity(pair_count * 4);
    result.extend(pairs.iter().map(|pair| pair.0));
    result.extend(pairs.iter().map(|pair| pair.1));
    result.extend(pairs.iter().map(|pair| pair.2 as f64));
    result.extend(pairs.iter().map(|pair| pair.3 as f64));
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_persistent_homology_sublevel() {
        let y = [1.0, 3.0, 2.0, 4.0, 0.0];
        let pairs = persistent_homology_0d(&y, "sublevel");
        // Non-interleaved blocks: births | deaths | birth indices | death indices.
        let pair_count = pairs.len() / 4;
        assert_eq!(pairs.len(), 4 * pair_count);
        for i in 0..pair_count {
            assert!(pairs[pair_count + i] >= pairs[i], "In sublevel, death must be >= birth");
            assert!(pairs[3 * pair_count + i] >= 0.0);
            assert!(pairs[4 * pair_count - 1 - i] >= 0.0);
        }
    }

    #[test]
    fn test_persistent_homology_superlevel() {
        let y = [1.0, 3.0, 2.0, 4.0, 0.0];
        let pairs = persistent_homology_0d(&y, "superlevel");
        let pair_count = pairs.len() / 4;
        assert_eq!(pairs.len(), 4 * pair_count);
        for i in 0..pair_count {
            assert!(pairs[i] >= pairs[pair_count + i], "In superlevel, birth must be >= death");
            assert!(pairs[3 * pair_count + i] >= 0.0);
            assert!(pairs[4 * pair_count - 1 - i] >= 0.0);
        }

        // The component of the global maximum never dies in superlevel mode.
        // It is returned explicitly as (birth=4, death=0), with index 3.
        let synthetic = pair_count - 1;
        assert_eq!(pairs[synthetic], 4.0);
        assert_eq!(pairs[pair_count + synthetic], 0.0);
        assert_eq!(pairs[2 * pair_count + synthetic], 3.0);
        assert_eq!(pairs[3 * pair_count + synthetic], 3.0);
    }

    #[test]
    fn test_persistent_homology_superlevel_single_point() {
        let pairs = persistent_homology_0d(&[7.5], "superlevel");
        assert_eq!(pairs, vec![7.5, 0.0, 0.0, 0.0]);
    }

    #[test]
    fn test_persistent_homology_sublevel_keeps_infinite_component_omitted() {
        let pairs = persistent_homology_0d(&[1.0, 3.0, 2.0], "sublevel");
        assert_eq!(pairs.len() / 4, 2);
    }
}