// Sample third-party embed provider — "widgets". Vanilla JS, no build step.
//
// A second ES-module bundle alongside playlists.js, to show two independent
// providers coexisting on the registry. Renders either a coloured *badge* or a
// *gauge*, and demonstrates leak discipline: the secret "bat-signal" widget
// 404s for everyone but its owner, so a viewer who can't see it gets the
// same "not found" treatment as a widget that truly doesn't exist.

const PREFIX = "/-/sample-embeds/widgets/";

export default {
  kind: "widget",

  matchRef(ref) {
    return ref.indexOf(PREFIX) === 0;
  },

  matchUrl(url) {
    return url.pathname.indexOf(PREFIX) === 0 ? url.pathname : null;
  },

  resolve(ref) {
    return fetch(ref + ".json", { headers: { accept: "application/json" } })
      .then(function (res) {
        if (res.status === 403) return { status: "denied" };
        if (!res.ok) return { status: "not_found" };
        return res.json().then(function (w) {
          return { status: "ok", kind: "widget", label: w.title, href: ref };
        });
      })
      .catch(function () {
        return null;
      });
  },

  mount(host, ctx) {
    let cancelled = false;
    fetch(ctx.ref + ".json", { headers: { accept: "application/json" } })
      .then(function (res) {
        if (cancelled) return;
        if (!res.ok) {
          // 403 and 404 both render the same "unavailable" body — for a
          // secret widget the server already collapsed denied → 404.
          renderMessage(host, "This widget isn't available to you.");
          return;
        }
        res.json().then(function (w) {
          if (!cancelled) renderWidget(host, w);
        });
      })
      .catch(function () {
        if (!cancelled) renderMessage(host, "Couldn't load this widget.");
      });
    return function () {
      cancelled = true;
    };
  },

  picker() {
    return { id: "widget", label: "Widgets", icon: "table" };
  },

  search(q, limit) {
    return fetch("/-/sample-embeds/widgets.json?q=" + encodeURIComponent(q))
      .then(function (res) {
        return res.ok ? res.json() : { results: [] };
      })
      .then(function (j) {
        return (j.results || []).slice(0, limit);
      })
      .catch(function () {
        return [];
      });
  },
};

// --- rendering ------------------------------------------------------------
function renderWidget(host, w) {
  host.replaceChildren();
  injectStylesOnce();
  if (w.type === "badge") {
    const wrap = document.createElement("div");
    wrap.className = "sample-widget-badge-wrap";
    const badge = document.createElement("span");
    badge.className = "sample-widget-badge";
    badge.style.background = w.color || "#374151";
    badge.textContent = w.holder || w.title;
    wrap.appendChild(badge);
    host.appendChild(wrap);
    return;
  }
  // gauge
  const wrap = document.createElement("div");
  wrap.className = "sample-widget-gauge";
  const label = document.createElement("div");
  label.className = "sample-widget-gauge-label";
  const v = Math.max(0, Math.min(100, Number(w.value) || 0));
  // The card header already shows the widget title; the body just states the
  // metric value (no redundant title).
  label.textContent = v + "%";
  const track = document.createElement("div");
  track.className = "sample-widget-gauge-track";
  const fill = document.createElement("div");
  fill.className = "sample-widget-gauge-fill";
  fill.style.width = v + "%";
  track.appendChild(fill);
  wrap.appendChild(label);
  wrap.appendChild(track);
  host.appendChild(wrap);
}

function renderMessage(host, msg) {
  host.replaceChildren();
  injectStylesOnce();
  const p = document.createElement("div");
  p.className = "sample-widget-msg";
  p.textContent = msg;
  host.appendChild(p);
}

function injectStylesOnce() {
  if (document.getElementById("sample-widget-styles")) return;
  const s = document.createElement("style");
  s.id = "sample-widget-styles";
  s.textContent =
    ".sample-widget-badge-wrap{padding:10px}" +
    ".sample-widget-badge{display:inline-block;padding:5px 12px;border-radius:999px;" +
    "color:#fff;font-size:13px;font-weight:600;letter-spacing:.02em}" +
    ".sample-widget-gauge{display:flex;flex-direction:column;gap:6px;padding:10px}" +
    ".sample-widget-gauge-label{font-size:13px;color:#333;font-weight:600;font-variant-numeric:tabular-nums}" +
    ".sample-widget-gauge-track{background:#eef1f5;border-radius:999px;height:10px;overflow:hidden}" +
    ".sample-widget-gauge-fill{height:100%;background:#059669;border-radius:999px}" +
    ".sample-widget-msg{color:#9a3412;font-size:13px;padding:10px}";
  document.head.appendChild(s);
}
