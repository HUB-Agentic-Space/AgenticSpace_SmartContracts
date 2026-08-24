/**
 * vis_tooltip.ts
 * --------------
 * Shared utilities for HTML reports that use vis-network graphs.
 *
 * Provides:
 * - polyScanLink: generates an <a> tag linking to PolygonScan
 * - polyScanAddrDisplay: generates an address display with optional anon mode
 * - INTERACTIVE_TOOLTIP_CSS: CSS for custom interactive tooltips
 * - INTERACTIVE_TOOLTIP_JS: JS that replaces vis-network's built-in tooltip
 *   with a custom one that stays visible when the mouse moves over it,
 *   allowing the user to click links inside the tooltip.
 *
 * Usage in report generators:
 *   import { polyScanLink, INTERACTIVE_TOOLTIP_CSS, INTERACTIVE_TOOLTIP_JS } from "../utils/vis_tooltip";
 *   // Inject CSS into <style> section
 *   // Inject JS into <script> section
 *   // Use polyScanLink(addr) in tooltip HTML strings
 */

/**
 * Generates an HTML <a> tag linking to a PolygonScan address page.
 *
 * The link carries a data-full-address attribute so the COPY_ADDRESS_JS
 * snippet can intercept copy events and place the full address on the
 * clipboard even when the visible text is shortened or a name.
 *
 * @param addr  - The full address (0x...)
 * @param label - Optional display text; defaults to the address itself
 * @returns HTML string with a styled link
 */
export function polyScanLink(addr: string, label?: string): string {
  const text = label ?? addr;
  return `<a href="https://polygonscan.com/address/${addr}" target="_blank" data-full-address="${addr}" style="color:#fcc650;text-decoration:none;"><code>${text}</code></a>`;
}

/**
 * Generates an address display for use in tooltips.
 *
 * In anon mode, returns a <code> with the anon label.
 * In normal mode, returns a PolygonScan link with the full or shortened address.
 *
 * @param addr      - The full address (0x...)
 * @param anonMode  - If true, use anonLabel instead of real address
 * @param anonLabel - The anon label to display (required if anonMode is true)
 * @param displayAddr - The address text to show (full or shortened)
 */
export function polyScanAddrDisplay(
  addr: string,
  anonMode: boolean,
  anonLabel?: string,
  displayAddr?: string,
): string {
  if (anonMode) {
    return `<code>${anonLabel ?? addr}</code>`;
  }
  const text = displayAddr ?? addr;
  return polyScanLink(addr, text);
}

/**
 * JS to inject into the <script> section of HTML reports.
 *
 * Intercepts copy events: when the user selects text inside an element
 * that has (or is contained within) a [data-full-address] attribute, the
 * clipboard is replaced with the full address instead of the visible
 * (possibly shortened or named) text.
 */
export const COPY_ADDRESS_JS = `
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

/**
 * CSS to inject into the <style> section of HTML reports.
 * Styles the custom interactive tooltip (#vis-custom-tooltip) and
 * hides vis-network's built-in tooltip (.vis-tooltip).
 */
export const INTERACTIVE_TOOLTIP_CSS = `
  .vis-tooltip { display: none !important; }
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
`;

/**
 * JS to inject into the <script> section of HTML reports.
 *
 * Sets up a custom tooltip system for vis-network graphs:
 * - Creates a #vis-custom-tooltip div
 * - On hoverNode/hoverEdge, shows the tooltip with the node/edge's tooltipHtml
 * - On blurNode/blurEdge, starts a hide timer (300ms delay)
 * - If the mouse enters the tooltip, the hide timer is cancelled
 * - If the mouse leaves the tooltip, it hides immediately
 *
 * Requires: graphData object with nodes[].title and edges[].title as HTML strings,
 *           and _graphNetwork, _visNodes, _visEdges variables.
 */
export const INTERACTIVE_TOOLTIP_JS = `
// ── Interactive vis-network tooltip ──
(function() {
  var tooltipEl = document.createElement('div');
  tooltipEl.id = 'vis-custom-tooltip';
  document.body.appendChild(tooltipEl);
  var hideTimer = null;
  var currentTarget = null;
  var tooltipSuppressed = false;

  function clearHideTimer() {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  }

  function showTooltip(html, x, y) {
    if (tooltipSuppressed) return;
    clearHideTimer();
    tooltipEl.innerHTML = html;
    tooltipEl.classList.add('visible');
    // Position tooltip, adjusting for viewport edges
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
    currentTarget = null;
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

  // Right-click on tooltip itself also suppresses
  tooltipEl.addEventListener('contextmenu', function(e) {
    e.preventDefault();
    suppressTooltip();
  });

  // Expose for external use
  window._visTooltip = { showTooltip, hideTooltip, scheduleHide, suppressTooltip, unsuppressTooltip };

  // Hook into vis-network events after network is created
  function hookVisTooltip(network, visNodes, visEdges) {
    if (!network) return;
    network.on('hoverNode', function(params) {
      if (tooltipSuppressed) return;
      var node = visNodes ? visNodes.get(params.node) : null;
      if (!node || !node.title) return;
      currentTarget = 'node:' + params.node;
      showTooltip(typeof node.title === 'string' ? node.title : node.title.innerHTML, params.pointer.DOM.x, params.pointer.DOM.y);
    });
    network.on('hoverEdge', function(params) {
      if (tooltipSuppressed) return;
      var edge = visEdges ? visEdges.get(params.edge) : null;
      if (!edge || !edge.title) return;
      currentTarget = 'edge:' + params.edge;
      showTooltip(typeof edge.title === 'string' ? edge.title : edge.title.innerHTML, params.pointer.DOM.x, params.pointer.DOM.y);
    });
    network.on('blurNode', scheduleHide);
    network.on('blurEdge', scheduleHide);
    network.on('zoom', hideTooltip);
    // Right-click suppresses tooltip until next left-click
    network.on('oncontext', function(params) {
      suppressTooltip();
    });
    // Left-click re-enables tooltip
    network.on('click', function() {
      unsuppressTooltip();
    });
    // Suppress during drag so tooltip doesn't interfere with organizing nodes
    network.on('dragStart', function() {
      suppressTooltip();
    });
    network.on('dragEnd', function() {
      unsuppressTooltip();
    });
  }

  // Auto-hook when _graphNetwork becomes available
  var hookInterval = setInterval(function() {
    if (typeof _graphNetwork !== 'undefined' && _graphNetwork && typeof _visNodes !== 'undefined' && typeof _visEdges !== 'undefined') {
      hookVisTooltip(_graphNetwork, _visNodes, _visEdges);
      clearInterval(hookInterval);
    }
  }, 100);
})();
`;
