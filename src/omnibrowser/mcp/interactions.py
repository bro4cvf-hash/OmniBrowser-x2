"""Small DOM scripts used by the browser tools. No page-side dependencies."""

import json

RESOLVE_LOCATOR_SCRIPT = r"""
function resolveLocator(locator, root = (typeof document !== 'undefined' ? document : null)) {
  if (typeof locator !== 'string' || !locator.trim()) return [];
  if (!root) return [];
  const trimmed = locator.trim();

  if (trimmed.includes('>>>')) {
    const parts = trimmed.split(/\s*>>>\s*/);
    let currentRoot = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const hosts = resolveLocator(parts[i], currentRoot);
      if (hosts.length !== 1 || !hosts[0].shadowRoot) return [];
      currentRoot = hosts[0].shadowRoot;
    }
    return resolveLocator(parts[parts.length - 1], currentRoot);
  }

  const norm = str => (str || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const unquote = str => {
    if (!str) return '';
    const s = str.trim();
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
      return s.slice(1, -1);
    }
    return s;
  };

  const getAccName = el => {
    const ariaLabel = el.getAttribute ? el.getAttribute('aria-label') : null;
    if (ariaLabel) return ariaLabel.trim();
    const ariaBy = el.getAttribute ? el.getAttribute('aria-labelledby') : null;
    if (ariaBy) {
      const doc = el.ownerDocument || (typeof document !== 'undefined' ? document : (root?.ownerDocument || root));
      const parts = ariaBy.split(/\s+/).map(id => {
        const target = doc.getElementById ? doc.getElementById(id) : null;
        return target ? (target.innerText || target.textContent || '').trim() : '';
      }).filter(Boolean);
      if (parts.length) return parts.join(' ');
    }
    if (el.labels && el.labels.length) {
      const text = Array.from(el.labels).map(l => l.innerText || l.textContent || '').join(' ').trim();
      if (text) return text;
    }
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'input' && ['button', 'submit', 'reset'].includes((el.type || '').toLowerCase())) {
      if (el.value) return el.value.trim();
    }
    if (tag === 'img' && el.getAttribute && el.getAttribute('alt')) {
      return el.getAttribute('alt').trim();
    }
    const text = (el.innerText || el.textContent || '').trim();
    if (text) return text;
    if (el.placeholder) return el.placeholder.trim();
    if (el.getAttribute && el.getAttribute('title')) return el.getAttribute('title').trim();
    if (el.name) return el.name.trim();
    return '';
  };

  const getRole = el => {
    const explicit = el.getAttribute ? el.getAttribute('role') : null;
    if (explicit) return explicit.trim().toLowerCase();
    const tag = (el.tagName || '').toLowerCase();
    const type = (el.type || '').toLowerCase();
    if (tag === 'button') return 'button';
    if (tag === 'input') {
      if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'number') return 'spinbutton';
      if (type === 'range') return 'slider';
      if (type === 'search') return 'searchbox';
      if (!type || ['text', 'email', 'tel', 'url', 'password'].includes(type)) return 'textbox';
    }
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    if (tag === 'a' && el.hasAttribute && el.hasAttribute('href')) return 'link';
    if (tag === 'img') return 'img';
    if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tag)) return 'heading';
    if (['ul', 'ol'].includes(tag)) return 'list';
    if (tag === 'li') return 'listitem';
    if (tag === 'option') return 'option';
    if (tag === 'dialog') return 'dialog';
    if (el.isContentEditable) return 'textbox';
    return '';
  };

  const roleMatch = trimmed.match(/^role=([a-zA-Z0-9_-]+)(?:\[name=(?:"([^"]*)"|'([^']*)'|([^\]]+))\])?$/i);
  if (roleMatch) {
    const targetRole = roleMatch[1].toLowerCase();
    const rawName = roleMatch[2] ?? roleMatch[3] ?? roleMatch[4];
    const targetName = rawName !== undefined ? norm(unquote(rawName)) : null;
    const all = Array.from(root.querySelectorAll('*'));
    return all.filter(el => {
      if (getRole(el) !== targetRole) return false;
      if (targetName !== null) {
        return norm(getAccName(el)) === targetName;
      }
      return true;
    });
  }

  const labelMatch = trimmed.match(/^label=(?:"([^"]*)"|'([^']*)'|([\s\S]+))$/i);
  if (labelMatch) {
    const targetLabel = norm(unquote(labelMatch[1] ?? labelMatch[2] ?? labelMatch[3]));
    const matched = new Set();
    const all = Array.from(root.querySelectorAll('*'));
    for (const el of all) {
      if (el.getAttribute && norm(el.getAttribute('aria-label')) === targetLabel) {
        matched.add(el);
      }
      if (el.labels && el.labels.length) {
        for (const l of el.labels) {
          if (norm(l.innerText || l.textContent) === targetLabel) matched.add(el);
        }
      }
      if ((el.tagName || '').toLowerCase() === 'label' && norm(el.innerText || el.textContent) === targetLabel) {
        if (el.htmlFor) {
          const doc = el.ownerDocument || (typeof document !== 'undefined' ? document : (root?.ownerDocument || root));
          const target = doc.getElementById ? doc.getElementById(el.htmlFor) : null;
          if (target) matched.add(target);
        } else if (el.querySelector) {
          const control = el.querySelector('input, textarea, select, button, [contenteditable="true"]');
          if (control) matched.add(control);
        }
      }
    }
    return Array.from(matched);
  }

  const textMatch = trimmed.match(/^text=(?:"([^"]*)"|'([^']*)'|([\s\S]+))$/i);
  if (textMatch) {
    const targetText = norm(unquote(textMatch[1] ?? textMatch[2] ?? textMatch[3]));
    const all = Array.from(root.querySelectorAll('*'));
    const candidates = all.filter(el => {
      const tag = (el.tagName || '').toLowerCase();
      if (tag === 'input' && ['button', 'submit', 'reset'].includes((el.type || '').toLowerCase())) {
        return norm(el.value) === targetText;
      }
      const txt = (el.innerText || el.textContent || '');
      return norm(txt) === targetText;
    });
    return candidates.filter(el => !candidates.some(other => other !== el && el.contains?.(other)));
  }

  const placeholderMatch = trimmed.match(/^placeholder=(?:"([^"]*)"|'([^']*)'|([\s\S]+))$/i);
  if (placeholderMatch) {
    const targetPlaceholder = norm(unquote(placeholderMatch[1] ?? placeholderMatch[2] ?? placeholderMatch[3]));
    const all = Array.from(root.querySelectorAll('*'));
    return all.filter(el => (el.getAttribute && norm(el.getAttribute('placeholder')) === targetPlaceholder) || norm(el.placeholder) === targetPlaceholder);
  }

  if (trimmed.startsWith('css=')) {
    try {
      return Array.from(root.querySelectorAll(trimmed.slice(4)));
    } catch {
      return [];
    }
  }

  try {
    return Array.from(root.querySelectorAll(trimmed));
  } catch {
    return [];
  }
}
"""

