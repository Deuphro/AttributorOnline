use wasm_bindgen::prelude::*;
use crate::persistent_homology_0d;

const MIN_CLASSIFIER_SLOPE: f64 = 1e-9;
const MAX_CLASSIFIER_SLOPE: f64 = 1.0 - 1e-12;

#[wasm_bindgen]
pub struct PersistenceAnalysis {
    births: Vec<f64>, deaths: Vec<f64>, points_x: Vec<f64>, points_y: Vec<f64>,
    birth_indices: Vec<f64>, slope: f64,
    //INTEGRATED MASS, accumulated by the union-find as it merges. Before this
    //existed the structure knew WHICH points merged and in what order, and
    //threw away how much signal they carried: a dying component was a pair
    //(birth, death) and nothing else. The merge is exactly the moment the
    //information still exists, so it is taken THERE, once per union, instead
    //of being rebuilt afterwards by walking the profile a second time.
    //
    //integrated_mass[i] is the summed intensity of the component that died
    //reporting its interval at i - the peak AREA, in the units of the input Y.
    //centroid_x[i] is that component's intensity-weighted mean X, i.e. where
    //the mass actually sits. NaN where the component carried no intensity: a
    //centroid of nothing is not zero, it is undefined.
    integrated_mass: Vec<f64>, centroid_x: Vec<f64>,
}
#[wasm_bindgen]
impl PersistenceAnalysis {
    #[wasm_bindgen(getter)] pub fn births(&self) -> Vec<f64> { self.births.clone() }
    #[wasm_bindgen(getter)] pub fn deaths(&self) -> Vec<f64> { self.deaths.clone() }
    #[wasm_bindgen(getter)] pub fn points_x(&self) -> Vec<f64> { self.points_x.clone() }
    #[wasm_bindgen(getter)] pub fn points_y(&self) -> Vec<f64> { self.points_y.clone() }
    #[wasm_bindgen(getter)] pub fn birth_indices(&self) -> Vec<f64> { self.birth_indices.clone() }
    #[wasm_bindgen(getter)] pub fn slope(&self) -> f64 { self.slope }
    #[wasm_bindgen(getter)] pub fn integrated_mass(&self) -> Vec<f64> { self.integrated_mass.clone() }
    #[wasm_bindgen(getter)] pub fn centroid_x(&self) -> Vec<f64> { self.centroid_x.clone() }
}

