//! Rich-text documents: Markdown with a small front matter, typeset by turning it into LaTeX.

use pulldown_cmark::{Alignment, Event, HeadingLevel, Options, Parser, Tag, TagEnd};

pub fn is_document(path: &str) -> bool {
    path.to_ascii_lowercase().ends_with(".md")
}

#[derive(Debug, Clone, PartialEq)]
pub struct Settings {
    pub title: String,
    pub author: String,
    pub date: String,
    pub font: String,
    pub font_size: u32,
    pub spacing: String,
    pub margins: String,
    pub paper: String,
    pub numbered: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            title: String::new(),
            author: String::new(),
            date: String::new(),
            font: "serif".into(),
            font_size: 12,
            spacing: "1.15".into(),
            margins: "2.5cm".into(),
            paper: "a4".into(),
            numbered: false,
        }
    }
}

/// Splits `---` front matter (simple `key: value` lines) from the body.
pub fn split_front_matter(src: &str) -> (Settings, &str) {
    let mut s = Settings::default();
    let src = src.strip_prefix('\u{feff}').unwrap_or(src);
    let Some(rest) = src
        .strip_prefix("---\n")
        .or_else(|| src.strip_prefix("---\r\n"))
    else {
        return (s, src);
    };
    let mut offset = src.len() - rest.len();
    for line in rest.split_inclusive('\n') {
        offset += line.len();
        let line = line.trim_end();
        if line == "---" {
            return (s, &src[offset..]);
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let value = unquote(value.trim()).to_string();
        match key.trim() {
            "title" => s.title = value,
            "author" => s.author = value,
            "date" => s.date = value,
            "font" => s.font = value,
            "fontSize" => s.font_size = value.parse().unwrap_or(s.font_size),
            "spacing" => s.spacing = value,
            "margins" => s.margins = value,
            "paper" => s.paper = value,
            "numbered" => s.numbered = value == "true",
            _ => {}
        }
    }
    (Settings::default(), src)
}

fn unquote(v: &str) -> &str {
    v.strip_prefix('"')
        .and_then(|v| v.strip_suffix('"'))
        .unwrap_or(v)
}

/// `image_exists` tells whether a project-relative image path can be included.
pub fn to_latex(src: &str, image_exists: &dyn Fn(&str) -> bool) -> String {
    let (s, body) = split_front_matter(src);
    let size = match s.font_size {
        n @ (10 | 11 | 12) => n,
        n if n < 10 => 10,
        _ => 12,
    };
    let paper = match s.paper.as_str() {
        "letter" => "letterpaper",
        "a5" => "a5paper",
        _ => "a4paper",
    };
    let margins = if valid_length(&s.margins) {
        s.margins.as_str()
    } else {
        "2.5cm"
    };
    let spacing = s
        .spacing
        .parse::<f32>()
        .ok()
        .filter(|v| (0.5..=4.0).contains(v))
        .unwrap_or(1.15);
    let mut out = format!(
        r"\documentclass[{size}pt,{paper}]{{article}}
\usepackage{{iftex}}
\ifPDFTeX
  \usepackage[T1]{{fontenc}}
  \usepackage[utf8]{{inputenc}}
  \usepackage{{lmodern}}
\else
  \usepackage{{fontspec}}
\fi
\usepackage{{amssymb}}
\usepackage[margin={margins}]{{geometry}}
\usepackage{{setspace}}
\usepackage{{parskip}}
\usepackage{{graphicx}}
\usepackage{{array}}
\usepackage{{longtable}}
\usepackage[normalem]{{ulem}}
\usepackage{{xcolor}}
\usepackage[hidelinks]{{hyperref}}
\graphicspath{{{{./}}{{../../}}}}
\setstretch{{{spacing}}}
\makeatletter
\def\maxwidth{{\ifdim\Gin@nat@width>\linewidth\linewidth\else\Gin@nat@width\fi}}
\makeatother
\setlength{{\LTpre}}{{0.5em}}
\setlength{{\LTpost}}{{0.5em}}
"
    );
    if s.font == "sans" {
        out.push_str("\\renewcommand{\\familydefault}{\\sfdefault}\n");
    }
    if !s.numbered {
        out.push_str("\\setcounter{secnumdepth}{0}\n");
    }
    let has_title = !s.title.trim().is_empty();
    if has_title {
        let date = match s.date.trim() {
            "today" => "\\today".to_string(),
            d => escape(d),
        };
        out.push_str(&format!(
            "\\title{{{}}}\n\\author{{{}}}\n\\date{{{date}}}\n",
            escape(&s.title),
            escape(&s.author)
        ));
    }
    out.push_str("\n\\begin{document}\n");
    if has_title {
        out.push_str("\\maketitle\n");
    }
    out.push('\n');
    out.push_str(&body_to_latex(body, image_exists));
    out.push_str("\n\\end{document}\n");
    out
}

fn valid_length(v: &str) -> bool {
    let num = v.trim_end_matches(|c: char| c.is_ascii_alphabetic());
    let unit = &v[num.len()..];
    !num.is_empty() && num.parse::<f32>().is_ok() && matches!(unit, "cm" | "mm" | "in" | "pt")
}

struct Table {
    cell: usize,
    head: bool,
}

pub fn body_to_latex(md: &str, image_exists: &dyn Fn(&str) -> bool) -> String {
    let opts = Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS;
    // Output goes to a stack of buffers so images can capture their alt text.
    let mut bufs = vec![String::new()];
    let mut lists: Vec<bool> = Vec::new();
    let mut pending_item = false;
    let mut table: Option<Table> = None;
    let mut in_code = false;
    // Inline HTML tags still open: (tag name, whether it opened a LaTeX group).
    let mut open: Vec<(&str, bool)> = Vec::new();
    let mut images: Vec<String> = Vec::new();

    macro_rules! w {
        ($($arg:tt)*) => { bufs.last_mut().unwrap().push_str(&format!($($arg)*)) };
    }

    for event in Parser::new_ext(md, opts) {
        // Loose list items open a paragraph before the task marker.
        if pending_item && !matches!(event, Event::Start(Tag::Paragraph)) {
            pending_item = false;
            match event {
                Event::TaskListMarker(done) => {
                    w!(
                        "\\item[{}] ",
                        if done { "$\\boxtimes$" } else { "$\\square$" }
                    );
                    continue;
                }
                _ => w!("\\item "),
            }
        }
        match event {
            Event::Start(tag) => match tag {
                Tag::Paragraph => {}
                Tag::Heading { level, .. } => w!(
                    "\\{}{{",
                    match level {
                        HeadingLevel::H1 => "section",
                        HeadingLevel::H2 => "subsection",
                        HeadingLevel::H3 => "subsubsection",
                        HeadingLevel::H4 => "paragraph",
                        _ => "subparagraph",
                    }
                ),
                Tag::BlockQuote(_) => w!("\\begin{{quote}}\n"),
                Tag::CodeBlock(_) => {
                    in_code = true;
                    w!("\\begin{{verbatim}}\n");
                }
                Tag::List(start) => {
                    lists.push(start.is_some());
                    match start {
                        Some(n) => {
                            w!("\\begin{{enumerate}}\n");
                            if n != 1 && lists.len() <= 4 {
                                w!(
                                    "\\setcounter{{enum{}}}{{{}}}\n",
                                    ["i", "ii", "iii", "iv"][lists.len() - 1],
                                    n.saturating_sub(1)
                                );
                            }
                        }
                        None => w!("\\begin{{itemize}}\n"),
                    }
                }
                Tag::Item => pending_item = true,
                Tag::Table(align) => {
                    let n = align.len().max(1);
                    let width = format!(
                        "\\dimexpr(\\linewidth-{}\\tabcolsep-{}\\arrayrulewidth)/{n}\\relax",
                        2 * n,
                        n + 1
                    );
                    let cols: String = align
                        .iter()
                        .map(|a| {
                            let ragged = match a {
                                Alignment::Center => "\\centering",
                                Alignment::Right => "\\raggedleft",
                                _ => "\\raggedright",
                            };
                            format!(">{{{ragged}\\arraybackslash}}p{{{width}}}|")
                        })
                        .collect();
                    w!("\\begin{{longtable}}{{|{cols}}}\n\\hline\n");
                    table = Some(Table {
                        cell: 0,
                        head: false,
                    });
                }
                Tag::TableHead => {
                    if let Some(t) = table.as_mut() {
                        t.head = true;
                        t.cell = 0;
                    }
                }
                Tag::TableRow => {
                    if let Some(t) = table.as_mut() {
                        t.cell = 0;
                    }
                }
                Tag::TableCell => {
                    if let Some(t) = table.as_mut() {
                        if t.cell > 0 {
                            w!(" & ");
                        }
                        t.cell += 1;
                        if t.head {
                            w!("\\textbf{{");
                        }
                    }
                }
                Tag::Emphasis => w!("\\emph{{"),
                Tag::Strong => w!("\\textbf{{"),
                Tag::Strikethrough => w!("\\sout{{"),
                Tag::Link { dest_url, .. } => w!("\\href{{{}}}{{", escape_url(&dest_url)),
                Tag::Image { dest_url, .. } => {
                    images.push(dest_url.to_string());
                    bufs.push(String::new());
                }
                _ => {}
            },
            Event::End(tag) => {
                if matches!(
                    tag,
                    TagEnd::Paragraph | TagEnd::Heading(_) | TagEnd::TableCell
                ) {
                    // Like the browser in the preview, inline tags never outlive their block.
                    for (_, group) in open.drain(..).rev() {
                        if group {
                            w!("}}");
                        }
                    }
                }
                match tag {
                    TagEnd::Paragraph => w!("\n\n"),
                    TagEnd::Heading(_) => w!("}}\n\n"),
                    TagEnd::BlockQuote(_) => w!("\\end{{quote}}\n\n"),
                    TagEnd::CodeBlock => {
                        in_code = false;
                        let buf = bufs.last_mut().unwrap();
                        if !buf.ends_with('\n') {
                            buf.push('\n');
                        }
                        w!("\\end{{verbatim}}\n\n");
                    }
                    TagEnd::List(ordered) => {
                        lists.pop();
                        w!(
                            "\\end{{{}}}\n\n",
                            if ordered { "enumerate" } else { "itemize" }
                        );
                    }
                    TagEnd::Item => w!("\n"),
                    TagEnd::Table => {
                        w!("\\end{{longtable}}\n\n");
                        table = None;
                    }
                    TagEnd::TableHead => {
                        if let Some(t) = table.as_mut() {
                            t.head = false;
                        }
                        w!(" \\\\\n\\hline\n\\endhead\n");
                    }
                    TagEnd::TableRow => w!(" \\\\\n\\hline\n"),
                    TagEnd::TableCell => {
                        if table.as_ref().is_some_and(|t| t.head) {
                            w!("}}");
                        }
                    }
                    TagEnd::Emphasis | TagEnd::Strong | TagEnd::Strikethrough | TagEnd::Link => {
                        w!("}}")
                    }
                    TagEnd::Image => {
                        let alt = bufs.pop().unwrap_or_default();
                        let url = images.pop().unwrap_or_default();
                        let path = percent_decode(&url);
                        if url.contains("://") {
                            w!(
                                "\\href{{{}}}{{{}}}",
                                escape_url(&url),
                                if alt.is_empty() { escape(&url) } else { alt }
                            );
                        } else if path.contains(['{', '}', '%', '#', '\\']) || !image_exists(&path)
                        {
                            w!("\\fbox{{{}}}", escape(&format!("[image: {path}]")));
                        } else {
                            w!("\\begin{{center}}\\includegraphics[width=\\maxwidth]{{{path}}}");
                            if !alt.trim().is_empty() {
                                w!("\\\\[0.3em]{{\\small {alt}}}");
                            }
                            w!("\\end{{center}}\n");
                        }
                    }
                    _ => {}
                }
            }
            Event::Text(text) => {
                if in_code {
                    w!("{}", text.replace("\\end{verbatim}", "\\end {verbatim}"));
                } else {
                    w!("{}", escape(&text));
                }
            }
            Event::Code(code) => w!("\\texttt{{{}}}", escape(&code)),
            Event::SoftBreak => w!("\n"),
            Event::HardBreak => w!("\\newline\n"),
            Event::Rule => w!("\\noindent\\rule{{\\linewidth}}{{0.4pt}}\n\n"),
            Event::InlineHtml(html) | Event::Html(html) => {
                let tag = html.trim().to_ascii_lowercase();
                if let Some(name) = tag.strip_prefix("</").and_then(|t| t.strip_suffix('>')) {
                    if let Some(i) = open.iter().rposition(|(n, _)| *n == name.trim()) {
                        for (_, group) in open.drain(i..).rev() {
                            if group {
                                w!("}}");
                            }
                        }
                    }
                    continue;
                }
                match tag.as_str() {
                    "<u>" => {
                        open.push(("u", true));
                        w!("\\uline{{");
                    }
                    "<br>" | "<br/>" | "<br />" => w!("\\newline\n"),
                    t if t.starts_with("<span") || t.starts_with("<font") => {
                        let name = if t.starts_with("<span") {
                            "span"
                        } else {
                            "font"
                        };
                        match tag_color(t).and_then(|c| color_hex(&c)) {
                            Some(hex) => {
                                open.push((name, true));
                                w!("\\textcolor[HTML]{{{hex}}}{{");
                            }
                            None => open.push((name, false)),
                        }
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }
    let mut out = bufs.swap_remove(0);
    out.push_str(&"}".repeat(open.iter().filter(|(_, group)| *group).count()));
    out
}

/// The color of `<span style="color: …">` or `<font color="…">`.
fn tag_color(tag: &str) -> Option<String> {
    use std::sync::OnceLock;
    static RE: OnceLock<[regex::Regex; 2]> = OnceLock::new();
    let [span, font] = RE.get_or_init(|| {
        [
            regex::Regex::new(
                r#"^<span\s+style\s*=\s*["']\s*(?:[^"']*;\s*)?color\s*:\s*([^;"']+)"#,
            )
            .unwrap(),
            regex::Regex::new(r#"^<font\s+color\s*=\s*["']?([#\w]+)"#).unwrap(),
        ]
    });
    let c = span.captures(tag).or_else(|| font.captures(tag))?;
    Some(c[1].trim().to_string())
}

/// Hex digits for a CSS color: `#rgb`, `#rrggbb` or one of the common names
/// (the preview in src/components/DocPreview.tsx accepts the same set).
pub fn color_hex(c: &str) -> Option<String> {
    let c = c.trim().to_ascii_lowercase();
    if let Some(h) = c.strip_prefix('#') {
        if !h.chars().all(|x| x.is_ascii_hexdigit()) {
            return None;
        }
        return match h.len() {
            3 => Some(
                h.chars()
                    .flat_map(|x| [x, x])
                    .collect::<String>()
                    .to_uppercase(),
            ),
            6 => Some(h.to_uppercase()),
            _ => None,
        };
    }
    let hex = match c.as_str() {
        "black" => "000000",
        "white" => "FFFFFF",
        "gray" | "grey" => "808080",
        "silver" => "C0C0C0",
        "red" => "FF0000",
        "darkred" => "8B0000",
        "maroon" => "800000",
        "crimson" => "DC143C",
        "orange" => "FFA500",
        "darkorange" => "FF8C00",
        "gold" => "FFD700",
        "yellow" => "FFFF00",
        "olive" => "808000",
        "lime" => "00FF00",
        "green" => "008000",
        "darkgreen" => "006400",
        "teal" => "008080",
        "cyan" | "aqua" => "00FFFF",
        "blue" => "0000FF",
        "darkblue" => "00008B",
        "navy" => "000080",
        "indigo" => "4B0082",
        "purple" => "800080",
        "violet" => "EE82EE",
        "magenta" | "fuchsia" => "FF00FF",
        "pink" => "FFC0CB",
        "brown" => "A52A2A",
        _ => return None,
    };
    Some(hex.into())
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Some(b) = s
                .get(i + 1..i + 3)
                .and_then(|h| u8::from_str_radix(h, 16).ok())
            {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\textbackslash{}"),
            '{' | '}' | '$' | '&' | '#' | '_' | '%' => {
                out.push('\\');
                out.push(c);
            }
            '~' => out.push_str("\\textasciitilde{}"),
            '^' => out.push_str("\\textasciicircum{}"),
            '<' => out.push_str("\\textless{}"),
            '>' => out.push_str("\\textgreater{}"),
            '|' => out.push_str("\\textbar{}"),
            _ => out.push(c),
        }
    }
    out
}

fn escape_url(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '\\' | '#' | '%' | '{' | '}' => {
                out.push('\\');
                out.push(c);
            }
            _ => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_front_matter() {
        let (s, body) =
            split_front_matter("---\ntitle: \"A: B\"\nfontSize: 11\nfont: sans\n---\n# Hi\n");
        assert_eq!(s.title, "A: B");
        assert_eq!(s.font_size, 11);
        assert_eq!(s.font, "sans");
        assert_eq!(body, "# Hi\n");
        let (s, body) = split_front_matter("# No front matter\n");
        assert_eq!(s, Settings::default());
        assert_eq!(body, "# No front matter\n");
    }

    #[test]
    fn converts_blocks_and_inlines() {
        let none = |_: &str| false;
        let tex = body_to_latex(
            "# Title\n\nSome **bold** and *it* with $5 & 10%_x.\n",
            &none,
        );
        assert!(tex.contains("\\section{Title}"));
        assert!(tex.contains("\\textbf{bold}"));
        assert!(tex.contains("\\emph{it}"));
        assert!(tex.contains("\\$5 \\& 10\\%\\_x."));

        let tex = body_to_latex("- [x] a\n- [ ] b\n\n1. one\n", &none);
        assert!(tex.contains("\\item[$\\boxtimes$] a"));
        assert!(tex.contains("\\item[$\\square$] b"));
        assert!(tex.contains("\\begin{enumerate}\n\\item one"));
        let loose = body_to_latex("- [x] a\n\n- [ ] b\n", &none);
        assert!(loose.contains("\\item[$\\boxtimes$] a"));
        assert!(loose.contains("\\item[$\\square$] b"));

        let tex = body_to_latex("| A | B |\n|---|--:|\n| 1 | 2 |\n", &none);
        assert!(tex.contains("\\begin{longtable}"));
        assert!(tex.contains("\\textbf{A} & \\textbf{B}"));
        assert!(tex.contains("1 & 2 \\\\"));

        let tex = body_to_latex("x <u>under</u> y\n", &none);
        assert!(tex.contains("\\uline{under}"));

        let tex = body_to_latex(
            "<span style=\"color: green\">[novo]</span> a <font color=\"#c00\">b</font> <span style='font-weight: bold; color:#1565c0'>c</span> <span>d</span> <span style=\"color: nope\">e</span>\n",
            &none,
        );
        assert!(tex.contains("\\textcolor[HTML]{008000}{[novo]}"), "{tex}");
        assert!(tex.contains("\\textcolor[HTML]{CC0000}{b}"));
        assert!(tex.contains("\\textcolor[HTML]{1565C0}{c}"));
        assert!(tex.contains(" d e"));
        assert_eq!(tex.matches('{').count(), tex.matches('}').count());
        let tex = body_to_latex("<span style=\"color: red\">open\n\nnext\n", &none);
        assert!(tex.contains("{open}\n\nnext"), "{tex}");
    }

    #[test]
    fn images_need_an_existing_file() {
        let tex = body_to_latex("![Chart](images/my%20chart.png)\n", &|p| {
            p == "images/my chart.png"
        });
        assert!(tex.contains("\\includegraphics[width=\\maxwidth]{images/my chart.png}"));
        assert!(tex.contains("\\small Chart"));
        let tex = body_to_latex("![x](missing.png)\n", &|_| false);
        assert!(!tex.contains("includegraphics"));
    }

    #[test]
    fn full_document_has_title_and_settings() {
        let tex = to_latex(
            "---\ntitle: Report\ndate: today\nmargins: 3cm\nnumbered: true\n---\nText\n",
            &|_| false,
        );
        assert!(tex.contains("\\title{Report}"));
        assert!(tex.contains("\\date{\\today}"));
        assert!(tex.contains("margin=3cm"));
        assert!(tex.contains("\\maketitle"));
        assert!(!tex.contains("secnumdepth"));
        let tex = to_latex("Text\n", &|_| false);
        assert!(!tex.contains("\\maketitle"));
        assert!(tex.contains("margin=2.5cm"));
    }
}
