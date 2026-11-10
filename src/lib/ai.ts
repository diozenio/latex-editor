import { hasKey, type MessageKey, t } from "@/lib/i18n";
import type { AppInfo, Settings } from "@/lib/ipc";

export type AiProvider = "claude" | "openrouter";

export const CLAUDE_MODELS: [string, string][] = [
  ["", "chat.modelDefault"],
  ["claude-fable-5-1", "Fable 5.1"],
  ["claude-opus-5-5", "Opus 5.5"],
  ["claude-sonnet-5-5", "Sonnet 5.5"],
  ["claude-haiku-5-5", "Haiku 5.5"],
];

export const OPENROUTER_DEFAULT = "anthropic/claude-sonnet-5.5";

/** Models known to handle tool calling well, which the assistant depends on. */
export const OPENROUTER_MODELS: [string, string][] = [
  ["anthropic/claude-sonnet-5.5", "Claude Sonnet 5.5"],
  ["anthropic/claude-opus-5.5", "Claude Opus 5.5"],
  ["anthropic/claude-haiku-5.5", "Claude Haiku 5.5"],
  ["anthropic/claude-fable-5.2", "Claude Fable 5.2"],
  ["openai/gpt-5.6-sol", "GPT-5.6 Sol"],
  ["openai/gpt-5.6-terra", "GPT-5.6 Terra"],
  ["openai/gpt-5.6-luna", "GPT-5.6 Luna"],
  ["google/gemini-4-argon", "Gemini 4 Argon"],
  ["google/gemini-3.8-flash", "Gemini 3.8 Flash"],
  ["x-ai/grok-4.7", "Grok 4.7"],
  ["deepseek/deepseek-v4.1-flash", "DeepSeek V4.1 Flash"],
  ["moonshotai/kimi-k3.1-pro", "Kimi K3.1 Pro"],
  ["qwen/qwen3.8-max-0902", "Qwen 3.8 Max"],
  ["z-ai/glm-5.3", "GLM 5.3"],
  ["mistralai/mistral-large-4-0", "Mistral Large 4"],
];

export function aiProvider(settings: Settings | null): AiProvider {
  return settings?.aiProvider === "openrouter" ? "openrouter" : "claude";
}

export function aiReady(settings: Settings | null, info: AppInfo | null) {
  return aiProvider(settings) === "openrouter"
    ? !!settings?.openrouterKey.trim()
    : !!info?.claude;
}

/** Explains an AI failure; `code` comes from the backend, `detail` is what the provider said. */
export function aiErrorMessage(code: string | null, detail: string | null) {
  const key = `ai.error.${code}`;
  if (!code || !hasKey(key)) return detail ?? "";
  const text = t(key as MessageKey);
  return detail && detail !== code ? `${text}\n${detail.slice(0, 400)}` : text;
}