ACTION_SCRIPT = (
    r"""
(actions => {
"""
    + RESOLVE_LOCATOR_SCRIPT
    + r"""
  const results = [];
  const resolveRef = (selector, action) => {
    const refs = window.__omnibrowser_refs;
    if (!refs || !refs.map) throw new Error('Reference map not initialized: ' + selector);
    const match = selector.match(/^@e(\d+)(?:[@:_]g?(\d+))?$/);
    if (!match) throw new Error('Invalid element reference format: ' + selector);
    const refKey = '@e' + match[1];
    const entry = refs.map[refKey] || refs.map[selector];
    if (!entry) throw new Error('Element reference not found: ' + selector);
    const expectedGen = match[2] ? parseInt(match[2], 10) : (action && action.generation !== undefined ? action.generation : null);
    if (expectedGen !== null && expectedGen !== entry.generation) {
      throw new Error('Stale element reference generation: ' + selector);
    }
    if (entry.generation !== refs.generation) {
      throw new Error('Stale element reference generation: ' + selector);
    }
    if (entry.document && entry.document !== document) {
      throw new Error('Stale element reference: document navigated');
    }
    const el = entry.el || entry;
    if (!el || !el.isConnected) {
      throw new Error('Stale element reference: element is no longer attached to DOM');
    }
    return el;
  };
  const find = (selector, action) => {
    let el;
    if (typeof selector === 'string' && selector.startsWith('@e')) {
      el = resolveRef(selector, action);
    } else {
      const matches = resolveLocator(selector);
      if (matches.length > 1) throw new Error('Selector matches multiple elements: ' + selector);
      el = matches[0];
      if (!el) throw new Error('Element not found: ' + selector);
    }
    if (el.disabled || el.readOnly || el.getAttribute?.('aria-disabled') === 'true' || el.closest?.('[aria-disabled="true"]')) throw new Error('Element is disabled or read-only');
    return el;
  };
  for (let index = 0; index < actions.length; index++) {
    const action = actions[index];
    try {
      if (action.action === 'scroll') {
        window.scrollBy(action.x || 0, action.y || 0);
      } else {
        const el = find(action.selector, action);
        if (action.action === 'click') {
          el.scrollIntoView({block: 'center'});
          if (!el.getClientRects().length) throw new Error('Element is hidden');
          el.click();
        } else if (action.action === 'fill') {
          if (typeof HTMLInputElement !== 'undefined' && el instanceof HTMLInputElement &&
              ['file','checkbox','radio','button','submit','reset','image','hidden'].includes(el.type))
            throw new Error('Use the dedicated tool for this input type');
          if ((typeof HTMLInputElement !== 'undefined' && el instanceof HTMLInputElement) ||
              (typeof HTMLTextAreaElement !== 'undefined' && el instanceof HTMLTextAreaElement)) {
            const proto = (typeof HTMLTextAreaElement !== 'undefined' && el instanceof HTMLTextAreaElement)
              ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const desc = Object.getOwnPropertyDescriptor(proto, 'value');
            if (desc && desc.set) desc.set.call(el, action.value);
            else el.value = action.value;
          } else if (el.isContentEditable) {
            el.textContent = action.value;
          } else if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
            el.value = action.value;
          } else throw new Error('Element is not an editable text field');
          if (typeof Event !== 'undefined' && typeof el.dispatchEvent === 'function') {
            el.dispatchEvent(new Event('input', {bubbles: true}));
            el.dispatchEvent(new Event('change', {bubbles: true}));
          }
        } else if (action.action === 'select') {
          if ((typeof HTMLSelectElement !== 'undefined' && !(el instanceof HTMLSelectElement)) && el.tagName !== 'SELECT')
            throw new Error('Element is not a select');
          if (![...el.options].some(o => o.value === action.value && !o.disabled
              && !o.closest?.('optgroup[disabled]')))
            throw new Error('Enabled option not found');
          el.value = action.value;
          if (typeof Event !== 'undefined' && typeof el.dispatchEvent === 'function') {
            el.dispatchEvent(new Event('input', {bubbles: true}));
            el.dispatchEvent(new Event('change', {bubbles: true}));
          }
        } else if (action.action === 'check') {
          if (((typeof HTMLInputElement !== 'undefined' && !(el instanceof HTMLInputElement)) && el.tagName !== 'INPUT') || !['checkbox','radio'].includes(el.type))
            throw new Error('Element is not a checkbox or radio');
          if (el.type === 'radio' && !action.checked) throw new Error('Cannot uncheck a radio');
          if (el.checked !== action.checked) el.click();
        } else throw new Error('Unknown action');
      }
      results.push({index, action: action.action, ok: true});
    } catch (error) {
      results.push({index, action: action.action, ok: false, error: String(error.message)});
      break;
    }
  }
  return {results, completed: results.filter(r => r.ok).length,
          stopped: results.some(r => !r.ok)};
})
"""
)


