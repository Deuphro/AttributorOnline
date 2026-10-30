// Bruker BAF reader.
//
// This is a Rust port of the BAF part of RTMS (https://github.com/MPL-Damping/rtms),
// GPL-3.0-or-later. The layout knowledge (index blocks, calibration block,
// header rows, metadata tables, spectrum block) comes from
// resources/rtms/R/rtmsBrukerBAFReader.R. The port reads from in-memory byte
// slices instead of an open file, because the browser hands us the three files
// (.baf, .baf_idx, .baf_xtr) as ArrayBuffers.
//
// Nothing here is chemistry-aware: the output is a flat m/z + intensity pair,
// exactly like the Thermo reader in thermo.rs.

use wasm_bindgen::prelude::*;

const A0: [u8; 4] = [0x01, 0x30, 0xa0, 0xbf];
const A1: [u8; 4] = [0x02, 0x20, 0xa0, 0xbf];
const A2: [u8; 4] = [0x01, 0x10, 0xa0, 0xbf];
const A3: [u8; 4] = [0x02, 0x10, 0xa0, 0xbf];
const A4: [u8; 4] = [0x04, 0x40, 0xa0, 0xbf];

#[derive(Debug, Clone, Copy, Default)]
pub struct BafCalibration {
    pub alpha: f64,
    pub beta: f64,
    pub frequency_high: f64,
    pub frequency_low: f64,
    pub frequency_width: f64,
    pub size: i32,
    pub calib_mode: i32,
}

impl BafCalibration {
    /// indexToMass from rtmsBrukerBAFReader.R
    pub fn index_to_mass(&self, i: f64) -> f64 {
        let fhigh = self.frequency_high;
        let fwidth = self.frequency_width;
        let fsize = self.size as f64;
        let alpha = self.alpha;
        let beta = self.beta;
        fhigh / ((fwidth * (fsize - i) / fsize) - beta) + alpha / fhigh
    }
}

#[derive(Debug, Clone, Default)]
pub struct BafHeaderRow {
    pub row_index: u16,
    pub row_type: i32,
    pub parameter_name: String,
    pub parameter_group: String,
    pub display_name: String,
    pub values: String,
    pub format: String,
    pub unit: String,
}

#[derive(Debug, Clone, Default)]
pub struct BafMetadataEntry {
    pub row_index: u16,
    pub parameter_name: String,
    pub parameter_group: String,
    pub display_name: String,
    pub string_value: String,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct BafOffsets {
    pub header: u64,
    pub metadata: u64,
    pub spectrum: u64,
    pub maxima: Option<u64>,
}

#[derive(Debug, Clone, Default)]
pub struct BafSpectrum {
    pub mz: Vec<f64>,
    pub intensity: Vec<f32>,
    pub point_count: usize,
    pub mz_min: f64,
    pub mz_max: f64,
    pub max_intensity: f32,
}

#[derive(Debug, Clone, Default)]
pub struct BafMaxima {
    pub mz: Vec<f64>,
    pub intensity: Vec<f64>,
    pub point_count: usize,
    pub mz_min: f64,
    pub mz_max: f64,
    pub max_intensity: f64,
}

struct Cursor<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Cursor<'a> {
    fn new(data: &'a [u8], pos: usize) -> Self {
        Self { data, pos }
    }

    fn need(&self, n: usize) -> Result<(), String> {
        if self.pos.checked_add(n).map_or(true, |end| end > self.data.len()) {
            Err(format!(
                "BAF: truncated read at {} ({} bytes needed, file has {})",
                self.pos,
                n,
                self.data.len()
            ))
        } else {
            Ok(())
        }
    }

    fn u8(&mut self) -> Result<u8, String> {
        self.need(1)?;
        let v = self.data[self.pos];
        self.pos += 1;
        Ok(v)
    }

    fn u16_le(&mut self) -> Result<u16, String> {
        self.need(2)?;
        let v = u16::from_le_bytes([self.data[self.pos], self.data[self.pos + 1]]);
        self.pos += 2;
        Ok(v)
    }

    fn i16_le(&mut self) -> Result<i16, String> {
        Ok(self.u16_le()? as i16)
    }

    fn i32_le(&mut self) -> Result<i32, String> {
        self.need(4)?;
        let v = i32::from_le_bytes([
            self.data[self.pos],
            self.data[self.pos + 1],
            self.data[self.pos + 2],
            self.data[self.pos + 3],
        ]);
        self.pos += 4;
        Ok(v)
    }

