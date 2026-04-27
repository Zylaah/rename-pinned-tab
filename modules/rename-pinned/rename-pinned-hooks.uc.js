// ==UserScript==
// @include   main
// @loadOrder 99999999999992
// @ignorecache
// ==/UserScript==

(function () {
  "use strict";

  if (location.href !== "chrome://browser/content/browser.xhtml") return;

  const DATA_ATTR = "data-zen-ai-pinned-rename";
  const REVERT_PULSE_CLASS = "zen-ai-pinned-revert-pulse";
  const THINKING_CLASS = "zen-ai-pinned-thinking";
  const SPARKLE_CLASS = "zen-ai-rename-sparkle";
  /** After this, the short title is final: no revert UI or modifier+click undo. */
  const AI_RENAME_CONFIRM_MS = 5000;

  /** Marks tabs that should never auto-rename (already-pinned at startup, or user reverted). */
  const SKIP_ATTR = "data-zen-ai-pinned-skip";

  /**
   * @param {KeyboardEvent|MouseEvent} e
   * @param {string} mod "shift" | "alt" | "meta"
   */
  function modifierActive(e, mod) {
    const m = (mod || "shift").toLowerCase();
    if (m === "alt") return e.altKey;
    if (m === "meta") return e.metaKey;
    return e.shiftKey;
  }

  /**
   * @param {(k: string) => string} getPref
   * @param {string} REVERT_MODIFIER_PREF
   */
  function getRevertModifierDisplayName(getPref, REVERT_MODIFIER_PREF) {
    const m = getPref(REVERT_MODIFIER_PREF, "shift").toLowerCase();
    if (m === "alt") return "Alt";
    if (m === "meta") {
      return typeof navigator !== "undefined" && navigator.platform?.includes("Mac")
        ? "⌘"
        : "Meta";
    }
    return "Shift";
  }

  /**
   * @param {Element} tab
   * @param {string} text
   */
  function setSublabelPlainText(tab, text) {
    const sub = tab.querySelector(".zen-tab-sublabel");
    if (!sub) return;
    sub.textContent = text;
    sub.removeAttribute("data-l10n-id");
  }

  /**
   * @param {Element} tab
   * @param {string} primary
   * @param {string} secondary
   * @param {boolean} modifierHeld
   */
  function applyAiRenameSublabel(tab, primary, secondary, modifierHeld) {
    const sub = tab.querySelector(".zen-tab-sublabel");
    if (!sub) return;
    const text = modifierHeld ? secondary : primary;
    try {
      if (typeof document.l10n?.setArgs === "function") {
        document.l10n.setArgs(sub, { tabSubtitle: text });
        return;
      }
    } catch (_) {}
    setSublabelPlainText(tab, text);
  }

  /**
   * @param {object} deps
   * @param {typeof window.gBrowser} deps.gBrowser
   * @param {typeof window} deps.win
   * @param {ReturnType<typeof window.zenRenamePinnedTabsAi.createAiRename>} deps.ai
   * @param {typeof window.zenRenamePinnedTabsUtils} deps.utils
   */
  /**
   * @param {object} tab
   */
  function isBrowserTab(gBrowser, tab) {
    if (!tab) return false;
    if (typeof gBrowser.isTab === "function") return gBrowser.isTab(tab);
    return tab.localName === "tab";
  }

  function init(deps) {
    const { gBrowser, win, ai, utils } = deps;
    const { getPref, createDebugLog, ENABLED_PREF, DEBUG_PREF, REVERT_MODIFIER_PREF } = utils;
    const { getRewrittenTitle } = ai;

    /** @type {WeakMap<import("chrome").BrowserTab, { originalLabel: string, abort?: AbortController }>} */
    const tabState = new WeakMap();
    /** @type {Map<import("chrome").BrowserTab, ReturnType<typeof setTimeout>>} */
    const pendingPinTimers = new Map();
    /** @type {Map<import("chrome").BrowserTab, ReturnType<typeof setTimeout>>} */
    const confirmAiRenameTimers = new Map();

    /** Ref-count window key listeners shared by all tabs in the undo window */
    let aiSublabelGlobalKeyRef = 0;

    function onWindowKeyAiSublabel(e) {
      const tabs = gBrowser?.tabs;
      if (!tabs?.length) return;
      for (let i = 0; i < tabs.length; i++) {
        const t = tabs[i];
        if (
          t.hasAttribute(DATA_ATTR) &&
          typeof t._zenAiRenameRefreshSublabel === "function"
        ) {
          t._zenAiRenameRefreshSublabel(e);
        }
      }
    }

    function attachAiSublabelGlobalKeys() {
      if (aiSublabelGlobalKeyRef++ === 0) {
        win.addEventListener("keydown", onWindowKeyAiSublabel, true);
        win.addEventListener("keyup", onWindowKeyAiSublabel, true);
      }
    }

    function detachAiSublabelGlobalKeys() {
      if (--aiSublabelGlobalKeyRef <= 0) {
        aiSublabelGlobalKeyRef = 0;
        win.removeEventListener("keydown", onWindowKeyAiSublabel, true);
        win.removeEventListener("keyup", onWindowKeyAiSublabel, true);
      }
    }

    function clearConfirmAiRenameTimer(tab) {
      const id = confirmAiRenameTimers.get(tab);
      if (id != null) {
        win.clearTimeout(id);
        confirmAiRenameTimers.delete(tab);
      }
    }

    /**
     * User did not revert in time: keep `zenStaticLabel`, drop undo affordances.
     * @param {import("chrome").BrowserTab} tab
     */
    function finalizeAiRename(tab) {
      confirmAiRenameTimers.delete(tab);
      if (!tab?.pinned || tab.closing) return;
      if (!tab.hasAttribute(DATA_ATTR)) return;
      unbindAiRenameHover(tab);
      tab.removeAttribute(DATA_ATTR);
      tabState.delete(tab);
      debugLog("AI rename confirmed (undo window closed)", tab);
    }

    function scheduleAiRenameConfirmation(tab) {
      clearConfirmAiRenameTimer(tab);
      const id = win.setTimeout(() => finalizeAiRename(tab), AI_RENAME_CONFIRM_MS);
      confirmAiRenameTimers.set(tab, id);
    }

    function bindAiRenameHover(tab) {
      if (tab._zenAiRenameHoverBound) return;
      tab._zenAiRenameHoverBound = true;

      const lineRevert = "Revert rename";
      const lineRestore = "Restore original title";

      const refresh = (e) => {
        const ev = e || { shiftKey: false, altKey: false, metaKey: false };
        const held = modifierActive(ev, getPref(REVERT_MODIFIER_PREF, "shift"));
        const key = getRevertModifierDisplayName(getPref, REVERT_MODIFIER_PREF);
        const primary = `${key}+click icon — ${lineRevert}`;
        const secondary = `${lineRestore} (${key}+click)`;
        applyAiRenameSublabel(tab, primary, secondary, held);
      };

      tab._zenAiRenameRefreshSublabel = refresh;
      tab.setAttribute("zen-show-sublabel", "true");
      refresh({ shiftKey: false, altKey: false, metaKey: false });
      attachAiSublabelGlobalKeys();
    }

    function unbindAiRenameHover(tab) {
      if (!tab._zenAiRenameHoverBound) return;
      tab._zenAiRenameHoverBound = false;
      tab.removeAttribute("zen-show-sublabel");
      detachAiSublabelGlobalKeys();
      delete tab._zenAiRenameRefreshSublabel;
    }

    /** Hard cap keeps paint cost predictable on very wide sidebars. */
    const SPARKLE_MAX = 34;
    const SPARKLE_MIN = 16;
    /** ~1 sparkle per 7px width; tune for density vs perf. */
    const SPARKLE_WIDTH_DIVISOR = 7;
    const SPARKLE_WAVE_MS = 310;
    /** Keyframe time stops (0–1) aligned with the former CSS @keyframes zen-ai-sparkle-pop. */
    const SPARKLE_K_T = [0, 0.28, 0.58, 1];
    const SPARKLE_K_OP = [0, 1, 0.88, 0];
    const SPARKLE_K_SC = [0, 1.08, 0.82, 0.18];
    const SPARKLE_K_DX = [-0.15, 0.35, 0.72, 1];
    const SPARKLE_K_DY = [0, 0.35, 0.72, 1];
    const SPARKLE_K_RROT = [0, 18, 42, 88];

    /**
     * @param {number} a
     * @param {number} b
     * @param {number} t
     */
    function lerp(a, b, t) {
      return a + (b - a) * t;
    }

    /**
     * Piecewise linear sample over 0..1 (matches old CSS keyframe stops).
     * @param {number} t 0..1
     * @param {number[]} stops sorted 0..1
     * @param {number[]} values same length
     */
    function sampleKf(t, stops, values) {
      if (t <= stops[0]) return values[0];
      if (t >= stops[stops.length - 1]) return values[values.length - 1];
      for (let i = 0; i < stops.length - 1; i++) {
        if (t >= stops[i] && t <= stops[i + 1]) {
          const u = (t - stops[i]) / (stops[i + 1] - stops[i]);
          return lerp(values[i], values[i + 1], u);
        }
      }
      return values[values.length - 1];
    }

    /**
     * Resolved CSS color for canvas (Zen accent).
     * @param {Element} el
     * @returns {string}
     */
    function resolveSparkleColor(el) {
      try {
        for (const node of [el, document.documentElement]) {
          if (!node) continue;
          const c = win.getComputedStyle(node).getPropertyValue("--zen-primary-color").trim();
          if (c) return c;
        }
      } catch (_) {}
      return "rgb(10, 132, 255)";
    }

    /**
     * Cross + core at origin. Caller sets translate / rotate / scale and globalAlpha.
     * @param {CanvasRenderingContext2D} ctx
     * @param {number} size CSS px
     * @param {string} colorCss
     */
    function drawSparkleShape(ctx, size, colorCss) {
      const rayW = Math.max(0.5, size * 0.11);
      const rayH = size * 0.48;
      const coreR = size * 0.26;
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, coreR);
      g.addColorStop(0, colorCss);
      g.addColorStop(0.6, colorCss);
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.beginPath();
      ctx.arc(0, 0, coreR, 0, Math.PI * 2);
      ctx.fillStyle = g;
      ctx.fill();
      ctx.fillStyle = colorCss;
      ctx.fillRect(-rayW * 0.5, -rayH, rayW, rayH * 2);
      ctx.fillRect(-rayH, -rayW * 0.5, rayH * 2, rayW);
    }

    /**
     * One canvas + rAF pass for the whole sparkle field (replaces N DOM .zen-ai-sparkle nodes).
     * @param {Element} tab
     */
    function playRenameSparkle(tab) {
      const container = tab.querySelector(".tab-label-container");
      if (!container) return;

      const prev = tab._zenAiSparkleLayer;
      if (prev) {
        if (prev._zenAiSparkleRaf != null) {
          win.cancelAnimationFrame(prev._zenAiSparkleRaf);
          prev._zenAiSparkleRaf = null;
        }
        if (prev.isConnected) prev.remove();
      }

      tab.classList.remove(SPARKLE_CLASS);
      tab.classList.add(SPARKLE_CLASS);

      if (win.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) {
        tab.style.setProperty("--zen-ai-label-reveal-ms", "420ms");
        win.setTimeout(() => {
          tab.classList.remove(SPARKLE_CLASS);
          tab.style.removeProperty("--zen-ai-label-reveal-ms");
        }, 480);
        return;
      }

      const rect = container.getBoundingClientRect();
      const width = Math.max(48, rect.width || 100);

      const count = Math.min(
        SPARKLE_MAX,
        Math.max(SPARKLE_MIN, Math.round(width / SPARKLE_WIDTH_DIVISOR))
      );

      const WAVE_MS = SPARKLE_WAVE_MS;
      let maxFinish = 0;

      /** @type {Array<{ xPct: number, yPct: number, delay: number, life: number, size: number, baseRot: number, driftX: number, driftY: number }>} */
      const particles = [];

      for (let i = 0; i < count; i++) {
        const progress = count > 1 ? i / (count - 1) : 0.5;
        const xPct = 2 + progress * 96 + (Math.random() * 3 - 1.5);
        const row = i % 2;
        const yPct =
          row === 0 ? 28 + Math.random() * 22 : 48 + Math.random() * 24;
        const delay = Math.round(progress * WAVE_MS) + ((Math.random() * 35) | 0);
        const life = 260 + ((Math.random() * 120) | 0);
        maxFinish = Math.max(maxFinish, delay + life);

        const size = 2.5 + Math.random() * 5;
        const baseRot = (Math.random() * 360 * Math.PI) / 180;
        const driftY = Math.round(-5 + Math.random() * 10);
        const driftX = Math.round(4 + Math.random() * 10);

        particles.push({
          xPct,
          yPct,
          delay,
          life,
          size,
          baseRot,
          driftX,
          driftY,
        });
      }

      const revealMs = Math.min(
        700,
        Math.max(410, Math.round(WAVE_MS * 1.12 + maxFinish * 0.38))
      );
      tab.style.setProperty("--zen-ai-label-reveal-ms", `${revealMs}ms`);

      const layer = document.createElement("div");
      layer.className = "zen-ai-rename-sparkle-layer";
      const canvas = document.createElement("canvas");
      layer.appendChild(canvas);
      tab._zenAiSparkleLayer = layer;
      container.appendChild(layer);

      const colorCss = resolveSparkleColor(tab);
      const dpr = win.devicePixelRatio || 1;

      const t0 = win.performance?.now() ?? win.Date.now();
      const totalMs = maxFinish + 50;

      function sizeCanvas() {
        const w = layer.clientWidth || 1;
        const h = layer.clientHeight || 1;
        const pw = Math.max(1, Math.round(w * dpr));
        const ph = Math.max(1, Math.round(h * dpr));
        if (canvas.width !== pw || canvas.height !== ph) {
          canvas.width = pw;
          canvas.height = ph;
        }
        return { cw: w, ch: h };
      }

      function frame() {
        const now = (win.performance?.now() ?? win.Date.now()) - t0;
        if (now >= totalMs) {
          layer._zenAiSparkleRaf = null;
          tab.classList.remove(SPARKLE_CLASS);
          tab.style.removeProperty("--zen-ai-label-reveal-ms");
          if (layer.isConnected) layer.remove();
          if (tab._zenAiSparkleLayer === layer) {
            delete tab._zenAiSparkleLayer;
          }
          return;
        }

        const { cw, ch } = sizeCanvas();
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          layer._zenAiSparkleRaf = null;
          if (tab._zenAiSparkleLayer === layer) delete tab._zenAiSparkleLayer;
          layer.remove();
          tab.classList.remove(SPARKLE_CLASS);
          return;
        }

        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.scale(dpr, dpr);

        for (const p of particles) {
          const age = now - p.delay;
          if (age < 0) continue;
          const tNorm = Math.min(1, Math.max(0, age / p.life));
          const op = sampleKf(tNorm, SPARKLE_K_T, SPARKLE_K_OP);
          if (op <= 0.001) continue;
          const sc = sampleKf(tNorm, SPARKLE_K_T, SPARKLE_K_SC);
          if (sc <= 0) continue;
          const fdx = sampleKf(tNorm, SPARKLE_K_T, SPARKLE_K_DX);
          const fdy = sampleKf(tNorm, SPARKLE_K_T, SPARKLE_K_DY);
          const rAdd = (sampleKf(tNorm, SPARKLE_K_T, SPARKLE_K_RROT) * Math.PI) / 180;

          const xBase = (p.xPct / 100) * cw;
          const yBase = (p.yPct / 100) * ch;
          const px = xBase + p.driftX * fdx;
          const py = yBase + p.driftY * fdy;

          ctx.save();
          ctx.globalAlpha = op;
          ctx.translate(px, py);
          ctx.rotate(p.baseRot + rAdd);
          ctx.scale(sc, sc);
          drawSparkleShape(ctx, p.size, colorCss);
          ctx.restore();
        }

        layer._zenAiSparkleRaf = win.requestAnimationFrame(frame);
      }

      layer._zenAiSparkleRaf = win.requestAnimationFrame(frame);
    }

    function debugLog(...args) {
      createDebugLog(getPref(DEBUG_PREF, false))(...args);
    }

    function getBrowserTabTitle(tab) {
      try {
        const t = tab.linkedBrowser?.contentTitle;
        if (t && String(t).trim()) return String(t).trim();
      } catch (_) {}
      return (tab.label && String(tab.label).trim()) || "";
    }

    /**
     * Zen patches `gBrowser._setTabLabel` to bail out unless `_zenChangeLabelFlag` is set, and
     * always prefers `tab.zenStaticLabel` for the visible title (manual rename / pinned editor).
     *
     * @param {import("chrome").BrowserTab} tab
     * @param {string} label
     * @param {{ revert?: boolean }} [opts]
     */
    function applyTabLabel(tab, label, opts = {}) {
      const { revert = false } = opts;
      const zenOpts = { _zenChangeLabelFlag: true };

      if (typeof gBrowser._setTabLabel === "function") {
        if (revert) {
          delete tab.zenStaticLabel;
          gBrowser._setTabLabel(tab, label, { isContentTitle: true, ...zenOpts });
        } else {
          tab.zenStaticLabel = label;
          gBrowser._setTabLabel(tab, label, { isContentTitle: false, ...zenOpts });
        }
        return;
      }

      if (revert) {
        delete tab.zenStaticLabel;
        if (typeof gBrowser.setTabTitle === "function") {
          gBrowser.setTabTitle(tab, null);
        } else {
          tab.label = label;
        }
      } else {
        tab.zenStaticLabel = label;
        if (typeof gBrowser.setTabTitle === "function") {
          gBrowser.setTabTitle(tab, label);
        } else {
          tab.label = label;
        }
      }
      win.gZenPinnedTabManager?.onTabLabelChanged?.(tab);
    }

    /**
     * @param {import("chrome").BrowserTab} tab
     */
    async function runRenameForTab(tab) {
      if (!getPref(ENABLED_PREF, true)) return;
      if (!tab?.pinned || tab.closing) return;
      if (tab.hasAttribute("zen-essential")) return;
      if (tab.hasAttribute(SKIP_ATTR)) {
        debugLog("Skip AI rename: tab marked as already handled/pre-pinned", tab);
        return;
      }

      clearConfirmAiRenameTimer(tab);

      const existing = tabState.get(tab);
      existing?.abort?.abort();

      const title = getBrowserTabTitle(tab);
      let url = "";
      try {
        url = tab.linkedBrowser?.currentURI?.spec ?? "";
      } catch (_) {}

      if (!title) {
        debugLog("Skip rename: empty title", tab);
        return;
      }

      /** Bumps so an older in-flight `runRenameForTab` does not clear "thinking" for a newer run. */
      tab._zenAiRenameGen = (tab._zenAiRenameGen || 0) + 1;
      const requestGen = tab._zenAiRenameGen;

      const abort = new AbortController();
      tabState.set(tab, { originalLabel: title, abort });
      tab.classList.add(THINKING_CLASS);

      let shortLabel;
      try {
        shortLabel = await getRewrittenTitle({
          title,
          url,
          signal: abort.signal,
        });
      } finally {
        if (requestGen === tab._zenAiRenameGen) {
          tab.classList.remove(THINKING_CLASS);
        }
      }

      if (requestGen !== tab._zenAiRenameGen) return;
      if (!shortLabel || abort.signal.aborted || !tab.pinned || tab.closing) {
        tabState.delete(tab);
        return;
      }

      applyTabLabel(tab, shortLabel);
      tab.setAttribute(DATA_ATTR, "true");
      bindAiRenameHover(tab);
      playRenameSparkle(tab);
      scheduleAiRenameConfirmation(tab);
      debugLog("Renamed pinned tab:", shortLabel, tab);
    }

    /**
     * @param {import("chrome").BrowserTab} tab
     */
    function scheduleRename(tab) {
      const prev = pendingPinTimers.get(tab);
      if (prev) clearTimeout(prev);

      const t = setTimeout(() => {
        pendingPinTimers.delete(tab);
        void runRenameForTab(tab);
      }, 450);
      pendingPinTimers.set(tab, t);
    }

    /**
     * True during browser startup / session restore. We ignore `TabPinned`
     * events while this is set because Firefox replays them when restoring
     * pinned tabs.
     */
    let startupSuppressPin = true;

    /**
     * @param {import("chrome").BrowserTab} tab
     */
    function onTabPinned(tab) {
      if (!tab) return;
      if (startupSuppressPin) {
        markSkip(tab);
        debugLog("Startup TabPinned ignored (restore)", tab);
        return;
      }
      scheduleRename(tab);
    }

    /**
     * @param {import("chrome").BrowserTab} tab
     */
    function onTabUnpinned(tab) {
      if (!tab) return;
      const p = pendingPinTimers.get(tab);
      if (p) clearTimeout(p);
      pendingPinTimers.delete(tab);
      clearConfirmAiRenameTimer(tab);
      const st = tabState.get(tab);
      st?.abort?.abort();
      tabState.delete(tab);
      tab._zenAiRenameGen = (tab._zenAiRenameGen || 0) + 1;
      tab.classList.remove(THINKING_CLASS);
      unbindAiRenameHover(tab);
      tab.removeAttribute(DATA_ATTR);
      /* Fresh pin next time should be eligible for AI rename again. */
      tab.removeAttribute(SKIP_ATTR);
    }

    /**
     * @param {MouseEvent} event
     */
    function onDocumentClickCapture(event) {
      if (event.button !== 0) return;
      const mod = getPref(REVERT_MODIFIER_PREF, "shift");
      if (!modifierActive(event, mod)) return;

      const icon = event.target?.closest?.(".tab-icon-image");
      if (!icon) return;

      const tab = event.target?.closest?.("tab");
      if (!isBrowserTab(gBrowser, tab)) return;
      if (!tab.pinned || !tab.hasAttribute(DATA_ATTR)) return;
      if (event.target.closest(".tab-reset-pin-button, .tab-icon-overlay, .tab-audio-button")) return;

      const state = tabState.get(tab);
      if (!state?.originalLabel) return;

      event.stopPropagation();
      event.preventDefault();

      clearConfirmAiRenameTimer(tab);

      tab.classList.add(REVERT_PULSE_CLASS);
      win.requestAnimationFrame(() => {
        unbindAiRenameHover(tab);
        applyTabLabel(tab, state.originalLabel, { revert: true });
        /* Reverted: don’t auto-rename again until user unpins and re-pins. */
        tab.setAttribute(SKIP_ATTR, "true");
        tab.removeAttribute(DATA_ATTR);
        tabState.delete(tab);
        debugLog("Reverted title for tab", tab);
        win.setTimeout(() => tab.classList.remove(REVERT_PULSE_CLASS), 220);
      });
    }

    /** Mark tab so TabPinned events on it are ignored (restore or already pinned). */
    function markSkip(tab) {
      if (tab && isBrowserTab(gBrowser, tab)) tab.setAttribute(SKIP_ATTR, "true");
    }

    /** Any pin that exists when the script starts is a restore, not a fresh pin. */
    for (const tab of gBrowser.tabs || []) {
      if (tab.pinned) markSkip(tab);
    }

    /**
     * Mark restoring tabs so even post-startup late restores don’t rename.
     */
    win.addEventListener(
      "SSTabRestoring",
      (ev) => {
        const tab = ev.target;
        if (!isBrowserTab(gBrowser, tab)) return;
        if (tab.pinned) markSkip(tab);
      },
      true
    );

    /**
     * Release the startup gate once session restore finishes.
     * Listens to Services observer topics as the primary signal, with a
     * timeout fallback in case they never fire (e.g. fresh profile).
     */
    (function waitForRestoreComplete() {
      const TOPICS = ["sessionstore-windows-restored", "sessionstore-browser-state-restored"];
      let released = false;
      const release = (reason) => {
        if (released) return;
        released = true;
        startupSuppressPin = false;
        for (const t of TOPICS) {
          try {
            Services.obs.removeObserver(obs, t);
          } catch (_) {}
        }
        debugLog(`Startup gate released: ${reason}`);
      };
      const obs = { observe: (_s, topic) => release(topic) };
      try {
        for (const t of TOPICS) Services.obs.addObserver(obs, t);
      } catch (e) {
        debugLog("Observer registration failed:", e);
      }
      win.setTimeout(() => release("timeout"), 8000);
    })();

    win.addEventListener("TabPinned", (ev) => {
      const tab = ev.target;
      if (isBrowserTab(gBrowser, tab)) onTabPinned(tab);
    });

    win.addEventListener("TabUnpinned", (ev) => {
      const tab = ev.target;
      if (isBrowserTab(gBrowser, tab)) onTabUnpinned(tab);
    });

    win.addEventListener("click", onDocumentClickCapture, true);

    win.addEventListener(
      "beforeunload",
      () => {
        win.removeEventListener("click", onDocumentClickCapture, true);
      },
      { once: true }
    );
  }

  window.zenRenamePinnedTabsHooks = { init };
})();