def action_expression(actions: list[dict]) -> str:
    if not 1 <= len(actions) <= 100:
        raise ValueError("Provide between 1 and 100 actions")
    for action in actions:
        kind = action.get("action")
        if kind not in {"click", "fill", "select", "check", "scroll"}:
            raise ValueError(f"Unsupported batch action: {kind}")
        if kind != "scroll" and not isinstance(action.get("selector"), str):
            raise ValueError("Each element action requires a CSS selector")
        if kind in {"fill", "select"} and not isinstance(action.get("value"), str):
            raise ValueError("fill/select require a string value")
        if kind == "check" and not isinstance(action.get("checked"), bool):
            raise ValueError("check requires a boolean checked value")
        if kind == "scroll":
            for axis in ("x", "y"):
                value = action.get(axis, 0)
                if not isinstance(value, (int, float)) or not -100000 <= value <= 100000:
                    raise ValueError("Scroll distances must be between -100000 and 100000")
    return ACTION_SCRIPT + "(" + json.dumps(actions) + ")"


CAPTCHA_SCRIPT = r"""
(() => {
  const visible = el => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
  };
  const widgets = [];
  const patterns = [
    ['recaptcha', '.g-recaptcha, iframe[src*="google.com/recaptcha"], ' +
                  'iframe[src*="recaptcha.net"]'],
    ['hcaptcha', '.h-captcha, iframe[src*="hcaptcha.com"]'],
    ['turnstile', '.cf-turnstile, iframe[src*="challenges.cloudflare.com"]']
  ];
  for (const [provider, selector] of patterns) {
    const elements = [...document.querySelectorAll(selector)];
    if (elements.length) widgets.push({provider, count: elements.length,
                                      visible: elements.some(visible)});
  }
  const text = (document.body?.innerText || '').slice(0, 10000);
  const challengePattern = new RegExp(
    "verify (you are|you're) human|checking your browser|" +
    "complete the captcha|security verification", 'i');
  const challengeText = challengePattern.test(text);
  const tokens = [...document.querySelectorAll(
    '[name="g-recaptcha-response"], [name="h-captcha-response"], [name="cf-turnstile-response"]'
  )];
  const tokenPresent = tokens.some(el => Boolean(el.value?.trim()));
  const detected = widgets.length > 0 || challengeText;
  return {detected, widgets, challenge_text: challengeText, response_present: tokenPresent,
          needs_user: detected && !tokenPresent,
          status: tokenPresent ? 'response_present' : detected ? 'user_required' : 'not_detected',
          note: 'Heuristic detection only; a response token does not confirm server acceptance.'};
})()
"""

