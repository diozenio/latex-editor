//! Minimal SyncTeX reader: enough for editor ↔ PDF jumps.

use std::collections::HashMap;
use std::io::Read;
use std::path::Path;

use serde::Serialize;

use crate::{Error, Result};

#[derive(Debug, Clone)]
struct Record {
    tag: u32,
    line: u32,
    page: u32,
    /// PDF points, origin at the top-left of the page.
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    d: f64,
    is_box: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct PdfSpot {
    pub page: u32,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct SourceSpot {
    pub file: String,
    pub line: u32,
}

pub struct SyncTex {
    /// tag → path relative to the project
    inputs: HashMap<u32, String>,
    records: Vec<Record>,
}

impl SyncTex {
    pub fn load(synctex_gz: &Path, project_dir: &Path) -> Result<Self> {
        let raw = std::fs::read(synctex_gz)?;
        let mut text = String::new();
        flate2::read::GzDecoder::new(&raw[..])
            .read_to_string(&mut text)
            .map_err(|e| Error::Other(format!("synctex: {e}")))?;
        Ok(Self::parse(&text, project_dir))
    }

    fn parse(text: &str, project_dir: &Path) -> Self {
        let mut inputs = HashMap::new();
        let mut records = Vec::new();
        let mut unit = 1.0f64;
        let mut mag = 1000.0f64;
        let (mut xoff, mut yoff) = (0.0f64, 0.0f64);
        let mut page = 0u32;
        let mut in_content = false;
        let canon_dir = project_dir.canonicalize().unwrap_or_else(|_| project_dir.to_path_buf());

        for line in text.lines() {
            if !in_content {
                if let Some(rest) = line.strip_prefix("Input:") {
                    if let Some((tag, path)) = rest.split_once(':') {
                        if let Ok(tag) = tag.parse() {
                            inputs.insert(tag, normalize(path, &canon_dir));
                        }
                    }
                } else if let Some(v) = line.strip_prefix("Unit:") {
                    unit = v.parse().unwrap_or(1.0);
                } else if let Some(v) = line.strip_prefix("Magnification:") {
                    mag = v.parse().unwrap_or(1000.0);
                } else if let Some(v) = line.strip_prefix("X Offset:") {
                    xoff = v.parse().unwrap_or(0.0);
                } else if let Some(v) = line.strip_prefix("Y Offset:") {
                    yoff = v.parse().unwrap_or(0.0);
                } else if line.starts_with("Content:") {
                    in_content = true;
                }
                continue;
            }
            // Inputs can also appear inside content.
            if let Some(rest) = line.strip_prefix("Input:") {
                if let Some((tag, path)) = rest.split_once(':') {
                    if let Ok(tag) = tag.parse() {
                        inputs.insert(tag, normalize(path, &canon_dir));
                    }
                }
                continue;
            }
            let mut chars = line.chars();
            let Some(kind) = chars.next() else { continue };
            let rest = chars.as_str();
            match kind {
                '{' => page = rest.parse().unwrap_or(page + 1),
                '[' | '(' | 'h' | 'v' | 'x' | 'k' | 'g' | '$' => {
                    let to_pt = |v: f64| v * unit * (mag / 1000.0) / 65536.0 * (72.0 / 72.27);
                    let mut parts = rest.split(':');
                    let (Some(tl), Some(xy)) = (parts.next(), parts.next()) else { continue };
                    let mut tl = tl.split(',');
                    let (Some(Ok(tag)), Some(Ok(ln))) = (tl.next().map(str::parse), tl.next().map(str::parse)) else { continue };
                    let mut xy = xy.split(',');
                    let (Some(Ok(x)), Some(Ok(y))) = (xy.next().map(str::parse::<f64>), xy.next().map(str::parse::<f64>)) else { continue };
                    let (mut w, mut h, mut d) = (0.0, 0.0, 0.0);
                    if let Some(whd) = parts.next() {
                        let v: Vec<f64> = whd.split(',').filter_map(|s| s.parse().ok()).collect();
                        w = v.first().copied().unwrap_or(0.0);
                        h = v.get(1).copied().unwrap_or(0.0);
                        d = v.get(2).copied().unwrap_or(0.0);
                    }
                    records.push(Record {
                        tag,
                        line: ln,
                        page,
                        x: to_pt(x + xoff),
                        y: to_pt(y + yoff),
                        w: to_pt(w),
                        h: to_pt(h),
                        d: to_pt(d),
                        is_box: matches!(kind, '[' | '(' | 'h'),
                    });
                }
                _ => {}
            }
        }
        Self { inputs, records }
    }

    /// Source line → places in the PDF (all on the first matching page).
    pub fn forward(&self, file: &str, line: u32) -> Vec<PdfSpot> {
        let tags: Vec<u32> = self.inputs.iter().filter(|(_, p)| p.as_str() == file).map(|(t, _)| *t).collect();
        let candidates: Vec<&Record> = self.records.iter().filter(|r| tags.contains(&r.tag) && r.line > 0).collect();
        if candidates.is_empty() {
            return vec![];
        }
        // Exact line, else the closest line after, else the closest before.
        let best_line = candidates
            .iter()
            .map(|r| r.line)
            .min_by_key(|l| if *l >= line { (0, l - line) } else { (1, line - l) })
            .unwrap();
        let hits: Vec<&&Record> = candidates.iter().filter(|r| r.line == best_line).collect();
        let page = hits[0].page;
        let mut spots: Vec<PdfSpot> = hits
            .iter()
            .filter(|r| r.page == page && r.is_box && r.w > 0.0)
            .map(|r| PdfSpot { page, x: r.x, y: r.y - r.h, w: r.w, h: r.h + r.d })
            .collect();
        if spots.is_empty() {
            let r = hits[0];
            spots.push(PdfSpot { page, x: r.x, y: r.y - 10.0, w: 40.0, h: 12.0 });
        }
        spots
    }

    /// Click in the PDF (points, top-left origin) → source line.
    pub fn inverse(&self, page: u32, x: f64, y: f64) -> Option<SourceSpot> {
        let on_page = self.records.iter().filter(|r| r.page == page && r.line > 0);
        let containing = on_page
            .clone()
            .filter(|r| r.is_box && x >= r.x && x <= r.x + r.w && y >= r.y - r.h && y <= r.y + r.d)
            .min_by(|a, b| (a.w * (a.h + a.d)).total_cmp(&(b.w * (b.h + b.d))));
        let r = containing.or_else(|| {
            on_page.min_by(|a, b| {
                let da = (a.x - x).powi(2) + (a.y - y).powi(2);
                let db = (b.x - x).powi(2) + (b.y - y).powi(2);
                da.total_cmp(&db)
            })
        })?;
        Some(SourceSpot { file: self.inputs.get(&r.tag)?.clone(), line: r.line })
    }
}

fn normalize(path: &str, project_dir: &Path) -> String {
    let p = Path::new(path);
    let rel = if p.is_absolute() {
        let canon = p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
        canon.strip_prefix(project_dir).map(|r| r.to_path_buf()).unwrap_or(canon)
    } else {
        p.to_path_buf()
    };
    let s = rel.to_string_lossy().replace('\\', "/");
    let s = s.trim_start_matches("./").replace("/./", "/");
    if Path::new(&s).extension().is_none() { format!("{s}.tex") } else { s }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let text = "SyncTeX Version:1\nInput:1:./main.tex\nInput:2:chapters/intro.tex\nOutput:pdf\nMagnification:1000\nUnit:1\nX Offset:0\nY Offset:0\nContent:\n{1\n[1,5:4736286,6553600:30000000,40000000,0\n(1,5:4736286,9000000:20000000,655360,0\nh2,3:4736286,20000000:20000000,655360,0\n]\n}1\nPostamble:\n";
        let s = SyncTex::parse(text, Path::new("/nonexistent"));
        let f = s.forward("main.tex", 5);
        assert_eq!(f[0].page, 1);
        let src = s.inverse(1, 100.0, 300.0 * 72.0 / 72.27 * 0.0 + 20000000.0 / 65536.0 * 72.0 / 72.27 - 2.0).unwrap();
        assert_eq!(src.file, "chapters/intro.tex");
        assert_eq!(src.line, 3);
    }
}
