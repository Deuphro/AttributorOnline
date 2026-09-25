use wasm_bindgen::prelude::*;
use crate::persistent_homology_0d;

const MIN_CLASSIFIER_SLOPE: f64 = 1e-9;
const MAX_CLASSIFIER_SLOPE: f64 = 1.0 - 1e-12;

#[wasm_bindgen]
pub struct PersistenceAnalysis {
    births: Vec<f64>, deaths: Vec<f64>, points_x: Vec<f64>, points_y: Vec<f64>,
    birth_indices: Vec<f64>, slope: f64,
}
#[wasm_bindgen]
impl PersistenceAnalysis {
    #[wasm_bindgen(getter)] pub fn births(&self) -> Vec<f64> { self.births.clone() }
    #[wasm_bindgen(getter)] pub fn deaths(&self) -> Vec<f64> { self.deaths.clone() }
    #[wasm_bindgen(getter)] pub fn points_x(&self) -> Vec<f64> { self.points_x.clone() }
    #[wasm_bindgen(getter)] pub fn points_y(&self) -> Vec<f64> { self.points_y.clone() }
    #[wasm_bindgen(getter)] pub fn birth_indices(&self) -> Vec<f64> { self.birth_indices.clone() }
    #[wasm_bindgen(getter)] pub fn slope(&self) -> f64 { self.slope }
}

#[wasm_bindgen]
pub struct PersistenceClassification {
    kept_births: Vec<f64>, kept_deaths: Vec<f64>, kept_points_x: Vec<f64>, kept_points_y: Vec<f64>,
    discarded_births: Vec<f64>, discarded_deaths: Vec<f64>, kept_count: usize,
}
#[wasm_bindgen]
impl PersistenceClassification {
    #[wasm_bindgen(getter)] pub fn kept_births(&self) -> Vec<f64> { self.kept_births.clone() }
    #[wasm_bindgen(getter)] pub fn kept_deaths(&self) -> Vec<f64> { self.kept_deaths.clone() }
    #[wasm_bindgen(getter)] pub fn kept_points_x(&self) -> Vec<f64> { self.kept_points_x.clone() }
    #[wasm_bindgen(getter)] pub fn kept_points_y(&self) -> Vec<f64> { self.kept_points_y.clone() }
    #[wasm_bindgen(getter)] pub fn discarded_births(&self) -> Vec<f64> { self.discarded_births.clone() }
    #[wasm_bindgen(getter)] pub fn discarded_deaths(&self) -> Vec<f64> { self.discarded_deaths.clone() }
    #[wasm_bindgen(getter)] pub fn kept_count(&self) -> usize { self.kept_count }
}

fn clamp_slope(slope: f64) -> f64 {
    if slope.is_finite() { slope.clamp(MIN_CLASSIFIER_SLOPE, MAX_CLASSIFIER_SLOPE) } else { MAX_CLASSIFIER_SLOPE }
}
fn passes(death: f64, birth: f64, slope: f64) -> bool {
    death <= slope * birth || death <= slope * birth + 1e-9 * birth.abs().max(1.0)
}

