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

  const RETRYABLE_HTTP = new Set([429, 502, 503]);
  const CHAT_MAX_ATTEMPTS = 4;
  const CHAT_RETRY_BASE_MS = 750;

  /** @type {((opts: object) => Promise<object>) | null} */
  let _createEngineFn = null;
  /** @type {object | null} */
  let _mozillaEngine = null;
  /** @type {string | null} */
  let _mozillaEngineKey = null;

  /**
   * @param {number} ms
   * @param {AbortSignal} [signal]
   * @returns {Promise<void>}
   */
  function delay(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      const id = setTimeout(() => {
        if (signal) signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      function onAbort() {
        clearTimeout(id);
        reject(new DOMException("Aborted", "AbortError"));
      }
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  /**
   * @param {number} status
   * @param {string} body
   * @returns {string}
   */
  function formatChatHttpError(status, body) {
    let msg = `HTTP ${status}: ${body}`;
    if (
      status === 503 &&
      (/no healthy upstream/i.test(body) || /Provider returned error/i.test(body))
    ) {
      msg +=
        " — Usually temporary: OpenRouter has no healthy backend for this model right now. Wait a minute, try again, or set a different OpenRouter model id.";
    }
    return msg;
  }

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
   * Small local models often skip JSON; accept a plain short label.
   * @param {string} raw
   * @returns {string | null}
   */
  function coercePlainLabel(raw) {
    if (!raw || typeof raw !== "string") return null;
    let s = raw.trim();
    const fence = s.match(/```(?:json|text)?\s*([\s\S]*?)```/);
    if (fence) s = fence[1].trim();
    s = s
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith("{") && !/^```/.test(line)) || s.split(/\r?\n/)[0] || "";
    s = s.replace(/^["'`]+|["'`]+$/g, "").trim();
    s = s.replace(/^(?:rewritten|title|label)\s*[:=]\s*/i, "").trim();
    if (!s || s.length > 120) return null;
    if (/^[\{\[]/.test(s)) return null;
    return s;
  }

  /**
   * @returns {(opts: object) => Promise<object>}
   */
  function getCreateEngine() {
    if (_createEngineFn) return _createEngineFn;
    try {
      const mod = ChromeUtils.importESModule(
        "chrome://global/content/ml/EngineProcess.sys.mjs"
      );
      if (typeof mod.createEngine !== "function") {
        throw new Error("createEngine is not available on EngineProcess.sys.mjs");
      }
      _createEngineFn = mod.createEngine;
      return _createEngineFn;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(
        `Firefox AI Runtime unavailable (${msg}). Enable browser.ml.enable and use a Zen build that ships toolkit/components/ml.`
      );
    }
  }

  /**
   * @param {unknown} res
   * @returns {string}
   */
  function extractEngineText(res) {
    if (typeof res === "string") return res.trim();
    if (Array.isArray(res) && res[0]) {
      const row = res[0];
      if (typeof row === "string") return row.trim();
      if (row && typeof row === "object") {
        return String(
          row.generated_text ?? row.summary_text ?? row.translation_text ?? row.text ?? ""
        ).trim();
      }
    }
    if (res && typeof res === "object") {
      return String(
        res.generated_text ?? res.summary_text ?? res.translation_text ?? res.text ?? ""
      ).trim();
    }
    return "";
  }

  /**
   * Flatten chat messages into a single prompt for Transformers.js pipelines.
   * @param {Array<{ role: string, content: string }>} messages
   * @returns {string}
   */
  function messagesToMozillaPrompt(messages) {
    const system = messages.find((m) => m.role === "system")?.content?.trim() || "";
    const user = messages.find((m) => m.role === "user")?.content?.trim() || "";
    // Compact instruction style works better for small T5-family models.
    return [
      system,
      "",
      user,
      "",
      "Reply with JSON only: {\"filtered\":\"...\",\"rewritten\":\"...\"}",
    ]
      .join("\n")
      .trim();
  }

  /**
   * @param {object} p
   * @param {AbortSignal} [signal]
   * @returns {Promise<object>}
   */
  async function ensureMozillaEngine(p, signal) {
    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    const key = `${p.taskName}|${p.model}|${p.modelHub}|${p.device}`;
    if (_mozillaEngine && _mozillaEngineKey === key) {
      return _mozillaEngine;
    }

    const createEngine = getCreateEngine();
    const engine = await createEngine({
      taskName: p.taskName,
      modelId: p.model,
      modelHub: p.modelHub,
      engineId: p.engineId,
      dtype: "q8",
      device: p.device,
      executionPriority: "LOW",
    });

    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    _mozillaEngine = engine;
    _mozillaEngineKey = key;
    return engine;
  }

  /**
   * @param {object} p
   * @param {Array<{ role: string, content: string }>} messages
   * @param {AbortSignal} [signal]
   * @returns {Promise<string>}
   */
  async function completeMozilla(p, messages, signal) {
    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    let engine;
    try {
      engine = await ensureMozillaEngine(p, signal);
    } catch (e) {
      // Stale worker / memory pressure: drop cache and retry once.
      _mozillaEngine = null;
      _mozillaEngineKey = null;
      engine = await ensureMozillaEngine(p, signal);
    }

    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    const prompt = messagesToMozillaPrompt(messages);
    const request = {
      args: [prompt],
      options: { max_new_tokens: 96 },
    };

    let res;
    try {
      res = await engine.run(request);
    } catch (e) {
      _mozillaEngine = null;
      _mozillaEngineKey = null;
      throw e;
    }

    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    return extractEngineText(res);
  }

  /**
   * @param {object} utils
   * @returns {{
   *   name: string,
   *   apiKey: string | null,
   *   baseUrl: string,
   *   model: string,
   *   isOllama: boolean,
   *   isGemini: boolean,
   *   isMozillaLocal: boolean,
   *   taskName?: string,
   *   modelHub?: string,
   *   device?: string,
   *   engineId?: string,
   *   extraHeaders?: Record<string, string>
   * }}
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
      MOZILLA_TASK_PREF,
      MOZILLA_MODEL_PREF,
      MOZILLA_DEVICE_PREF,
      DEFAULT_MOZILLA_TASK,
      DEFAULT_MOZILLA_MODEL,
      DEFAULT_MOZILLA_DEVICE,
      MOZILLA_ENGINE_ID,
    } = utils;

    const id = String(getPref(PROVIDER_PREF, "mistral") || "mistral").toLowerCase();

    if (id === "mozilla") {
      return {
        name: "Mozilla Local",
        apiKey: null,
        baseUrl: "",
        model: getPref(MOZILLA_MODEL_PREF, DEFAULT_MOZILLA_MODEL),
        isOllama: false,
        isGemini: false,
        isMozillaLocal: true,
        taskName: getPref(MOZILLA_TASK_PREF, DEFAULT_MOZILLA_TASK),
        modelHub: "huggingface",
        device: getPref(MOZILLA_DEVICE_PREF, DEFAULT_MOZILLA_DEVICE),
        engineId: MOZILLA_ENGINE_ID,
      };
    }

    if (id === "ollama") {
      return {
        name: "Ollama",
        apiKey: null,
        baseUrl: getPref(OLLAMA_BASE_URL_PREF, DEFAULT_OLLAMA_CHAT_URL),
        model: getPref(OLLAMA_MODEL_PREF, "mistral"),
        isOllama: true,
        isGemini: false,
        isMozillaLocal: false,
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
        isMozillaLocal: false,
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
        isMozillaLocal: false,
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
        isMozillaLocal: false,
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
      isMozillaLocal: false,
    };
  }

  /**
   * @param {object} p
   * @param {Array<{ role: string, content: string }>} messages
   * @param {AbortSignal} [signal]
   * @returns {Promise<string>}
   */
  async function completeChat(p, messages, signal) {
    if (p.isMozillaLocal) {
      return completeMozilla(p, messages, signal);
    }

    const { apiKey, baseUrl, model, isOllama, isGemini } = p;

    if (isOllama) {
      let lastStatus = 0;
      let lastBody = "";
      for (let attempt = 1; attempt <= CHAT_MAX_ATTEMPTS; attempt++) {
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
        if (response.ok) {
          const json = await response.json();
          return (json.message?.content || "").trim();
        }
        lastStatus = response.status;
        lastBody = await response.text();
        if (!RETRYABLE_HTTP.has(lastStatus) || attempt === CHAT_MAX_ATTEMPTS) {
          throw new Error(formatChatHttpError(lastStatus, lastBody));
        }
        await delay(CHAT_RETRY_BASE_MS * 2 ** (attempt - 1), signal);
      }
      throw new Error(formatChatHttpError(lastStatus, lastBody));
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

    const init = {
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
    };

    let lastStatus = 0;
    let lastBody = "";
    for (let attempt = 1; attempt <= CHAT_MAX_ATTEMPTS; attempt++) {
      const response = await fetch(url, init);
      if (response.ok) {
        const json = await response.json();
        return (json.choices?.[0]?.message?.content || "").trim();
      }
      lastStatus = response.status;
      lastBody = await response.text();
      if (!RETRYABLE_HTTP.has(lastStatus) || attempt === CHAT_MAX_ATTEMPTS) {
        throw new Error(formatChatHttpError(lastStatus, lastBody));
      }
      await delay(CHAT_RETRY_BASE_MS * 2 ** (attempt - 1), signal);
    }
    throw new Error(formatChatHttpError(lastStatus, lastBody));
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
      BROWSER_ML_ENABLE_PREF,
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

      if (provider.isMozillaLocal) {
        if (!getPref(BROWSER_ML_ENABLE_PREF, false)) {
          console.warn(
            "[Rename Pinned Tab] Mozilla Local requires browser.ml.enable=true in about:config"
          );
          return null;
        }
      } else if (!provider.isOllama && (!provider.apiKey || provider.apiKey.length < 10)) {
        console.warn(`[Rename Pinned Tab] Missing or invalid API key (${provider.name})`);
        return null;
      }

      const now = Date.now();
      const wait = _lastRequestAt + MIN_INTERVAL_MS - now;
      if (wait > 0) {
        await new Promise((r) => setTimeout(r, wait));
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
        let label = parsed?.rewritten?.replace(/^["'\s]+|["'\s]+$/g, "").trim() || "";

        if (!label && provider.isMozillaLocal) {
          label = coercePlainLabel(raw) || "";
          if (label) debugLog("Mozilla Local used plain-text fallback label");
        }

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
