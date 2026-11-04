import type {
  CompletionContext,
  CompletionResult,
} from "@codemirror/autocomplete";
import { flatten } from "@/stores/project";
import { api, type FileNode } from "./ipc";

let labels: string[] = [];
let citations: { key: string; title: string }[] = [];

export async function refreshRefs(project: string, tree: FileNode[]) {
  const files = flatten(tree).filter(
    (n) => !n.isDir && /\.(tex|bib)$/i.test(n.name) && n.size < 2_000_000,
  );
  const nextLabels = new Set<string>();
  const nextCites: { key: string; title: string }[] = [];
  await Promise.all(
    files.map(async (f) => {
      try {
        const text = await api.readText(project, f.path);
        if (f.name.endsWith(".bib")) {
          for (const m of text.matchAll(
            /@\w+\s*\{\s*([^,\s]+)\s*,([\s\S]*?)(?=\n@|$)/g,
          )) {
            const title =
              /title\s*=\s*[{"](.+?)[}"]\s*,?\s*\n/i.exec(m[2])?.[1] ?? "";
            nextCites.push({ key: m[1], title: title.replace(/[{}]/g, "") });
          }
        } else {
          for (const m of text.matchAll(/\\label\{([^}]+)\}/g))
            nextLabels.add(m[1]);
          for (const m of text.matchAll(/\\bibitem(?:\[[^\]]*\])?\{([^}]+)\}/g))
            nextCites.push({ key: m[1], title: "" });
        }
      } catch {}
    }),
  );
  labels = [...nextLabels].sort();
  citations = nextCites;
}

export function refCompletion(ctx: CompletionContext): CompletionResult | null {
  const before = ctx.matchBefore(
    /\\(?:[a-zA-Z]*ref|eqref|cite[a-zA-Z]*|autocite|parencite|textcite)\*?(?:\[[^\]]*\])*\{[^}]*/,
  );
  if (!before) return null;
  const brace = before.text.lastIndexOf("{");
  const comma = before.text.lastIndexOf(",");
  const from = before.from + Math.max(brace, comma) + 1;
  const isCite = /\\[a-z]*cite/i.test(before.text);
  const options = isCite
    ? citations.map((c) => ({
        label: c.key,
        detail: c.title,
        type: "constant",
      }))
    : labels.map((l) => ({ label: l, type: "variable" }));
  return { from, options, validFor: /^[^},]*$/ };
}