    fn f32_le(&mut self) -> Result<f32, String> {
        self.need(4)?;
        let v = f32::from_le_bytes([
            self.data[self.pos],
            self.data[self.pos + 1],
            self.data[self.pos + 2],
            self.data[self.pos + 3],
        ]);
        self.pos += 4;
        Ok(v)
    }

    fn f64_le(&mut self) -> Result<f64, String> {
        self.need(8)?;
        let mut b = [0u8; 8];
        b.copy_from_slice(&self.data[self.pos..self.pos + 8]);
        self.pos += 8;
        Ok(f64::from_le_bytes(b))
    }

    fn skip(&mut self, n: usize) -> Result<(), String> {
        self.need(n)?;
        self.pos += n;
        Ok(())
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8], String> {
        self.need(n)?;
        let s = &self.data[self.pos..self.pos + n];
        self.pos += n;
        Ok(s)
    }
}

fn i32_at(data: &[u8], pos: usize) -> Result<i32, String> {
    if pos.checked_add(4).map_or(true, |e| e > data.len()) {
        return Err(format!("BAF: i32 read out of bounds at {}", pos));
    }
    Ok(i32::from_le_bytes([
        data[pos],
        data[pos + 1],
        data[pos + 2],
        data[pos + 3],
    ]))
}

fn u16_at(data: &[u8], pos: usize) -> Result<u16, String> {
    if pos.checked_add(2).map_or(true, |e| e > data.len()) {
        return Err(format!("BAF: u16 read out of bounds at {}", pos));
    }
    Ok(u16::from_le_bytes([data[pos], data[pos + 1]]))
}

fn f64_at(data: &[u8], pos: usize) -> Result<f64, String> {
    if pos.checked_add(8).map_or(true, |e| e > data.len()) {
        return Err(format!("BAF: f64 read out of bounds at {}", pos));
    }
    let mut b = [0u8; 8];
    b.copy_from_slice(&data[pos..pos + 8]);
    Ok(f64::from_le_bytes(b))
}

fn bytes_to_string(bytes: &[u8]) -> String {
    let end = bytes.iter().position(|&b| b == 0).unwrap_or(bytes.len());
    String::from_utf8_lossy(&bytes[..end]).trim().to_string()
}

/// bafidx_getRawVectors: walk the 24-byte framed records of a .baf_idx /
/// .baf_xtr file and yield the payload of each record.
fn bafidx_get_raw_vectors(data: &[u8]) -> Result<Vec<&[u8]>, String> {
    let mut out = Vec::new();
    let mut pos = 0usize;
    while pos + 12 <= data.len() {
        // The first i32 is a record id that RTMS reads and ignores.
        let block_size = i32_at(data, pos + 8)?;
        if block_size == 0 {
            break;
        }
        if block_size < 24 {
            return Err(format!(
                "BAF: invalid index block size {} at {}",
                block_size, pos
            ));
        }
        let payload_len = block_size as usize - 24;
        let payload_start = pos + 12;
        let payload_end = payload_start
            .checked_add(payload_len)
            .ok_or_else(|| "BAF: index block overflow".to_string())?;
        if payload_end > data.len() {
            return Err(format!(
                "BAF: index block at {} claims {} bytes, file is {}",
                pos, block_size, data.len()
            ));
        }
        out.push(&data[payload_start..payload_end]);
        pos += block_size as usize;
    }
    Ok(out)
}

fn reshift_offset(offset: i32, offset_page: i32) -> u64 {
    let mut page = (offset_page as i64) * 2;
    let mut off = offset as i64;
    if off < 0 {
        page += 1;
        off += 1i64 << 31;
    }
    (off + page * (1i64 << 31)).max(0) as u64
}

