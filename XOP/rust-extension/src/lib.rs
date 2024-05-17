#![allow(unused)]
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn compute(a: i32,b: i32) -> i32{
    println!("Hello, world!");
    let mut c=0;
    for k in 0..a {
        for i in 0..b {
            c=k+i;
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
pub fn bench(n: u64) -> u64{
    let mut sum=0;
    for k in 0..n{
        for i in 0..n{
            sum+=1
        }
    }
    return sum
}