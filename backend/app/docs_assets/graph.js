/*
================================================================================
FILE: backend/app/docs_assets/graph.js
================================================================================

SUMMARY
    The embedded graph viewer copied into every documentation site at
    assets/graph.js. Reads the complete graph the generator inlined into the
    page, lays it out with a small force simulation, draws it on a canvas, lets
    the reader drag and pan it, and scrolls to a term's section when its node is
    clicked. That click is the join between the moving picture and the prose.

BASIC IDEA
    This is deliberately dependency-free vanilla JavaScript rather than a
    bundled Sigma/graphology build. The project ships no bundler step for a
    standalone artefact, and a published page must be self-contained: no CDN,
    no import, no network request of any kind (AC-3). A few hundred lines of
    canvas code buy a live, movable graph with none of that surface.

    The graph data is read from an inline
        <script id="graph-data" type="application/json">…</script>
    element, NOT fetched. A fetch would be a network request, and worse, the
    file:// origin a reader uses after unzipping blocks fetch entirely, so the
    graph would silently never load. Each node carries an `anchor`: the id of
    its term's section in the page, or null if it has none. Clicking a node with
    an anchor moves the page to that section.

INPUTS / INPUT SOURCES
    - The inline #graph-data JSON: { nodes:[{id,label,kind,degree,anchor}],
      edges:[{source,target}] }.
    - Pointer events on the canvas.

EXPECTED OUTPUT
    - A rendered, interactive force-directed graph in #graph-canvas, and
      navigation to a term section on node click.
================================================================================
*/

