// DOM discovery probes for chatbridge providers. Loaded into every page by
// Playwright MCP (--init-script). Installs window.__cbProbe and nothing else.
// Reads page structure only: no credentials, no stored browser data, and text
// is reported as a length plus its first 40 characters.
(() => {
  if (window.__cbProbe) return;

  // ---- helpers ----------------------------------------------------------

  const HEAD = 40;
  const MAX_EVENTS = 2000;

  const text = (s) => {
    const t = (s ?? "").replace(/\s+/g, " ").trim();
    return { length: t.length, head: t.slice(0, HEAD) };
  };

  /** Hash-like values change between builds; they are not locator material. */
  const generated = (value) => {
    if (/^css-[a-z0-9]+$/i.test(value) || /^sc-/.test(value)) return true;
    if (/^:r[0-9a-z]+:$/i.test(value)) return true;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(value)) return true;
    const hex = /[0-9a-f]{8,}/i.exec(value);
    return !!hex && /\d/.test(hex[0]) && /[a-f]/i.test(hex[0]);
  };

  const visible = (el) => {
    if (!(el instanceof Element)) return false;
    if (
      typeof el.checkVisibility === "function" &&
      !el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })
    )
      return false;
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  };

  const q = (v) => `"${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const count = (sel) => {
    try {
      return document.querySelectorAll(sel).length;
    } catch {
      return -1;
    }
  };

  /** A readable, not necessarily unique, sketch of an element: its tag plus
   * the names of its structural attributes. */
  const shape = (el) => {
    const names = Array.from(el.attributes)
      .map((a) => a.name)
      .filter((n) => n.startsWith("data-") || n === "role")
      .sort();
    return el.tagName.toLowerCase() + names.map((n) => `[${n}]`).join("");
  };

  /** How good a data-* attribute is at naming one element: a test id first,
   * then an identity attribute, then anything else. */
  const dataRank = (name) => {
    if (name === "data-testid" || name === "data-test-id") return 0;
    if (/(^|-)ids?$/.test(name)) return 1;
    return 2;
  };

  /** Attribute-based selectors for one element, best first, uniqueness not
   * checked. `unstable` collects what was rejected and why. */
  const selectorsOf = (el, unstable = []) => {
    const tag = el.tagName.toLowerCase();
    const out = [];
    const data = Array.from(el.attributes)
      .filter((a) => a.name.startsWith("data-"))
      .sort((a, b) => dataRank(a.name) - dataRank(b.name));
    for (const a of data) {
      if (a.value === "" || a.value.length > 60) continue;
      if (generated(a.value)) {
        unstable.push(`${a.name}: generated value`);
        continue;
      }
      out.push(`[${a.name}=${q(a.value)}]`);
    }
    if (el.id) {
      if (generated(el.id)) unstable.push("id: generated value");
      else out.push(`#${CSS.escape(el.id)}`);
    }
    const role = el.getAttribute("role");
    const label = el.getAttribute("aria-label");
    if (role && label) out.push(`[role=${q(role)}][aria-label=${q(label)}]`);
    if (label) out.push(`${tag}[aria-label=${q(label)}]`);
    for (const name of ["name", "placeholder", "title"]) {
      const v = el.getAttribute(name);
      if (v) out.push(`${tag}[${name}=${q(v)}]`);
    }
    if (el.getAttribute("contenteditable") === "true")
      out.push(`${tag}[contenteditable="true"]`);
    if (role) out.push(`[role=${q(role)}]`, `${tag}[role=${q(role)}]`);
    if (el.classList.length > 0)
      unstable.push("class: never used as a locator");
    return out;
  };

  /** Unique locators: own attributes first, then scoped under the nearest
   * ancestor that has a unique locator of its own. */
  const locatorsOf = (el, unstable = []) => {
    const own = selectorsOf(el, unstable);
    const unique = own.filter((s) => count(s) === 1);
    if (unique.length > 0) return unique;
    const tag = el.tagName.toLowerCase();
    for (
      let a = el.parentElement;
      a && a !== document.body;
      a = a.parentElement
    ) {
      const anchor = selectorsOf(a).find((s) => count(s) === 1);
      if (!anchor) continue;
      const scoped = [
        ...own.map((s) => `${anchor} ${s}`),
        `${anchor} ${tag}`,
        `${anchor} > ${tag}`,
      ].filter((s) => count(s) === 1);
      if (scoped.length > 0) return scoped;
    }
    return [];
  };

  /** One readable handle for an element in event logs; may not be unique. */
  const describeEl = (el) => {
    if (!(el instanceof Element)) return "(text)";
    return locatorsOf(el)[0] ?? selectorsOf(el)[0] ?? shape(el);
  };

  const name = (el) =>
    el.getAttribute("aria-label") ||
    el.getAttribute("title") ||
    el.textContent ||
    "";

  const candidate = (el) => {
    const unstable = [];
    const locators = locatorsOf(el, unstable);
    const c = {
      locators,
      tag: el.tagName.toLowerCase(),
      visible: visible(el),
      unstable: Array.from(new Set(unstable)),
    };
    const role = el.getAttribute("role");
    const label = el.getAttribute("aria-label");
    if (role) c.role = role;
    if (label) c.ariaLabel = label;
    const t = text(el.textContent);
    if (t.length > 0) c.text = t;
    return c;
  };

  const ACCOUNT =
    /account|profile|avatar|user|アカウント|プロフィール|ユーザー/i;
  const SIGN_IN = /log ?in|sign ?in|sign ?up|ログイン|サインイン|新規登録/i;
  const STATE_ATTR =
    /^(aria-busy|data-(.*-)?(state|status|streaming|loading|generating))$/;

  const hints = (el) =>
    [name(el), el.getAttribute("data-testid"), el.id, el.getAttribute("href")]
      .filter(Boolean)
      .join(" ");

  // ---- census -----------------------------------------------------------

  function census() {
    const all = (sel) => Array.from(document.querySelectorAll(sel));
    const clickable = all('button, [role="button"], a[href]');
    const signInEls = clickable.filter((el) => SIGN_IN.test(hints(el)));
    const accountEls = clickable.filter(
      (el) => !signInEls.includes(el) && ACCOUNT.test(hints(el)),
    );

    const messageLists = [];
    for (const el of all("body *")) {
      const live =
        el.getAttribute("role") === "log" || el.hasAttribute("aria-live");
      if (el.children.length < (live ? 1 : 2)) continue;
      const shapes = new Map();
      for (const child of el.children) {
        const s = shape(child);
        shapes.set(s, (shapes.get(s) ?? 0) + 1);
      }
      const [childShape, n] = Array.from(shapes).sort((a, b) => b[1] - a[1])[0];
      if (!live && (n < 2 || !childShape.includes("["))) continue;
      messageLists.push({
        locator: describeEl(el),
        children: el.children.length,
        childShape,
      });
    }
    messageLists.sort((a, b) => b.children - a.children);

    const stateAttrs = [];
    const dataAttrCensus = {};
    for (const el of all("body *")) {
      for (const a of el.attributes) {
        if (a.name.startsWith("data-"))
          dataAttrCensus[a.name] = (dataAttrCensus[a.name] ?? 0) + 1;
        if (STATE_ATTR.test(a.name))
          stateAttrs.push({
            locator: describeEl(el),
            attr: a.name,
            value: a.value,
          });
      }
    }

    return {
      url: location.origin + location.pathname,
      title: document.title,
      lang: document.documentElement.lang || "",
      composer: all(
        'textarea, [contenteditable="true"], [contenteditable=""], [role="textbox"]',
      ).map(candidate),
      buttons: all('button, [role="button"]')
        .filter(
          (el) =>
            name(el).trim() !== "" ||
            Array.from(el.attributes).some((a) => a.name.startsWith("data-")),
        )
        .map(candidate),
      account: accountEls.map(candidate),
      signIn: signInEls.map(candidate),
      messageLists: messageLists.slice(0, 10),
      stateAttrs: stateAttrs.slice(0, 50),
      dataAttrCensus,
    };
  }

  // ---- recordTurn -------------------------------------------------------

  let rec = null;
  let lastStreaming = null;

  const isButton = (el) =>
    el instanceof Element && el.matches('button, [role="button"]');
  const buttonsIn = (node) =>
    node instanceof Element
      ? [
          ...(isButton(node) ? [node] : []),
          ...node.querySelectorAll('button, [role="button"]'),
        ]
      : [];

  function start() {
    if (rec) rec.observer.disconnect();
    const t0 = performance.now();
    const state = {
      t0,
      added: [],
      attrs: [],
      swaps: [],
      growth: new Map(),
      addedNodes: new Map(),
      events: 0,
      truncated: false,
    };
    const now = () => Math.round(performance.now() - t0);
    const room = () => {
      if (state.events >= MAX_EVENTS) {
        state.truncated = true;
        return false;
      }
      state.events++;
      return true;
    };
    /** The outermost element added during this turn that contains `node`. */
    const growthRoot = (node) => {
      let root = null;
      for (
        let el = node instanceof Element ? node : node.parentElement;
        el;
        el = el.parentElement
      )
        if (state.addedNodes.has(el)) root = el;
      return root;
    };
    const grow = (node) => {
      const root = growthRoot(node);
      if (!root) return;
      const g = state.growth.get(root) ?? {
        firstAt: now(),
        lastAt: 0,
        updates: 0,
      };
      g.lastAt = now();
      g.updates++;
      state.growth.set(root, g);
    };

    state.observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === "characterData") {
          grow(m.target);
          continue;
        }
        if (m.type === "attributes") {
          const el = m.target;
          const to = el.getAttribute(m.attributeName);
          if (
            isButton(el) &&
            /^(aria-label|data-testid|disabled|hidden)$/.test(m.attributeName)
          ) {
            if (room())
              state.swaps.push({
                t: now(),
                changed: `${describeEl(el)} ${m.attributeName}: ${m.oldValue} → ${to}`,
              });
          }
          if (m.attributeName === "class" || m.attributeName === "style")
            continue;
          if (room())
            state.attrs.push({
              t: now(),
              locator: describeEl(el),
              attr: m.attributeName,
              from: m.oldValue,
              to,
            });
          continue;
        }
        // childList
        const insideAdded =
          growthRoot(m.target) !== null || state.addedNodes.has(m.target);
        if (insideAdded) grow(m.target);
        for (const node of m.addedNodes) {
          if (!(node instanceof Element)) continue;
          for (const b of buttonsIn(node))
            if (!insideAdded && room())
              state.swaps.push({ t: now(), appeared: describeEl(b) });
          if (insideAdded) continue;
          const entry = {
            t: now(),
            locator: describeEl(node),
            shape: shape(node),
          };
          // A control that comes and goes is a button swap, not a turn.
          if (isButton(node)) entry.isControl = true;
          state.addedNodes.set(node, entry);
          if (room()) state.added.push(entry);
        }
        for (const node of m.removedNodes) {
          if (!(node instanceof Element)) continue;
          for (const b of buttonsIn(node)) {
            // Detached: uniqueness cannot be checked any more.
            if (!insideAdded && room())
              state.swaps.push({
                t: now(),
                gone: selectorsOf(b)[0] ?? shape(b),
              });
          }
          const entry = state.addedNodes.get(node);
          if (entry) {
            entry.removedAt = now();
            entry.locator = selectorsOf(node)[0] ?? entry.locator;
          }
        }
      }
    });
    state.observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeOldValue: true,
      characterData: true,
    });
    rec = state;
    return "recording";
  }

  function stop() {
    if (!rec)
      return { error: "recordTurn.start() was not called on this page" };
    const state = rec;
    rec = null;
    state.observer.disconnect();
    const durationMs = Math.round(performance.now() - state.t0);

    const textGrowth = Array.from(state.growth, ([el, g]) => ({
      locator: describeEl(el),
      firstAt: g.firstAt,
      lastAt: g.lastAt,
      updates: g.updates,
      finalLength: (el.textContent ?? "").length,
    }))
      .filter((g) => g.updates >= 2)
      .sort((a, b) => b.updates - a.updates);

    const streaming = textGrowth[0];
    lastStreaming = streaming
      ? (Array.from(state.growth.keys()).find(
          (el) => describeEl(el) === streaming.locator,
        ) ?? null)
      : null;

    const placeholderTurns = state.added
      .filter((a) => a.removedAt !== undefined && !a.isControl)
      .map(
        (a) =>
          `${a.locator} (${a.shape}) added @${a.t}ms, removed @${a.removedAt}ms`,
      );

    // Last event per distinct signal; keep those at or after the last text update.
    const last = new Map();
    for (const a of state.attrs)
      if (
        STATE_ATTR.test(a.attr) ||
        a.attr === "disabled" ||
        a.attr === "aria-disabled"
      )
        last.set(`attr ${a.locator} ${a.attr}`, {
          t: a.t,
          line: `attribute ${a.attr} on ${a.locator}: ${a.from} → ${a.to} @${a.t}ms`,
        });
    for (const s of state.swaps) {
      const what = s.gone
        ? `button gone: ${s.gone}`
        : s.appeared
          ? `button appeared: ${s.appeared}`
          : `button changed: ${s.changed}`;
      last.set(what, { t: s.t, line: `${what} @${s.t}ms` });
    }
    const floor = streaming ? streaming.lastAt - 100 : 0;
    const doneCandidates = Array.from(last.values())
      .filter((e) => e.t >= floor)
      .sort((a, b) => b.t - a.t)
      .slice(0, 8)
      .map((e) => e.line);

    const result = {
      durationMs,
      added: state.added,
      attrs: state.attrs,
      textGrowth,
      buttonsSwapped: state.swaps,
      summary: { placeholderTurns, doneCandidates },
    };
    if (streaming) result.summary.streamingElement = streaming.locator;
    if (state.truncated) result.truncated = true;
    return result;
  }

  // ---- replyShape -------------------------------------------------------

  const CONTENT = "p, pre, ul, ol, table, blockquote, h1, h2, h3, h4, h5, h6";

  function replyShape(selector) {
    let root = selector ? document.querySelector(selector) : lastStreaming;
    if (!root || !root.isConnected) {
      const list = census().messageLists[0];
      const container = list && document.querySelector(list.locator);
      root = container?.lastElementChild ?? null;
    }
    if (!root)
      return {
        error:
          "no reply element: pass its selector, or run recordTurn across one turn first",
      };

    const tagCensus = {};
    for (const el of root.querySelectorAll("*")) {
      const tag = el.tagName.toLowerCase();
      tagCensus[tag] = (tagCensus[tag] ?? 0) + 1;
    }

    const chromeEls = new Map();
    const mark = (el, kind) => {
      if (!chromeEls.has(el)) chromeEls.set(el, kind);
    };
    for (const el of root.querySelectorAll('[role="toolbar"]'))
      mark(el, "toolbar");
    for (const el of root.querySelectorAll("details")) mark(el, "collapsible");
    for (const el of root.querySelectorAll('[aria-hidden="true"]'))
      mark(el, "hidden");
    for (const pre of root.querySelectorAll("pre")) {
      // A header is a sibling of <pre> inside a wrapper that holds nothing else
      // of substance.
      for (const sib of pre.parentElement?.children ?? [])
        if (
          sib !== pre &&
          !sib.matches(CONTENT) &&
          (sib.textContent ?? "").trim().length <= 40
        )
          mark(sib, "code-header");
    }
    for (const el of root.querySelectorAll('button, [role="button"]')) {
      if (![...chromeEls.keys()].some((c) => c.contains(el)))
        mark(el, "button");
    }
    const inChrome = (el) =>
      [...chromeEls.keys()].some((c) => c !== el && c.contains(el)) ||
      chromeEls.has(el);

    const blocks = Array.from(root.querySelectorAll(CONTENT)).filter(
      (el) => !inChrome(el),
    );
    let contentRootEl = blocks[0] ?? null;
    for (const b of blocks)
      while (contentRootEl && !contentRootEl.contains(b))
        contentRootEl = contentRootEl.parentElement;
    if (contentRootEl && blocks.length === 1)
      contentRootEl = contentRootEl.parentElement;
    if (contentRootEl && !root.contains(contentRootEl)) contentRootEl = root;

    let codeLanguage = "no-code-block";
    const pres = Array.from(root.querySelectorAll("pre"));
    if (pres.length > 0) {
      const byClass = pres.some((pre) =>
        [pre, pre.querySelector("code")].some((n) =>
          Array.from(n?.classList ?? []).some((c) =>
            /^(language|lang)-/.test(c),
          ),
        ),
      );
      const byHeader = [...chromeEls].some(
        ([el, kind]) =>
          kind === "code-header" && (el.textContent ?? "").trim() !== "",
      );
      codeLanguage = byClass ? "class" : byHeader ? "header-label" : "none";
    }

    const chrome = Array.from(chromeEls, ([el, kind]) => ({
      locator: describeEl(el),
      kind,
    }));
    return {
      root: describeEl(root),
      tagCensus,
      chrome,
      codeLanguage,
      contentRoot: contentRootEl ? describeEl(contentRootEl) : null,
      chromeInsideContent: contentRootEl
        ? Array.from(chromeEls)
            .filter(([el]) => contentRootEl.contains(el))
            .map(([el, kind]) => `${kind}: ${describeEl(el)}`)
        : [],
    };
  }

  // ---- verify -----------------------------------------------------------

  function verify(selectors) {
    const out = {};
    for (const [key, value] of Object.entries(selectors ?? {})) {
      const many =
        typeof value === "object" && value !== null && value.many === true;
      const selector = typeof value === "string" ? value : value?.selector;
      try {
        const els = Array.from(document.querySelectorAll(selector));
        const visibleCount = els.filter(visible).length;
        out[key] = {
          count: els.length,
          visibleCount,
          ok: many ? els.length >= 1 : els.length === 1,
        };
      } catch {
        out[key] = {
          count: 0,
          visibleCount: 0,
          ok: false,
          error: `invalid selector: ${selector}`,
        };
      }
    }
    return out;
  }

  window.__cbProbe = {
    census,
    recordTurn: { start, stop },
    replyShape,
    verify,
  };
})();
