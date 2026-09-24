#![allow(unused)]
use wasm_bindgen::prelude::*;

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
/// Returns a flat vector of [birth, death, birth_idx, death_idx, ...].
#[wasm_bindgen]
pub fn persistent_homology_0d(data: &[f64], mode: &str) -> Vec<f64> {
    let n = data.len();
    if n < 2 {
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

    let mut result: Vec<f64> = Vec::with_capacity((n - 1) * 4);

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
                result.push(bv);
                result.push(death);
                result.push(birth_idx[rv] as f64);
                result.push(death_idx as f64);
                parent[rv] = ru;
            } else {
                result.push(bu);
                result.push(death);
                result.push(birth_idx[ru] as f64);
                result.push(death_idx as f64);
                parent[ru] = rv;
            }
        }
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_persistent_homology_sublevel() {
        let y = [1.0, 3.0, 2.0, 4.0, 0.0];
        let pairs = persistent_homology_0d(&y, "sublevel");
        // Each pair has 4 floats: [birth, death, birth_idx, death_idx]
        assert_eq!(pairs.len(), 4 * 4);
        for chunk in pairs.chunks_exact(4) {
            let birth = chunk[0];
            let death = chunk[1];
            assert!(death >= birth, "In sublevel, death must be >= birth");
        }
    }

    #[test]
    fn test_persistent_homology_superlevel() {
        let y = [1.0, 3.0, 2.0, 4.0, 0.0];
        let pairs = persistent_homology_0d(&y, "superlevel");
        assert_eq!(pairs.len(), 4 * 4);
        for chunk in pairs.chunks_exact(4) {
            let birth = chunk[0];
            let death = chunk[1];
            assert!(birth >= death, "In superlevel, birth must be >= death");
        }
    }
}