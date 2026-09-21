// DOM discovery probes for chatbridge providers. Loaded into every page by
// Playwright MCP (--init-script). Installs window.__cbProbe and nothing else.
// Reads page structure only: no credentials, no stored browser data, and text
// is reported as a length plus its first 40 characters.
(() => {
  if (window.__cbProbe) return;

  // ---- helpers ----------------------------------------------------------

  const HEAD = 40;
  const ATTR_CAP = 60;
  const MAX_EVENTS = 2000;
  const MAX_LISTS = 10;
  const MAX_STATE_ATTRS = 50;

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

  /** Attribute values longer than this are page content, not structure. */
  const short = (v) =>
    typeof v === "string" && v !== "" && v.length <= ATTR_CAP;
  const cut = (v) =>
    typeof v === "string" && v.length > ATTR_CAP
      ? `${v.slice(0, ATTR_CAP)}…`
      : v;

  const visible = (el) => {
    if (!(el instanceof Element)) return false;
    if (
      typeof el.checkVisibility === "function" &&
      !el.checkVisibility({ visibilityProperty: true })
    )
      return false;
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  };

  const q = (v) => `"${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

  /** Counting matches is the probe's hot path: one document query per
   * candidate selector. `cached()` makes a whole report cost each distinct
   * selector once; the cache never outlives one call, so it cannot go stale. */
  let countCache = null;
  const count = (sel) => {
    if (countCache?.has(sel)) return countCache.get(sel);
    let n;
    try {
      n = document.querySelectorAll(sel).length;
    } catch {
      n = -1;
    }
    countCache?.set(sel, n);
    return n;
  };
  const cached = (fn) => {
    const outer = countCache;
    countCache = new Map();
    try {
      return fn();
    } finally {
      countCache = outer;
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

  /** `data-message-id` names one turn; `data-turn` names every turn. */
  const identityAttr = (name) => /(^|-)ids?$/.test(name);

  /** How good a data-* attribute is at naming an element. A test id always
   * wins. After that the answer depends on the question: to point at one
   * element on this page, identity beats description; to write a selector into
   * a provider, description beats identity, because the identity is gone next
   * turn. */
  const dataRank = (name, identityFirst) => {
    if (name === "data-testid" || name === "data-test-id") return 0;
    return identityAttr(name) === !!identityFirst ? 1 : 2;
  };

  /** Attribute-based selectors for one element, best first, uniqueness not
   * checked. `unstable` collects what was rejected and why. */
  const selectorsOf = (el, unstable = [], identityFirst = false) => {
    const tag = el.tagName.toLowerCase();
    const out = [];
    const data = Array.from(el.attributes)
      .filter((a) => a.name.startsWith("data-"))
      .sort(
        (a, b) =>
          dataRank(a.name, identityFirst) - dataRank(b.name, identityFirst),
      );
    for (const a of data) {
      if (!short(a.value)) continue;
      if (generated(a.value)) {
        unstable.push(`${a.name}: generated value`);
        continue;
      }
      out.push(`[${a.name}=${q(a.value)}]`);
    }
    if (el.id) {
      if (generated(el.id)) unstable.push("id: generated value");
      else if (short(el.id)) out.push(`#${CSS.escape(el.id)}`);
    }
    const role = el.getAttribute("role");
    const label = el.getAttribute("aria-label");
    const usableRole = short(role) ? role : null;
    const usableLabel = short(label) ? label : null;
    if (usableRole && usableLabel)
      out.push(`[role=${q(usableRole)}][aria-label=${q(usableLabel)}]`);
    if (usableLabel) out.push(`${tag}[aria-label=${q(usableLabel)}]`);
    for (const name of ["name", "placeholder", "title"]) {
      const v = el.getAttribute(name);
      if (short(v)) out.push(`${tag}[${name}=${q(v)}]`);
    }
    if (el.getAttribute("contenteditable") === "true")
      out.push(`${tag}[contenteditable="true"]`);
    if (usableRole)
      out.push(`[role=${q(usableRole)}]`, `${tag}[role=${q(usableRole)}]`);
    if (el.classList.length > 0)
      unstable.push("class: never used as a locator");
    return out;
  };

  /** Unique locators: own attributes first, then scoped under the nearest
   * ancestor that has a unique locator of its own. */
  const locatorsOf = (el, unstable = [], identityFirst = false) => {
    const own = selectorsOf(el, unstable, identityFirst);
    const unique = own.filter((s) => count(s) === 1);
    if (unique.length > 0) return unique;
    const tag = el.tagName.toLowerCase();
    for (
      let a = el.parentElement;
      a && a !== document.body;
      a = a.parentElement
    ) {
      const anchor = selectorsOf(a, [], identityFirst).find(
        (s) => count(s) === 1,
      );
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
  const describeEl = (el, identityFirst = false) => {
    if (!(el instanceof Element)) return "(text)";
    return (
      locatorsOf(el, [], identityFirst)[0] ??
      selectorsOf(el, [], identityFirst)[0] ??
      shape(el)
    );
  };

  /** A selector built from one element's own identity, such as `#id` or
   * `[data-message-id="m2"]`: right for this turn, wrong for the next one. */
  const identitySelector = (s) => {
    if (s.startsWith("#")) return true;
    const attr = /^\[([^\]=]+)=/.exec(s);
    return !!attr && identityAttr(attr[1]);
  };

  const NO_COLLECTION =
    "no stable attribute or anchor distinguishes this element; " +
    "pick an ancestor from census().messageLists";

  /** How many elements `selector` matches, or 0 unless every one of them is a
   * sibling of `el` — which is what "the same-shaped turns of this thread"
   * means. A selector that reaches outside that family is not one to keep. */
  const familyCount = (selector, el) => {
    let found;
    try {
      found = Array.from(document.querySelectorAll(selector));
    } catch {
      return 0;
    }
    if (found.length === 0) return 0;
    const parent = el.parentElement;
    return found.every((m) => m.parentElement === parent) ? found.length : 0;
  };

  /** A selector for the element's whole family: what it has in common with the
   * same element from every other turn. Identity attributes are left out on
   * purpose — this is the selector a provider keeps. Falls back to anchoring
   * the element under an ancestor, and reports failure rather than handing back
   * a bare tag, which would match hundreds of unrelated elements. */
  const collectionOf = (el) => {
    const tag = el.tagName.toLowerCase();
    const identities = new Set(
      Array.from(el.attributes)
        .filter((a) => identityAttr(a.name))
        .map((a) => a.value),
    );
    const parts = [];
    for (const a of el.attributes) {
      if (!a.name.startsWith("data-") || identityAttr(a.name)) continue;
      if (!short(a.value) || generated(a.value) || identities.has(a.value))
        continue;
      parts.push(`[${a.name}=${q(a.value)}]`);
    }
    if (parts.length > 0) {
      const selector = tag + parts.join("");
      return { selector, count: count(selector) };
    }
    // Nothing describes the element itself. A role alone only counts if it
    // stays inside the family; a tag alone never does.
    const role = el.getAttribute("role");
    if (short(role)) {
      const selector = `${tag}[role=${q(role)}]`;
      const n = familyCount(selector, el);
      if (n > 0) return { selector, count: n };
    }
    for (
      let a = el.parentElement;
      a && a !== document.body;
      a = a.parentElement
    ) {
      const anchor = selectorsOf(a).find(
        (s) => !identitySelector(s) && count(s) === 1,
      );
      if (!anchor) continue;
      const selector = `${anchor}${a === el.parentElement ? " > " : " "}${tag}`;
      const n = familyCount(selector, el);
      if (n > 0) return { selector, count: n };
    }
    return { selector: null, count: 0, note: NO_COLLECTION };
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

  const census = () => cached(censusUncached);

  function censusUncached() {
    const all = (sel) => Array.from(document.querySelectorAll(sel));
    const clickable = all('button, [role="button"], a[href]');
    const signInEls = clickable.filter((el) => SIGN_IN.test(hints(el)));
    const accountEls = clickable.filter(
      (el) => !signInEls.includes(el) && ACCOUNT.test(hints(el)),
    );

    // One pass over the document collecting element references and cheap
    // facts only. Locators cost a document query each, so they are computed
    // after the ranking and the slice, for the rows that are kept.
    const listRows = [];
    const stateRows = [];
    const dataAttrCensus = {};
    for (const el of all("body *")) {
      for (const a of el.attributes) {
        if (a.name.startsWith("data-"))
          dataAttrCensus[a.name] = (dataAttrCensus[a.name] ?? 0) + 1;
        if (STATE_ATTR.test(a.name))
          stateRows.push({ el, attr: a.name, value: cut(a.value) });
      }
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
      listRows.push({ el, children: el.children.length, childShape });
    }

    const messageLists = listRows
      .sort((a, b) => b.children - a.children)
      .slice(0, MAX_LISTS)
      .map((row) => ({
        locator: describeEl(row.el),
        children: row.children,
        childShape: row.childShape,
      }));
    const stateAttrs = stateRows.slice(0, MAX_STATE_ATTRS).map((row) => ({
      locator: describeEl(row.el),
      attr: row.attr,
      value: row.value,
    }));

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
      messageLists,
      stateAttrs,
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
    lastStreaming = null;
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

    // The callback runs inside the page's own work, so it stays cheap: it
    // keeps element references and raw values, and stop() turns them into
    // locators. Computing a locator here would mean a document query per
    // mutation, which would slow the page and skew the timings below.
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
                el,
                snap: selectorsOf(el, [], true)[0],
                attr: m.attributeName,
                from: cut(m.oldValue),
                to: cut(to),
              });
          }
          if (m.attributeName === "class" || m.attributeName === "style")
            continue;
          if (room())
            state.attrs.push({
              // The element may be gone by stop(); its own attributes are the
              // only honest handle left, and reading them costs no query.
              t: now(),
              el,
              snap: selectorsOf(el, [], true)[0],
              attr: m.attributeName,
              from: cut(m.oldValue),
              to: cut(to),
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
              state.swaps.push({ t: now(), el: b, appeared: true });
          if (insideAdded) continue;
          const entry = { t: now(), el: node, shape: shape(node) };
          // A control that comes and goes is a button swap, not a turn.
          if (isButton(node)) entry.isControl = true;
          state.addedNodes.set(node, entry);
          if (room()) state.added.push(entry);
        }
        for (const node of m.removedNodes) {
          if (!(node instanceof Element)) continue;
          for (const b of buttonsIn(node)) {
            // Detached: uniqueness cannot be checked any more, so the
            // attribute-only selector is taken now, while the node still has
            // its attributes. That costs no document query.
            if (!insideAdded && room())
              state.swaps.push({
                t: now(),
                gone: selectorsOf(b, [], true)[0] ?? shape(b),
              });
          }
          const entry = state.addedNodes.get(node);
          if (entry) {
            entry.removedAt = now();
            entry.goneLocator = selectorsOf(node, [], true)[0];
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
    return cached(() => report(state));
  }

  /** Turns the recorded references into locators. One place, one cache. */
  function report(state) {
    const durationMs = Math.round(performance.now() - state.t0);
    // An event names the element it happened to, so identity attributes lead.
    const at = (el) => describeEl(el, true);
    /** The locator of an element an event happened to: a live element can be
     * located in the page, a detached one only by what it carried at the time,
     * since any query would now find some other element instead. */
    const was = (e) => (e.el.isConnected ? at(e.el) : (e.snap ?? shape(e.el)));

    const grown = Array.from(state.growth, ([el, g]) => ({ el, ...g }))
      .filter((g) => g.updates >= 2)
      .sort((a, b) => b.updates - a.updates);
    lastStreaming = grown[0]?.el ?? null;
    const textGrowth = grown.map((g) => ({
      locator: at(g.el),
      collection: collectionOf(g.el),
      firstAt: g.firstAt,
      lastAt: g.lastAt,
      updates: g.updates,
      finalLength: (g.el.textContent ?? "").length,
    }));

    const added = state.added.map((a) => {
      const entry = {
        t: a.t,
        locator:
          a.removedAt === undefined ? at(a.el) : (a.goneLocator ?? at(a.el)),
        shape: a.shape,
      };
      if (a.isControl) entry.isControl = true;
      if (a.removedAt !== undefined) entry.removedAt = a.removedAt;
      return entry;
    });
    const attrs = state.attrs.map((a) => {
      const row = {
        t: a.t,
        locator: was(a),
        attr: a.attr,
        from: a.from,
        to: a.to,
      };
      if (!a.el.isConnected) row.detached = true;
      return row;
    });
    const buttonsSwapped = state.swaps.map((s) => {
      if (s.gone !== undefined) return { t: s.t, gone: s.gone };
      if (s.appeared) return { t: s.t, appeared: at(s.el) };
      return {
        t: s.t,
        changed: `${was(s)} ${s.attr}: ${s.from} → ${s.to}`,
      };
    });

    const streaming = textGrowth[0];
    const placeholderTurns = added
      .filter((a) => a.removedAt !== undefined && !a.isControl)
      .map(
        (a) =>
          `${a.locator} (${a.shape}) added @${a.t}ms, removed @${a.removedAt}ms`,
      );

    // Last event per distinct signal; keep those at or after the last text update.
    const last = new Map();
    for (const a of attrs)
      if (
        STATE_ATTR.test(a.attr) ||
        a.attr === "disabled" ||
        a.attr === "aria-disabled"
      )
        last.set(`attr ${a.locator} ${a.attr}`, {
          t: a.t,
          line: `attribute ${a.attr} on ${a.locator}: ${a.from} → ${a.to} @${a.t}ms`,
        });
    for (const s of buttonsSwapped) {
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
      added,
      attrs,
      textGrowth,
      buttonsSwapped,
      summary: { placeholderTurns, doneCandidates },
    };
    if (streaming) {
      // The instance that streamed, and the family a provider should select.
      result.summary.streamingElement = streaming.locator;
      result.summary.streamingCollection = streaming.collection;
    }
    if (state.truncated) result.truncated = true;
    return result;
  }

  // ---- replyShape -------------------------------------------------------

  const CONTENT = "p, pre, ul, ol, table, blockquote, h1, h2, h3, h4, h5, h6";

  /** A selector for `el` that is evaluated *inside* `root`, the way a provider
   * uses a body selector: locator(turn).last().locator(body).first(). The whole
   * point is that it carries no ancestor above the turn, so it keeps working on
   * every later turn. `""` means "the root itself"; `null` means there is no
   * such selector. Queries are scoped to `root`, so the count cache used for
   * document-wide uniqueness does not apply and is left alone. */
  const relativeTo = (root, el) => {
    if (!el || !root) return null;
    if (el === root) return "";
    if (!root.contains(el)) return null;
    const hit = (selector) => {
      try {
        return root.querySelector(selector) === el;
      } catch {
        return false;
      }
    };
    for (const s of selectorsOf(el)) if (hit(s)) return s;
    const tag = el.tagName.toLowerCase();
    const child = el.parentElement === root;
    const combinator = child ? ":scope > " : ":scope ";
    const role = el.getAttribute("role");
    if (short(role) && hit(`${combinator}${tag}[role=${q(role)}]`))
      return `${combinator}${tag}[role=${q(role)}]`;
    if (hit(`${combinator}${tag}`)) return `${combinator}${tag}`;
    return null;
  };

  const replyShape = (selector) => cached(() => replyShapeUncached(selector));

  function replyShapeUncached(selector) {
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
      contentRootWithin: relativeTo(root, contentRootEl),
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
      const object = typeof value === "object" && value !== null;
      const many = object && value.many === true;
      const within = object && value.within ? value.within : null;
      const selector = typeof value === "string" ? value : value?.selector;
      // A constant a VARIANT deliberately leaves empty is not a broken
      // selector; the caller knows which names that is allowed for.
      if (selector === "" || selector === undefined || selector === null) {
        out[key] = {
          count: 0,
          visibleCount: 0,
          ok: true,
          skipped: "empty — allowed only where a VARIANT says so",
        };
        continue;
      }
      try {
        // `within` reproduces how a provider uses a body selector:
        // page.locator(TURN).last().locator(BODY).first(). Scoping the query
        // to that last element is what makes a `:scope > …` form work here.
        let root = document;
        if (within) {
          const hosts = document.querySelectorAll(within);
          if (hosts.length === 0) {
            out[key] = {
              count: 0,
              visibleCount: 0,
              ok: false,
              error: `within matched nothing: ${within}`,
            };
            continue;
          }
          root = hosts[hosts.length - 1];
        }
        const els = Array.from(root.querySelectorAll(selector));
        const visibleCount = els.filter(visible).length;
        out[key] = {
          count: els.length,
          visibleCount,
          // A scoped selector is taken with .first(), so one match is enough.
          ok: many || within ? els.length >= 1 : els.length === 1,
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