/// readBafIndexFile
pub fn read_baf_index(data: &[u8]) -> Result<BafOffsets, String> {
    let mut offsets = BafOffsets::default();
    let mut seen_header = false;
    let mut seen_metadata = false;
    let mut seen_spectrum = false;
    let mut seen_maxima = false;

    for rv in bafidx_get_raw_vectors(data)? {
        if rv.len() < 2 || rv[1] == 0 {
            continue;
        }
        if rv.len() < 24 {
            continue;
        }
        let id_a = rv[0];
        let id_b = rv[1];
        let offset = i32_at(rv, 16)?;
        let offset_page = i32_at(rv, 20)?;
        let value = reshift_offset(offset, offset_page);
        match (id_a, id_b) {
            (1, 48) => {
                offsets.header = value;
                seen_header = true;
            }
            (2, 32) => {
                offsets.metadata = value;
                seen_metadata = true;
            }
            (1, 16) => {
                offsets.spectrum = value;
                seen_spectrum = true;
            }
            (2, 16) => {
                offsets.maxima = Some(value);
                seen_maxima = true;
            }
            _ => {}
        }
    }

    if !(seen_header && seen_metadata && seen_spectrum) {
        return Err(format!(
            "BAF: index incomplete (header={}, metadata={}, spectrum={}, maxima={})",
            seen_header, seen_metadata, seen_spectrum, seen_maxima
        ));
    }
    Ok(offsets)
}

/// readBafExtraFile
pub fn read_baf_calibration(data: &[u8]) -> Result<BafCalibration, String> {
    for rv in bafidx_get_raw_vectors(data)? {
        if rv.len() < 2 || rv[0] != 4 || rv[1] != 1 {
            continue;
        }
        let mut cur = Cursor::new(rv, 4);
        let header_size = cur.i32_le()?;
        let mut offset = 4 + header_size.max(0) as usize;
        if offset + 4 > rv.len() {
            return Err("BAF: calibration header out of bounds".to_string());
        }
        let block_size = i32_at(rv, offset)?;
        offset = (offset as i64 + block_size as i64 - header_size as i64).max(0) as usize;

        let calib_mode = i32_at(rv, offset + 8)?;
        let alpha = if calib_mode == 5 {
            f64_at(rv, offset + 12)?
        } else {
            0.0
        };
        let mut beta = f64_at(rv, offset + 20)?;
        let frequency_high = f64_at(rv, offset + 28)?;
        if calib_mode == 4 {
            beta = -beta;
        }
        let size = i32_at(rv, offset + 40)?;
        let frequency_low = f64_at(rv, offset + 48)?;
        let frequency_width = f64_at(rv, offset + 56)?;

        return Ok(BafCalibration {
            alpha,
            beta,
            frequency_high,
            frequency_low,
            frequency_width,
            size,
            calib_mode,
        });
    }
    Err("BAF: calibration record (4,1) not found in .baf_xtr".to_string())
}

fn read_header_row<'a>(cur: &mut Cursor<'a>) -> Result<BafHeaderRow, String> {
    let row_start = cur.pos;
    let row_size = cur.u16_le()? as usize;
    if row_size < 20 {
        return Err(format!("BAF: header row too short ({})", row_size));
    }
    cur.pos = row_start;
    let row = cur.take(row_size)?;

    let row_index = u16_at(row, 2)?;
    let row_type = i32_at(row, 4)?;
    let mut field_offsets = [0u16; 6];
    for i in 0..6 {
        field_offsets[i] = u16_at(row, 8 + i * 2)?;
    }

    let mut field_lengths = [0u16; 7];
    field_lengths[..6].copy_from_slice(&field_offsets);
    field_lengths[6] = row_size as u16;
    for i in (0..6).rev() {
        if field_lengths[i] == 0 {
            field_lengths[i] = field_lengths[i + 1];
        }
    }
    let mut lengths = [0u16; 6];
    for i in 0..6 {
        lengths[i] = field_lengths[i + 1].saturating_sub(field_lengths[i]);
    }

    let mut fields: [String; 6] = Default::default();
    for i in 0..6 {
        let off = field_offsets[i] as usize;
        let len = lengths[i] as usize;
        if off == 0 || len == 0 {
            continue;
        }
        if off + len > row.len() {
            continue;
        }
        fields[i] = bytes_to_string(&row[off..off + len]);
    }

    Ok(BafHeaderRow {
        row_index,
        row_type,
        parameter_name: fields[0].clone(),
        parameter_group: fields[1].clone(),
        display_name: fields[2].clone(),
        values: fields[3].clone(),
        format: fields[4].clone(),
        unit: fields[5].clone(),
    })
}