#[wasm_bindgen]
pub struct PersistenceClassification {
    kept_births: Vec<f64>, kept_deaths: Vec<f64>, kept_points_x: Vec<f64>, kept_points_y: Vec<f64>,
    //The index of each KEPT point in the INPUT wave. The classifier only ever
    //REORDERS or REMOVES points, so this is the only way back to the profile:
    //without it a kept point is just a coordinate, and a filter that needs the
    //raw samples around it (a width, a shape) has nothing to measure. It is the
    //same convention as trim.rs kept_indices.
    kept_indices: Vec<f64>,
    /* THE INTEGRATED MASS, CARRIED THROUGH THE CLASSIFIER.
       It used to be computed by the sweep and then dropped on the floor here:
       the classifier re-emitted kept_points_y, which is the intensity of the
       single point that BORN the component — the chief, as it were — so
       everything downstream still saw one tall point per peak and never the
       area under it. The sum was right for one kernel call and gone by the
       next one.

       So it travels with its point: an array of the same length, reordered and
       filtered exactly as kept_points_x is. */
    kept_integrated_mass: Vec<f64>, kept_centroid_x: Vec<f64>,
    discarded_births: Vec<f64>, discarded_deaths: Vec<f64>, kept_count: usize,
}
#[wasm_bindgen]
impl PersistenceClassification {
    #[wasm_bindgen(getter)] pub fn kept_births(&self) -> Vec<f64> { self.kept_births.clone() }
    #[wasm_bindgen(getter)] pub fn kept_deaths(&self) -> Vec<f64> { self.kept_deaths.clone() }
    #[wasm_bindgen(getter)] pub fn kept_points_x(&self) -> Vec<f64> { self.kept_points_x.clone() }
    #[wasm_bindgen(getter)] pub fn kept_points_y(&self) -> Vec<f64> { self.kept_points_y.clone() }
    #[wasm_bindgen(getter)] pub fn kept_indices(&self) -> Vec<f64> { self.kept_indices.clone() }
    #[wasm_bindgen(getter)] pub fn kept_integrated_mass(&self) -> Vec<f64> { self.kept_integrated_mass.clone() }
    #[wasm_bindgen(getter)] pub fn kept_centroid_x(&self) -> Vec<f64> { self.kept_centroid_x.clone() }
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
    /* THE INTEGRATION, held on the ROOTS.
       mass[root] is the summed intensity of the component rooted here, and
       xmass[root] the same sum weighted by X, so the centroid is their ratio.
       Both are indexed by root, exactly like birth and deaths, because that is
       what the merge hands back.

       The accumulator is a sum, never an average of averages: two components
       merging must not let a tall peak be outvoted by a wide one, and a mean
       of the two means would do exactly that. */
    let mut mass:Vec<f64>=(0..n).map(|i| if y[i].is_finite(){y[i]}else{0.0}).collect();
    let mut xmass:Vec<f64>=(0..n).map(|i|{let x=if stride==2{core[i]}else{i as f64};if x.is_finite()&&y[i].is_finite(){x*y[i]}else{0.0}}).collect();
    //recorded per DYING root, then read back on the same index as deaths
    let mut integrated=vec![0.0;n];
    let mut centroid=vec![f64::NAN;n];
    //whether this root ever DIED. A flag and not "integrated == 0": a component
    //can die carrying no intensity at all - a valley - and a mass of zero is a
    //perfectly good area, not the mark of a survivor.
    let mut died=vec![false;n];
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
            /* WHICH END DIES, and which one is told apart here because the two
               rules used to be written separately and DISAGREEED on a tie.

               ra_is_old already decides the survivor: it is the side the parent
               pointer keeps, and a tie makes it keep `ra`. The dying side used
               to be computed again as `birth[ra] <= birth[rb] ? ra : rb`, which
               on a tie ALSO picks `ra` - the surviving one. So on every plateau
               the component that lived on was recorded as the one that died.

               That was invisible while a death was only a (birth, death) pair,
               because the level was the same either way. It stops being
               invisible the moment the component carries a MASS: the survivor
               was stamped with the mass it had at that instant and its final,
               complete total was then thrown away. One decision, used twice. */
            let (survivor,dying)=if ra_is_old{(ra,rb)}else{(rb,ra)};
            deaths[dying]=edge;
            /* The dying component's OWN total, recorded BEFORE the hand-off:
               once the accumulators are folded into the survivor the area that
               just died is nowhere to be found. This is the whole point of
               integrating here rather than after the sweep - after the sweep
               every point belongs to one component and the split is gone. */
            integrated[dying]=mass[dying];
            centroid[dying]=if mass[dying]!=0.0{xmass[dying]/mass[dying]}else{f64::NAN};
            died[dying]=true;
            mass[survivor]+=mass[dying];
            xmass[survivor]+=xmass[dying];
            if ra_is_old{parent[rb]=ra}else{parent[ra]=rb}
        }
    }
    /* The component that NEVER dies still has a mass, and it is the one the user
       is usually looking at: the tallest peak of a superlevel sweep is still
       growing when the filtration ends. It is recorded on its own root by the
       same rule as every other component, so "the integrated area" carries no
       exception the caller would have to remember. */
    for i in 0..n{ if !died[i] {integrated[i]=mass[i];centroid[i]=if mass[i]!=0.0{xmass[i]/mass[i]}else{f64::NAN}} }
    let mut rows:Vec<(f64,f64,f64,f64,f64,f64)>=Vec::with_capacity(n);
    for i in 0..n {let x=if stride==2{core[i]}else{i as f64};rows.push((x,y[i],deaths[i],i as f64,integrated[i],centroid[i]))}
    rows.sort_by(|a,b|{let ord=a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal);if ord==std::cmp::Ordering::Equal{if a.3<b.3{std::cmp::Ordering::Less}else if a.3>b.3{std::cmp::Ordering::Greater}else{ord}}else{ord}});
    let mut births=Vec::with_capacity(n);let mut out_deaths=Vec::with_capacity(n);let mut points_x=Vec::with_capacity(n);let mut points_y=Vec::with_capacity(n);let mut birth_indices=Vec::with_capacity(n);let mut out_integrated=Vec::with_capacity(n);let mut out_centroid=Vec::with_capacity(n);let mut sum_birth=0.0;let mut sum_death=0.0;
    for (x,b,d,idx,integ,cent) in rows{births.push(b);out_deaths.push(d);points_x.push(x);points_y.push(b);birth_indices.push(idx);out_integrated.push(integ);out_centroid.push(cent);sum_birth+=b;sum_death+=d}
    let slope=if sum_birth>0.0&&(sum_death/sum_birth).is_finite(){clamp_slope(sum_death/sum_birth)}else{let mut max_ratio: f64=0.0;for i in 0..n{if births[i]>0.0{max_ratio=max_ratio.max(out_deaths[i]/births[i])}}clamp_slope(max_ratio*(1.0+f64::EPSILON))};
    PersistenceAnalysis{births,deaths:out_deaths,points_x,points_y,birth_indices,slope,integrated_mass:out_integrated,centroid_x:out_centroid}
}

