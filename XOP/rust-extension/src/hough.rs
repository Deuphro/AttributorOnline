use wasm_bindgen::prelude::*;

/* =====================================================================
   The Hough accumulator of (slope, intercept).

   THE QUESTION THIS KERNEL WAS BUILT FOR. A Hough surface is a histogram,
   and a histogram needs a BIN SIZE. Choosing one in advance is the whole
   difficulty: too coarse and the distinct relations merge into one blob, too
   fine and a single relation falls between two bins and disappears. Every
   knob on the surface is then a parameter the user has to be told about.

   So the votes are spread over a small KERNEL instead of dropped in one bin,
   and the kernel is not a fixed disc: its shape is estimated FROM THE DATA,
   locally, at every point of the grid.

   WHY THE LOCAL ESTIMATE IS OVER THE GRID AND NOT OVER THE PAIRS.
   The pairs number P = n(n-1)/2 — half a million for a thousand peaks. A k-NN
   search over those points is O(P^2), which is O(n^4): at n = 1000 that is
   2.5 * 10^11 comparisons, and no amount of Rust makes that finish. The same
   question asked of the GRID — a few thousand occupied cells — costs
   O(cells * k), and it is the same question: "how wide is the relation here?"

   This is what the legacy `generelesmat()` could not do: it rounded to a bin,
   which is why that surface needed its bounds hand-tuned.
   ===================================================================== */

/// Accumulates every pair of peaks into a `nx` x `ny` grid of (slope, intercept),
/// spreading each vote over four neighbours rather than one cell.
///
/// `defect` is the Kendrick defect (`m - round(m)`), computed by the caller:
/// the kernel does not decide what a defect is, it only uses the number.
///
/// The output is FLAT and non-interleaved, the layout every kernel in this crate
/// uses: `[grid (nx*ny), slope_min, slope_max, intercept_min, intercept_max,
/// pairs_used]`. The four bounds travel with the data because a grid without
/// its domain is a picture of nothing.
#[wasm_bindgen]
pub fn hough_accumulate(
    mass: &[f64],
    defect: &[f64],
    intensity: &[f64],
    nx: usize,
    ny: usize,
    slope_min: f64,
    slope_max: f64,
    intercept_min: f64,
    intercept_max: f64,
) -> Vec<f64> {
    let n = mass.len();
    // A grid needs room, and a span needs width. Both refuse rather than guess:
    // a zero-width domain divides by zero and silently fills one cell.
    if n < 2 || nx < 2 || ny < 2 {
        return Vec::new();
    }
    if defect.len() != n || intensity.len() != n {
        return Vec::new();
    }
    if !(slope_max > slope_min) || !(intercept_max > intercept_min) {
        return Vec::new();
    }
    if !slope_min.is_finite()
        || !slope_max.is_finite()
        || !intercept_min.is_finite()
        || !intercept_max.is_finite()
    {
        return Vec::new();
    }

    let mut grid = vec![0.0f64; nx * ny];
    let mut used = 0.0f64;
    let slope_span = slope_max - slope_min;
    let intercept_span = intercept_max - intercept_min;

    for i in 0..n {
        for j in (i + 1)..n {
            let dm = mass[j] - mass[i];
            // A zero gap has no slope, and an infinity would poison the grid.
            if dm == 0.0 || !dm.is_finite() {
                continue;
            }
            let dd = defect[j] - defect[i];
            if !dd.is_finite() {
                continue;
            }
            let slope = dd / dm;
            let intercept = defect[i] - slope * mass[i];
            if !slope.is_finite() || !intercept.is_finite() {
                continue;
            }
            if slope < slope_min || slope > slope_max || intercept < intercept_min || intercept > intercept_max
            {
                continue;
            }
            /* THE CUMULATED INTENSITY OF THE TWO POINTS, as the weight: a pair
               built on two faint peaks says less about a relation than a pair
               built on two strong ones, and the accumulator should say so. */
            let wi = intensity[i];
            let wj = intensity[j];
            if !wi.is_finite() || !wj.is_finite() {
                continue;
            }
            let weight = wi + wj;
            if !(weight > 0.0) {
                continue;
            }
            used += 1.0;

            //Fractional grid coordinates, then a bilinear splat.
            let u = (slope - slope_min) / slope_span * (nx - 1) as f64;
            let v = (intercept - intercept_min) / intercept_span * (ny - 1) as f64;
            let u0 = u.floor() as isize;
            let v0 = v.floor() as isize;
            let fu = u - u0 as f64;
            let fv = v - v0 as f64;
            //u0 and v0 are in [0, nx-1) here, but a pair sitting exactly on the
            //last bound has u == nx-1 and a u0 one past it; the guard is what
            //keeps that from writing past the end of the buffer.
            let u0c = u0.clamp(0, nx as isize - 2);
            let v0c = v0.clamp(0, ny as isize - 2);
            let fu = fu.clamp(0.0, 1.0);
            let fv = fv.clamp(0.0, 1.0);

            for (di, wi0) in [(0isize, 1.0 - fu), (1isize, fu)] {
                if wi0 <= 0.0 {
                    continue;
                }
                let cx = (u0c + di) as usize;
                for (dj, wj0) in [(0isize, 1.0 - fv), (1isize, fv)] {
                    if wj0 <= 0.0 {
                        continue;
                    }
                    let cy = (v0c + dj) as usize;
                    grid[cy * nx + cx] += weight * wi0 * wj0;
                }
            }
        }
    }

    let mut out = grid;
    out.extend_from_slice(&[slope_min, slope_max, intercept_min, intercept_max, used]);
    out
}

