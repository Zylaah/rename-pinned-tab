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
      const st = tabState.get(tab);
      st?.abort?.abort();
      tabState.delete(tab);
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

      tab.classList.add(REVERT_PULSE_CLASS);
      win.requestAnimationFrame(() => {
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
