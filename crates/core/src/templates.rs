pub const TEMPLATES: &[(&str, &str)] = &[
    ("blank", "Blank"),
    ("article", "Article"),
    ("report", "Report"),
    ("beamer", "Presentation (Beamer)"),
    ("letter", "Letter"),
    ("cv", "CV"),
];

pub fn files(template: &str, title: &str) -> Vec<(&'static str, String)> {
    let title = escape(title);
    match template {
        "article" => vec![
            ("main.tex", format!(r"\documentclass[11pt]{{article}}
\usepackage[utf8]{{inputenc}}
\usepackage[T1]{{fontenc}}
\usepackage{{amsmath, amssymb}}
\usepackage{{graphicx}}
\usepackage[margin=2.5cm]{{geometry}}
\usepackage{{hyperref}}

\title{{{title}}}
\author{{}}
\date{{\today}}

\begin{{document}}
\maketitle

\begin{{abstract}}
A short summary of the work.
\end{{abstract}}

\section{{Introduction}}
\label{{sec:intro}}
Start writing here. Cite like this~\cite{{knuth1984}}.

\section{{Method}}
\begin{{equation}}
  e^{{i\pi}} + 1 = 0
\end{{equation}}

\bibliographystyle{{plain}}
\bibliography{{refs}}
\end{{document}}
")),
            ("refs.bib", r"@book{knuth1984,
  author    = {Donald E. Knuth},
  title     = {The {\TeX}book},
  publisher = {Addison-Wesley},
  year      = {1984}
}
".to_string()),
        ],
        "report" => vec![
            ("main.tex", format!(r"\documentclass[12pt]{{report}}
\usepackage[T1]{{fontenc}}
\usepackage{{graphicx}}
\usepackage{{hyperref}}

\title{{{title}}}
\author{{}}

\begin{{document}}
\maketitle
\tableofcontents

\input{{chapters/introduction}}

\end{{document}}
")),
            ("chapters/introduction.tex", "\\chapter{Introduction}\n\nStart writing here.\n".to_string()),
        ],
        "beamer" => vec![("main.tex", format!(r"\documentclass{{beamer}}
\usetheme{{default}}
\setbeamertemplate{{navigation symbols}}{{}}

\title{{{title}}}
\author{{}}
\date{{\today}}

\begin{{document}}

\begin{{frame}}
  \titlepage
\end{{frame}}

\begin{{frame}}{{Outline}}
  \begin{{itemize}}
    \item First point
    \item Second point
  \end{{itemize}}
\end{{frame}}

\end{{document}}
"))],
        "letter" => vec![("main.tex", r"\documentclass{letter}
\signature{Your Name}
\address{Street \\ City}

\begin{document}
\begin{letter}{Recipient \\ Address}
\opening{Dear Sir or Madam,}

Body of the letter.

\closing{Yours faithfully,}
\end{letter}
\end{document}
".to_string())],
        "cv" => vec![("main.tex", r"\documentclass[11pt]{article}
\usepackage[margin=2cm]{geometry}
\usepackage{enumitem}
\usepackage{hyperref}
\pagestyle{empty}
\setlength{\parindent}{0pt}

\newcommand{\entry}[3]{\textbf{#1} \hfill #2 \\ #3 \medskip}

\begin{document}
{\LARGE\bfseries Your Name} \\[2pt]
you@example.com \quad \href{https://github.com/you}{github.com/you}

\section*{Experience}
\entry{Role, Company}{2024 -- now}{What you did and the impact it had.}

\section*{Education}
\entry{Degree, University}{2020 -- 2024}{}

\end{document}
".to_string())],
        _ => vec![("main.tex", format!(r"\documentclass{{article}}

\title{{{title}}}
\author{{}}

\begin{{document}}
\maketitle

\end{{document}}
"))],
    }
}

fn escape(s: &str) -> String {
    s.chars()
        .flat_map(|c| match c {
            '&' | '%' | '$' | '#' | '_' | '{' | '}' => vec!['\\', c],
            '\\' | '~' | '^' => vec![],
            _ => vec![c],
        })
        .collect()
}
