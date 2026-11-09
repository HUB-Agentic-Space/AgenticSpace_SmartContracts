/**
 * 3d_graph_render.ts
 * ------------------
 * Shared utilities for HTML reports that use 3D force-directed graphs
 * to visualize relationships between accounts and contracts.
 *
 * Replaces the previous vis-network (2D) approach with 3d-force-graph
 * (Three.js-based), enabling better visualization of complex multi-account
 * and multi-contract relationships in three-dimensional space.
 *
 * Provides:
 * - GRAPH_3D_CDN: CDN <script> tag for 3d-force-graph
 * - GRAPH_3D_CSS: CSS for the 3D graph container + custom tooltip
 * - GRAPH_3D_TOOLTIP_JS: JS for custom interactive HTML tooltips (3D)
 * - GRAPH_3D_INIT_JS: JS template that initializes a 3D force graph
 *   from a `graphData` object with nodes[] and edges[].
 * - GRAPH_3D_SEARCH_JS: JS for search/clear functions adapted to 3D.
 *
 * Usage in report generators:
 *   import {
 *     GRAPH_3D_CDN, GRAPH_3D_CSS, GRAPH_3D_TOOLTIP_JS,
 *     GRAPH_3D_INIT_JS, GRAPH_3D_SEARCH_JS,
 *   } from "../utils/3d_graph_render";
 *   // Inject GRAPH_3D_CDN into <head>
 *   // Inject GRAPH_3D_CSS into <style>
 *   // Inject GRAPH_3D_TOOLTIP_JS + GRAPH_3D_INIT_JS + GRAPH_3D_SEARCH_JS into <script>
 *
 * Requirements:
 *   - A <div id="network-graph"></div> element in the HTML body
 *   - A `graphData` JS object with nodes[{id,label,title,color,borderColor,
 *     size,borderWidth,isContract,type,icon,...}] and edges[{from,to,color,
 *     highlight,width,title,volumeLabel,dashes,...}]
 */

// ── CDN ───────────────────────────────────────────────────────────────

/**
 * CDN script tags para o grafo 3D.
 *
 * - 3d-force-graph@1.80.0: engine do grafo. O bundle UMD embute three
 *   internamente (>=0.179) sem expô-lo como global — e não existe build
 *   UMD de three compatível para carregar separadamente.
 * - Dynamic import de three@0.179.x (ESM): expõe `window.THREE` para o
 *   nodeThreeObject customizado (sprites/icosaedro) e resolve a promise
 *   `window.__threeReady`, que o init aguarda antes de instanciar o grafo.
 *   A lib segue usando o three bundlado dela — mesma versão, instâncias
 *   distintas são compatíveis para objetos básicos (Mesh/Sprite/Group).
 *
 * Place this in the <head> of the HTML document.
 */
export const GRAPH_3D_CDN = `<script src="https://cdn.jsdelivr.net/npm/3d-force-graph@1.80.0/dist/3d-force-graph.min.js"></script>
<script>window.__threeReady = import("https://cdn.jsdelivr.net/npm/three@0.179.1/build/three.module.js").then(function (m) { window.THREE = m; });</script>`;

// ── CSS ───────────────────────────────────────────────────────────────

/**
 * CSS for the 3D graph container and custom tooltip.
 * Inject into the <style> section of HTML reports.
 */