(function () {
  "use strict";

  // Node fill per kind. Mirrors the application's palette closely enough to
  // read as "the same view"; kept inline because the page loads no other asset.
  var KIND_COLORS = {
    class: "#4f9cf9",
    objectProperty: "#f59e42",
    datatypeProperty: "#37b98a",
    annotationProperty: "#c084fc",
    property: "#e0a640",
    concept: "#a78bfa",
    conceptScheme: "#8b5cf6",
    collection: "#f472b6",
    individual: "#f6c453",
    ontology: "#64748b",
    other: "#94a3b8"
  };

  function readData() {
    var el = document.getElementById("graph-data");
    if (!el) return null;
    try {
      return JSON.parse(el.textContent || "{}");
    } catch (e) {
      return null;
    }
  }

  function ready(fn) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", fn);
    } else {
      fn();
    }
  }

  ready(function () {
    var wrap = document.getElementById("graph-canvas-wrap");
    var canvas = document.getElementById("graph-canvas");
    if (!wrap || !canvas) return;

    var data = readData();
    if (!data || !data.nodes || data.nodes.length === 0) {
      wrap.innerHTML =
        '<p class="graph-fallback">This ontology has no entities to draw.</p>';
      return;
    }

    var ctx = canvas.getContext("2d");
    var nodes = data.nodes.map(function (n) {
      return {
        id: n.id,
        label: n.label || "",
        kind: n.kind || "other",
        degree: n.degree || 0,
        anchor: n.anchor || null,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        fixed: false
      };
    });
    var index = {};
    nodes.forEach(function (n, i) {
      index[n.id] = i;
    });
    var edges = (data.edges || [])
      .map(function (e) {
        return { s: index[e.source], t: index[e.target] };
      })
      .filter(function (e) {
        return e.s !== undefined && e.t !== undefined;
      });

    // Deterministic initial placement: a golden-angle spiral, so the layout is
    // the same every time the page is opened rather than reshuffling per load.
    var GOLDEN = Math.PI * (3 - Math.sqrt(5));
    var R0 = 260;
    nodes.forEach(function (n, i) {
      var r = R0 * Math.sqrt((i + 0.5) / nodes.length);
      var a = i * GOLDEN;
      n.x = Math.cos(a) * r;
      n.y = Math.sin(a) * r;
    });

    // Force simulation: repulsion between all nodes, spring along edges, and a
    // gentle pull to the centre. Barnes–Hut is overkill at these sizes; the
    // guard already refuses graphs over 5 MB of JSON, so this stays cheap.
    var AREA = 900 * 900;
    var k = Math.sqrt(AREA / Math.max(nodes.length, 1));
    function step(temp) {
      var i, j, n, m, dx, dy, dist, force;
      for (i = 0; i < nodes.length; i++) {
        nodes[i].vx = 0;
        nodes[i].vy = 0;
      }
      // Repulsion (O(n^2); fine because the graph is capped before it gets here).
      for (i = 0; i < nodes.length; i++) {
        n = nodes[i];
        for (j = i + 1; j < nodes.length; j++) {
          m = nodes[j];
          dx = n.x - m.x;
          dy = n.y - m.y;
          dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
          force = (k * k) / dist;
          var ux = (dx / dist) * force;
          var uy = (dy / dist) * force;
          n.vx += ux;
          n.vy += uy;
          m.vx -= ux;
          m.vy -= uy;
        }
      }
      // Attraction along edges.
      for (i = 0; i < edges.length; i++) {
        n = nodes[edges[i].s];
        m = nodes[edges[i].t];
        dx = n.x - m.x;
        dy = n.y - m.y;
        dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
        force = (dist * dist) / k;
        var ax = (dx / dist) * force;
        var ay = (dy / dist) * force;
        n.vx -= ax;
        n.vy -= ay;
        m.vx += ax;
        m.vy += ay;
      }
      // Displace, capped by the cooling temperature, plus a centring pull.
      for (i = 0; i < nodes.length; i++) {
        n = nodes[i];
        if (n.fixed) continue;
        var vlen = Math.sqrt(n.vx * n.vx + n.vy * n.vy) || 0.01;
        n.x += (n.vx / vlen) * Math.min(vlen, temp);
        n.y += (n.vy / vlen) * Math.min(vlen, temp);
        n.x -= n.x * 0.008;
        n.y -= n.y * 0.008;
      }
    }

    // Run the layout to a settled state before the first paint. Bounded by a
    // fixed iteration count so a large graph cannot freeze the tab.
    var ITER = Math.min(300, Math.max(80, Math.round(6000 / Math.sqrt(nodes.length))));
    var t;
    for (t = 0; t < ITER; t++) {
      step(k * (1 - t / ITER) * 0.1 + 1);
    }

    // Camera: fit the settled layout into the canvas, then allow pan/zoom/drag.
    var view = { scale: 1, ox: 0, oy: 0 };
    var dpr = Math.max(1, window.devicePixelRatio || 1);
    // Once the reader pans, zooms or drags, stop auto-fitting so a later resize
    // does not throw away the view they arranged.
    var userAdjusted = false;

    function resize() {
      // Fall back to sane dimensions when the container reports zero size — a
      // page that opens with the figure not yet laid out (or briefly hidden)
      // would otherwise draw nothing and only recover on a resize event. The
      // ResizeObserver below re-fits the moment a real size arrives.
      var w = wrap.clientWidth || 800;
      var h = wrap.clientHeight || 460;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = w + "px";
      canvas.style.height = h + "px";
    }

    function fit() {
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      nodes.forEach(function (n) {
        if (n.x < minX) minX = n.x;
        if (n.y < minY) minY = n.y;
        if (n.x > maxX) maxX = n.x;
        if (n.y > maxY) maxY = n.y;
      });
      var w = canvas.width / dpr;
      var h = canvas.height / dpr;
      var gw = maxX - minX || 1;
      var gh = maxY - minY || 1;
      var pad = 40;
      view.scale = Math.min((w - pad * 2) / gw, (h - pad * 2) / gh);
      view.scale = Math.max(0.05, Math.min(view.scale, 3));
      view.ox = w / 2 - ((minX + maxX) / 2) * view.scale;
      view.oy = h / 2 - ((minY + maxY) / 2) * view.scale;
    }

    function toScreen(n) {
      return { x: n.x * view.scale + view.ox, y: n.y * view.scale + view.oy };
    }

    function radius(n) {
      return Math.max(3, Math.min(11, 3 + Math.sqrt(n.degree)));
    }

    function draw() {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      var w = canvas.width / dpr;
      var h = canvas.height / dpr;
      ctx.clearRect(0, 0, w, h);
      // Edges first, so nodes sit on top.
      ctx.strokeStyle = "rgba(128,140,155,0.35)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      edges.forEach(function (e) {
        var a = toScreen(nodes[e.s]);
        var b = toScreen(nodes[e.t]);
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      });
      ctx.stroke();
      // Nodes.
      nodes.forEach(function (n) {
        var p = toScreen(n);
        ctx.beginPath();
        ctx.fillStyle = KIND_COLORS[n.kind] || KIND_COLORS.other;
        ctx.arc(p.x, p.y, radius(n), 0, Math.PI * 2);
        ctx.fill();
      });
      // Labels for the most connected handful, so the picture is legible.
      ctx.fillStyle = getComputedStyle(document.body).color;
      ctx.font = "11px sans-serif";
      var labelled = nodes
        .slice()
        .sort(function (a, b) {
          return b.degree - a.degree;
        })
        .slice(0, 24);
      labelled.forEach(function (n) {
        var p = toScreen(n);
        ctx.fillText(n.label, p.x + radius(n) + 2, p.y + 3);
      });
    }

    function pick(mx, my) {
      // Topmost node under the cursor, tested in screen space.
      for (var i = nodes.length - 1; i >= 0; i--) {
        var p = toScreen(nodes[i]);
        var r = radius(nodes[i]) + 3;
        if ((mx - p.x) * (mx - p.x) + (my - p.y) * (my - p.y) <= r * r) {
          return nodes[i];
        }
      }
      return null;
    }

    // Interaction: drag a node, pan the background, wheel to zoom, click to
    // navigate. A small move threshold separates a click from a drag.
    var dragging = null;
    var panning = false;
    var last = { x: 0, y: 0 };
    var down = { x: 0, y: 0 };
    var moved = false;

    function localPos(ev) {
      var rect = canvas.getBoundingClientRect();
      return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
    }

    canvas.addEventListener("pointerdown", function (ev) {
      var pos = localPos(ev);
      down = pos;
      moved = false;
      var hit = pick(pos.x, pos.y);
      if (hit) {
        dragging = hit;
        hit.fixed = true;
      } else {
        panning = true;
      }
      last = pos;
      canvas.setPointerCapture(ev.pointerId);
    });

    canvas.addEventListener("pointermove", function (ev) {
      var pos = localPos(ev);
      if (Math.abs(pos.x - down.x) > 3 || Math.abs(pos.y - down.y) > 3) {
        moved = true;
      }
      if (dragging) {
        userAdjusted = true;
        dragging.x = (pos.x - view.ox) / view.scale;
        dragging.y = (pos.y - view.oy) / view.scale;
        draw();
      } else if (panning) {
        userAdjusted = true;
        view.ox += pos.x - last.x;
        view.oy += pos.y - last.y;
        last = pos;
        draw();
      } else {
        canvas.style.cursor = pick(pos.x, pos.y) ? "pointer" : "default";
      }
    });

    canvas.addEventListener("pointerup", function (ev) {
      var pos = localPos(ev);
      if (dragging && !moved && dragging.anchor) {
        // A click, not a drag: navigate to the term's section.
        var target = document.getElementById(dragging.anchor);
        if (target) {
          if (window.history && window.history.replaceState) {
            window.history.replaceState(null, "", "#" + dragging.anchor);
          }
          target.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      }
      if (dragging) dragging.fixed = false;
      dragging = null;
      panning = false;
    });

    canvas.addEventListener(
      "wheel",
      function (ev) {
        ev.preventDefault();
        userAdjusted = true;
        var pos = localPos(ev);
        var factor = ev.deltaY < 0 ? 1.1 : 1 / 1.1;
        // Zoom about the cursor so the point under it stays put.
        view.ox = pos.x - (pos.x - view.ox) * factor;
        view.oy = pos.y - (pos.y - view.oy) * factor;
        view.scale *= factor;
        draw();
      },
      { passive: false }
    );

    // Re-fit to the container until the reader has arranged their own view.
    // This is what recovers a figure that was zero-sized at first paint: the
    // observer fires when a real size arrives, and the fit finally has one.
    function refit() {
      resize();
      if (!userAdjusted) fit();
      draw();
    }
    window.addEventListener("resize", refit);
    if (typeof ResizeObserver !== "undefined") {
      new ResizeObserver(refit).observe(wrap);
    }

    resize();
    fit();
    draw();
  });
})();
