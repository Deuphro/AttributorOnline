use wasm_bindgen::prelude::*;
use thermorawfile::{RawFile, Peak, ScanIndexEntry, Profile, ProfileChunk, Calibration};
use web_sys::console;
use std::collections::HashSet;

/// Simple centroiding: find local maxima in profile data
fn centroid_profile(profile: &Profile, calib: &Calibration) -> Vec<Peak> {
    let mut peaks = Vec::new();
    
    for chunk in &profile.chunks {
        let first_bin = chunk.first_bin as usize;
        let signal = &chunk.signal;
        let signal_len = signal.len();
        
        for (i, &intensity) in signal.iter().enumerate() {
            if intensity <= 0.0 {
                continue;
            }
            let bin = first_bin + i;
            
            // Simple local maximum detection
            let is_max = if i == 0 {
                // First point in chunk
                if signal_len > 1 {
                    intensity > signal[1]
                } else {
                    false
                }
            } else if i == signal_len - 1 {
                // Last point in chunk
                intensity > signal[i - 1]
            } else {
                // Middle point
                intensity > signal[i - 1] && intensity > signal[i + 1]
            };
            
            if is_max {
                let freq = profile.first_value + bin as f64 * profile.step;
                let mz = calib.mz(freq);
                if mz.is_finite() && mz > 0.0 {
                    peaks.push(Peak { mz, intensity });
                }
            }
        }
    }
    
    peaks
}

#[derive(Debug)]
struct ParseOptions {
    data_type: String,      // "centroid", "profile", "auto"
    first_scan: u32,
    last_scan: u32,         // 0 = all
    ms_level_filter: u8,    // 0 = all
    rt_min: f64,
    rt_max: f64,
    metadata_only: bool,
}

fn parse_options(options: &JsValue) -> ParseOptions {
    let mut opts = ParseOptions {
        data_type: "auto".to_string(),
        first_scan: 1,
        last_scan: 0,
        ms_level_filter: 0,
        rt_min: 0.0,
        rt_max: 0.0,
        metadata_only: false,
    };
    
    if options.is_undefined() || options.is_null() {
        return opts;
    }
    
    let obj = js_sys::Object::from(options.clone());
    
    if let Some(dt) = js_sys::Reflect::get(&obj, &"dataType".into()).ok().and_then(|v| v.as_string()) {
        opts.data_type = dt;
    }
    if let Some(fs) = js_sys::Reflect::get(&obj, &"firstScan".into()).ok().and_then(|v| v.as_f64()) {
        opts.first_scan = fs.max(1.0) as u32;
    }
    if let Some(ls) = js_sys::Reflect::get(&obj, &"lastScan".into()).ok().and_then(|v| v.as_f64()) {
        opts.last_scan = ls.max(0.0) as u32;
    }
    if let Some(ml) = js_sys::Reflect::get(&obj, &"msLevelFilter".into()).ok().and_then(|v| v.as_f64()) {
        opts.ms_level_filter = ml.max(0.0) as u8;
    }
    if let Some(rt) = js_sys::Reflect::get(&obj, &"rtMin".into()).ok().and_then(|v| v.as_f64()) {
        opts.rt_min = rt;
    }
    if let Some(rt) = js_sys::Reflect::get(&obj, &"rtMax".into()).ok().and_then(|v| v.as_f64()) {
        opts.rt_max = rt;
    }
    if let Some(mo) = js_sys::Reflect::get(&obj, &"metadataOnly".into()).ok().and_then(|v| v.as_bool()) {
        opts.metadata_only = mo;
    }
    
    opts
}