/// baf_readFileHeader
pub fn read_baf_header(data: &[u8], offset: u64) -> Result<Vec<BafHeaderRow>, String> {
    let mut cur = Cursor::new(data, offset as usize);
    let _block_size = cur.i32_le()?;
    cur.skip(4)?; // delimiter
    cur.skip(4)?; // sub-delimiter
    let _header_size = cur.i32_le()?;
    let next_offset = cur.i32_le()?;
    // seek(nextOffset - 20, current) after having consumed 20 bytes
    let mblock_pos = (offset as i64 + next_offset as i64).max(0) as usize;
    cur.pos = mblock_pos;
    let mblock_size = cur.i32_le()?;
    // seek(mblockSize - 4, current)
    cur.pos = (mblock_pos as i64 + mblock_size as i64).max(0) as usize;
    let _hblock_size = cur.i32_le()?;
    cur.skip(4)?; // hdelim
    let _hheader_size = cur.u16_le()?;
    let num_rows = cur.u16_le()?;

    let mut rows = Vec::with_capacity(num_rows as usize);
    for _ in 0..num_rows {
        rows.push(read_header_row(&mut cur)?);
    }
    Ok(rows)
}

fn format_number(value: f64, format: &str) -> String {
    if format.contains('d') {
        return (value.round() as i64).to_string();
    }
    if let Some(pct) = format.find('%') {
        let rest = &format[pct + 1..];
        let dot = rest.find('.');
        if let Some(dot_pos) = dot {
            let after = &rest[dot_pos + 1..];
            let digits: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
            if !digits.is_empty() {
                let precision: usize = digits.parse().unwrap_or(0);
                if rest[dot_pos + 1..].contains('f') {
                    return format!("{:.*}", precision, value);
                }
            }
        }
        if rest.contains('f') {
            return format!("{:.6}", value);
        }
    }
    value.to_string()
}

fn recode(value: f64, value_list: &str) -> String {
    let code = (value.round() as i64).to_string();
    for pair in value_list.split(';') {
        if let Some(colon) = pair.find(':') {
            if pair[..colon].trim() == code {
                return pair[colon + 1..].to_string();
            }
        }
    }
    String::new()
}

/// getBrukerBAFAllMetadata
pub fn read_baf_metadata(
    data: &[u8],
    offset: u64,
    parameters: &[BafHeaderRow],
) -> Result<Vec<BafMetadataEntry>, String> {
    let mut cur = Cursor::new(data, offset as usize);
    let _mblock_size = cur.i32_le()?;
    cur.skip(4)?;
    let mheader_size = cur.i32_le()?;
    cur.pos = offset as usize + mheader_size.max(0) as usize;

    let nv_pos = cur.pos;
    let nvblock_size = cur.i32_le()?;
    cur.skip(4)?;
    let _nvheader_size = cur.i32_le()?;
    let nnum_values = cur.i32_le()?;

    if nnum_values < 0 {
        return Err("BAF: negative numeric metadata count".to_string());
    }
    let mut numeric: Vec<(u16, f64)> = Vec::with_capacity(nnum_values as usize);
    for _ in 0..nnum_values {
        let row_index = cur.u16_le()?;
        let value = cur.f64_le()?;
        numeric.push((row_index, value));
    }
    // The next block starts at the end of this one; R reads it straight after
    // the entries because the block has no padding in practice.
    cur.pos = (nv_pos as i64 + nvblock_size as i64).max(0) as usize;

    let _svblock_size = cur.i32_le()?;
    cur.skip(4)?;
    let _svheader_size = cur.i32_le()?;
    let snum_values = cur.i32_le()?;
    if snum_values < 0 {
        return Err("BAF: negative string metadata count".to_string());
    }
    let mut strings: Vec<(u16, String)> = Vec::with_capacity(snum_values as usize);
    for _ in 0..snum_values {
        let row_start = cur.pos;
        let row_size = cur.u16_le()? as usize;
        if row_size < 9 {
            return Err(format!("BAF: string metadata row too short ({})", row_size));
        }
        cur.pos = row_start;
        let row = cur.take(row_size)?;
        let row_index = u16_at(row, 2)?;
        let raw_len = i32_at(row, 4)? - 1;
        if raw_len < 0 {
            strings.push((row_index, String::new()));
            continue;
        }
        let end = 8usize.saturating_add(raw_len as usize);
        let end = end.min(row.len());
        strings.push((row_index, bytes_to_string(&row[8..end])));
    }

    let mut out = Vec::with_capacity(numeric.len() + strings.len());
    for (row_index, value) in numeric {
        if let Some(p) = parameters.iter().find(|p| p.row_index == row_index) {
            let mut s = if p.values.is_empty() {
                format_number(value, &p.format)
            } else {
                recode(value, &p.values)
            };
            if !p.unit.is_empty() {
                s.push(' ');
                s.push_str(&p.unit);
            }
            out.push(BafMetadataEntry {
                row_index,
                parameter_name: p.parameter_name.clone(),
                parameter_group: p.parameter_group.clone(),
                display_name: p.display_name.clone(),
                string_value: s,
            });
        }
    }
    for (row_index, value) in strings {
        if let Some(p) = parameters.iter().find(|p| p.row_index == row_index) {
            let mut s = value;
            if !p.unit.is_empty() {
                s.push(' ');
                s.push_str(&p.unit);
            }
            out.push(BafMetadataEntry {
                row_index,
                parameter_name: p.parameter_name.clone(),
                parameter_group: p.parameter_group.clone(),
                display_name: p.display_name.clone(),
                string_value: s,
            });
        }
    }
    out.sort_by_key(|e| e.row_index);
    Ok(out)
}