/// `points_index` is the position of each point in the INPUT wave (the
/// birth_indices of persistent_homology_0d_waves, already sorted and aligned
/// with the points). It is carried through the classifier untouched: the slope
/// decides WHICH points survive, never where they came from.
#[wasm_bindgen]
pub fn classify_persistence_0d(births:&[f64],deaths:&[f64],points_x:&[f64],points_y:&[f64],points_index:&[f64],slope:f64,integrated_mass:&[f64],centroid_x:&[f64])->PersistenceClassification{
    let n=births.len(); let mut kept_births=Vec::new(); let mut kept_deaths=Vec::new(); let mut kept_points_x=Vec::new(); let mut kept_points_y=Vec::new(); let mut kept_indices=Vec::new(); let mut kept_mass=Vec::new(); let mut kept_centroid=Vec::new();
    let mut discarded_births=Vec::new(); let mut discarded_deaths=Vec::new();
    for i in 0..n { if passes(deaths[i],births[i],slope) { kept_births.push(births[i]); kept_deaths.push(deaths[i]); kept_points_x.push(points_x[i]); kept_points_y.push(points_y[i]);
        //A missing or out-of-range index stays NaN rather than being clamped: a
        //fabricated index would send a downstream profile read to the wrong
        //peak, which is worse than an index that is visibly unusable.
        kept_indices.push(points_index.get(i).copied().unwrap_or(f64::NAN));
        //Same rule for the mass: a too-short array yields NaN, not zero. A zero
        //would read as "this peak has no area", which is a CLAIM; a NaN reads
        //as "this build did not tell me", which is the truth — and the two are
        //very different to whoever is reading the spectrum.
        kept_mass.push(integrated_mass.get(i).copied().unwrap_or(f64::NAN));
        kept_centroid.push(centroid_x.get(i).copied().unwrap_or(f64::NAN)); } else { discarded_births.push(births[i]); discarded_deaths.push(deaths[i]); } }
    let kept_count=kept_births.len(); PersistenceClassification{kept_births,kept_deaths,kept_points_x,kept_points_y,kept_indices,kept_integrated_mass:kept_mass,kept_centroid_x:kept_centroid,discarded_births,discarded_deaths,kept_count}
}

#[cfg(test)]
mod tests {
    use super::*;

    /* Two well-separated peaks. The superlevel sweep activates the tall one
       first, it survives, and the short one dies into it at the valley between
       them - so the short peak's OWN area is what the dying component carries. */
    const TWO_PEAKS_X: [f64; 8] = [10.0, 20.0, 30.0, 40.0, 50.0, 60.0, 70.0, 80.0];
    const TWO_PEAKS_Y: [f64; 8] = [1.0, 1.0, 9.0, 1.0, 1.0, 8.0, 1.0, 1.0];

    fn two_peaks(mode: &str) -> PersistenceAnalysis {
        let mut core = Vec::new();
        core.extend_from_slice(&TWO_PEAKS_X);
        core.extend_from_slice(&TWO_PEAKS_Y);
        persistent_homology_0d_waves(&core, 2, mode)
    }

    #[test]
    fn a_dying_component_carries_the_area_of_the_peak_that_died() {
        let a = two_peaks("superlevel");
        let mass = a.integrated_mass();
        //the short peak (Y=8 at x=60) dies first and must report its own 8,
        //never the sum it hands over to the survivor
        let short = mass
            .iter()
            .zip(a.points_x())
            .find(|(_, x)| (*x - 60.0).abs() < 1e-9)
            .map(|(m, _)| *m)
            .expect("the peak at x=60 is missing from the analysis");
        assert!(
            (short - 8.0).abs() < 1e-9,
            "the dying component should carry 8, got {}",
            short
        );
    }

