// Sample third-party embed provider — "playlists". Vanilla JS, no build step.
//
// datasette-paper injects this bundle on demand (when a doc uses a playlist
// embed, or the author picks "Playlists" from the / menu). It registers a
// provider on the shared `window.datasettePaperEmbeds` registry, which supplies
// the inline-pill identity (`resolve`) and the rich block body (`mount`). All
// data is fetched from this plugin's own JSON routes with the VIEWER's cookie,
// so per-viewer permissions + leak discipline are ours, not paper's.
(function () {
  "use strict";

  // Minimal registry shim, identical in shape to paper's makeEmbedRegistry.
  // Paper normally creates the registry first (at editor init) and this is a
  // no-op `||`; the full shim makes the bundle safe to load in any order.
  function makeRegistry() {
    var byKind = {};
    return {
      register: function (p) {
        byKind[p.kind] = p;
      },
      get: function (k) {
        return byKind[k];
      },
      all: function () {
        return Object.keys(byKind).map(function (k) {
          return byKind[k];
        });
      },
      providerForRef: function (ref) {
        for (var k in byKind)
          if (byKind[k].matchRef && byKind[k].matchRef(ref)) return byKind[k];
      },
      match: function (url) {
        for (var k in byKind)
          if (byKind[k].matchUrl) {
            var r = byKind[k].matchUrl(url);
            if (r) return r;
          }
        return null;
      },
      providerForSource: function (id) {
        for (var k in byKind)
          if (byKind[k].picker && byKind[k].picker().id === id) return byKind[k];
      },
      sources: function () {
        var out = [];
        for (var k in byKind) if (byKind[k].picker) out.push(byKind[k].picker());
        return out;
      },
    };
  }
  var registry = (window.datasettePaperEmbeds =
    window.datasettePaperEmbeds || makeRegistry());

  var PREFIX = "/-/sample-embeds/playlists/";

  registry.register({
    kind: "playlist",

    matchRef: function (ref) {
      return ref.indexOf(PREFIX) === 0;
    },

    matchUrl: function (url) {
      return url.pathname.indexOf(PREFIX) === 0 ? url.pathname : null;
    },

    // Inline pill identity. Leak discipline: never a label on denied/not_found.
    resolve: function (ref) {
      return fetch(ref + ".json", { headers: { accept: "application/json" } })
        .then(function (res) {
          if (res.status === 403) return { status: "denied" };
          if (!res.ok) return { status: "not_found" };
          return res.json().then(function (pl) {
            return { status: "ok", kind: "playlist", label: pl.title, href: ref };
          });
        })
        .catch(function () {
          return null; // transient → pill stays loading, retried later
        });
    },

    // Rich block body. Paper owns the header chrome; we fill `host`.
    mount: function (host, ctx) {
      var cancelled = false;
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
    picker: function () {
      return { id: "playlist", label: "Playlists", icon: "database" };
    },

    // Viewer-filtered search for the picker dialog.
    search: function (q, limit) {
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
  });

  // --- rendering (text nodes only — never innerHTML with data) -------------
  function renderPlaylist(host, pl) {
    host.replaceChildren();
    var max = 1;
    pl.tracks.forEach(function (t) {
      if (t.plays > max) max = t.plays;
    });
    var list = document.createElement("div");
    list.className = "sample-playlist";
    pl.tracks.forEach(function (t) {
      var row = document.createElement("div");
      row.className = "sample-playlist-row";

      var name = document.createElement("span");
      name.className = "sample-playlist-track";
      name.textContent = t.title + " — " + t.artist;

      var barWrap = document.createElement("span");
      barWrap.className = "sample-playlist-barwrap";
      var bar = document.createElement("span");
      bar.className = "sample-playlist-bar";
      bar.style.width = Math.round((t.plays / max) * 100) + "%";
      barWrap.appendChild(bar);

      var plays = document.createElement("span");
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
    var p = document.createElement("div");
    p.className = "sample-playlist-msg";
    p.textContent = msg;
    host.appendChild(p);
    injectStylesOnce();
  }

  function injectStylesOnce() {
    if (document.getElementById("sample-playlist-styles")) return;
    var s = document.createElement("style");
    s.id = "sample-playlist-styles";
    s.textContent =
      ".sample-playlist{display:flex;flex-direction:column;gap:6px;padding:4px 2px}" +
      ".sample-playlist-row{display:grid;grid-template-columns:1fr 120px auto;" +
      "align-items:center;gap:10px;font-size:13px}" +
      ".sample-playlist-track{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      ".sample-playlist-barwrap{background:#eef1f5;border-radius:999px;height:8px;overflow:hidden}" +
      ".sample-playlist-bar{display:block;height:100%;background:#1d4ed8;border-radius:999px}" +
      ".sample-playlist-plays{color:#888;font-variant-numeric:tabular-nums;white-space:nowrap}" +
      ".sample-playlist-msg{color:#9a3412;font-size:13px;padding:6px 2px}";
    document.head.appendChild(s);
  }
})();
