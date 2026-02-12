/**
 * Page script: a11y tree snapshot
 * Extracted from browser-extension/src/tools/dom-reader.ts (readDOMFromTab)
 *
 * Generates an accessibility tree representation of the page,
 * assigning data-mcp-ref attributes to each element for later interaction.
 *
 * Usage:
 *   - Extension mode: callExtensionTool("read_page", opts)
 *   - CDP mode: Runtime.evaluate(buildSnapshotExpression(opts))
 */

export interface SnapshotOptions {
  depth?: number
  filter?: 'all' | 'interactive' | 'visible'
  refId?: string
  maxChars?: number
}

/**
 * Build a JS expression string that generates an a11y tree snapshot.
 * The expression is self-contained and returns a JSON string.
 */
export function buildSnapshotExpression(opts: SnapshotOptions = {}): string {
  const options = {
    depth: opts.depth ?? 10,
    filter: opts.filter ?? 'all',
    refId: opts.refId,
    maxChars: opts.maxChars ?? 50000,
  }

  return `(function(opts) {
    var depth = opts.depth;
    var filter = opts.filter;
    var refId = opts.refId;
    var maxChars = opts.maxChars;

    function getImplicitRole(tagName) {
      var roleMap = {
        a: 'link', button: 'button', input: 'textbox', select: 'combobox',
        textarea: 'textbox', img: 'img', h1: 'heading', h2: 'heading',
        h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading',
        nav: 'navigation', main: 'main', aside: 'complementary',
        footer: 'contentinfo', header: 'banner', form: 'form',
        table: 'table', ul: 'list', ol: 'list', li: 'listitem',
      };
      return roleMap[tagName] || '';
    }

    function getAccessibilityInfo(element) {
      var tagName = element.tagName.toLowerCase();
      var role = element.getAttribute('role') || getImplicitRole(tagName);
      var label = element.getAttribute('aria-label')
        || element.getAttribute('title')
        || element.getAttribute('alt')
        || element.placeholder
        || '';
      var text = (element.textContent || '').slice(0, 100).trim();

      var ref = 'ref_' + Math.random().toString(36).slice(2, 9);
      element.setAttribute('data-mcp-ref', ref);

      var info = { tag: tagName, ref: ref };

      if (role) info.role = role;
      if (label) info.label = label;
      if (text && text !== label) info.text = text;

      if (element instanceof HTMLInputElement) {
        info.type = element.type;
        if (element.value) info.value = element.value;
        if (element.name) info.name = element.name;
      }
      if (element instanceof HTMLAnchorElement && element.href) {
        info.href = element.href;
      }
      if (element instanceof HTMLButtonElement) {
        info.disabled = element.disabled;
      }
      if (element.id) info.id = element.id;
      if (element.className && typeof element.className === 'string') info.class = element.className;

      return info;
    }

    function isInteractive(element) {
      var tagName = element.tagName.toLowerCase();
      var interactiveTags = ['a', 'button', 'input', 'select', 'textarea', 'details', 'summary'];
      if (interactiveTags.indexOf(tagName) !== -1) return true;
      var role = element.getAttribute('role') || '';
      if (/button|link|checkbox|radio|textbox|combobox|listbox|menu|menuitem|tab|switch/.test(role)) return true;
      if (element.getAttribute('tabindex')) return true;
      if (element.getAttribute('onclick') || element.getAttribute('onkeydown')) return true;
      return false;
    }

    function isVisible(element) {
      var style = window.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      var rect = element.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return false;
      return true;
    }

    function traverse(element, currentDepth) {
      if (currentDepth > depth) return null;

      if (filter === 'visible' && !isVisible(element)) return null;
      if (filter === 'interactive' && !isInteractive(element) && currentDepth > 0) {
        var children = [];
        for (var i = 0; i < element.children.length; i++) {
          var childInfo = traverse(element.children[i], currentDepth);
          if (childInfo) children.push(childInfo);
        }
        if (children.length === 0) return null;
        return { children: children };
      }

      var info = getAccessibilityInfo(element);
      if (!info) return null;

      if (currentDepth < depth) {
        var ch = [];
        for (var j = 0; j < element.children.length; j++) {
          var ci = traverse(element.children[j], currentDepth + 1);
          if (ci) ch.push(ci);
        }
        if (ch.length > 0) info.children = ch;
      }

      return info;
    }

    var rootElement = document.body;
    if (refId) {
      rootElement = document.querySelector('[data-mcp-ref="' + refId + '"]');
      if (!rootElement) {
        return JSON.stringify({ error: 'Element with ref "' + refId + '" not found' });
      }
    }

    var result = traverse(rootElement, 0);
    var jsonString = JSON.stringify(result, null, 2);

    if (jsonString.length > maxChars) {
      return JSON.stringify({
        error: 'Output exceeds ' + maxChars + ' characters. Please specify a smaller depth or focus on a specific element using ref_id.',
        truncated: true,
        actualLength: jsonString.length,
      });
    }

    return jsonString;
  })(${JSON.stringify(options)})`
}