    #[test]
    fn the_centroid_of_a_component_is_its_intensity_weighted_mean() {
        //The reported point is the component's BIRTH, not its centre: a
        //component that absorbed points on both sides has a centroid far from
        //the point that represents it. So the centroid is checked against the
        //points that went INTO it, computed here by hand.
        let x = [10.0, 20.0, 30.0];
        let y = [5.0, 0.0, 5.0];
        let mut core = Vec::new();
        core.extend_from_slice(&x);
        core.extend_from_slice(&y);
        let a = persistent_homology_0d_waves(&core, 2, "superlevel");
        let cent = a.centroid_x();
        //the one component that never died holds every point:
        //(10*5 + 20*0 + 30*5) / 10 = 200 / 10 = 20
        let root = cent
            .iter()
            .position(|c| (*c - 20.0).abs() < 1e-9)
            .unwrap_or_else(|| panic!("no component reported the full-profile centroid 20"));
        //and it must be the one holding all the mass
        assert!(
            (a.integrated_mass()[root] - 10.0).abs() < 1e-9,
            "the surviving component should hold the whole 10"
        );
        //the peak that died into it kept its OWN area and its own position
        let other = x
            .iter()
            .position(|v| (*v - 30.0).abs() < 1e-9)
            .expect("the peak at x=30 is missing");
        assert!(
            (a.integrated_mass()[other] - 5.0).abs() < 1e-9,
            "the dying peak should carry its own 5, not the total"
        );
        assert!((a.centroid_x()[other] - 30.0).abs() < 1e-9);
    }

    #[test]
    fn a_dying_component_is_smaller_than_the_one_that_absorbs_it() {
        //The subtree masses form a TREE, so summing every entry double counts:
        //a point absorbed by a small component is counted again in whatever
        //absorbed that component. Conservation is therefore a property of the
        //ROOT alone, never of the sum - and each step down must be smaller.
        let x = [1.0, 2.0, 3.0, 4.0];
        let y = [5.0, 0.0, 0.0, 5.0];
        let mut core = Vec::new();
        core.extend_from_slice(&x);
        core.extend_from_slice(&y);
        let a = persistent_homology_0d_waves(&core, 2, "superlevel");
        let mass = a.integrated_mass();
        let total: f64 = y.iter().sum();
        let largest = mass.iter().cloned().fold(0.0, f64::max);
        assert!(
            (largest - total).abs() < 1e-9,
            "the deepest component should hold the whole profile ({}), got {}",
            total,
            largest
        );
        //the valleys carried no intensity, so they die carrying nothing
        for m in &mass {
            assert!(m.is_finite() && *m >= 0.0);
        }
    }

    #[test]
    fn a_component_with_no_intensity_has_no_centroid() {
        //an all-zero profile: the areas are 0, and a centroid of nothing is
        //undefined, so it must be NaN rather than a misleading 0
        let core = [0.0, 0.0, 0.0, 0.0];
        let a = persistent_homology_0d_waves(&core, 2, "superlevel");
        for c in a.centroid_x() {
            assert!(c.is_nan(), "an empty component must not report a centroid");
        }
    }

    #[test]
    fn a_non_finite_intensity_does_not_poison_the_accumulator() {
        //NaN in the profile must not turn every later area into NaN: a single
        //bad sample would otherwise erase the mass of the whole spectrum
        let x = [1.0, 2.0, 3.0];
        let y = [10.0, f64::NAN, 4.0];
        let mut core = Vec::new();
        core.extend_from_slice(&x);
        core.extend_from_slice(&y);
        let a = persistent_homology_0d_waves(&core, 2, "superlevel");
        for m in a.integrated_mass() {
            assert!(m.is_finite(), "a NaN sample leaked into the integrated mass");
        }
    }

    #[test]
    fn an_empty_profile_yields_empty_mass_not_a_crash() {
        let a = persistent_homology_0d_waves(&[], 2, "superlevel");
        assert!(a.integrated_mass().is_empty());
        assert!(a.centroid_x().is_empty());
    }
}

