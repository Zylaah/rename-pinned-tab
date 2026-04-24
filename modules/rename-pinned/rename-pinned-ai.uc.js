// ==UserScript==
// @include   main
// @loadOrder 99999999999991
// @ignorecache
// ==/UserScript==

(function () {
  "use strict";

  if (location.href !== "chrome://browser/content/browser.xhtml") return;

  let _lastRequestAt = 0;
  const MIN_INTERVAL_MS = 800;

  /**
   * @param {string} raw
   * @returns {{ filtered?: string, rewritten?: string } | null}
   */
  function parseJsonResponse(raw) {
    if (!raw || typeof raw !== "string") return null;
    let s = raw.trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) s = fence[1].trim();
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    try {
      const obj = JSON.parse(s.slice(start, end + 1));
      if (obj && typeof obj.rewritten === "string") return obj;
      return null;
    } catch {
      return null;
    }
  }

  /**
   * @param {object} utils
   * @returns {{ name: string, apiKey: string | null, baseUrl: string, model: string, isOllama: boolean, isGemini: boolean, extraHeaders?: Record<string, string> }}
   */
  function resolveProvider(utils) {
    const {
      getPref,
      PROVIDER_PREF,
      MISTRAL_API_KEY_PREF,
      MODEL_PREF,
      MISTRAL_URL,
      OPENAI_API_KEY_PREF,
      OPENAI_MODEL_PREF,
      OPENAI_URL,
      OPENROUTER_API_KEY_PREF,
      OPENROUTER_MODEL_PREF,
      OPENROUTER_URL,
      GEMINI_API_KEY_PREF,
      GEMINI_MODEL_PREF,
      GEMINI_OPENAI_BASE_URL,
      OLLAMA_BASE_URL_PREF,
      OLLAMA_MODEL_PREF,
      DEFAULT_OLLAMA_CHAT_URL,
    } = utils;

    const id = String(getPref(PROVIDER_PREF, "mistral") || "mistral").toLowerCase();

    if (id === "ollama") {
      return {
        name: "Ollama",
        apiKey: null,
        baseUrl: getPref(OLLAMA_BASE_URL_PREF, DEFAULT_OLLAMA_CHAT_URL),
        model: getPref(OLLAMA_MODEL_PREF, "mistral"),
        isOllama: true,
        isGemini: false,
      };
    }

    if (id === "gemini") {
      return {
        name: "Gemini",
        apiKey: getPref(GEMINI_API_KEY_PREF, ""),
        baseUrl: GEMINI_OPENAI_BASE_URL,
        model: getPref(GEMINI_MODEL_PREF, "gemini-3.1-pro-preview"),
        isOllama: false,
        isGemini: true,
      };
    }

    if (id === "openai") {
      return {
        name: "OpenAI",
        apiKey: getPref(OPENAI_API_KEY_PREF, ""),
        baseUrl: OPENAI_URL,
        model: getPref(OPENAI_MODEL_PREF, "gpt-5.3-chat-latest"),
        isOllama: false,
        isGemini: false,
      };
    }

    if (id === "openrouter") {
      return {
        name: "OpenRouter",
        apiKey: getPref(OPENROUTER_API_KEY_PREF, ""),
        baseUrl: OPENROUTER_URL,
        model: getPref(OPENROUTER_MODEL_PREF, "openai/gpt-4o-mini"),
        isOllama: false,
        isGemini: false,
        extraHeaders: {
          "HTTP-Referer": "https://zen-browser.app",
          "X-Title": "Rename Pinned Tab (Zen)",
        },
      };
    }

    return {
      name: "Mistral",
      apiKey: getPref(MISTRAL_API_KEY_PREF, ""),
      baseUrl: MISTRAL_URL,
      model: getPref(MODEL_PREF, "mistral-small-latest"),
      isOllama: false,
      isGemini: false,
    };
  }

  /**
   * @param {object} p
   * @param {Array<{ role: string, content: string }>} messages
   * @param {AbortSignal} [signal]
   * @returns {Promise<string>}
   */
  async function completeChat(p, messages, signal) {
    const { apiKey, baseUrl, model, isOllama, isGemini } = p;

    if (isOllama) {
      const response = await fetch(baseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages,
          stream: false,
        }),
        signal,
      });
      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errText}`);
      }
      const json = await response.json();
      return (json.message?.content || "").trim();
    }

    const base = baseUrl.replace(/\/+$/, "");
    let url = base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
    if (isGemini && apiKey) {
      url += (url.includes("?") ? "&" : "?") + "key=" + encodeURIComponent(apiKey);
    }

    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...(p.extraHeaders || {}),
    };

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        temperature: 0.1,
        max_tokens: 256,
      }),
      signal,
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errText}`);
    }

    const json = await response.json();
    return (json.choices?.[0]?.message?.content || "").trim();
  }

  /**
   * @param {object} deps
   * @param {typeof window.zenRenamePinnedTabsUtils} deps.utils
   */
  function createAiRename(deps) {
    const { utils } = deps;
    const {
      getPref,
      createDebugLog,
      redactSensitiveData,
      PINNED_TAB_SYSTEM_PROMPT,
      DEBUG_PREF,
    } = utils;

    /**
     * @param {object} params
     * @param {string} params.title
     * @param {string} params.url
     * @param {AbortSignal} [params.signal]
     * @returns {Promise<string | null>} Short label or null
     */
    async function getRewrittenTitle({ title, url, signal }) {
      const debug = getPref(DEBUG_PREF, false);
      const debugLog = createDebugLog(debug);

      const provider = resolveProvider(utils);

      if (!provider.isOllama && (!provider.apiKey || provider.apiKey.length < 10)) {
        console.warn(`[Rename Pinned Tab] Missing or invalid API key (${provider.name})`);
        return null;
      }

      const now = Date.now();
      const wait = _lastRequestAt + MIN_INTERVAL_MS - now;
      if (wait > 0) {
        await new Promise(r => setTimeout(r, wait));
      }
      _lastRequestAt = Date.now();

      const userContent = `Tab title (this text sets the output language — match it exactly, do not translate to another language):\n${title}\n\nPage URL (for context only; may not match the title language; ignore for language choice):\n${url}\n\nOutput: one JSON object with keys filtered and rewritten only. Same language as the tab title line above.`;

      const messages = [
        { role: "system", content: PINNED_TAB_SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ];

      try {
        const raw = await completeChat(provider, messages, signal);
        debugLog(`${provider.name} raw:`, raw);

        const parsed = parseJsonResponse(raw);
        if (!parsed?.rewritten) return null;

        let label = parsed.rewritten.replace(/^["'\s]+|["'\s]+$/g, "").trim();
        if (!label || label.length > 120) return null;
        return label;
      } catch (e) {
        const msg = e instanceof Error ? redactSensitiveData(e.message) : String(e);
        console.error("[Rename Pinned Tab] AI error:", msg);
        return null;
      }
    }

    return { getRewrittenTitle };
  }

  window.zenRenamePinnedTabsAi = { createAiRename };
})();