/// Parse a Thermo .raw file and return centroid peaks for each scan.
/// Returns flat arrays for easy WASM/JS interop.
#[wasm_bindgen]
pub fn parse_thermo_raw(data: &[u8], options: JsValue) -> Result<JsValue, JsValue> {
    let opts = parse_options(&options);
    
    console::log_1(&format!("Parse options: {:?}", opts).into());
    
    let bytes = data.to_vec();
    
    console::log_1(&format!("Raw file size: {} bytes", bytes.len()).into());
    
    let raw_file = RawFile::from_bytes(bytes)
        .map_err(|e| {
            console::log_1(&format!("Parse error: {}", e).into());
            JsValue::from_str(&format!("Failed to parse raw file: {}", e))
        })?;

    console::log_1(&format!("File version: {}, first_scan: {}, last_scan: {}", 
        raw_file.version, raw_file.first_scan, raw_file.last_scan).into());

    // Verify checksum
    if !raw_file.checksum_valid() {
        console::log_1(&"Checksum validation failed".into());
        return Err(JsValue::from_str("Checksum validation failed"));
    }

    let scan_count = raw_file.scan_count();
    let file_version = raw_file.version;
    let file_first_scan = raw_file.first_scan;
    let file_last_scan = raw_file.last_scan;
    
    console::log_1(&format!("Scan count: {}, first_scan: {}", scan_count, file_first_scan).into());

    // Determine scan range
    let start_scan = opts.first_scan.max(file_first_scan).min(file_last_scan);
    let end_scan = if opts.last_scan > 0 {
        opts.last_scan.min(file_last_scan)
    } else {
        file_last_scan
    };
    
    if start_scan > end_scan {
        console::log_1(&"Invalid scan range".into());
        return Err(JsValue::from_str("Invalid scan range"));
    }
    
    let scan_indices = (start_scan..=end_scan).collect::<Vec<u32>>();
    
    console::log_1(&format!("Processing scans {} to {} ({} scans)", start_scan, end_scan, scan_indices.len()).into());

    // If metadata only, return scan info without processing peaks
    if opts.metadata_only {
        let mut ms_levels = std::collections::HashSet::new();
        let mut centroid_count = 0;
        let mut profile_count = 0;
        let mut rt_min = f64::INFINITY;
        let mut rt_max = f64::NEG_INFINITY;
        
        for &scan_number in &scan_indices {
            let scan_idx = (scan_number - file_first_scan) as usize;
            let scan_event = raw_file.scan_event(scan_number);
            let ms_level = scan_event.map(|se| se.ms_order).unwrap_or(1);
            ms_levels.insert(ms_level);
            
            let scan_index_entry: &ScanIndexEntry = &raw_file.index[scan_idx];
            let rt = scan_index_entry.time;
            rt_min = rt_min.min(rt);
            rt_max = rt_max.max(rt);
            
            // Check if scan has centroid peaks
            let centroid_peaks = raw_file.centroid_peaks(scan_number);
            if !centroid_peaks.is_empty() {
                centroid_count += 1;
            } else if raw_file.profile(scan_number).is_some() {
                profile_count += 1;
            }
        }
        
        let mut ms_levels_vec: Vec<u8> = ms_levels.into_iter().collect();
        ms_levels_vec.sort();
        
        let result = js_sys::Object::new();
        js_sys::Reflect::set(&result, &"scanCount".into(), &(scan_indices.len() as f64).into()).unwrap();
        js_sys::Reflect::set(&result, &"firstScan".into(), &(start_scan as f64).into()).unwrap();
        js_sys::Reflect::set(&result, &"lastScan".into(), &(end_scan as f64).into()).unwrap();
        js_sys::Reflect::set(&result, &"rtMin".into(), &(if rt_min.is_finite() { rt_min } else { 0.0 }).into()).unwrap();
        js_sys::Reflect::set(&result, &"rtMax".into(), &(if rt_max.is_finite() { rt_max } else { 0.0 }).into()).unwrap();
        js_sys::Reflect::set(&result, &"msLevelsPresent".into(), &js_sys::Uint32Array::from(ms_levels_vec.iter().map(|&v| v as u32).collect::<Vec<u32>>().as_slice()).into()).unwrap();
        js_sys::Reflect::set(&result, &"centroidScanCount".into(), &(centroid_count as f64).into()).unwrap();
        js_sys::Reflect::set(&result, &"profileScanCount".into(), &(profile_count as f64).into()).unwrap();
        
        let wrapper = js_sys::Object::new();
        js_sys::Reflect::set(&wrapper, &"scanMetadata".into(), &result).unwrap();
        
        return Ok(wrapper.into());
    }

    // Collect all data in flat arrays
    let mut all_mz = Vec::new();
    let mut all_intensity = Vec::new();
    let mut scan_numbers = Vec::new();
    let mut rts = Vec::new();
    let mut ms_levels = Vec::new();
    let mut scan_peak_counts = Vec::new();

    for &scan_number in &scan_indices {
        let scan_idx = (scan_number - file_first_scan) as usize;

        // Get scan event info for metadata (MS level)
        let scan_event = raw_file.scan_event(scan_number);
        let ms_level = scan_event.map(|se| se.ms_order).unwrap_or(1);

        // Get retention time from scan index
        let scan_index_entry: &ScanIndexEntry = &raw_file.index[scan_idx];
        let rt = scan_index_entry.time;

        // Filter by MS level
        if opts.ms_level_filter > 0 && ms_level != opts.ms_level_filter {
            scan_peak_counts.push(0);
            continue;
        }

        // Filter by RT
        if (opts.rt_min > 0.0 && rt < opts.rt_min) || (opts.rt_max > 0.0 && rt > opts.rt_max) {
            scan_peak_counts.push(0);
            continue;
        }

        // Try centroid peaks first (unless profile only)
        let mut peaks: Vec<Peak> = if opts.data_type != "profile" {
            raw_file.centroid_peaks(scan_number)
        } else {
            Vec::new()
        };

        console::log_1(&format!("Scan {}: {} centroid peaks, rt={}, ms_level={}", 
            scan_number, peaks.len(), rt, ms_level).into());

        // If no centroid peaks and not centroid-only, try profile data
        if peaks.is_empty() && opts.data_type != "centroid" {
            console::log_1(&format!("Scan {}: trying profile data...", scan_number).into());
            if let Some(profile) = raw_file.profile(scan_number) {
                console::log_1(&format!("Scan {}: profile found, nbins={}, chunks={}", 
                    scan_number, profile.nbins, profile.chunks.len()).into());
                // Get calibration from scan event
                if let Some(event_offset) = raw_file.scan_event_byte_offset(scan_number) {
                    if let Some(calib) = raw_file.calibration_at_event(event_offset) {
                        console::log_1(&format!("Scan {}: calibration found", scan_number).into());
                        peaks = centroid_profile(&profile, &calib);
                        console::log_1(&format!("Scan {}: centroided {} peaks from profile", 
                            scan_number, peaks.len()).into());
                    } else {
                        console::log_1(&format!("Scan {}: no calibration at event offset {}", scan_number, event_offset).into());
                    }
                } else {
                    console::log_1(&format!("Scan {}: no scan event offset", scan_number).into());
                }
            } else {
                console::log_1(&format!("Scan {}: no profile data", scan_number).into());
            }
        }

        let peak_count = peaks.len();
        scan_peak_counts.push(peak_count as u32);
        
        for p in peaks {
            all_mz.push(p.mz);
            all_intensity.push(p.intensity as f64);
            scan_numbers.push(scan_number);
            rts.push(rt);
            ms_levels.push(ms_level as f64);
        }
    }

    // Return as a JS object with flat arrays
    let result = js_sys::Object::new();
    js_sys::Reflect::set(&result, &"mz".into(), &js_sys::Float64Array::from(all_mz.as_slice()).into()).unwrap();
    js_sys::Reflect::set(&result, &"intensity".into(), &js_sys::Float64Array::from(all_intensity.as_slice()).into()).unwrap();
    js_sys::Reflect::set(&result, &"scanNumbers".into(), &js_sys::Uint32Array::from(scan_numbers.as_slice()).into()).unwrap();
    js_sys::Reflect::set(&result, &"rts".into(), &js_sys::Float64Array::from(rts.as_slice()).into()).unwrap();
    js_sys::Reflect::set(&result, &"msLevels".into(), &js_sys::Float64Array::from(ms_levels.as_slice()).into()).unwrap();
    js_sys::Reflect::set(&result, &"scanPeakCounts".into(), &js_sys::Uint32Array::from(scan_peak_counts.as_slice()).into()).unwrap();
    js_sys::Reflect::set(&result, &"fileVersion".into(), &(file_version as f64).into()).unwrap();
    js_sys::Reflect::set(&result, &"scanCount".into(), &(scan_indices.len() as f64).into()).unwrap();

    Ok(result.into())
}