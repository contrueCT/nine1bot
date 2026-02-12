/**
 * Page script: element search with multi-word scoring
 * Extracted from browser-extension/src/tools/dom-reader.ts (findTool)
 * Enhanced with multi-word split + scoring algorithm for better relevance.
 *
 * Usage:
 *   - Extension mode: callExtensionTool("find", { query })
 *   - CDP mode: Runtime.evaluate(buildFindExpression(query))
 */

export interface FindMatch {
  ref: string
  tag: string
  text?: string
  label?: string
  role?: string
  score: number
  rect: { x: number; y: number; width: number; height: number }
}

/**
 * Build a JS expression that searches the page for elements matching a query.
 * Uses multi-word split + scoring: matches against text, aria-label, role, id, class, placeholder.
 * Returns JSON array of top 20 matches sorted by score descending.
 */
export function buildFindExpression(query: string): string {
  return `(function(searchQuery) {
    var matches = [];
    var words = searchQuery.toLowerCase().split(/\\s+/).filter(function(w) { return w.length > 0; });
    if (words.length === 0) return JSON.stringify([]);

    var elements = document.querySelectorAll('*');

    for (var i = 0; i < elements.length; i++) {
      var element = elements[i];
      var tagName = element.tagName.toLowerCase();

      // Skip non-visible elements
      var style = window.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') continue;

      var rect = element.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;

      // Gather searchable attributes
      var text = (element.textContent || '').slice(0, 200).toLowerCase();
      var ariaLabel = (element.getAttribute('aria-label') || '').toLowerCase();
      var title = (element.getAttribute('title') || '').toLowerCase();
      var placeholder = (element.placeholder || '').toLowerCase();
      var role = (element.getAttribute('role') || '').toLowerCase();
      var id = (element.id || '').toLowerCase();
      var className = (typeof element.className === 'string' ? element.className : '').toLowerCase();
      var label = ariaLabel || title;

      // Multi-word scoring
      var score = 0;
      for (var w = 0; w < words.length; w++) {
        var word = words[w];
        if (ariaLabel.indexOf(word) !== -1) score += 3;
        if (placeholder.indexOf(word) !== -1) score += 3;
        if (label.indexOf(word) !== -1) score += 2;
        if (role === word || tagName === word) score += 2;
        if (text.indexOf(word) !== -1) score += 1;
        if (id.indexOf(word) !== -1) score += 1;
        if (className.indexOf(word) !== -1) score += 1;
      }

      if (score === 0) continue;

      // Boost interactive elements
      var interactiveTags = ['a', 'button', 'input', 'select', 'textarea', 'details', 'summary'];
      if (interactiveTags.indexOf(tagName) !== -1) score += 1;
      if (element.getAttribute('tabindex')) score += 1;

      // Penalize very deeply nested or very large text containers
      var directText = '';
      for (var c = 0; c < element.childNodes.length; c++) {
        if (element.childNodes[c].nodeType === 3) directText += element.childNodes[c].textContent;
      }
      if (directText.trim().length > 0) score += 1;

      var ref = 'ref_' + Math.random().toString(36).slice(2, 9);
      element.setAttribute('data-mcp-ref', ref);

      matches.push({
        ref: ref,
        tag: tagName,
        text: (element.textContent || '').slice(0, 100).trim() || undefined,
        label: element.getAttribute('aria-label') || element.getAttribute('title') || undefined,
        role: element.getAttribute('role') || undefined,
        score: score,
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      });
    }

    // Sort by score descending, take top 20
    matches.sort(function(a, b) { return b.score - a.score; });
    matches = matches.slice(0, 20);

    return JSON.stringify(matches);
  })(${JSON.stringify(query)})`
}
