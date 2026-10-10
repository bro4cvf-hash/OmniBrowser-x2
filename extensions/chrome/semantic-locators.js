/**
 * Semantic Locator Resolution Engine (W3C AccName & ARIA Compliant)
 * Supporting:
 *   - role=<role>[name="<accessibleName>"]
 *   - label="<labelText>"
 *   - placeholder="<text>"
 *   - text="<visibleText>"
 *   - CSS selector fallback (with >>> shadow DOM piercing)
 * Strict ambiguity: throws AmbiguousLocatorError with candidate descriptions and coordinates when >1 match.
 */
(function (root) {
  'use strict';

  function normalizeWhitespace(text) {
    return (text || '').replace(/\s+/g, ' ').trim();
  }

  function escapeCss(str) {
    if (typeof CSS !== 'undefined' && CSS.escape) {
      return CSS.escape(str);
    }
    return String(str).replace(/([!"#$%&'()*+,.\/:;<=>?@[\\\]^`{|}~])/g, '\\$1');
  }

  function isHidden(element) {
    if (!element || element.nodeType !== 1) return false;
    if (element.getAttribute && element.getAttribute('aria-hidden') === 'true') return true;
    if (element.hidden === true || element.hasAttribute?.('hidden')) return true;
    if (element.style) {
      if (element.style.display === 'none' || element.style.visibility === 'hidden') return true;
    }
    if (typeof getComputedStyle === 'function') {
      try {
        const style = getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden') return true;
      } catch (_) {}
    }
    return false;
  }

  function getElementCoordinates(element) {
    if (element && typeof element.getBoundingClientRect === 'function') {
      try {
        const rect = element.getBoundingClientRect();
        return {
          x: rect.x ?? rect.left ?? 0,
          y: rect.y ?? rect.top ?? 0,
          width: rect.width ?? 0,
          height: rect.height ?? 0,
          top: rect.top ?? 0,
          left: rect.left ?? 0,
          bottom: rect.bottom ?? 0,
          right: rect.right ?? 0
        };
      } catch (_) {}
    }
    return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, bottom: 0, right: 0 };
  }

  class AmbiguousLocatorError extends Error {
    constructor(locatorStr, candidates) {
      const candidateList = candidates.map((el, index) => {
        const desc = describeElement(el);
        const coords = getElementCoordinates(el);
        return `  Candidate #${index + 1}: ${desc} at {x: ${coords.x}, y: ${coords.y}, width: ${coords.width}, height: ${coords.height}}`;
      }).join('\n');

      super(`Strict ambiguity error: locator "${locatorStr}" matched ${candidates.length} elements:\n${candidateList}`);
      this.name = 'AmbiguousLocatorError';
      this.locator = locatorStr;
      this.candidates = candidates.map(el => ({
        element: el,
        description: describeElement(el),
        coordinates: getElementCoordinates(el)
      }));
    }
  }

  function computeAccessibleRole(element) {
    if (!element || element.nodeType !== 1) return '';

    // 1. Explicit ARIA role
    const roleAttr = element.getAttribute && element.getAttribute('role');
    if (roleAttr && typeof roleAttr === 'string' && roleAttr.trim()) {
      const tokens = roleAttr.trim().split(/\s+/);
      if (tokens.length > 0 && tokens[0]) {
        return tokens[0].toLowerCase();
      }
    }

    // 2. Implicit role per HTML tag
    const tag = (element.tagName || '').toLowerCase();
    switch (tag) {
      case 'a':
      case 'area':
        return element.hasAttribute?.('href') ? 'link' : 'generic';
      case 'button':
        return 'button';
      case 'input': {
        const type = (element.getAttribute?.('type') || element.type || 'text').toLowerCase();
        switch (type) {
          case 'button':
          case 'submit':
          case 'reset':
          case 'image':
            return 'button';
          case 'checkbox':
            return 'checkbox';
          case 'radio':
            return 'radio';
          case 'search':
            return 'searchbox';
          case 'number':
            return 'spinbutton';
          case 'range':
            return 'slider';
          case 'hidden':
            return '';
          default:
            return 'textbox';
        }
      }
      case 'textarea':
        return 'textbox';
      case 'select': {
        const isMultiple = element.hasAttribute?.('multiple') || element.multiple;
        const size = parseInt(element.getAttribute?.('size') || element.size || '1', 10);
        return (isMultiple || size > 1) ? 'listbox' : 'combobox';
      }
      case 'option':
        return 'option';
      case 'optgroup':
        return 'group';
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6':
        return 'heading';
      case 'img':
        return 'img';
      case 'progress':
        return 'progressbar';
      case 'meter':
        return 'meter';
      case 'ul':
      case 'ol':
        return 'list';
      case 'li':
        return 'listitem';
      case 'table':
        return 'table';
      case 'thead':
      case 'tbody':
      case 'tfoot':
        return 'rowgroup';
      case 'tr':
        return 'row';
      case 'td':
        return 'cell';
      case 'th': {
        const scope = (element.getAttribute?.('scope') || '').toLowerCase();
        return scope === 'row' ? 'rowheader' : 'columnheader';
      }
      case 'nav':
        return 'navigation';
      case 'main':
        return 'main';
      case 'header':
        return 'banner';
      case 'footer':
        return 'contentinfo';
      case 'form':
        return 'form';
      case 'dialog':
        return 'dialog';
      case 'article':
        return 'article';
      case 'aside':
        return 'complementary';
      case 'section':
        return 'region';
      case 'figure':
        return 'figure';
      case 'summary':
        return 'button';
      case 'details':
        return 'group';
      case 'hr':
        return 'separator';
      default:
        return 'generic';
    }
  }

  const ROLES_ALLOWING_NAME_FROM_CONTENT = new Set([
    'button', 'link', 'heading', 'checkbox', 'radio', 'switch',
    'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
    'tab', 'tooltip', 'treeitem', 'cell', 'columnheader', 'rowheader',
    'listitem'
  ]);

  const TAGS_ALLOWING_NAME_FROM_CONTENT = new Set([
    'button', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'option', 'li', 'td', 'th', 'label', 'summary',
    'caption', 'figcaption', 'legend'
  ]);

  function getDocumentOf(node) {
    if (!node) return (typeof document !== 'undefined' ? document : null);
    return node.ownerDocument || (node.nodeType === 9 ? node : (typeof document !== 'undefined' ? document : null));
  }

  function findElementById(docOrRoot, id) {
    if (!id || !docOrRoot) return null;
    if (typeof docOrRoot.getElementById === 'function') {
      const el = docOrRoot.getElementById(id);
      if (el) return el;
    }
    if (typeof docOrRoot.querySelector === 'function') {
      try {
        const el = docOrRoot.querySelector('#' + escapeCss(id));
        if (el) return el;
      } catch (_) {}
    }
    return null;
  }

  function extractNodeText(node, visited = new Set(), excludedNode = null, isDirectlyReferenced = false) {
    if (!node || visited.has(node) || node === excludedNode) return '';
    if (!isDirectlyReferenced) {
      if (node.nodeType === 1 && isHidden(node)) return '';
    }
    visited.add(node);

    // Text node
    if (node.nodeType === 3) {
      return node.textContent || node.nodeValue || '';
    }

    if (node.nodeType !== 1) return '';

    const tag = (node.tagName || '').toLowerCase();
    if (['script', 'style', 'noscript', 'template'].includes(tag)) return '';

    // Check child aria-label: if a child element has aria-label, use its normalized aria-label rather than its raw text content
    if (!isDirectlyReferenced) {
      const childAriaLabel = node.getAttribute?.('aria-label');
      if (childAriaLabel && childAriaLabel.trim()) {
        return normalizeWhitespace(childAriaLabel);
      }
    }

    // If image, use alt attribute
    if (tag === 'img') {
      return node.getAttribute?.('alt') || '';
    }

    // Children recursion
    const childNodes = node.childNodes || [];
    const parts = [];
    for (let i = 0; i < childNodes.length; i++) {
      const child = childNodes[i];
      if (child === excludedNode) continue;
      const text = extractNodeText(child, visited, excludedNode);
      if (text) parts.push(text);
    }
    return parts.join(' ');
  }

  function computeAccessibleName(element, context = {}) {
    if (!element || element.nodeType !== 1) return '';

    const visited = context.visited || new Set();
    if (visited.has(element)) return '';
    visited.add(element);

    const isReferenced = !!context.isReferenced;

    // Step 2A: Hidden check (unless referenced by aria-labelledby)
    if (!isReferenced && isHidden(element)) {
      return '';
    }

    const doc = getDocumentOf(element);

    // Step 2B: aria-labelledby
    if (!isReferenced) {
      const labelledBy = element.getAttribute?.('aria-labelledby');
      if (labelledBy && labelledBy.trim()) {
        const ids = labelledBy.trim().split(/\s+/);
        const nameParts = [];
        for (const id of ids) {
          const refEl = findElementById(doc, id);
          if (refEl) {
            const part = computeAccessibleName(refEl, { isReferenced: true, visited: new Set(visited) });
            if (part) nameParts.push(part);
          }
        }
        if (nameParts.length > 0) {
          return normalizeWhitespace(nameParts.join(' '));
        }
      }
    }

    // Step 2C: aria-label
    const ariaLabel = element.getAttribute?.('aria-label');
    if (ariaLabel && ariaLabel.trim()) {
      return normalizeWhitespace(ariaLabel);
    }

    // Step 2D: Native host language markup
    const tag = (element.tagName || '').toLowerCase();

    // Form elements: associated <label>
    if (['input', 'textarea', 'select', 'progress', 'meter'].includes(tag)) {
      // 1. element.labels collection
      if (element.labels && element.labels.length) {
        const labelTexts = Array.from(element.labels)
          .map(lbl => extractNodeText(lbl, new Set(), element))
          .filter(Boolean);
        if (labelTexts.length > 0) {
          return normalizeWhitespace(labelTexts.join(' '));
        }
      }

      // 2. label[for=id]
      if (element.id && doc && typeof doc.querySelectorAll === 'function') {
        try {
          const matchingLabels = doc.querySelectorAll(`label[for="${escapeCss(element.id)}"]`);
          if (matchingLabels && matchingLabels.length > 0) {
            const labelTexts = Array.from(matchingLabels)
              .map(lbl => extractNodeText(lbl, new Set(), element))
              .filter(Boolean);
            if (labelTexts.length > 0) {
              return normalizeWhitespace(labelTexts.join(' '));
            }
          }
        } catch (_) {}
      }

      // 3. Ancestor wrapping <label>
      let parent = element.parentElement;
      while (parent) {
        if ((parent.tagName || '').toLowerCase() === 'label') {
          const labelText = extractNodeText(parent, new Set(), element);
          if (labelText) {
            return normalizeWhitespace(labelText);
          }
          break;
        }
        parent = parent.parentElement;
      }

      // Input button types: value or default
      if (tag === 'input') {
        const type = (element.getAttribute?.('type') || element.type || 'text').toLowerCase();
        if (type === 'button') {
          const val = element.getAttribute?.('value') || element.value;
          if (val) return normalizeWhitespace(val);
        } else if (type === 'submit') {
          const val = element.getAttribute?.('value') || element.value;
          return normalizeWhitespace(val || 'Submit');
        } else if (type === 'reset') {
          const val = element.getAttribute?.('value') || element.value;
          return normalizeWhitespace(val || 'Reset');
        } else if (type === 'image') {
          const alt = element.getAttribute?.('alt');
          if (alt !== undefined && alt !== null) return normalizeWhitespace(alt);
          const val = element.getAttribute?.('value') || element.value;
          return normalizeWhitespace(val || 'Submit');
        }
      }
    }

    // Images
    if (tag === 'img' || tag === 'area') {
      if (element.hasAttribute?.('alt')) {
        return normalizeWhitespace(element.getAttribute?.('alt') || '');
      }
    }

    // SVG title
    if (tag === 'svg') {
      const titleEl = element.querySelector?.('title');
      if (titleEl && titleEl.textContent) {
        return normalizeWhitespace(titleEl.textContent);
      }
    }

    // Table caption
    if (tag === 'table') {
      const caption = element.querySelector?.('caption');
      if (caption && caption.textContent) {
        return normalizeWhitespace(caption.textContent);
      }
    }

    // Fieldset legend
    if (tag === 'fieldset') {
      const legend = element.querySelector?.('legend');
      if (legend && legend.textContent) {
        return normalizeWhitespace(legend.textContent);
      }
    }

    // Figure figcaption
    if (tag === 'figure') {
      const figcaption = element.querySelector?.('figcaption');
      if (figcaption && figcaption.textContent) {
        return normalizeWhitespace(figcaption.textContent);
      }
    }

    // Details summary
    if (tag === 'details') {
      const summary = element.querySelector?.('summary');
      if (summary && summary.textContent) {
        return normalizeWhitespace(summary.textContent);
      }
    }

    // Step 2F: Subtree text (name from contents)
    const role = computeAccessibleRole(element);
    if (isReferenced || ROLES_ALLOWING_NAME_FROM_CONTENT.has(role) || TAGS_ALLOWING_NAME_FROM_CONTENT.has(tag)) {
      const contentText = extractNodeText(element, new Set(), null, isReferenced);
      if (contentText && contentText.trim()) {
        return normalizeWhitespace(contentText);
      }
    }

    // Step 2G: Placeholder
    if (['input', 'textarea'].includes(tag)) {
      const placeholder = element.getAttribute?.('placeholder') || element.placeholder;
      if (placeholder && placeholder.trim()) {
        return normalizeWhitespace(placeholder);
      }
    }

    // Step 2H: Title
    const title = element.getAttribute?.('title');
    if (title && title.trim()) {
      return normalizeWhitespace(title);
    }

    return '';
  }

  function describeElement(element) {
    if (!element || element.nodeType !== 1) return '<unknown>';
    const tag = (element.tagName || '').toLowerCase();
    const id = element.id ? `#${element.id}` : (element.getAttribute?.('id') ? `#${element.getAttribute('id')}` : '');
    const className = typeof element.className === 'string' && element.className.trim()
      ? `.${element.className.trim().split(/\s+/).join('.')}`
      : '';
    const type = (element.type || element.getAttribute?.('type')) ? `[type="${element.type || element.getAttribute('type')}"]` : '';
    const role = computeAccessibleRole(element);
    const name = computeAccessibleName(element);

    const tokens = [`<${tag}${id}${className}${type}>`];
    if (role && role !== 'generic') tokens.push(`role="${role}"`);
    if (name) tokens.push(`name="${name}"`);
    return tokens.join(' ');
  }

  function parseLocator(dslOrObj) {
    if (!dslOrObj) {
      throw new Error('Locator must be a non-empty string or object');
    }

    // Object form
    if (typeof dslOrObj === 'object') {
      if (dslOrObj.role !== undefined) {
        return {
          type: 'role',
          role: String(dslOrObj.role).toLowerCase(),
          name: dslOrObj.name !== undefined ? String(dslOrObj.name) : undefined,
          raw: JSON.stringify(dslOrObj)
        };
      }
      if (dslOrObj.label !== undefined) {
        return {
          type: 'label',
          label: String(dslOrObj.label),
          raw: JSON.stringify(dslOrObj)
        };
      }
      if (dslOrObj.placeholder !== undefined) {
        return {
          type: 'placeholder',
          placeholder: String(dslOrObj.placeholder),
          raw: JSON.stringify(dslOrObj)
        };
      }
      if (dslOrObj.text !== undefined) {
        return {
          type: 'text',
          text: String(dslOrObj.text),
          raw: JSON.stringify(dslOrObj)
        };
      }
      if (dslOrObj.css !== undefined || dslOrObj.selector !== undefined) {
        return {
          type: 'css',
          selector: String(dslOrObj.css || dslOrObj.selector),
          raw: JSON.stringify(dslOrObj)
        };
      }
      throw new Error('Unsupported locator object properties: ' + JSON.stringify(dslOrObj));
    }

    if (typeof dslOrObj !== 'string') {
      throw new Error('Locator must be a string or object, got: ' + typeof dslOrObj);
    }

    const trimmed = dslOrObj.trim();

    // 1. role=<role>[name="<accessibleName>"] or role=<role>
    const roleMatch = trimmed.match(/^role=([a-zA-Z0-9_-]+)(?:\[name=(?:"([^"]*)"|'([^']*)'|([^\]]+))\])?$/);
    if (roleMatch) {
      const role = roleMatch[1].toLowerCase();
      const name = roleMatch[2] !== undefined ? roleMatch[2] : (roleMatch[3] !== undefined ? roleMatch[3] : roleMatch[4]);
      return {
        type: 'role',
        role,
        name: name !== undefined ? name : undefined,
        raw: trimmed
      };
    }

    // 2. label="<labelText>"
    const labelMatch = trimmed.match(/^label=(?:"([^"]*)"|'([^']*)'|(.+))$/);
    if (labelMatch) {
      const label = labelMatch[1] !== undefined ? labelMatch[1] : (labelMatch[2] !== undefined ? labelMatch[2] : labelMatch[3]);
      return {
        type: 'label',
        label,
        raw: trimmed
      };
    }

    // 3. placeholder="<text>"
    const placeholderMatch = trimmed.match(/^placeholder=(?:"([^"]*)"|'([^']*)'|(.+))$/);
    if (placeholderMatch) {
      const placeholder = placeholderMatch[1] !== undefined ? placeholderMatch[1] : (placeholderMatch[2] !== undefined ? placeholderMatch[2] : placeholderMatch[3]);
      return {
        type: 'placeholder',
        placeholder,
        raw: trimmed
      };
    }

    // 4. text="<visibleText>"
    const textMatch = trimmed.match(/^text=(?:"([^"]*)"|'([^']*)'|(.+))$/);
    if (textMatch) {
      const text = textMatch[1] !== undefined ? textMatch[1] : (textMatch[2] !== undefined ? textMatch[2] : textMatch[3]);
      return {
        type: 'text',
        text,
        raw: trimmed
      };
    }

    // 5. CSS selector fallback
    return {
      type: 'css',
      selector: trimmed,
      raw: trimmed
    };
  }

  function getAllElements(rootNode) {
    const elements = [];
    const roots = [];
    if (rootNode) {
      roots.push(rootNode);
      if (rootNode.nodeType === 1) {
        elements.push(rootNode);
        if (rootNode.shadowRoot) roots.push(rootNode.shadowRoot);
      }
    }
    const visitedRoots = new Set(roots);

    for (let i = 0; i < roots.length; i++) {
      const current = roots[i];
      let nodes = [];
      if (typeof current.querySelectorAll === 'function') {
        try {
          nodes = Array.from(current.querySelectorAll('*'));
        } catch (_) {}
      } else if (current.childNodes) {
        const stack = Array.from(current.childNodes);
        while (stack.length) {
          const item = stack.shift();
          if (item && item.nodeType === 1) {
            nodes.push(item);
            if (item.childNodes) stack.unshift(...Array.from(item.childNodes));
          }
        }
      }

      for (const node of nodes) {
        elements.push(node);
        if (node.shadowRoot && !visitedRoots.has(node.shadowRoot)) {
          visitedRoots.add(node.shadowRoot);
          roots.push(node.shadowRoot);
        }
      }
    }
    return elements;
  }

  function queryCssWithShadow(selector, rootNode) {
    const parts = selector.split(' >>> ');
    let currentRoots = [rootNode];

    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      const nextRoots = [];
      for (const r of currentRoots) {
        const hosts = typeof r.querySelectorAll === 'function' ? Array.from(r.querySelectorAll(part)) : [];
        for (const h of hosts) {
          if (h.shadowRoot) nextRoots.push(h.shadowRoot);
        }
      }
      currentRoots = nextRoots;
    }

    const finalSelector = parts[parts.length - 1];
    const results = [];
    for (const r of currentRoots) {
      if (typeof r.querySelectorAll === 'function') {
        results.push(...Array.from(r.querySelectorAll(finalSelector)));
      }
    }
    return results;
  }

  function resolveAllLocators(dslOrObj, rootNode) {
    const root = rootNode || (typeof document !== 'undefined' ? document : null);
    if (!root) {
      throw new Error('A rootNode is required when global document is undefined');
    }

    const parsed = parseLocator(dslOrObj);
    const all = getAllElements(root);

    switch (parsed.type) {
      case 'role': {
        const targetRole = parsed.role;
        const targetName = parsed.name !== undefined ? normalizeWhitespace(parsed.name) : undefined;

        const roleMatches = all.filter(el => computeAccessibleRole(el) === targetRole);
        if (targetName === undefined) {
          return roleMatches;
        }

        // Exact accessible name match
        const exactMatches = roleMatches.filter(el => normalizeWhitespace(computeAccessibleName(el)) === targetName);
        if (exactMatches.length > 0) return exactMatches;

        // Case-insensitive fallback
        const lowerTarget = targetName.toLowerCase();
        return roleMatches.filter(el => normalizeWhitespace(computeAccessibleName(el)).toLowerCase() === lowerTarget);
      }

      case 'label': {
        const targetLabel = normalizeWhitespace(parsed.label);
        const lowerTarget = targetLabel.toLowerCase();
        const doc = getDocumentOf(root);

        const candidates = new Set();

        // 1. Check <label> elements matching text
        const labels = all.filter(el => (el.tagName || '').toLowerCase() === 'label');
        for (const lbl of labels) {
          const lblText = normalizeWhitespace(extractNodeText(lbl, new Set()));
          if (lblText === targetLabel || lblText.toLowerCase() === lowerTarget) {
            // Associated control via for attribute
            const forId = lbl.getAttribute?.('for') || lbl.htmlFor;
            if (forId) {
              const target = findElementById(doc, forId);
              if (target) candidates.add(target);
            }
            // Control nested inside label
            if (typeof lbl.querySelector === 'function') {
              const nested = lbl.querySelector('input, textarea, select, button, [role]');
              if (nested) candidates.add(nested);
            }
          }
        }

        // 2. Elements with labels property
        for (const el of all) {
          if (el.labels && el.labels.length) {
            for (const lbl of Array.from(el.labels)) {
              const lblText = normalizeWhitespace(extractNodeText(lbl, new Set()));
              if (lblText === targetLabel || lblText.toLowerCase() === lowerTarget) {
                candidates.add(el);
              }
            }
          }
        }

        // 3. Form elements or controls with aria-label or aria-labelledby or accessible name
        for (const el of all) {
          const ariaLabel = normalizeWhitespace(el.getAttribute?.('aria-label') || '');
          if (ariaLabel === targetLabel || ariaLabel.toLowerCase() === lowerTarget) {
            candidates.add(el);
            continue;
          }

          const accName = normalizeWhitespace(computeAccessibleName(el));
          if (accName === targetLabel || accName.toLowerCase() === lowerTarget) {
            const role = computeAccessibleRole(el);
            const tag = (el.tagName || '').toLowerCase();
            if (['input', 'textarea', 'select', 'button'].includes(tag) ||
                ['textbox', 'combobox', 'listbox', 'checkbox', 'radio', 'button'].includes(role)) {
              candidates.add(el);
            }
          }
        }

        return Array.from(candidates);
      }

      case 'placeholder': {
        const targetPlaceholder = normalizeWhitespace(parsed.placeholder);
        const lowerTarget = targetPlaceholder.toLowerCase();

        const exact = all.filter(el => {
          const ph = el.getAttribute?.('placeholder') || el.placeholder;
          return ph !== undefined && normalizeWhitespace(ph) === targetPlaceholder;
        });
        if (exact.length > 0) return exact;

        return all.filter(el => {
          const ph = el.getAttribute?.('placeholder') || el.placeholder;
          return ph !== undefined && normalizeWhitespace(ph).toLowerCase() === lowerTarget;
        });
      }

      case 'text': {
        const targetText = normalizeWhitespace(parsed.text);
        const lowerTarget = targetText.toLowerCase();

        const filterLeafMatches = (matchingElements) => {
          return matchingElements.filter(el => {
            return !matchingElements.some(other => other !== el && el.contains?.(other));
          });
        };

        const exact = all.filter(el => {
          const tag = (el.tagName || '').toLowerCase();
          if (['script', 'style', 'noscript', 'template'].includes(tag)) return false;
          const text = normalizeWhitespace(el.innerText || el.textContent || '');
          return text === targetText;
        });

        if (exact.length > 0) {
          return filterLeafMatches(exact);
        }

        const caseInsensitive = all.filter(el => {
          const tag = (el.tagName || '').toLowerCase();
          if (['script', 'style', 'noscript', 'template'].includes(tag)) return false;
          const text = normalizeWhitespace(el.innerText || el.textContent || '');
          return text.toLowerCase() === lowerTarget;
        });

        return filterLeafMatches(caseInsensitive);
      }

      case 'css': {
        return queryCssWithShadow(parsed.selector, root);
      }

      default:
        return [];
    }
  }

  function resolveLocator(dslOrObj, rootNode, options = {}) {
    const parsed = parseLocator(dslOrObj);
    const matches = resolveAllLocators(dslOrObj, rootNode);

    if (matches.length > 1) {
      if (options.strict !== false) {
        throw new AmbiguousLocatorError(parsed.raw, matches);
      }
      return matches[0];
    }

    if (matches.length === 1) {
      return matches[0];
    }

    if (options.required) {
      throw new Error(`No element matching locator: "${parsed.raw}"`);
    }

    return null;
  }

  const api = {
    resolveLocator,
    resolveAllLocators,
    computeAccessibleName,
    computeAccessibleRole,
    parseLocator,
    describeElement,
    getElementCoordinates,
    AmbiguousLocatorError
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.SemanticLocators = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
