// Sample third-party embed provider — "playlists". Vanilla JS, no build step.
//
// datasette-paper loads this bundle on demand (when a doc uses a playlist
// embed, or the author picks "Playlists" from the / menu) by `import()`ing it
// as an ES module and registering its `export default` provider. The provider
// supplies the inline-pill identity (`resolve`) and the rich block body
// (`mount`). All data is fetched from this plugin's own JSON routes with the
// VIEWER's cookie, so per-viewer permissions + leak discipline are ours, not
// paper's.

const PREFIX = "/-/sample-embeds/playlists/";

// Raw inline-SVG (bootstrap-icons/music-note-list) for the pill + card header.
// Providers ship their own icon markup — paper renders it as-is (trusted plugin
// JS) and CSS clamps it to the chrome size.
const ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">' +
  '<path d="M12 13c0 1.105-1.12 2-2.5 2S7 14.105 7 13s1.12-2 2.5-2 2.5.895 2.5 2"/>' +
  '<path fill-rule="evenodd" d="M12 3v10h-1V3z"/>' +
  '<path d="M11 2.82a1 1 0 0 1 .804-.98l3-.6A1 1 0 0 1 16 2.22V4l-5 1z"/>' +
  '<path fill-rule="evenodd" d="M0 11.5a.5.5 0 0 1 .5-.5H4a.5.5 0 0 1 0 1H.5a.5.5 0 0 1-.5-.5m0-3a.5.5 0 0 1 .5-.5H8a.5.5 0 0 1 0 1H.5a.5.5 0 0 1-.5-.5m0-3a.5.5 0 0 1 .5-.5H8a.5.5 0 0 1 0 1H.5a.5.5 0 0 1-.5-.5m0-3A.5.5 0 0 1 .5 2H8a.5.5 0 0 1 0 1H.5a.5.5 0 0 1-.5-.5"/>' +
  "</svg>";

export default {
  kind: "playlist",

  matchRef(ref) {
    return ref.indexOf(PREFIX) === 0;
  },

  matchUrl(url) {
    return url.pathname.indexOf(PREFIX) === 0 ? url.pathname : null;
  },

  // Inline pill identity. Leak discipline: never a label on denied/not_found.
  resolve(ref) {
    return fetch(ref + ".json", { headers: { accept: "application/json" } })
      .then(function (res) {
        if (res.status === 403) return { status: "denied" };
        if (!res.ok) return { status: "not_found" };
        return res.json().then(function (pl) {
          // `icon` (raw SVG) overrides paper's generic kind icon.
          return {
            status: "ok",
            kind: "playlist",
            label: pl.title,
            href: ref,
            icon: ICON,
          };
        });
      })
      .catch(function () {
        return null; // transient → pill stays loading, retried later
      });
  },

  // Rich block body. Paper owns the header chrome; we fill `host`.
  mount(host, ctx) {
    let cancelled = false;
    fetch(ctx.ref + ".json", { headers: { accept: "application/json" } })
      .then(function (res) {
        if (cancelled) return;
        if (!res.ok) {
          renderMessage(
            host,
            res.status === 403
              ? "You don't have access to this playlist."
              : "Playlist not found.",
          );
          return;
        }
        res.json().then(function (pl) {
          if (!cancelled) renderPlaylist(host, pl);
        });
      })
      .catch(function () {
        if (!cancelled) renderMessage(host, "Couldn't load this playlist.");
      });
    return function () {
      cancelled = true;
    };
  },

  // Opt into the / menu as a browsable source.
  picker() {
    return { id: "playlist", label: "Playlists", icon: "database" };
  },

  // Viewer-filtered search for the picker dialog.
  search(q, limit) {
    return fetch("/-/sample-embeds/playlists.json?q=" + encodeURIComponent(q))
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

// --- rendering (text nodes only — never innerHTML with data) ---------------
function renderPlaylist(host, pl) {
  host.replaceChildren();
  let max = 1;
  pl.tracks.forEach(function (t) {
    if (t.plays > max) max = t.plays;
  });
  const list = document.createElement("div");
  list.className = "sample-playlist";
  pl.tracks.forEach(function (t) {
    const row = document.createElement("div");
    row.className = "sample-playlist-row";

    const name = document.createElement("span");
    name.className = "sample-playlist-track";
    name.textContent = t.title + " — " + t.artist;

    const barWrap = document.createElement("span");
    barWrap.className = "sample-playlist-barwrap";
    const bar = document.createElement("span");
    bar.className = "sample-playlist-bar";
    bar.style.width = Math.round((t.plays / max) * 100) + "%";
    barWrap.appendChild(bar);

    const plays = document.createElement("span");
    plays.className = "sample-playlist-plays";
    plays.textContent = t.plays.toLocaleString() + " plays";

    row.appendChild(name);
    row.appendChild(barWrap);
    row.appendChild(plays);
    list.appendChild(row);
  });
  host.appendChild(list);
  injectStylesOnce();
}

function renderMessage(host, msg) {
  host.replaceChildren();
  const p = document.createElement("div");
  p.className = "sample-playlist-msg";
  p.textContent = msg;
  host.appendChild(p);
  injectStylesOnce();
}

function injectStylesOnce() {
  if (document.getElementById("sample-playlist-styles")) return;
  const s = document.createElement("style");
  s.id = "sample-playlist-styles";
  s.textContent =
    ".sample-playlist{display:flex;flex-direction:column;gap:7px;padding:10px}" +
    // Fixed track widths (not `auto`) so every row shares the same columns —
    // otherwise a wider "1,840 plays" shrinks that row's 1fr and shifts the bar.
    ".sample-playlist-row{display:grid;grid-template-columns:1fr 120px 84px;" +
    "align-items:center;gap:12px;font-size:13px}" +
    ".sample-playlist-track{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
    ".sample-playlist-barwrap{background:#eef1f5;border-radius:999px;height:8px;overflow:hidden}" +
    ".sample-playlist-bar{display:block;height:100%;background:#1d4ed8;border-radius:999px}" +
    ".sample-playlist-plays{color:#888;font-variant-numeric:tabular-nums;white-space:nowrap;text-align:right}" +
    ".sample-playlist-msg{color:#9a3412;font-size:13px;padding:10px}";
  document.head.appendChild(s);
}