fn spectrum_layout(data: &[u8], offset: u64) -> Result<(usize, usize, usize), String> {
    let mut cur = Cursor::new(data, offset as usize);
    let block_size = cur.i32_le()?;
    cur.skip(4)?;
    let header_size = cur.i32_le()?;
    if block_size < header_size || header_size < 12 {
        return Err(format!(
            "BAF: invalid spectrum block (size {}, header {})",
            block_size, header_size
        ));
    }
    let body = (block_size - header_size) as usize;
    if body % 4 != 0 {
        return Err(format!("BAF: spectrum body is not f32-aligned ({})", body));
    }
    Ok((offset as usize + header_size as usize, body / 4, header_size as usize))
}

/// getBrukerBAFSpectrum
pub fn read_baf_spectrum(
    data: &[u8],
    offset: u64,
    calib: &BafCalibration,
) -> Result<BafSpectrum, String> {
    let (start, count, _header_size) = spectrum_layout(data, offset)?;
    if start + count * 4 > data.len() {
        return Err(format!(
            "BAF: spectrum body runs past end of file ({} points from {})",
            count, start
        ));
    }

    let mut mz = Vec::with_capacity(count);
    let mut intensity = Vec::with_capacity(count);
    let mut max_intensity = f32::NEG_INFINITY;
    let mut all_finite = true;
    for i in 0..count {
        let base = start + i * 4;
        let value = f32::from_le_bytes([
            data[base],
            data[base + 1],
            data[base + 2],
            data[base + 3],
        ]);
        let mass = calib.index_to_mass(i as f64);
        if !mass.is_finite() {
            all_finite = false;
        }
        if value > max_intensity {
            max_intensity = value;
        }
        mz.push(mass);
        intensity.push(value);
    }

    // rtmsSpectrum sorts by m/z. The calibration is monotonically increasing
    // with the index, so on a healthy file this is free; only sort when the
    // check fails, to keep a well-formed 15M-point spectrum from paying for it.
    let mut sorted = all_finite;
    if sorted {
        for i in 1..mz.len() {
            if mz[i] < mz[i - 1] {
                sorted = false;
                break;
            }
        }
    }
    let mz_min;
    let mz_max;
    if sorted {
        mz_min = mz.first().copied().unwrap_or(f64::NAN);
        mz_max = mz.last().copied().unwrap_or(f64::NAN);
    } else {
        let mut pairs: Vec<(f64, f32)> = mz.into_iter().zip(intensity.into_iter()).collect();
        pairs.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
        mz = pairs.iter().map(|p| p.0).collect();
        intensity = pairs.iter().map(|p| p.1).collect();
        mz_min = mz.first().copied().unwrap_or(f64::NAN);
        mz_max = mz.last().copied().unwrap_or(f64::NAN);
    }

    Ok(BafSpectrum {
        mz,
        intensity,
        point_count: count,
        mz_min,
        mz_max,
        max_intensity,
    })
}

pub fn baf_spectrum_info(
    data: &[u8],
    offset: u64,
    calib: &BafCalibration,
) -> Result<(usize, f64, f64), String> {
    let (_start, count, _header_size) = spectrum_layout(data, offset)?;
    if count == 0 {
        return Ok((0, f64::NAN, f64::NAN));
    }
    let a = calib.index_to_mass(0.0);
    let b = calib.index_to_mass((count - 1) as f64);
    Ok((count, a.min(b), a.max(b)))
}