export const GRAPH_3D_CSS = `
  #network-graph { width:100%; height:840px; min-height:600px; border:1px solid rgba(255,255,255,0.15); border-radius:12px; background:#070404; overflow:hidden; }
  #network-graph canvas { display:block; }
  .graph-3d-controls { position:absolute; top:12px; right:12px; z-index:10; display:flex; flex-direction:column; gap:6px; }
  .graph-3d-btn { background:rgba(113,45,35,0.85); color:#ffffff; border:1px solid rgba(255,255,255,0.15); border-radius:8px; padding:6px 12px; font-size:.8rem; cursor:pointer; backdrop-filter:blur(4px); transition:background .2s; }
  .graph-3d-btn:hover { background:rgba(240,95,64,0.85); }
  .graph-3d-info { position:absolute; bottom:12px; left:12px; z-index:10; background:rgba(113,45,35,0.85); color:#f7d4ca; border:1px solid rgba(255,255,255,0.15); border-radius:8px; padding:6px 12px; font-size:.75rem; backdrop-filter:blur(4px); pointer-events:none; }
  #vis-custom-tooltip {
    position: fixed;
    z-index: 9999;
    max-width: 380px;
    background: #712d23;
    color: #ffffff;
    border: 1px solid rgba(255,255,255,0.15);
    border-radius: 8px;
    padding: 10px 14px;
    font-size: 0.85rem;
    line-height: 1.5;
    box-shadow: 0 4px 12px rgba(0,0,0,0.4);
    pointer-events: auto;
    opacity: 0;
    transition: opacity 0.15s ease-in-out;
    display: none;
  }
  #vis-custom-tooltip.visible { opacity: 1; display: block; }
  #vis-custom-tooltip b { color: #fcc650; }
  #vis-custom-tooltip code { color: #f7d4ca; background: rgba(255,255,255,0.08); padding: 2px 6px; border-radius: 4px; font-size: 0.8rem; }
  #vis-custom-tooltip a { color: #fcc650; text-decoration: none; }
  #vis-custom-tooltip a:hover { text-decoration: underline; }
  #vis-custom-tooltip br { display: block; margin-bottom: 2px; }
  #vis-custom-tooltip em { color: #f7d4ca; }
  @media print {
    #network-graph { height:500px !important; border:1px solid rgba(34,34,34,0.15) !important; }
    .graph-3d-controls, .graph-3d-info { display:none !important; }
  }
`;

// ── Tooltip JS ────────────────────────────────────────────────────────

/**
 * JS for custom interactive HTML tooltips compatible with 3d-force-graph.
 * Inject into the <script> section, before GRAPH_3D_INIT_JS.
 *
 * Creates a #vis-custom-tooltip div and hooks into 3d-force-graph's
 * onNodeHover/onLinkHover events to show rich HTML tooltips with
 * clickable PolygonScan links.
 *
 * Requires: _graph3d (the 3d-force-graph instance) to be defined.
 */
export const GRAPH_3D_TOOLTIP_JS = `
// ── Interactive 3D tooltip ──
(function() {
  var tooltipEl = document.createElement('div');
  tooltipEl.id = 'vis-custom-tooltip';
  document.body.appendChild(tooltipEl);
  var hideTimer = null;
  var tooltipSuppressed = false;

  function clearHideTimer() {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  }

  function showTooltip(html, x, y) {
    if (tooltipSuppressed) return;
    clearHideTimer();
    tooltipEl.innerHTML = html;
    tooltipEl.classList.add('visible');
    var rect = tooltipEl.getBoundingClientRect();
    var tx = x + 14;
    var ty = y + 14;
    if (tx + rect.width > window.innerWidth - 8) tx = x - rect.width - 14;
    if (ty + rect.height > window.innerHeight - 8) ty = y - rect.height - 14;
    if (tx < 8) tx = 8;
    if (ty < 8) ty = 8;
    tooltipEl.style.left = tx + 'px';
    tooltipEl.style.top = ty + 'px';
  }

  function hideTooltip() {
    clearHideTimer();
    tooltipEl.classList.remove('visible');
  }

  function suppressTooltip() {
    tooltipSuppressed = true;
    hideTooltip();
  }

  function unsuppressTooltip() {
    tooltipSuppressed = false;
  }

  function scheduleHide() {
    clearHideTimer();
    hideTimer = setTimeout(hideTooltip, 300);
  }

  tooltipEl.addEventListener('mouseenter', clearHideTimer);
  tooltipEl.addEventListener('mouseleave', scheduleHide);
  tooltipEl.addEventListener('contextmenu', function(e) {
    e.preventDefault();
    suppressTooltip();
  });

  window._visTooltip = { showTooltip, hideTooltip, scheduleHide, suppressTooltip, unsuppressTooltip };
  window._tooltipSuppressed = function() { return tooltipSuppressed; };
})();
`;

