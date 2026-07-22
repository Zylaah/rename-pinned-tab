// ==UserScript==
// @include   main
// @loadOrder 99999999999990
// @ignorecache
// ==/UserScript==

(function () {
  "use strict";

  if (location.href !== "chrome://browser/content/browser.xhtml") return;

  const { classes: Cc, interfaces: Ci } = Components;

  const MISTRAL_API_KEY_PREF = "extensions.zen.rename_pinned_tab.mistral_api_key";
  const ENABLED_PREF = "extensions.zen.rename_pinned_tab.enabled";
  const DEBUG_PREF = "extensions.zen.rename_pinned_tab.debug";
  const MODEL_PREF = "extensions.zen.rename_pinned_tab.mistral_model";
  const REVERT_MODIFIER_PREF = "extensions.zen.rename_pinned_tab.revert_modifier";

  /** @typedef {"mistral"|"openai"|"openrouter"|"ollama"|"gemini"|"mozilla"} RenamePinnedProviderId */

  const PROVIDER_PREF = "extensions.zen.rename_pinned_tab.provider";
  const OPENAI_API_KEY_PREF = "extensions.zen.rename_pinned_tab.openai_api_key";
  const OPENAI_MODEL_PREF = "extensions.zen.rename_pinned_tab.openai_model";
  const OPENROUTER_API_KEY_PREF = "extensions.zen.rename_pinned_tab.openrouter_api_key";
  const OPENROUTER_MODEL_PREF = "extensions.zen.rename_pinned_tab.openrouter_model";
  const GEMINI_API_KEY_PREF = "extensions.zen.rename_pinned_tab.gemini_api_key";
  const GEMINI_MODEL_PREF = "extensions.zen.rename_pinned_tab.gemini_model";
  const OLLAMA_BASE_URL_PREF = "extensions.zen.rename_pinned_tab.ollama_base_url";
  const OLLAMA_MODEL_PREF = "extensions.zen.rename_pinned_tab.ollama_model";
  const MOZILLA_TASK_PREF = "extensions.zen.rename_pinned_tab.mozilla_task";
  const MOZILLA_MODEL_PREF = "extensions.zen.rename_pinned_tab.mozilla_model";
  const MOZILLA_DEVICE_PREF = "extensions.zen.rename_pinned_tab.mozilla_device";
  const BROWSER_ML_ENABLE_PREF = "browser.ml.enable";

  const MISTRAL_URL = "https://api.mistral.ai/v1/chat/completions";
  const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
  const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
  const GEMINI_OPENAI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";
  const DEFAULT_OLLAMA_CHAT_URL = "http://localhost:11434/api/chat";
  const DEFAULT_MOZILLA_TASK = "text2text-generation";
  const DEFAULT_MOZILLA_MODEL = "Xenova/flan-t5-small";
  const DEFAULT_MOZILLA_DEVICE = "wasm";
  /** Unique engine id so Firefox features do not reuse/destroy this pipeline. */
  const MOZILLA_ENGINE_ID = "zen-tidy-pinned-tabs";

  /** System prompt (from project ai prompt.txt — keep in sync). */
  const PINNED_TAB_SYSTEM_PROMPT = `You are an expert editor who shortens browser tab titles. You are not a cross-language translator for this task.

I am bookmarking a tab in my browser.

Example title: \`Wolfram|Alpha: Computational Intelligence\`.

- Remove the site name (e.g. wolframalpha.com) when it is not the only meaningful part.
- Remove SEO cruft.
- Stay specific; avoid vague generic labels.
- For proper nouns (people, brands, venues), keep the name and enough context. Example shortenings in the SAME language as the source: "Individualized Eng Expectations - Anna Delvey" → "Anna's Eng Expectations"; "Arc by the Browser Company: Monetization Strategy" → "Arc Monetization".
- Drop words that only describe page type (video, recipe, guide, etc.).
- Prefer keeping subject / verb / object; trim the rest.

LANGUAGE (strict): The user message includes the real tab title. Both \`filtered\` and \`rewritten\` MUST be written in that title's language only. If the tab title is English, output English only—never Spanish, French, or any other language. If the title is Spanish, output Spanish only. Do not switch language because of the URL, domain, or your own guess. Mixed-language titles: use the dominant language of the title text. Never "translate" the title into another language.

Return JSON only, matching this schema (property names exactly):
\`\`\`
{
    filtered: string // Edited full title: cruft removed, same language as the tab title.
    rewritten: string // Ultra-short label, 1-3 words, same language as the tab title.
}
\`\`\`

JSON keys must be \`filtered\` and \`rewritten\`. No markdown outside the JSON object.`;

  const _prefBranch = (() => {
    try {
      return Cc["@mozilla.org/preferences-service;1"]
        .getService(Ci.nsIPrefService)
        .getBranch("");
    } catch (_) {
      return null;
    }
  })();

  /**
   * @param {string} prefName
   * @param {string|number|boolean} defaultValue
   */
  function getPref(prefName, defaultValue) {
    try {
      const branch = _prefBranch;
      if (!branch || !prefName) return defaultValue;
      if (typeof defaultValue === "boolean") {
        try {
          return branch.getBoolPref(prefName, defaultValue);
        } catch (_) {
          // Older builds: no default-arg form.
          try {
            return branch.getBoolPref(prefName);
          } catch {
            return defaultValue;
          }
        }
      }
      if (typeof defaultValue === "string") {
        return branch.getStringPref(prefName, defaultValue);
      }
      if (typeof defaultValue === "number") {
        return branch.getIntPref(prefName, defaultValue);
      }
      return defaultValue;
    } catch (e) {
      console.error("[Rename Pinned Tab] getPref:", e);
      return defaultValue;
    }
  }

  /**
   * @param {string} prefName
   * @param {boolean} value
   * @returns {boolean} Whether the write succeeded
   */
  function setBoolPref(prefName, value) {
    try {
      const branch = _prefBranch;
      if (!branch || !prefName) return false;
      branch.setBoolPref(prefName, !!value);
      return true;
    } catch (e) {
      console.error("[Rename Pinned Tab] setBoolPref:", e);
      return false;
    }
  }

  /**
   * @param {boolean} debug
   * @returns {(msg: string, ...args: unknown[]) => void}
   */
  function createDebugLog(debug) {
    return (msg, ...args) => {
      if (debug) {
        console.log(`[Rename Pinned Tab] ${msg}`, ...args);
      }
    };
  }

  function redactSensitiveData(text) {
    if (typeof text !== "string") return String(text);
    return text.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]").replace(/"Authorization"\s*:\s*"[^"]+"/gi, '"Authorization":"[REDACTED]"');
  }

  window.zenRenamePinnedTabsUtils = {
    MISTRAL_API_KEY_PREF,
    ENABLED_PREF,
    DEBUG_PREF,
    MODEL_PREF,
    REVERT_MODIFIER_PREF,
    PROVIDER_PREF,
    OPENAI_API_KEY_PREF,
    OPENAI_MODEL_PREF,
    OPENROUTER_API_KEY_PREF,
    OPENROUTER_MODEL_PREF,
    GEMINI_API_KEY_PREF,
    GEMINI_MODEL_PREF,
    OLLAMA_BASE_URL_PREF,
    OLLAMA_MODEL_PREF,
    MOZILLA_TASK_PREF,
    MOZILLA_MODEL_PREF,
    MOZILLA_DEVICE_PREF,
    BROWSER_ML_ENABLE_PREF,
    MISTRAL_URL,
    OPENAI_URL,
    OPENROUTER_URL,
    GEMINI_OPENAI_BASE_URL,
    DEFAULT_OLLAMA_CHAT_URL,
    DEFAULT_MOZILLA_TASK,
    DEFAULT_MOZILLA_MODEL,
    DEFAULT_MOZILLA_DEVICE,
    MOZILLA_ENGINE_ID,
    PINNED_TAB_SYSTEM_PROMPT,
    getPref,
    setBoolPref,
    createDebugLog,
    redactSensitiveData,
  };
})();
