/**
 * Page script: form filling
 * Extracted from browser-extension/src/tools/form-input.ts
 *
 * Handles HTMLInputElement (text/checkbox/radio), HTMLTextAreaElement,
 * HTMLSelectElement (single/multi), and contenteditable elements.
 * Dispatches input and change events after setting values.
 *
 * Usage:
 *   - Extension mode: callExtensionTool("form_input", { ref, value })
 *   - CDP mode: Runtime.evaluate(buildFormFillExpression(ref, value))
 */

export interface FormFillResult {
  success: boolean
  error?: string
  elementType?: string
  inputType?: string
}

/**
 * Build a JS expression that fills a form element identified by ref.
 * Dispatches appropriate input/change events.
 * Returns JSON with { success, error?, elementType?, inputType? }.
 */
export function buildFormFillExpression(ref: string, value: unknown): string {
  return `(function(refId, inputValue) {
    var element = document.querySelector('[data-mcp-ref="' + refId + '"]');

    if (!element) {
      return JSON.stringify({ success: false, error: 'Element with ref "' + refId + '" not found' });
    }

    try {
      if (element instanceof HTMLInputElement) {
        var inputType = element.type.toLowerCase();

        if (inputType === 'checkbox') {
          element.checked = Boolean(inputValue);
          element.dispatchEvent(new Event('change', { bubbles: true }));
        } else if (inputType === 'radio') {
          element.checked = Boolean(inputValue);
          element.dispatchEvent(new Event('change', { bubbles: true }));
        } else if (inputType === 'file') {
          return JSON.stringify({ success: false, error: 'Cannot set file input value programmatically. Use browser_upload instead.' });
        } else {
          element.focus();
          element.value = String(inputValue);
          element.dispatchEvent(new Event('input', { bubbles: true }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
        }
      } else if (element instanceof HTMLTextAreaElement) {
        element.focus();
        element.value = String(inputValue);
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (element instanceof HTMLSelectElement) {
        if (Array.isArray(inputValue)) {
          for (var i = 0; i < element.options.length; i++) {
            element.options[i].selected = inputValue.indexOf(element.options[i].value) !== -1;
          }
        } else {
          element.value = String(inputValue);
        }
        element.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (element.getAttribute('contenteditable') === 'true') {
        element.focus();
        element.textContent = String(inputValue);
        element.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        element.focus();
        element.value = String(inputValue);
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      }

      return JSON.stringify({
        success: true,
        elementType: element.tagName.toLowerCase(),
        inputType: element.type || undefined,
      });
    } catch (e) {
      return JSON.stringify({ success: false, error: String(e) });
    }
  })(${JSON.stringify(ref)}, ${JSON.stringify(value)})`
}