// ── Copy address JS ───────────────────────────────────────────────────

/**
 * JS to intercept copy events and replace clipboard with full address.
 * Same as COPY_ADDRESS_JS in vis_tooltip.ts but exported separately
 * for convenience when not importing from vis_tooltip.
 */
export const COPY_ADDRESS_JS_3D = `
// ── Copy full address on selection ──
(function() {
  document.addEventListener('copy', function(e) {
    var selection = window.getSelection();
    if (!selection || selection.isCollapsed) return;
    var node = selection.anchorNode;
    if (!node) return;
    var el = node.nodeType === 1 ? node : node.parentElement;
    if (!el) return;
    var link = el.closest('[data-full-address]');
    if (!link) return;
    var fullAddr = link.getAttribute('data-full-address');
    if (!fullAddr) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', fullAddr);
  });
})();
`;

// ── 3D Graph Init JS ──────────────────────────────────────────────────

/**
 * JS template that initializes a 3D force-directed graph from graphData.
 *
 * Expects a `graphData` JS object with:
 *   nodes: [{ id, label, title, color, borderColor, size, borderWidth,
 *            isContract, type, icon, ... }]
 *   edges: [{ from, to, color, highlight, width, title, volumeLabel,
 *            dashes, ... }]
 *
 * Creates a global `_graph3d` variable (the 3d-force-graph instance)
 * and `_graph3dData` (the processed graph data).
 *
 * Also creates a wrapper div with controls (reset view, toggle labels).
 */