fn maxima_layout(data: &[u8], offset: u64) -> Result<(usize, usize), String> {
    let mut cur = Cursor::new(data, offset as usize);
    let block_size = cur.i32_le()?;
    cur.skip(4)?;
    let header_size = cur.i32_le()?;
    if header_size < 12 || block_size < header_size {
        return Err(format!(
            "BAF: invalid maxima block (size {}, header {})",
            block_size, header_size
        ));
    }
    let control = offset as usize + header_size as usize;
    let num_peaks = i32_at(data, control)?;
    let peak_offset = i32_at(data, control + 4)?;
    if num_peaks < 0 {
        return Err(format!("BAF: negative maxima count ({})", num_peaks));
    }
    let num_peaks = num_peaks as usize;
    let start = (control as i64 + 8 + peak_offset as i64 - 8).max(0) as usize;
    let end = start
        .checked_add(num_peaks * 16)
        .ok_or_else(|| "BAF: maxima block overflow".to_string())?;
    if end > data.len() {
        return Err(format!(
            "BAF: maxima block runs past end of file ({} peaks from {})",
            num_peaks, start
        ));
    }
    Ok((start, num_peaks))
}

/// getBrukerBAFSample: the `maxima` field. These are peaks the acquisition
/// software already picked and stored in the .baf, not a detection we run.
pub fn read_baf_maxima(
    data: &[u8],
    offset: u64,
    calib: &BafCalibration,
) -> Result<BafMaxima, String> {
    let (start, count) = maxima_layout(data, offset)?;
    let mut mz = Vec::with_capacity(count);
    let mut intensity = Vec::with_capacity(count);
    let mut max_intensity = f64::NEG_INFINITY;
    for i in 0..count {
        let index = f64_at(data, start + i * 8)?;
        let value = f64_at(data, start + count * 8 + i * 8)?;
        if value > max_intensity {
            max_intensity = value;
        }
        mz.push(calib.index_to_mass(index));
        intensity.push(value);
    }

    let mut sorted = true;
    for i in 1..mz.len() {
        if mz[i] < mz[i - 1] {
            sorted = false;
            break;
        }
    }
    if !sorted {
        let mut pairs: Vec<(f64, f64)> = mz.into_iter().zip(intensity.into_iter()).collect();
        pairs.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
        mz = pairs.iter().map(|p| p.0).collect();
        intensity = pairs.iter().map(|p| p.1).collect();
    }

    let mz_min = mz.first().copied().unwrap_or(f64::NAN);
    let mz_max = mz.last().copied().unwrap_or(f64::NAN);
    Ok(BafMaxima {
        mz,
        intensity,
        point_count: count,
        mz_min,
        mz_max,
        max_intensity,
    })
}

pub fn baf_maxima_info(
    data: &[u8],
    offset: u64,
    calib: &BafCalibration,
) -> Result<(usize, f64, f64), String> {
    let (start, count) = maxima_layout(data, offset)?;
    if count == 0 {
        return Ok((0, f64::NAN, f64::NAN));
    }
    let mut mz_min = f64::INFINITY;
    let mut mz_max = f64::NEG_INFINITY;
    for i in 0..count {
        let mass = calib.index_to_mass(f64_at(data, start + i * 8)?);
        if mass < mz_min {
            mz_min = mass;
        }
        if mass > mz_max {
            mz_max = mass;
        }
    }
    Ok((count, mz_min, mz_max))
}

fn set(obj: &js_sys::Object, key: &str, value: JsValue) {
    let _ = js_sys::Reflect::set(obj, &JsValue::from_str(key), &value);
}

fn calibration_to_js(calib: &BafCalibration) -> JsValue {
    let obj = js_sys::Object::new();
    set(&obj, "alpha", calib.alpha.into());
    set(&obj, "beta", calib.beta.into());
    set(&obj, "frequencyHigh", calib.frequency_high.into());
    set(&obj, "frequencyLow", calib.frequency_low.into());
    set(&obj, "frequencyWidth", calib.frequency_width.into());
    set(&obj, "size", (calib.size as f64).into());
    set(&obj, "calibMode", (calib.calib_mode as f64).into());
    obj.into()
}

