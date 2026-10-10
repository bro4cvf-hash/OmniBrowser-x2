/* Local replay contract adapted from Stagehand cache normalization, MIT.
 * Copyright (c) 2024 Browserbase Inc. See vendor/browser-reuse/LICENSE-stagehand.
 * Modification: local storage, live target validation, input placeholders; no API.
 */
(function (root) {
  'use strict';
  const { normalizeCachedActions } = typeof module !== 'undefined' && module.exports ? require('./vendor/browser-reuse/kernels.js') : root.OmniReuseKernels;
  const key = 'omniActionRecipes';
  const variable = /^\{\{([a-zA-Z][a-zA-Z0-9_]{0,39})\}\}$/;
  const scope = raw => { const url = new URL(raw); return url.origin + url.pathname; };
  const validAction = action => !!action && ['fill', 'select_option', 'set_checked'].includes(action.action) &&
    typeof action.selector === 'string' && !!action.selector.trim() && !action.selector.startsWith('@') &&
    action.selector.length <= 2000 && (action.frameId === undefined || Number.isSafeInteger(action.frameId) && action.frameId >= 0) &&
    (action.action === 'set_checked' ? typeof action.checked === 'boolean' : typeof action.value === 'string' && variable.test(action.value));
  const inputsFor = actions => [...new Set(actions.filter(action => action.action !== 'set_checked')
    .map(action => action.value.match(variable)[1]))];
  const validRecipe = recipe => recipe && typeof recipe.name === 'string' && typeof recipe.scope === 'string' &&
    Array.isArray(recipe.actions) && recipe.actions.length > 0 && recipe.actions.length <= 100 && recipe.actions.every(validAction);
  class Recipes {
    constructor(storage) { this.storage = storage; this.tail = Promise.resolve(); }
    async list(url) {
      const all = (await this.storage.get(key))[key] || {};
      return Object.values(all).filter(recipe => validRecipe(recipe) && (!url || recipe.scope === scope(url)))
        .map(recipe => ({ name: recipe.name, scope: recipe.scope, variables: inputsFor(recipe.actions), updatedAt: recipe.updatedAt }));
    }
    async save({ name, actions }, page) {
      const operation = async () => {
        if (typeof name !== 'string' || !/^[a-zA-Z0-9_-]{1,60}$/.test(name) || !Array.isArray(actions) || !actions.length || actions.length > 100) throw new Error('Provide a recipe name and 1 to 100 field actions');
        if (['__proto__', 'constructor', 'prototype'].includes(name)) throw new Error('Choose a different recipe name');
        if (actions.some(action => !action || typeof action !== 'object' || Array.isArray(action))) throw new Error('Malformed recipe actions');
        const variables = new Set();
        const normalized = normalizeCachedActions(actions.map(action => ({ ...action, method: action.action })));
        if (normalized.length !== actions.length) throw new Error('Malformed recipe actions');
        for (const action of actions) {
          if (!['fill', 'select_option', 'set_checked'].includes(action.action) || typeof action.selector !== 'string' || action.selector.startsWith('@') || action.selector.length > 2000) throw new Error('Recipes accept durable CSS selectors and field edits only');
          const matches = page.elements.filter(element => element.selector === action.selector && (element.frameId || 0) === (action.frameId || 0));
          if (matches.length !== 1 || matches[0].disabled || matches[0].type === 'password' || matches[0].value === '[redacted]') throw new Error('Every recipe field must be uniquely observed, enabled and non-sensitive');
          if (action.action === 'set_checked') { if (typeof action.checked !== 'boolean') throw new Error('Provide a checkbox state'); }
          else { const match = typeof action.value === 'string' && action.value.match(variable); if (!match) throw new Error('Use {{variable}} for field values; personal values are never stored in recipes'); variables.add(match[1]); }
          if (!validAction(action)) throw new Error('Provide a nonempty CSS selector and a valid frame ID');
        }
        const all = (await this.storage.get(key))[key] || {};
        if (!all[name] && Object.keys(all).length >= 100) throw new Error('Recipe limit reached');
        all[name] = { name, scope: scope(page.url), variables: [...variables], updatedAt: Date.now(), actions: actions.map(({ action, selector, frameId, value, checked }) => ({ action, selector, ...(frameId !== undefined ? { frameId } : {}), ...(value !== undefined ? { value } : {}), ...(checked !== undefined ? { checked } : {}) })) };
        await this.storage.set({ [key]: all }); return { saved: true, name, variables: [...variables] };
      };
      const pending = this.tail.then(operation); this.tail = pending.catch(() => {}); return pending;
    }
    async resolve(name, values, page) {
      const all = (await this.storage.get(key))[key] || {};
      const recipe = Object.prototype.hasOwnProperty.call(all, name) ? all[name] : null;
      if (!recipe || recipe.scope !== scope(page.url)) throw new Error('No recipe for this page; inspect and prepare the fields again');
      if (!validRecipe(recipe)) throw new Error('Invalid stored recipe; prepare the fields again');
      if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Provide recipe input values');
      for (const input of inputsFor(recipe.actions)) if (!Object.prototype.hasOwnProperty.call(values, input) || typeof values[input] !== 'string' || values[input].length > 16000) throw new Error(`Missing text input: ${input}`);
      return recipe.actions.map(action => {
        const matches = page.elements.filter(element => element.selector === action.selector && (element.frameId || 0) === (action.frameId || 0));
        if (matches.length !== 1 || matches[0].disabled || matches[0].type === 'password' || matches[0].value === '[redacted]') throw new Error('Recipe target changed; inspect and prepare the fields again');
        return { ...action, selector: matches[0].ref || action.selector, ...(action.value !== undefined ? { value: values[action.value.match(variable)[1]] } : {}) };
      });
    }
  }
  const api = { Recipes };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.OmniRecipes = api;
})(globalThis);
