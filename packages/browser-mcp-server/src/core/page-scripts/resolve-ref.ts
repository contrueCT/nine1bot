/**
 * Page script: resolve ref ID to element coordinates
 * Extracted from browser-extension/src/tools/interaction.ts (getElementCoordinates)
 *
 * Usage:
 *   - CDP mode: Runtime.evaluate(buildResolveRefExpression(ref))
 *   - Extension mode: uses callExtensionTool("computer") which handles ref internally
 */

export interface ResolvedElement {
  found: boolean
  x?: number
  y?: number
  width?: number
  height?: number
  centerX?: number
  centerY?: number
  tagName?: string
  originalTagName?: string
  visible?: boolean
  resolution?: 'self' | 'descendant' | 'ancestor'
  usedFallbackTarget?: boolean
  reason?: 'stale_ref' | 'no_refs_on_page'
  message?: string
}

function buildResolveRefHelpers(): string {
  return `
    function isVisibleElement(element) {
      if (!element) return false;
      var style = window.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      var rect = element.getBoundingClientRect();
      return !(rect.width === 0 && rect.height === 0);
    }

    function isDisabledElement(element) {
      return Boolean(
        (typeof element.disabled === 'boolean' && element.disabled)
        || element.getAttribute('disabled') !== null
        || element.getAttribute('aria-disabled') === 'true'
      );
    }

    function isActionableElement(element) {
      if (!element || isDisabledElement(element)) return false;

      var tagName = element.tagName.toLowerCase();
      if (tagName === 'a' && element.href) return true;
      if (['button', 'input', 'select', 'textarea', 'summary'].indexOf(tagName) !== -1) return true;

      var role = (element.getAttribute('role') || '').toLowerCase();
      if (/button|link|checkbox|radio|textbox|combobox|listbox|menuitem|tab|switch/.test(role)) return true;

      var tabIndex = element.getAttribute('tabindex');
      if (tabIndex !== null && tabIndex !== '-1') return true;

      if (element.getAttribute('onclick') || element.getAttribute('onkeydown') || element.getAttribute('onkeyup')) return true;

      return false;
    }

    function getActionableScore(element) {
      if (!isActionableElement(element) || !isVisibleElement(element)) return -1;

      var tagName = element.tagName.toLowerCase();
      var score = 0;

      if (tagName === 'button') score += 60;
      else if (tagName === 'a') score += 55;
      else if (tagName === 'input') score += 50;
      else if (tagName === 'select' || tagName === 'textarea') score += 45;
      else if (tagName === 'summary') score += 35;

      var role = (element.getAttribute('role') || '').toLowerCase();
      if (role === 'button' || role === 'link') score += 35;
      else if (role) score += 20;

      if (element.getAttribute('onclick')) score += 20;

      var tabIndex = element.getAttribute('tabindex');
      if (tabIndex !== null && tabIndex !== '-1') score += 10;

      var text = (element.textContent || '').trim();
      if (text.length > 0) score += 5;

      return score;
    }

    function findBestActionableDescendant(root) {
      var best = null;
      var bestScore = -1;
      var queue = [];

      for (var i = 0; i < root.children.length; i++) {
        queue.push({ element: root.children[i], depth: 1 });
      }

      while (queue.length > 0) {
        var current = queue.shift();
        var candidate = current.element;
        var score = getActionableScore(candidate);
        if (score >= 0) {
          score -= current.depth * 2;
          if (score > bestScore) {
            best = candidate;
            bestScore = score;
          }
        }

        for (var j = 0; j < candidate.children.length; j++) {
          queue.push({ element: candidate.children[j], depth: current.depth + 1 });
        }
      }

      return best;
    }

    function findNearestActionableAncestor(element) {
      var current = element.parentElement;
      while (current) {
        if (getActionableScore(current) >= 0) return current;
        current = current.parentElement;
      }
      return null;
    }

    function buildMissingRefResult(refId) {
      var hasAnyRefs = Boolean(document.querySelector('[data-mcp-ref]'));
      return {
        found: false,
        reason: hasAnyRefs ? 'stale_ref' : 'no_refs_on_page',
        message: hasAnyRefs
          ? 'Element with ref "' + refId + '" not found. This ref is likely stale after a later snapshot/find call or a DOM re-render. Re-run browser_snapshot/browser_find before interacting.'
          : 'Element with ref "' + refId + '" not found and the page currently has no ref markers. Run browser_snapshot/browser_find before interacting, or re-snapshot after navigation.'
      };
    }

    function resolveRefTarget(refId) {
      var element = document.querySelector('[data-mcp-ref="' + refId + '"]');
      if (!element) return buildMissingRefResult(refId);

      var target = null;
      var resolution = 'self';

      if (getActionableScore(element) >= 0) {
        target = element;
      } else {
        target = findBestActionableDescendant(element);
        if (target) {
          resolution = 'descendant';
        } else {
          target = findNearestActionableAncestor(element);
          if (target) resolution = 'ancestor';
        }
      }

      if (!target) target = element;

      var rect = target.getBoundingClientRect();
      return {
        found: true,
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        centerX: Math.round(rect.x + rect.width / 2),
        centerY: Math.round(rect.y + rect.height / 2),
        tagName: target.tagName.toLowerCase(),
        originalTagName: element.tagName.toLowerCase(),
        visible: isVisibleElement(target),
        resolution: resolution,
        usedFallbackTarget: target !== element,
        message: target !== element
          ? 'Resolved ref "' + refId + '" from ' + element.tagName.toLowerCase() + ' to clickable ' + target.tagName.toLowerCase() + '.'
          : undefined
      };
    }
  `
}

/**
 * Build a JS expression that resolves a ref ID to element center coordinates.
 * Returns JSON with center coordinates, bounding rect, visibility info,
 * and whether the ref had to be resolved to a descendant/ancestor.
 */
export function buildResolveRefExpression(ref: string): string {
  const helpers = buildResolveRefHelpers()
  return `(function(refId) {
    ${helpers}
    return JSON.stringify(resolveRefTarget(refId));
  })(${JSON.stringify(ref)})`
}

/**
 * Build a JS expression that scrolls a ref element into view.
 * Useful before clicking/interacting if element is off-screen.
 */
export function buildScrollIntoViewExpression(ref: string): string {
  const helpers = buildResolveRefHelpers()
  return `(function(refId) {
    ${helpers}
    var resolved = resolveRefTarget(refId);
    if (!resolved.found) return JSON.stringify({ success: false, error: resolved.message, reason: resolved.reason });

    var target = document.querySelector('[data-mcp-ref="' + refId + '"]');
    if (resolved.resolution === 'descendant' && target) {
      target = findBestActionableDescendant(target) || target;
    } else if (resolved.resolution === 'ancestor' && target) {
      target = findNearestActionableAncestor(target) || target;
    }

    if (!target) return JSON.stringify({ success: false, error: 'Element target could not be resolved for scrolling' });

    target.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    return JSON.stringify({ success: true });
  })(${JSON.stringify(ref)})`
}