fn metadata_to_js(entries: &[BafMetadataEntry]) -> JsValue {
    let arr = js_sys::Array::new();
    for e in entries {
        let obj = js_sys::Object::new();
        set(&obj, "rowIndex", (e.row_index as f64).into());
        set(&obj, "parameterName", e.parameter_name.clone().into());
        set(&obj, "parameterGroup", e.parameter_group.clone().into());
        set(&obj, "displayName", e.display_name.clone().into());
        set(&obj, "stringValue", e.string_value.clone().into());
        arr.push(&obj);
    }
    arr.into()
}

#[derive(Debug, Default)]
struct BafOptions {
    metadata_only: bool,
    peak_list: bool,
}

fn parse_options(options: &JsValue) -> BafOptions {
    let mut out = BafOptions::default();
    if options.is_undefined() || options.is_null() {
        return out;
    }
    let obj = js_sys::Object::from(options.clone());
    if let Some(v) = js_sys::Reflect::get(&obj, &"metadataOnly".into())
        .ok()
        .and_then(|v| v.as_bool())
    {
        out.metadata_only = v;
    }
    if let Some(v) = js_sys::Reflect::get(&obj, &"peakList".into())
        .ok()
        .and_then(|v| v.as_bool())
    {
        out.peak_list = v;
    }
    out
}