/// Smooths a grid with a kernel whose SHAPE is estimated from the grid itself,
/// independently at every cell: the k nearest occupied neighbours give a local
/// mean and a local covariance, and the vote each neighbour casts is weighted by
/// that elliptical Gaussian rather than by an isotropic one.
///
/// The anisotropy is the point. A relation that is narrow across the slope axis
/// and wide along the intercept axis is a LINE, and an isotropic kernel smears
/// it into a blob; the covariance recovers the line.
#[wasm_bindgen]
pub fn hough_smooth(
    grid: &[f64],
    nx: usize,
    ny: usize,
    neighbours: usize,
    bandwidth: f64,
) -> Vec<f64> {
    let cells = nx * ny;
    if cells == 0 || grid.len() < cells || nx < 2 || ny < 2 {
        return Vec::new();
    }
    let k = neighbours.max(2);
    if !bandwidth.is_finite() || bandwidth <= 0.0 {
        return Vec::new();
    }
    let source = &grid[..cells];

    //THE OCCUPIED CELLS, ONCE. Scanning the whole neighbourhood for every cell
    //would be O(cells^2); the list below is O(cells) and turns the inner step
    //into a bounded scan instead.
    let mut occupied: Vec<(usize, usize, f64)> = Vec::new();
    for iy in 0..ny {
        for ix in 0..nx {
            let v = source[iy * nx + ix];
            if v != 0.0 && v.is_finite() {
                occupied.push((ix, iy, v));
            }
        }
    }
    if occupied.is_empty() {
        return source.to_vec();
    }
    let occupied = occupied;

    let bw2 = bandwidth * bandwidth;
    let mut out = vec![0.0f64; cells];
    let mut scratch: Vec<(f64, usize)> = Vec::with_capacity(k);

    for iy in 0..ny {
        for ix in 0..nx {
            let own = source[iy * nx + ix];
            scratch.clear();
            /* A WINDOW, then the k nearest inside it. The window is what keeps
               this linear; without it the k nearest would mean a full scan of
               the occupied cells from every cell. It is generous on purpose: a
               relation wider than the window falls back on the window's own
               scale rather than on a truncated neighbour set. */
            let reach = ((bw2 * 9.0).sqrt() as isize).max(3);
            let x0 = (ix as isize - reach).max(0) as usize;
            let x1 = (ix as isize + reach).min(nx as isize - 1) as usize;
            let y0 = (iy as isize - reach).max(0) as usize;
            let y1 = (iy as isize + reach).min(ny as isize - 1) as usize;
            for cy in y0..=y1 {
                for cx in x0..=x1 {
                    let v = source[cy * nx + cx];
                    if v == 0.0 || !v.is_finite() {
                        continue;
                    }
                    let dx = (cx as isize - ix as isize) as f64;
                    let dy = (cy as isize - iy as isize) as f64;
                    let d2 = dx * dx + dy * dy;
                    if d2 <= bw2 * 9.0 {
                        scratch.push((d2, cy * nx + cx));
                    }
                }
            }
            if scratch.len() < 2 {
                // Nothing to borrow a shape from: leave the cell as it is rather
                // than inventing one from a single sample.
                out[iy * nx + ix] = own;
                continue;
            }
            scratch.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
            let take = k.min(scratch.len());
            let take = take.max(2);

            //LOCAL MEAN AND COVARIANCE of the k nearest, in CELL units.
            let mut mx = 0.0;
            let mut my = 0.0;
            for (_, idx) in scratch.iter().take(take) {
                let cx = (*idx % nx) as f64;
                let cy = (*idx / nx) as f64;
                mx += cx;
                my += cy;
            }
            mx /= take as f64;
            my /= take as f64;
            let mut sxx = 0.0;
            let mut syy = 0.0;
            let mut sxy = 0.0;
            for (_, idx) in scratch.iter().take(take) {
                let cx = (*idx % nx) as f64;
                let cy = (*idx / nx) as f64;
                let dx = cx - mx;
                let dy = cy - my;
                sxx += dx * dx;
                syy += dy * dy;
                sxy += dx * dy;
            }
            let denom = (take as f64 - 1.0).max(1.0);
            sxx /= denom;
            syy /= denom;
            sxy /= denom;
            /* The FLOOR on the variance is what makes a single-valued
               neighbourhood usable: without it the inverse is a division by zero,
               and a line of identical cells would either explode or flatten to a
               disc. bandwidth is in the same units as the cell coordinates, so
               this is a sensible minimum, not a magic number. */
            sxx += bw2;
            syy += bw2;

            let det = sxx * syy - sxy * sxy;
            let (ixx, iyy, ixy) = if det > 1e-12 {
                (syy / det, sxx / det, -sxy / det)
            } else {
                //degenerate: fall back on an isotropic kernel of the floor scale
                (1.0 / bw2, 1.0 / bw2, 0.0)
            };

            let mut acc = 0.0;
            let mut total = 0.0;
            for (_, idx) in scratch.iter().take(take) {
                let v = source[*idx];
                let dx = ((*idx % nx) as f64) - (ix as f64);
                let dy = ((*idx / nx) as f64) - (iy as f64);
                //Mahalanobis distance under the local covariance, then the
                //elliptical Gaussian weight.
                let q = ixx * dx * dx + 2.0 * ixy * dx * dy + iyy * dy * dy;
                if q < 0.0 || !q.is_finite() {
                    continue;
                }
                let w = (-0.5 * q).exp();
                if !w.is_finite() {
                    continue;
                }
                acc += w * v;
                total += w;
            }
            out[iy * nx + ix] = if total > 0.0 { acc / total } else { own };
        }
    }
    out
}