export const GRAPH_3D_INIT_JS = `
// ── 3D Force Graph initialization ──
let _graph3d = null;
let _graph3dData = null;
let _labelsVisible = true;
let _selectedNode = null;

if (graphData.nodes.length > 0) {
  // Map vis-network format to 3d-force-graph format
  var nodes3d = graphData.nodes.map(function(n) {
    return {
      id: n.id,
      name: (n.icon ? n.icon + ' ' : '') + n.label,
      label: n.label,
      tooltipHtml: n.title,
      color: n.color,
      borderColor: n.borderColor,
      borderWidth: n.borderWidth,
      val: Math.max(1, n.size / 6),
      size: n.size,
      isContract: n.isContract,
      type: n.type,
      icon: n.icon,
      shape: n.shape,
      alerts: n.alerts,
      holderBalance: n.holderBalance || 0,
    };
  });

  var nodeMap = {};
  nodes3d.forEach(function(n) { nodeMap[n.id] = n; });

  var links3d = graphData.edges.map(function(e) {
    return {
      source: e.from,
      target: e.to,
      color: e.color,
      highlight: e.highlight,
      width: e.width,
      tooltipHtml: e.title,
      volumeLabel: e.volumeLabel,
      dashes: e.dashes || false,
      value: e.value || 1,
    };
  });

  _graph3dData = { nodes: nodes3d, links: links3d };

  var container = document.getElementById('network-graph');

  // O nodeThreeObject depende de window.THREE, carregado via dynamic
  // import (ver GRAPH_3D_CDN) — aguarda __threeReady antes de instanciar.
  function _initWhenThreeReady() {
    var ready = window.__threeReady || Promise.resolve();
    ready.then(function() { _initGraph3D(container, nodes3d, links3d); });
  }

  // If container is hidden (e.g. inside a non-active tab), defer initialization
  var containerVisible = container.offsetWidth > 0 && container.offsetHeight > 0;
  if (!containerVisible) {
    // Poll until container becomes visible, then initialize
    var _initPending = true;
    var _initInterval = setInterval(function() {
      if (container.offsetWidth > 0 && container.offsetHeight > 0 && _initPending) {
        _initPending = false;
        clearInterval(_initInterval);
        _initWhenThreeReady();
      }
    }, 100);
    // Safety: stop polling after 30s
    setTimeout(function() { clearInterval(_initInterval); }, 30000);
  } else {
    _initWhenThreeReady();
  }

  function _initGraph3D(container, nodes3d, links3d) {

  var autoRotate = false;

  _graph3d = ForceGraph3D()(container)
    .graphData(_graph3dData)
    .backgroundColor('#070404')
    .nodeRelSize(6)
    .nodeVal(function(n) { return n.val; })
    .nodeColor(function(n) { return n.color; })
    .nodeLabel(function(n) { return ''; })
    .linkColor(function(l) { return l.color; })
    .linkWidth(function(l) { return Math.max(0.8, l.width * 0.6); })
    .linkDirectionalArrowLength(5)
    .linkDirectionalArrowRelPos(1)
    .linkDirectionalParticles(2)
    .linkDirectionalParticleWidth(0.6)
    .linkDirectionalParticleSpeed(0.004)
    .linkLabel(function(l) { return ''; })
    .warmupTicks(120)
    .cooldownTicks(100)
    .onNodeHover(function(node) {
      if (!node || window._tooltipSuppressed()) return;
      window._visTooltip.showTooltip(node.tooltipHtml, _lastMouseX, _lastMouseY);
    })
    .onLinkHover(function(link) {
      if (!link || window._tooltipSuppressed()) return;
      window._visTooltip.showTooltip(link.tooltipHtml, _lastMouseX, _lastMouseY);
    })
    .onNodeClick(function(node) {
      _selectedNode = node;
      // Focus camera on clicked node
      var distance = 120;
      var distRatio = 1 + distance / _graph3d.width();
      _graph3d.cameraPosition({
        x: node.x * distRatio,
        y: node.y * distRatio,
        z: node.z * distRatio
      }, { x: node.x, y: node.y, z: node.z }, 1000);
    })
    .onBackgroundClick(function() {
      _selectedNode = null;
      window._visTooltip.hideTooltip();
    })
    .onBackgroundRightClick(function() {
      window._visTooltip.suppressTooltip();
    });

  // Create controls overlay — DEPOIS do ForceGraph3D(): a lib limpa o
  // container no init, então elementos inseridos antes são removidos.
  var controlsDiv = document.createElement('div');
  controlsDiv.className = 'graph-3d-controls';
  controlsDiv.innerHTML =
    '<button class="graph-3d-btn" id="btn-reset-view" title="Resetar c\\u00e2mera">\\u2728 Resetar</button>' +
    '<button class="graph-3d-btn" id="btn-toggle-labels" title="Alternar r\\u00f3tulos">\\u1f5f Etiquetas</button>' +
    '<button class="graph-3d-btn" id="btn-toggle-rotation" title="Auto-rota\\u00e7\\u00e3o">\\u27f3 Auto-rot</button>';
  container.style.position = 'relative';
  container.appendChild(controlsDiv);

  var infoDiv = document.createElement('div');
  infoDiv.className = 'graph-3d-info';
  infoDiv.textContent = 'Arraste para rotacionar \\u00b7 Scroll para zoom \\u00b7 Clique direito para pan';
  container.appendChild(infoDiv);

  // Track mouse position for tooltip placement
  var _lastMouseX = 0;
  var _lastMouseY = 0;
  container.addEventListener('mousemove', function(e) {
    _lastMouseX = e.clientX;
    _lastMouseY = e.clientY;
  });

  // Hide tooltip on blur
  container.addEventListener('mouseleave', function() {
    window._visTooltip.scheduleHide();
  });

  // ── Controls ──
  document.getElementById('btn-reset-view').addEventListener('click', function() {
    _graph3d.zoomToFit(400, 60);
    _selectedNode = null;
  });

  document.getElementById('btn-toggle-labels').addEventListener('click', function() {
    _labelsVisible = !_labelsVisible;
    _graph3d.refresh();
  });

  document.getElementById('btn-toggle-rotation').addEventListener('click', function() {
    autoRotate = !autoRotate;
    _graph3d.autoRotate(autoRotate, 0.5);
  });

  // ── Format balance for compact display ──
  function _formatBalance(val) {
    if (val >= 1000000) return (val / 1000000).toFixed(1) + 'M CAS';
    if (val >= 1000) return (val / 1000).toFixed(1) + 'k CAS';
    return val.toFixed(2) + ' CAS';
  }

  // ── Text sprite helper for labels ──
  // Renderiza o texto com fonte auto-ajustada para caber na largura alvo
  // (em unidades de cena), sem corte: mede a linha mais longa e reduz o
  // fonte até caber com margem. Retorna {texture, aspect}.
  function _makeTextSprite(text, targetW) {
    var lines = text.split('\\n');
    var pxPerUnit = 32;
    var pad = 12;
    var canvas = document.createElement('canvas');
    canvas.width = Math.max(64, Math.round(targetW * pxPerUnit));
    var ctx = canvas.getContext('2d');
    var fontSize = 20;
    ctx.font = 'bold ' + fontSize + 'px system-ui, sans-serif';
    var longest = 1;
    lines.forEach(function(l) { longest = Math.max(longest, ctx.measureText(l).width); });
    fontSize = Math.max(7, Math.min(20, Math.floor(fontSize * (canvas.width - pad * 2) / longest)));
    var lineH = Math.round(fontSize * 1.3);
    canvas.height = lineH * lines.length + pad;
    ctx = canvas.getContext('2d');
    ctx.fillStyle = 'rgba(7,4,4,0.72)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    lines.forEach(function(line, i) {
      var y = (i + 0.5) * lineH + pad / 2;
      if (i === 0) {
        ctx.font = 'bold ' + fontSize + 'px system-ui, sans-serif';
        ctx.fillStyle = '#ffffff';
      } else {
        ctx.font = Math.max(6, Math.round(fontSize * 0.8)) + 'px system-ui, sans-serif';
        ctx.fillStyle = '#fcc650';
      }
      ctx.fillText(line, canvas.width / 2, y);
    });
    var texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    return { texture: texture, aspect: canvas.height / canvas.width };
  }

  // ── Node 3D objects: contract geometry + always-on label sprites ──
  _graph3d.nodeThreeObjectExtend(function(node) { return !node.isContract; });
  _graph3d.nodeThreeObject(function(node) {
    var objects = [];

    // Contract nodes get icosahedron geometry
    if (node.isContract) {
      var geo = new THREE.IcosahedronGeometry(8, 0);
      var mat = new THREE.MeshLambertMaterial({
        color: node.color,
        emissive: node.borderColor,
        emissiveIntensity: 0.3,
        transparent: true,
        opacity: 0.85,
      });
      objects.push(new THREE.Mesh(geo, mat));
    }

    // Label sprite contido à representação do nó: largura ~ diâmetro,
    // centrado no nó — legível conforme o zoom aproxima.
    if (_labelsVisible) {
      var labelText = node.label || node.id || '';
      if (node.holderBalance && node.holderBalance > 0) {
        labelText += '\\n' + _formatBalance(node.holderBalance);
      }
      var nodeRadius = node.isContract ? 8 : 6 * Math.cbrt(Math.max(1, node.val));
      var labelW = nodeRadius * 2.1;
      var spr = _makeTextSprite(labelText, labelW);
      var sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: spr.texture,
        transparent: true,
        depthTest: false,
      }));
      sprite.scale.set(labelW, labelW * spr.aspect, 1);
      objects.push(sprite);
    }

    if (objects.length === 0) return null;
    if (objects.length === 1) return objects[0];
    var group = new THREE.Group();
    objects.forEach(function(o) { group.add(o); });
    return group;
  });

  // ── Dashed links for alerts ──
  // 3d-force-graph não implementa linkLineDash (API exclusiva do force-graph
  // 2D). Arestas de alerta mantêm cor #ce6e6d + partículas reforçadas.
  _graph3d.linkDirectionalParticles(function(link) {
    return link.dashes ? 5 : 2;
  });

  // ── Fit view after initial stabilization ──
  setTimeout(function() {
    _graph3d.zoomToFit(400, 60);
  }, 1500);

  ${COPY_ADDRESS_JS_3D}
  } // end _initGraph3D
}
`;