/// Parse a Bruker BAF acquisition from its three in-memory files.
///
/// `baf`, `idx` and `xtr` are the contents of the `.baf`, `.baf_idx` and
/// `.baf_xtr` files. Returns either
///   { spectrum: {mz, intensity}, maxima: {...}, metadata: [...], ... }
/// or, when `options.metadataOnly` is true,
///   { metadata: [...], maxima: {...}, calibration: {...}, pointCount, ... }.
/// When `options.peakList` is true the result carries `peakList` (the 2500
/// peaks stored by the acquisition software) instead of the full profile.
#[wasm_bindgen]
pub fn parse_bruker_baf(
    baf: &[u8],
    idx: &[u8],
    xtr: &[u8],
    options: JsValue,
) -> Result<JsValue, JsValue> {
    let opts = parse_options(&options);
    let fail = |e: String| JsValue::from_str(&e);

    let offsets = read_baf_index(idx).map_err(fail)?;
    let calib = read_baf_calibration(xtr).map_err(fail)?;
    let header = read_baf_header(baf, offsets.header).map_err(fail)?;
    let metadata = read_baf_metadata(baf, offsets.metadata, &header).map_err(fail)?;
    let (point_count, mz_min, mz_max) =
        baf_spectrum_info(baf, offsets.spectrum, &calib).map_err(fail)?;

    let result = js_sys::Object::new();
    set(&result, "metadata", metadata_to_js(&metadata));
    set(&result, "calibration", calibration_to_js(&calib));
    set(&result, "pointCount", (point_count as f64).into());
    set(&result, "mzMin", mz_min.into());
    set(&result, "mzMax", mz_max.into());

    if let Some(maxima_offset) = offsets.maxima {
        let (count, min, max) = baf_maxima_info(baf, maxima_offset, &calib).map_err(fail)?;
        let maxima_obj = js_sys::Object::new();
        set(&maxima_obj, "pointCount", (count as f64).into());
        set(&maxima_obj, "mzMin", min.into());
        set(&maxima_obj, "mzMax", max.into());
        set(&result, "maxima", maxima_obj.into());
    }

    if opts.metadata_only {
        set(&result, "metadataOnly", JsValue::TRUE);
        return Ok(result.into());
    }

    if opts.peak_list {
        let maxima_offset = offsets
            .maxima
            .ok_or_else(|| fail("BAF: no maxima block in index".to_string()))?;
        let maxima = read_baf_maxima(baf, maxima_offset, &calib).map_err(fail)?;
        let peak_obj = js_sys::Object::new();
        set(
            &peak_obj,
            "mz",
            js_sys::Float64Array::from(maxima.mz.as_slice()).into(),
        );
        set(
            &peak_obj,
            "intensity",
            js_sys::Float64Array::from(maxima.intensity.as_slice()).into(),
        );
        set(&peak_obj, "pointCount", (maxima.point_count as f64).into());
        set(&peak_obj, "mzMin", maxima.mz_min.into());
        set(&peak_obj, "mzMax", maxima.mz_max.into());
        set(&peak_obj, "maxIntensity", maxima.max_intensity.into());
        set(&result, "peakList", peak_obj.into());
        return Ok(result.into());
    }

    let spectrum = read_baf_spectrum(baf, offsets.spectrum, &calib).map_err(fail)?;
    let spectrum_obj = js_sys::Object::new();
    set(
        &spectrum_obj,
        "mz",
        js_sys::Float64Array::from(spectrum.mz.as_slice()).into(),
    );
    set(
        &spectrum_obj,
        "intensity",
        js_sys::Float32Array::from(spectrum.intensity.as_slice()).into(),
    );
    set(&spectrum_obj, "pointCount", (spectrum.point_count as f64).into());
    set(&spectrum_obj, "mzMin", spectrum.mz_min.into());
    set(&spectrum_obj, "mzMax", spectrum.mz_max.into());
    set(&spectrum_obj, "maxIntensity", (spectrum.max_intensity as f64).into());
    set(&result, "spectrum", spectrum_obj.into());
    Ok(result.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixture_dir() -> Option<PathBuf> {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../data/testdata/fticr")
            .join("190424_LDI_pos_8M_Tholins_exoplanet_Insoluble_0_P20_000001_AMP_001.d");
        if dir.join("analysis.baf").exists() {
            Some(dir)
        } else {
            None
        }
    }

    fn read_fixture() -> Option<(Vec<u8>, Vec<u8>, Vec<u8>)> {
        let dir = fixture_dir()?;
        Some((
            std::fs::read(dir.join("analysis.baf")).ok()?,
            std::fs::read(dir.join("analysis.baf_idx")).ok()?,
            std::fs::read(dir.join("analysis.baf_xtr")).ok()?,
        ))
    }

    #[test]
    fn reads_index_offsets() {
        let Some((_baf, idx, _xtr)) = read_fixture() else {
            return;
        };
        let offsets = read_baf_index(&idx).unwrap();
        assert_eq!(offsets.header, 191);
        assert_eq!(offsets.metadata, 37408);
        assert_eq!(offsets.spectrum, 42548);
        assert_eq!(offsets.maxima, Some(60556744));
    }

    #[test]
    fn reads_calibration() {
        let Some((_baf, _idx, xtr)) = read_fixture() else {
            return;
        };
        let calib = read_baf_calibration(&xtr).unwrap();
        assert_eq!(calib.calib_mode, 4);
        assert_eq!(calib.size, 16777216);
        assert!((calib.frequency_high - 184257440.895214).abs() < 1e-6);
        assert!((calib.beta + 3.33706201262133).abs() < 1e-12);
        assert!((calib.frequency_width - 1875000.0).abs() < 1e-9);
    }

    #[test]
    fn reads_header_and_metadata() {
        let Some((baf, _idx, _xtr)) = read_fixture() else {
            return;
        };
        let header = read_baf_header(&baf, 191).unwrap();
        assert_eq!(header.len(), 446);
        let metadata = read_baf_metadata(&baf, 37408, &header).unwrap();
        assert_eq!(metadata.len(), 348);
    }

    #[test]
    fn reads_full_spectrum() {
        let Some((baf, idx, xtr)) = read_fixture() else {
            return;
        };
        let offsets = read_baf_index(&idx).unwrap();
        let calib = read_baf_calibration(&xtr).unwrap();
        let spectrum = read_baf_spectrum(&baf, offsets.spectrum, &calib).unwrap();
        assert_eq!(spectrum.point_count, 15128538);
        assert!((spectrum.mz_min - 98.27046).abs() < 1e-3);
        assert!((spectrum.mz_max - 999.99928).abs() < 1e-3);
        assert!(spectrum.max_intensity > 3.0e8);
        assert!(spectrum.max_intensity < 3.3e8);
    }

    #[test]
    fn reads_vendor_maxima() {
        let Some((baf, idx, xtr)) = read_fixture() else {
            return;
        };
        let offsets = read_baf_index(&idx).unwrap();
        let calib = read_baf_calibration(&xtr).unwrap();
        let maxima = read_baf_maxima(&baf, offsets.maxima.unwrap(), &calib).unwrap();
        assert_eq!(maxima.point_count, 2500);
        assert!((maxima.mz_min - 119.9995).abs() < 1e-3);
        assert!((maxima.mz_max - 985.0061).abs() < 1e-3);
        assert!(maxima.max_intensity > 3.2e8);
        assert!(maxima.max_intensity < 3.3e8);
        for i in 1..maxima.mz.len() {
            assert!(maxima.mz[i] >= maxima.mz[i - 1]);
        }
    }
}
