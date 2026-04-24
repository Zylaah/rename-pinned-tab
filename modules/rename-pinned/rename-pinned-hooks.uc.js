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
  const SPARKLE_CLASS = "zen-ai-rename-sparkle";
  /** After this, the short title is final: no revert UI or modifier+click undo. */
  const AI_RENAME_CONFIRM_MS = 5000;

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

    /** @type {import("chrome").BrowserTab | null} */
    let hoveredAiRenameTab = null;

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

    /** @param {Event} e */
    function onGlobalKeyForSublabel(e) {
      const tab = hoveredAiRenameTab;
      if (!tab?.hasAttribute?.(DATA_ATTR)) return;
      tab._zenAiRenameRefreshSublabel?.(e);
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

      tab._zenAiRenameMouseEnter = () => {
        hoveredAiRenameTab = tab;
        tab.setAttribute("zen-show-sublabel", "true");
        refresh({ shiftKey: false, altKey: false, metaKey: false });
        win.addEventListener("keydown", onGlobalKeyForSublabel, true);
        win.addEventListener("keyup", onGlobalKeyForSublabel, true);
      };
      tab._zenAiRenameMouseLeave = () => {
        if (hoveredAiRenameTab === tab) hoveredAiRenameTab = null;
        tab.removeAttribute("zen-show-sublabel");
        win.removeEventListener("keydown", onGlobalKeyForSublabel, true);
        win.removeEventListener("keyup", onGlobalKeyForSublabel, true);
      };
      tab._zenAiRenameMouseMove = (e) => refresh(e);

      tab.addEventListener("mouseenter", tab._zenAiRenameMouseEnter);
      tab.addEventListener("mouseleave", tab._zenAiRenameMouseLeave);
      tab.addEventListener("mousemove", tab._zenAiRenameMouseMove);
    }

    function unbindAiRenameHover(tab) {
      if (!tab._zenAiRenameHoverBound) return;
      tab._zenAiRenameHoverBound = false;
      if (hoveredAiRenameTab === tab) hoveredAiRenameTab = null;
      tab.removeAttribute("zen-show-sublabel");
      win.removeEventListener("keydown", onGlobalKeyForSublabel, true);
      win.removeEventListener("keyup", onGlobalKeyForSublabel, true);
      tab.removeEventListener("mouseenter", tab._zenAiRenameMouseEnter);
      tab.removeEventListener("mouseleave", tab._zenAiRenameMouseLeave);
      tab.removeEventListener("mousemove", tab._zenAiRenameMouseMove);
      delete tab._zenAiRenameMouseEnter;
      delete tab._zenAiRenameMouseLeave;
      delete tab._zenAiRenameMouseMove;
      delete tab._zenAiRenameRefreshSublabel;
    }

    /**
     * Sprinkle animated sparkle particles over the tab label.
     * Creates a short-lived layer of star-shaped spans with randomized
     * positions, sizes, colors, and delays. Auto-cleans after the animation.
     * @param {Element} tab
     */
    function playRenameSparkle(tab) {
      const container = tab.querySelector(".tab-label-container");
      if (!container) return;

      const prev = tab._zenAiSparkleLayer;
      if (prev?.isConnected) prev.remove();

      tab.classList.remove(SPARKLE_CLASS);
      tab.classList.add(SPARKLE_CLASS);

      const layer = document.createElement("div");
      layer.className = "zen-ai-rename-sparkle-layer";
      container.appendChild(layer);
      tab._zenAiSparkleLayer = layer;

      const rect = container.getBoundingClientRect();
      const width = Math.max(60, rect.width || 120);
      const height = Math.max(14, rect.height || 18);

      const PALETTE = [
        "#fef3c7", // warm white
        "#fde68a", // amber
        "#fbcfe8", // pink
        "#c4b5fd", // violet
        "#a5f3fc", // cyan
        "#ffffff",
      ];

      const count = Math.min(16, Math.max(9, Math.round(width / 14)));
      const totalMs = 1400;

      for (let i = 0; i < count; i++) {
        const s = document.createElement("span");
        s.className = "zen-ai-sparkle";
        const size = 3 + Math.random() * 6; // 3–9px
        const xPct = (i / count) * 100 + (Math.random() * 8 - 4);
        const yPct = Math.random() * 100;
        const delay = Math.random() * 650; // staggered sprinkle
        const life = 650 + Math.random() * 350;
        const rot = Math.round(Math.random() * 360);
        const drift = Math.round(-6 + Math.random() * 12);
        const color = PALETTE[Math.floor(Math.random() * PALETTE.length)];

        s.style.setProperty("--sparkle-size", `${size.toFixed(2)}px`);
        s.style.setProperty("--sparkle-x", `${xPct.toFixed(2)}%`);
        s.style.setProperty("--sparkle-y", `${yPct.toFixed(2)}%`);
        s.style.setProperty("--sparkle-delay", `${Math.round(delay)}ms`);
        s.style.setProperty("--sparkle-life", `${Math.round(life)}ms`);
        s.style.setProperty("--sparkle-rot", `${rot}deg`);
        s.style.setProperty("--sparkle-drift", `${drift}px`);
        s.style.setProperty("--sparkle-color", color);
        layer.appendChild(s);
      }

      win.setTimeout(() => {
        tab.classList.remove(SPARKLE_CLASS);
        if (layer.isConnected) layer.remove();
        if (tab._zenAiSparkleLayer === layer) delete tab._zenAiSparkleLayer;
      }, totalMs);
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

      clearConfirmAiRenameTimer(tab);

      const existing = tabState.get(tab);
      existing?.abort?.abort();

      const abort = new AbortController();
      const title = getBrowserTabTitle(tab);
      let url = "";
      try {
        url = tab.linkedBrowser?.currentURI?.spec ?? "";
      } catch (_) {}

      if (!title) {
        debugLog("Skip rename: empty title", tab);
        return;
      }

      tabState.set(tab, { originalLabel: title, abort });

      const shortLabel = await getRewrittenTitle({
        title,
        url,
        signal: abort.signal,
      });

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
     * @param {import("chrome").BrowserTab} tab
     */
    function onTabPinned(tab) {
      if (!tab) return;
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
      unbindAiRenameHover(tab);
      tab.removeAttribute(DATA_ATTR);
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
        tab.removeAttribute(DATA_ATTR);
        tabState.delete(tab);
        debugLog("Reverted title for tab", tab);
        win.setTimeout(() => tab.classList.remove(REVERT_PULSE_CLASS), 220);
      });
    }

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