// ── Search JS ─────────────────────────────────────────────────────────

/**
 * JS for search and clear functions adapted to 3d-force-graph.
 * Inject into the <script> section, after GRAPH_3D_INIT_JS.
 *
 * Requires: _graph3d, _graph3dData, graphData variables.
 * Uses _graph3d.nodeOpacity() and linkColor() accessors to
 * highlight/dim nodes and links based on search query.
 */
export const GRAPH_3D_SEARCH_JS = `
function searchGraph() {
  if (!_graph3d || !_graph3dData) return;
  var query = document.getElementById('graph-search-input').value.trim().toLowerCase();
  if (!query) return;

  var matched = _graph3dData.nodes.filter(function(n) {
    return (n.id && n.id.toLowerCase().indexOf(query) !== -1) ||
           (n.label && n.label.toLowerCase().indexOf(query) !== -1) ||
           (n.name && n.name.toLowerCase().indexOf(query) !== -1);
  });

  var resultEl = document.getElementById('graph-search-result');
  if (matched.length === 0) {
    resultEl.textContent = 'Nenhum resultado';
    resultEl.style.color = '#eb3812';
    return;
  }
  resultEl.textContent = matched.length + ' resultado(s)';
  resultEl.style.color = '#fcc650';

  var matchedIds = new Set(matched.map(function(n) { return n.id; }));

  // Find connected links
  var connectedLinkKeys = new Set();
  matched.forEach(function(n) {
    _graph3dData.links.forEach(function(l) {
      if (l.source.id === n.id || l.target.id === n.id) {
        connectedLinkKeys.add(l.source.id + '->' + l.target.id);
      }
    });
  });

  // Highlight matched nodes, dim others
  _graph3d.nodeOpacity(function(node) {
    return matchedIds.has(node.id) ? 1 : 0.08;
  });

  // Highlight connected links, dim others
  _graph3d.linkColor(function(link) {
    var key = link.source.id + '->' + link.target.id;
    if (connectedLinkKeys.has(key)) {
      var orig = graphData.edges.find(function(e) { return e.from === link.source.id && e.to === link.target.id; });
      return orig ? orig.highlight : '#F05F40';
    }
    return 'rgba(255,255,255,0.03)';
  });

  _graph3d.refresh();

  // Focus camera on matched node(s)
  if (matched.length === 1) {
    var node = matched[0];
    var distance = 120;
    var distRatio = 1 + distance / _graph3d.width();
    _graph3d.cameraPosition({
      x: node.x * distRatio,
      y: node.y * distRatio,
      z: node.z * distRatio
    }, { x: node.x, y: node.y, z: node.z }, 800);
  } else {
    // Frame all matched nodes
    _graph3d.zoomToFit(400, 60, function(node) {
      return matchedIds.has(node.id);
    });
  }
}

function clearGraphSearch() {
  if (!_graph3d || !_graph3dData) return;
  document.getElementById('graph-search-input').value = '';
  document.getElementById('graph-search-result').textContent = '';
  document.getElementById('graph-search-result').style.color = '';

  // Restore all nodes to full opacity
  _graph3d.nodeOpacity(1);

  // Restore all links to original colors
  _graph3d.linkColor(function(link) {
    var orig = graphData.edges.find(function(e) { return e.from === link.source.id && e.to === link.target.id; });
    return orig ? orig.color : '#d49a5a';
  });

  _graph3d.refresh();
  _graph3d.zoomToFit(400, 60);
}
`;
