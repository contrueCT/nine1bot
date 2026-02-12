/**
 * Page script: resolve ref ID to element coordinates
 * Extracted from browser-extension/src/tools/interaction.ts (getElementCoordinates)
 *
 * Usage:
 *   - CDP mode: Runtime.evaluate(buildResolveRefExpression(ref))
 *   - Extension mode: uses callExtensionTool("computer") which handles ref internally
 */

export interface ResolvedElement {
  x: number
  y: number
  width: number
  height: number
  centerX: number
  centerY: number
  tagName: string
  visible: boolean
}

/**
 * Build a JS expression that resolves a ref ID to element center coordinates.
 * Returns JSON with center coordinates, bounding rect, and visibility info.
 * Returns null (as JSON string "null") if element not found.
 */
export function buildResolveRefExpression(ref: string): string {
  return `(function(refId) {
    var element = document.querySelector('[data-mcp-ref="' + refId + '"]');
    if (!element) return JSON.stringify(null);

    var rect = element.getBoundingClientRect();
    var style = window.getComputedStyle(element);
    var visible = style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';

    return JSON.stringify({
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      centerX: Math.round(rect.x + rect.width / 2),
      centerY: Math.round(rect.y + rect.height / 2),
      tagName: element.tagName.toLowerCase(),
      visible: visible
    });
  })(${JSON.stringify(ref)})`
}

/**
 * Build a JS expression that scrolls a ref element into view.
 * Useful before clicking/interacting if element is off-screen.
 */
export function buildScrollIntoViewExpression(ref: string): string {
  return `(function(refId) {
    var element = document.querySelector('[data-mcp-ref="' + refId + '"]');
    if (!element) return JSON.stringify({ success: false, error: 'Element not found' });
    element.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    return JSON.stringify({ success: true });
  })(${JSON.stringify(ref)})`
}