ACTIONABILITY_STATES = {
    "actionable",
    "attached",
    "unique",
    "visible",
    "hidden",
    "stable",
    "enabled",
    "unobstructed",
}

ACTIONABILITY_SCRIPT = (
    r"""
((selector, expectedState, prevRect) => {
"""
    + RESOLVE_LOCATOR_SCRIPT
    + r"""
  const result = {
    selector,
    expected_state: expectedState || 'actionable',
    attached: false,
    unique: false,
    visible: false,
    stable: false,
    enabled: false,
    unobstructed: false,
    actionable: false,
    matches: 0,
    point: null,
    rect: null,
    reasons: [],
    details: {}
  };

  let elements = [];
  try {
    if (typeof selector === 'string' && selector.startsWith('@e')) {
      const refs = window.__omnibrowser_refs;
      if (!refs || !refs.map) {
        const reason = 'Reference map not initialized: ' + selector;
        result.reasons.push(reason);
        result.details.attached = { ok: false, reason };
        result.details.unique = { ok: false, count: 0, reason };
        result.details.visible = { ok: false, reason };
        result.details.stable = { ok: false, reason };
        result.details.enabled = { ok: false, reason };
        result.details.unobstructed = { ok: false, reason };
        return result;
      }
      const match = selector.match(/^@e(\d+)(?:[@:_]g?(\d+))?$/);
      if (!match) {
        const reason = 'Invalid element reference format: ' + selector;
        result.reasons.push(reason);
        result.details.attached = { ok: false, reason };
        result.details.unique = { ok: false, count: 0, reason };
        result.details.visible = { ok: false, reason };
        result.details.stable = { ok: false, reason };
        result.details.enabled = { ok: false, reason };
        result.details.unobstructed = { ok: false, reason };
        return result;
      }
      const refKey = '@e' + match[1];
      const entry = refs.map[refKey] || refs.map[selector];
      if (!entry) {
        const reason = 'Element reference not found: ' + selector;
        result.reasons.push(reason);
        result.details.attached = { ok: false, reason };
        result.details.unique = { ok: false, count: 0, reason };
        result.details.visible = { ok: false, reason };
        result.details.stable = { ok: false, reason };
        result.details.enabled = { ok: false, reason };
        result.details.unobstructed = { ok: false, reason };
        return result;
      }
      const expectedGen = match[2] ? parseInt(match[2], 10) : null;
      if (expectedGen !== null && expectedGen !== entry.generation) {
        const reason = 'Stale element reference generation: ' + selector;
        result.reasons.push(reason);
        result.details.attached = { ok: false, reason };
        result.details.unique = { ok: false, count: 0, reason };
        result.details.visible = { ok: false, reason };
        result.details.stable = { ok: false, reason };
        result.details.enabled = { ok: false, reason };
        result.details.unobstructed = { ok: false, reason };
        return result;
      }
      if (entry.generation !== refs.generation) {
        const reason = 'Stale element reference generation: ' + selector;
        result.reasons.push(reason);
        result.details.attached = { ok: false, reason };
        result.details.unique = { ok: false, count: 0, reason };
        result.details.visible = { ok: false, reason };
        result.details.stable = { ok: false, reason };
        result.details.enabled = { ok: false, reason };
        result.details.unobstructed = { ok: false, reason };
        return result;
      }
      if (entry.document && entry.document !== document) {
        const reason = 'Stale element reference: document navigated';
        result.reasons.push(reason);
        result.details.attached = { ok: false, reason };
        result.details.unique = { ok: false, count: 0, reason };
        result.details.visible = { ok: false, reason };
        result.details.stable = { ok: false, reason };
        result.details.enabled = { ok: false, reason };
        result.details.unobstructed = { ok: false, reason };
        return result;
      }
      const el = entry.el || entry;
      if (!el || !el.isConnected) {
        const reason = 'Stale element reference: element is no longer attached to DOM';
        result.reasons.push(reason);
        result.details.attached = { ok: false, reason };
        result.details.unique = { ok: false, count: 0, reason };
        result.details.visible = { ok: false, reason };
        result.details.stable = { ok: false, reason };
        result.details.enabled = { ok: false, reason };
        result.details.unobstructed = { ok: false, reason };
        return result;
      }
      elements = [el];
    } else {
      elements = resolveLocator(selector);
    }
  } catch (err) {
    const reason = 'Invalid selector syntax: ' + err.message;
    result.reasons.push(reason);
    result.details.attached = { ok: false, reason };
    result.details.unique = { ok: false, count: 0, reason: 'Invalid selector' };
    result.details.visible = { ok: false, reason: 'Invalid selector' };
    result.details.stable = { ok: false, reason: 'Invalid selector' };
    result.details.enabled = { ok: false, reason: 'Invalid selector' };
    result.details.unobstructed = { ok: false, reason: 'Invalid selector' };
    return result;
  }

  result.matches = elements.length;

  if (elements.length === 0) {
    const reason = 'Element not found in DOM matching selector: ' + selector;
    result.reasons.push(reason);
    result.details.attached = { ok: false, reason };
    result.details.unique = { ok: false, count: 0, reason: 'Element not attached' };
    result.details.visible = { ok: false, reason: 'Element not attached' };
    result.details.stable = { ok: false, reason: 'Element not attached' };
    result.details.enabled = { ok: false, reason: 'Element not attached' };
    result.details.unobstructed = { ok: false, reason: 'Element not attached' };
    return result;
  }
  result.attached = true;
  result.details.attached = { ok: true };

  if (elements.length > 1) {
    const reason = 'Selector matches ' + elements.length + ' elements (expected 1): ' + selector;
    result.reasons.push(reason);
    result.details.unique = { ok: false, count: elements.length, reason };
  } else {
    result.unique = true;
    result.details.unique = { ok: true, count: 1 };
  }

  const el = elements[0];

  let enabled = true;
  let enabledReason = null;
  if (el.disabled || (el.hasAttribute && el.hasAttribute('disabled'))) {
    enabled = false;
    enabledReason = 'Element has disabled attribute';
  } else if (el.closest && el.closest('[inert]')) {
    enabled = false;
    enabledReason = 'Element is inside an [inert] container';
  } else if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') {
    enabled = false;
    enabledReason = 'Element has aria-disabled="true"';
  } else if (el.closest && el.closest('[aria-disabled="true"]')) {
    enabled = false;
    enabledReason = 'Element is inside an [aria-disabled="true"] container';
  }
  result.enabled = enabled;
  result.details.enabled = { ok: enabled, ...(enabledReason ? { reason: enabledReason } : {}) };
  if (!enabled) {
    result.reasons.push(enabledReason);
  }

  try {
    el.scrollIntoView({ block: 'center', inline: 'center' });
  } catch (_) {}
  const rect = el.getBoundingClientRect();
  result.rect = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  const style = window.getComputedStyle ? window.getComputedStyle(el) : null;

  let visible = true;
  let visibleReason = null;
  if (style && style.display === 'none') {
    visible = false;
    visibleReason = 'Element has display: none';
  } else if (style && (style.visibility === 'hidden' || style.visibility === 'collapse')) {
    visible = false;
    visibleReason = 'Element has visibility: ' + style.visibility;
  } else if (style && parseFloat(style.opacity || '1') === 0) {
    visible = false;
    visibleReason = 'Element has opacity: 0';
  } else if (rect.width <= 0 || rect.height <= 0 || (el.getClientRects && !el.getClientRects().length)) {
    visible = false;
    visibleReason = 'Element has zero bounding dimensions (' + Math.round(rect.width) + 'x' + Math.round(rect.height) + ')';
  }
  result.visible = visible;
  result.details.visible = { ok: visible, ...(visibleReason ? { reason: visibleReason } : {}) };
  if (!visible) {
    result.reasons.push(visibleReason);
  }

  let stable = true;
  let stableReason = null;
  if (prevRect && typeof prevRect === 'object' && typeof prevRect.x === 'number') {
    const dx = Math.abs(rect.x - prevRect.x);
    const dy = Math.abs(rect.y - prevRect.y);
    const dw = Math.abs(rect.width - prevRect.width);
    const dh = Math.abs(rect.height - prevRect.height);
    if (dx > 1 || dy > 1 || dw > 1 || dh > 1) {
      stable = false;
      stableReason = 'Element is moving or resizing (dx=' + dx.toFixed(1) + ', dy=' + dy.toFixed(1) + ')';
    }
  }
  result.stable = stable;
  result.details.stable = { ok: stable, ...(stableReason ? { reason: stableReason } : {}) };
  if (!stable) {
    result.reasons.push(stableReason);
  }

  let unobstructed = true;
  let unobstructedReason = null;
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  result.point = { x: Math.round(cx), y: Math.round(cy) };

  if (!visible) {
    unobstructed = false;
    unobstructedReason = 'Element is hidden and cannot be hit-tested';
  } else if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) {
    unobstructed = false;
    unobstructedReason = 'Element center point (' + Math.round(cx) + ', ' + Math.round(cy) + ') is outside viewport';
  } else {
    const root = typeof el.getRootNode === 'function' ? el.getRootNode() : document;
    const hitTarget = (root && typeof root.elementFromPoint === 'function' ? root : document)
      .elementFromPoint(cx, cy);
    if (!hitTarget) {
      unobstructed = false;
      unobstructedReason = 'No element returned from elementFromPoint at center point (' + Math.round(cx) + ', ' + Math.round(cy) + ')';
    } else if (hitTarget !== el && !el.contains(hitTarget)) {
      unobstructed = false;
      const tag = hitTarget.tagName ? hitTarget.tagName.toLowerCase() : 'element';
      const id = hitTarget.id ? '#' + hitTarget.id : '';
      const cls = hitTarget.className && typeof hitTarget.className === 'string'
        ? '.' + hitTarget.className.trim().split(/\s+/).filter(Boolean).join('.') : '';
      unobstructedReason = 'Element is covered by <' + tag + id + cls + '> at point (' + Math.round(cx) + ', ' + Math.round(cy) + ')';
    }
  }
  result.unobstructed = unobstructed;
  result.details.unobstructed = { ok: unobstructed, ...(unobstructedReason ? { reason: unobstructedReason } : {}) };
  if (!unobstructed) {
    result.reasons.push(unobstructedReason);
  }

  result.actionable = result.attached && result.unique && result.visible && result.stable && result.enabled && result.unobstructed;
  return result;
})
"""
)


