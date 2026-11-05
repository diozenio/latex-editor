import { useMemo } from "react";
import { create } from "zustand";
import { de } from "./locales/de";
import { en } from "./locales/en";
import { es } from "./locales/es";
import { it } from "./locales/it";
import { ptBR } from "./locales/pt-BR";

export type Messages = { [K in keyof typeof en]: string };
type Plural<K> = K extends `${infer B}.${"one" | "other"}` ? B : K;
export type MessageKey = Plural<keyof Messages>;
export type Params = Record<string, string | number>;

export type Language = "en" | "pt-BR" | "es" | "it" | "de";

export const LANGUAGES: { id: Language; name: string }[] = [
  { id: "en", name: "English" },
  { id: "pt-BR", name: "Português (Brasil)" },
  { id: "es", name: "Español" },
  { id: "it", name: "Italiano" },
  { id: "de", name: "Deutsch" },
];

const DICTIONARIES: Record<Language, Messages> = {
  en,
  "pt-BR": ptBR,
  es,
  it,
  de,
};

const STORAGE_KEY = "quilltex.language";

function isLanguage(value: unknown): value is Language {
  return LANGUAGES.some((l) => l.id === value);
}

function detectLanguage(): Language {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isLanguage(saved)) return saved;
  } catch {}
  const nav = typeof navigator === "undefined" ? "en" : navigator.language;
  const base = nav.toLowerCase().split("-")[0];
  if (base === "pt") return "pt-BR";
  if (base === "es" || base === "it" || base === "de") return base;
  return "en";
}

interface LanguageState {
  language: Language;
  setLanguage: (language: Language) => void;
}

const initial = detectLanguage();
if (typeof document !== "undefined") document.documentElement.lang = initial;

export const useLanguage = create<LanguageState>((set) => ({
  language: initial,
  setLanguage(language) {
    try {
      localStorage.setItem(STORAGE_KEY, language);
    } catch {}
    document.documentElement.lang = language;
    set({ language });
  },
}));

export function getLanguage(): Language {
  return useLanguage.getState().language;
}

export function hasKey(key: string, language = getLanguage()): boolean {
  return key in DICTIONARIES[language] || key in en;
}

function lookup(language: Language, key: string): string | undefined {
  return (
    (DICTIONARIES[language] as Record<string, string>)[key] ??
    (en as Record<string, string>)[key]
  );
}

const rules = new Map<Language, Intl.PluralRules>();

function pluralForm(language: Language, count: number): "one" | "other" {
  let r = rules.get(language);
  if (!r) {
    r = new Intl.PluralRules(language);
    rules.set(language, r);
  }
  return r.select(count) === "one" ? "one" : "other";
}

export function translate(
  language: Language,
  key: MessageKey,
  params?: Params,
): string {
  let text: string | undefined;
  if (typeof params?.count === "number")
    text = lookup(language, `${key}.${pluralForm(language, params.count)}`);
  text ??= lookup(language, key);
  if (text === undefined) return key;
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name];
    if (value === undefined) return whole;
    return name === "count" && typeof value === "number"
      ? value.toLocaleString(language)
      : String(value);
  });
}

export function t(key: MessageKey, params?: Params): string {
  return translate(getLanguage(), key, params);
}

export type TFunction = typeof t;

export function useT(): TFunction {
  const language = useLanguage((s) => s.language);
  return useMemo(
    () => (key: MessageKey, params?: Params) =>
      translate(language, key, params),
    [language],
  );
}