/// The whole transform: accumulate the pairs, then smooth with a locally
/// estimated kernel.
///
/// Returns `[grid (nx*ny), slope_min, slope_max, intercept_min, intercept_max,
/// pairs_used]` — the same layout `hough_accumulate` produces, so the caller
/// slices it the same way whichever of the two it calls.
#[wasm_bindgen]
pub fn hough_transform(
    mass: &[f64],
    defect: &[f64],
    intensity: &[f64],
    nx: usize,
    ny: usize,
    slope_min: f64,
    slope_max: f64,
    intercept_min: f64,
    intercept_max: f64,
    neighbours: usize,
    bandwidth: f64,
) -> Vec<f64> {
    let accumulated = hough_accumulate(
        mass,
        defect,
        intensity,
        nx,
        ny,
        slope_min,
        slope_max,
        intercept_min,
        intercept_max,
    );
    let cells = nx * ny;
    if accumulated.len() < cells || cells == 0 {
        return accumulated;
    }
    let smoothed = hough_smooth(&accumulated, nx, ny, neighbours, bandwidth);
    if smoothed.len() != cells {
        return accumulated;
    }
    let mut out = smoothed;
    out.extend_from_slice(&accumulated[cells..]);
    out
}

/// The peak list a Hough accumulator needs: masses, their Kendrick defects, and
/// their intensities, sorted by rising mass and stripped of anything unusable.
///
/// Exposed as its own step because it is a DECISION, not a detail: the caller
/// must be able to say how many peaks it fed in, because "there is no surface"
/// and "the peaks were all rejected" are different failures.
#[wasm_bindgen]
pub fn hough_prepare(core: &[f64], keep: usize) -> Vec<f64> {
    let n = core.len() / 2;
    if n == 0 {
        return Vec::new();
    }
    let mut rows: Vec<(f64, f64, f64)> = Vec::with_capacity(n);
    for i in 0..n {
        let mass = core[i];
        let intensity = core[n + i];
        if !mass.is_finite() || mass <= 0.0 || !intensity.is_finite() {
            continue;
        }
        rows.push((mass, mass - mass.round(), intensity));
    }
    rows.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));

    let limit = if keep == 0 { rows.len() } else { keep.min(rows.len()) };
    rows.truncate(limit);

    let mut out = Vec::with_capacity(rows.len() * 3 + 1);
    for (mass, _, _) in rows.iter() {
        out.push(*mass);
    }
    for (_, defect, _) in rows.iter() {
        out.push(*defect);
    }
    for (_, _, intensity) in rows.iter() {
        out.push(*intensity);
    }
    out.push(rows.len() as f64);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `n` points on an exact line of given slope and intercept in (mass,
    /// defect), which is what an Hough peak should look like.
    fn line(n: usize, slope: f64, intercept: f64) -> (Vec<f64>, Vec<f64>, Vec<f64>) {
        let mut mass = Vec::new();
        let mut defect = Vec::new();
        let mut intensity = Vec::new();
        for i in 0..n {
            let m = 100.0 + i as f64;
            mass.push(m);
            defect.push(slope * m + intercept);
            intensity.push(1000.0 + i as f64);
        }
        (mass, defect, intensity)
    }

    /// The peak cell of the grid, read back the way the caller will.
    fn peak_cell(
        out: &[f64],
        nx: usize,
        ny: usize,
        slope: f64,
        intercept: f64,
    ) -> (usize, usize, f64) {
        let slope_min = out[nx * ny];
        let slope_max = out[nx * ny + 1];
        let intercept_min = out[nx * ny + 2];
        let intercept_max = out[nx * ny + 3];
        let ix = (((slope - slope_min) / (slope_max - slope_min) * (nx - 1) as f64)
            .round()
            .clamp(0.0, (nx - 1) as f64)) as usize;
        let iy = (((intercept - intercept_min) / (intercept_max - intercept_min) * (ny - 1) as f64)
            .round()
            .clamp(0.0, (ny - 1) as f64)) as usize;
        (ix, iy, out[iy * nx + ix])
    }

    // ---- hough_prepare ----

    #[test]
    fn prepare_splits_a_canonical_xy_core_into_three_planes() {
        // [m0..m2, y0..y2], the layout a 2D Wave carries.
        let core = vec![10.0, 20.0, 30.0, 1.0, 2.0, 3.0];
        let out = hough_prepare(&core, 0);
        assert_eq!(out.len(), 3 * 3 + 1);
        assert_eq!(&out[0..3], &[10.0, 20.0, 30.0]);
        assert_eq!(&out[3..6], &[10.0 - 10.0, 20.0 - 20.0, 30.0 - 30.0]);
        assert_eq!(&out[6..9], &[1.0, 2.0, 3.0]);
        assert_eq!(out[9], 3.0);
    }

    #[test]
    fn prepare_sorts_by_mass_and_keeps_the_most_intense_when_asked() {
        //descending mass on purpose: the kernel must sort, not trust the caller
        let core = vec![30.0, 10.0, 20.0, 5.0, 900.0, 7.0];
        let out = hough_prepare(&core, 2);
        let count = out[out.len() - 1] as usize;
        assert_eq!(count, 2);
        assert_eq!(&out[0..2], &[10.0, 20.0], "the two most intense, sorted by mass");
        assert_eq!(&out[4..6], &[900.0, 7.0]);
    }

    #[test]
    fn prepare_drops_what_a_slope_cannot_be_computed_from() {
        //mass 0 cannot give a Kendrick defect worth anything, and a non-finite
        //intensity cannot be a vote weight. The third point is FINE and must
        //survive: rejecting it would turn "one bad point" into "no surface".
        let core = vec![0.0, 10.0, 20.0, f64::NAN, 5.0, 7.0];
        let out = hough_prepare(&core, 0);
        let count = out[out.len() - 1] as usize;
        assert_eq!(count, 2, "masses 10 and 20 both survive");
        assert_eq!(&out[0..2], &[10.0, 20.0]);
        assert_eq!(&out[4..6], &[5.0, 7.0], "intensities travel with their mass");
    }

    #[test]
    fn prepare_refuses_an_empty_core() {
        assert!(hough_prepare(&[], 0).is_empty());
    }

    // ---- hough_accumulate ----

    #[test]
    fn a_line_of_peaks_peaks_in_the_cell_of_that_line() {
        let (mass, defect, intensity) = line(24, 0.7, -30.0);
        let out = hough_accumulate(&mass, &defect, &intensity, 64, 48, -1.0, 1.0, -60.0, 60.0);
        assert_eq!(out.len(), 64 * 48 + 5);
        let (ix, iy, value) = peak_cell(&out, 64, 48, 0.7, -30.0);
        assert!(
            value > 0.0,
            "the cell holding the line must hold its votes: got {value} at ({ix},{iy})"
        );
        assert_eq!(out[64 * 48 + 4], (24 * 23 / 2) as f64, "every pair votes");
    }

    #[test]
    fn two_lines_of_different_slope_peak_in_two_different_cells() {
        let (m1, d1, i1) = line(20, 0.5, -10.0);
        let (m2, d2, i2) = line(20, -0.8, 25.0);
        let mut mass = m1;
        mass.extend(m2);
        let mut defect = d1;
        defect.extend(d2);
        let mut intensity = i1;
        intensity.extend(i2);
        let out = hough_accumulate(&mass, &defect, &intensity, 96, 72, -1.0, 1.0, -60.0, 60.0);
        let (_, _, first) = peak_cell(&out, 96, 72, 0.5, -10.0);
        let (_, _, second) = peak_cell(&out, 96, 72, -0.8, 25.0);
        assert!(first > 0.0, "the first line must be visible");
        assert!(second > 0.0, "the second line must be visible");
    }

    #[test]
    fn a_vote_is_spread_over_its_neighbours_and_conserves_its_weight() {
        //One pair, mass gap big enough that slope lands mid-grid on purpose:
        //a single bin would put the whole weight in one cell, and the sum over
        //the four neighbours would still be the weight — that conservation is
        //what "spread, not drop" means.
        let mass = vec![100.0, 110.0];
        let defect = vec![0.0, 0.5];
        let intensity = vec![3.0, 4.0];
        let out = hough_accumulate(&mass, &defect, &intensity, 8, 8, -1.0, 1.0, -10.0, 10.0);
        let cells = 64;
        let total: f64 = out[..cells].iter().sum();
        assert!(
            (total - 7.0).abs() < 1e-9,
            "one pair of weight 3+4 must conserve 7, got {total}"
        );
        let occupied = out[..cells].iter().filter(|v| **v > 0.0).count();
        assert!(
            occupied > 1,
            "the vote must be spread over several cells, not dropped in one: {occupied}"
        );
    }

    #[test]
    fn heavier_pairs_cast_heavier_votes() {
        let mass = vec![100.0, 110.0];
        let defect = vec![0.0, 0.5];
        let weak = hough_accumulate(&mass, &defect, &[1.0, 1.0], 8, 8, -1.0, 1.0, -10.0, 10.0);
        let heavy = hough_accumulate(&mass, &defect, &[50.0, 50.0], 8, 8, -1.0, 1.0, -10.0, 10.0);
        let weak_total: f64 = weak[..64].iter().sum();
        let heavy_total: f64 = heavy[..64].iter().sum();
        assert!(
            heavy_total > weak_total,
            "the cumulated intensity of the two points is the vote weight: {heavy_total} vs {weak_total}"
        );
    }

    #[test]
    fn the_grid_travels_with_its_domain() {
        let (mass, defect, intensity) = line(10, 0.1, 1.0);
        let out = hough_accumulate(&mass, &defect, &intensity, 16, 16, -0.5, 0.5, -2.0, 2.0);
        let cells = 256;
        assert_eq!(&out[cells..cells + 4], &[-0.5, 0.5, -2.0, 2.0]);
    }

    #[test]
    fn accumulate_refuses_rather_than_divide_by_zero() {
        let (mass, defect, intensity) = line(6, 0.1, 1.0);
        //a collapsed domain
        assert!(hough_accumulate(&mass, &defect, &intensity, 8, 8, 1.0, 1.0, -1.0, 1.0).is_empty());
        assert!(hough_accumulate(&mass, &defect, &intensity, 8, 8, -1.0, 1.0, 1.0, 1.0).is_empty());
        //a grid too small to hold a cell
        assert!(hough_accumulate(&mass, &defect, &intensity, 1, 8, -1.0, 1.0, -1.0, 1.0).is_empty());
        //mismatched planes
        assert!(hough_accumulate(&mass, &defect[0..3], &intensity, 8, 8, -1.0, 1.0, -1.0, 1.0).is_empty());
        //too few peaks for a single pair
        assert!(hough_accumulate(&mass[0..1], &defect[0..1], &intensity[0..1], 8, 8, -1.0, 1.0, -1.0, 1.0).is_empty());
    }

    #[test]
    fn a_pair_outside_the_domain_is_dropped_not_wrapped() {
        //slope 5 sits outside [-1,1]; a wrapping index would paint it on the
        //far side of the grid and invent a peak that does not exist
        let mass = vec![100.0, 110.0];
        let defect = vec![0.0, 50.0];
        let intensity = vec![1.0, 1.0];
        let out = hough_accumulate(&mass, &defect, &intensity, 16, 16, -1.0, 1.0, -10.0, 10.0);
        assert_eq!(out[256 + 4], 0.0, "no pair fell inside the domain");
        assert!(out[..256].iter().all(|v| *v == 0.0), "and nothing was written");
    }

    // ---- hough_smooth ----

    #[test]
    fn smoothing_keeps_a_single_sharp_peak_where_it_was() {
        let (nx, ny) = (32, 32);
        let mut grid = vec![0.0; nx * ny];
        grid[16 * nx + 16] = 10.0;
        let out = hough_smooth(&grid, nx, ny, 8, 3.0);
        assert_eq!(out.len(), nx * ny);
        let peak = out.iter().cloned().fold(0.0f64, f64::max);
        assert!(peak > 0.0, "the peak must survive: an emptied grid loses the structure");
        let (ix, iy) = out
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.partial_cmp(b.1).unwrap())
            .map(|(i, _)| (i % nx, i / nx))
            .unwrap();
        assert_eq!((ix, iy), (16, 16), "and it must not have moved");
    }

    #[test]
    fn smoothing_never_produces_a_value_where_there_was_none() {
        let (nx, ny) = (24, 24);
        let mut grid = vec![0.0; nx * ny];
        grid[12 * nx + 5] = 3.0;
        grid[12 * nx + 6] = 4.0;
        let out = hough_smooth(&grid, nx, ny, 6, 2.5);
        for (i, v) in out.iter().enumerate() {
            if grid[i] == 0.0 && *v != 0.0 {
                //a kernel spread may legitimately light a neighbour cell, but
                //only INSIDE the reach: nothing may appear across the grid
                let (ix, iy) = (i % nx, i / nx);
                let d = ((ix as f64 - 5.0).powi(2) + (iy as f64 - 12.0).powi(2)).sqrt();
                assert!(d <= 9.0 * 2.5, "value at ({ix},{iy}) is {d} away, beyond the reach");
            }
        }
    }

    #[test]
    fn smoothing_refuses_rather_than_loop_forever() {
        let grid = vec![1.0; 16];
        assert!(hough_smooth(&grid, 4, 4, 8, 0.0).is_empty(), "a zero bandwidth");
        assert!(hough_smooth(&grid, 4, 4, 8, f64::NAN).is_empty(), "a NaN bandwidth");
        assert!(hough_smooth(&grid, 1, 4, 8, 1.0).is_empty(), "a grid one cell wide");
        assert!(hough_smooth(&[], 4, 4, 8, 1.0).is_empty(), "no grid at all");
    }

    #[test]
    fn smoothing_an_empty_grid_is_a_no_op() {
        let grid = vec![0.0; 64];
        let out = hough_smooth(&grid, 8, 8, 8, 2.0);
        assert_eq!(out, grid);
    }

    // ---- hough_transform ----

    #[test]
    fn the_transform_carries_its_domain_and_its_pair_count() {
        let (mass, defect, intensity) = line(20, 0.6, -12.0);
        let out = hough_transform(
            &mass, &defect, &intensity, 48, 40, -1.0, 1.0, -60.0, 60.0, 8, 3.0,
        );
        let cells = 48 * 40;
        assert_eq!(out.len(), cells + 5);
        assert_eq!(&out[cells..cells + 4], &[-1.0, 1.0, -60.0, 60.0]);
        assert_eq!(out[cells + 4], 190.0, "20 peaks give 190 pairs");
        let (_, _, value) = peak_cell(&out, 48, 40, 0.6, -12.0);
        assert!(value > 0.0, "the relation must still be visible after smoothing");
    }

    #[test]
    fn the_transform_survives_an_accumulation_that_found_nothing() {
        //every pair outside the domain: accumulate returns a zeroed grid, and the
        //smooth pass must hand it back rather than an empty slice
        let (mass, defect, intensity) = line(8, 5.0, 0.0);
        let out = hough_transform(
            &mass, &defect, &intensity, 16, 16, -1.0, 1.0, -10.0, 10.0, 8, 2.0,
        );
        assert_eq!(out.len(), 16 * 16 + 5);
        assert_eq!(out[16 * 16 + 4], 0.0);
    }

    #[test]
    fn the_transform_is_the_accumulation_when_the_smoothing_is_impossible() {
        let (mass, defect, intensity) = line(10, 0.2, -3.0);
        let mut bad = hough_transform(
            &mass, &defect, &intensity, 24, 24, -1.0, 1.0, -20.0, 20.0, 8, 3.0,
        );
        //a grid whose cells are all equal: nothing to borrow a shape from, and
        //the caller still gets a full-length array rather than a short one
        bad.truncate(24 * 24 + 5);
        assert_eq!(bad.len(), 24 * 24 + 5);
    }
}