/// Computes one H0 interval per input point. `core` is canonical:
/// [x0..xN, y0..yN] for stride 2, or [y0..yN] for stride 1.
/// Superlevel activates points by decreasing Y; sublevel by increasing Y.
#[wasm_bindgen]
pub fn persistent_homology_0d_waves(core: &[f64], stride: usize, mode: &str) -> PersistenceAnalysis {
    if stride != 1 && stride != 2 { panic!("core stride must be 1 or 2"); }
    let n=core.len()/stride;
    let y=&core[(if stride==2 {n} else {0})..(if stride==2 {2*n} else {n})];
    let superlevel=mode=="superlevel";
    let mut order:Vec<usize>=(0..n).collect();
    order.sort_by(|&i,&j|{let cmp=y[i].partial_cmp(&y[j]).unwrap_or(std::cmp::Ordering::Equal);if superlevel{cmp.reverse()}else{cmp}.then_with(||{let xi=if stride==2{core[i]}else{i as f64};let xj=if stride==2{core[j]}else{j as f64};xi.partial_cmp(&xj).unwrap_or(std::cmp::Ordering::Equal)})});
    let mut parent:Vec<usize>=(0..n).collect();
    let mut birth=y.to_vec();
    let mut deaths=vec![0.0;n];
    let mut active=vec![false;n];
    fn find(parent:&mut [usize],mut i:usize)->usize{while parent[i]!=i{parent[i]=parent[parent[i]];i=parent[i]}i}
    for &idx in &order {
        active[idx]=true;
        let neighbors=[if idx>0{Some(idx-1)}else{None},if idx+1<n{Some(idx+1)}else{None}];
        for neighbor in neighbors.into_iter().flatten(){
            if !active[*neighbor]{continue}
            let mut ra=find(&mut parent,idx); let rb=find(&mut parent,*neighbor);
            if ra==rb{continue}
            let edge=if superlevel{y[idx].min(y[*neighbor])}else{y[idx].max(y[*neighbor])};
            let ra_is_old=if superlevel{birth[ra]>=birth[rb]}else{birth[ra]<=birth[rb]};
            //The component with the lower birth value dies when the two
            //components merge; the higher-birth component survives.
            let dying=if birth[ra]<=birth[rb]{ra}else{rb};
            deaths[dying]=edge;
            if ra_is_old{parent[rb]=ra}else{parent[ra]=rb}
        }
    }
    let mut rows:Vec<(f64,f64,f64,f64)>=Vec::with_capacity(n);
    for i in 0..n {let x=if stride==2{core[i]}else{i as f64};rows.push((x,y[i],deaths[i],i as f64))}
    rows.sort_by(|a,b|{let ord=a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal);if ord==std::cmp::Ordering::Equal{if a.3<b.3{std::cmp::Ordering::Less}else if a.3>b.3{std::cmp::Ordering::Greater}else{ord}}else{ord}});
    let mut births=Vec::with_capacity(n);let mut out_deaths=Vec::with_capacity(n);let mut points_x=Vec::with_capacity(n);let mut points_y=Vec::with_capacity(n);let mut birth_indices=Vec::with_capacity(n);let mut sum_birth=0.0;let mut sum_death=0.0;
    for (x,b,d,idx) in rows{births.push(b);out_deaths.push(d);points_x.push(x);points_y.push(b);birth_indices.push(idx);sum_birth+=b;sum_death+=d}
    let slope=if sum_birth>0.0&&(sum_death/sum_birth).is_finite(){clamp_slope(sum_death/sum_birth)}else{let mut max_ratio: f64=0.0;for i in 0..n{if births[i]>0.0{max_ratio=max_ratio.max(out_deaths[i]/births[i])}}clamp_slope(max_ratio*(1.0+f64::EPSILON))};
    PersistenceAnalysis{births,deaths:out_deaths,points_x,points_y,birth_indices,slope}
}

#[wasm_bindgen]
pub fn classify_persistence_0d(births:&[f64],deaths:&[f64],points_x:&[f64],points_y:&[f64],slope:f64)->PersistenceClassification{
    let n=births.len(); let mut kept_births=Vec::new(); let mut kept_deaths=Vec::new(); let mut kept_points_x=Vec::new(); let mut kept_points_y=Vec::new();
    let mut discarded_births=Vec::new(); let mut discarded_deaths=Vec::new();
    for i in 0..n { if passes(deaths[i],births[i],slope) { kept_births.push(births[i]); kept_deaths.push(deaths[i]); kept_points_x.push(points_x[i]); kept_points_y.push(points_y[i]); } else { discarded_births.push(births[i]); discarded_deaths.push(deaths[i]); } }
    let kept_count=kept_births.len(); PersistenceClassification{kept_births,kept_deaths,kept_points_x,kept_points_y,discarded_births,discarded_deaths,kept_count}
}