def actionability_expression(
    selector: str, state: str = "actionable", prev_rect: dict | None = None
) -> str:
    if not isinstance(selector, str) or not selector.strip():
        raise ValueError("Selector must be a non-empty string")
    if state not in ACTIONABILITY_STATES:
        raise ValueError(
            f"Invalid state: {state} (must be one of: {', '.join(sorted(ACTIONABILITY_STATES))})"
        )
    if prev_rect is not None and not isinstance(prev_rect, dict):
        raise ValueError("prev_rect must be a dictionary or None")
    return (
        ACTIONABILITY_SCRIPT
        + "("
        + json.dumps(selector)
        + ", "
        + json.dumps(state)
        + ", "
        + json.dumps(prev_rect)
        + ")"
    )


def element_point_expression(selector: str) -> str:
    if not isinstance(selector, str) or not selector.strip():
        raise ValueError("Selector must be a non-empty string")
    return (
        r"""
(selector => {
"""
        + RESOLVE_LOCATOR_SCRIPT
        + r"""
  let el;
  if (typeof selector === 'string' && selector.startsWith('@e')) {
    const refs = window.__omnibrowser_refs;
    if (!refs || !refs.map) throw new Error('Reference map not initialized: ' + selector);
    const match = selector.match(/^@e(\d+)(?:[@:_]g?(\d+))?$/);
    if (!match) throw new Error('Invalid element reference format: ' + selector);
    const refKey = '@e' + match[1];
    const entry = refs.map[refKey] || refs.map[selector];
    if (!entry) throw new Error('Element reference not found: ' + selector);
    el = entry.el || entry;
  } else {
    const matches = resolveLocator(selector);
    if (matches.length > 1) throw new Error('Selector matches multiple elements: ' + selector);
    el = matches[0];
  }
  if (!el) throw new Error('Element not found: ' + selector);
  if (el.disabled || el.closest?.('[inert]') || el.getAttribute?.('aria-disabled') === 'true' || el.closest?.('[aria-disabled="true"]')) throw new Error('Element is disabled');
  el.scrollIntoView({block: 'center'});
  const r = el.getBoundingClientRect();
  const win = el.ownerDocument?.defaultView || (typeof window !== 'undefined' ? window : globalThis);
  const s = typeof getComputedStyle === 'function' ? getComputedStyle(el) : (win.getComputedStyle ? win.getComputedStyle(el) : {});
  if (!r.width || !r.height || s.visibility === 'hidden' || s.display === 'none')
    throw new Error('Element is hidden');
  const x = r.x + r.width / 2, y = r.y + r.height / 2;
  const root = typeof el.getRootNode === 'function' ? el.getRootNode() : document;
  const hit = (root && typeof root.elementFromPoint === 'function' ? root : document).elementFromPoint(x, y);
  if (!hit || (hit !== el && !el.contains(hit))) throw new Error('Element is covered');
  return {x, y};
})("""
        + json.dumps(selector)
        + ")"
    )
