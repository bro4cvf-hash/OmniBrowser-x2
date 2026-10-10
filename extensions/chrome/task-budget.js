/* Shared budgets include child agents, compaction and provider retries. */
(function (root) {
  'use strict';
  class TaskBudget {
    constructor(settings = {}, onEvent = () => {}, previous = {}) {
      this.startedAt = Date.now() - Math.max(0, Number(previous.elapsedMs) || 0);
      this.maxMs = Math.max(0, Number(settings.taskMinutes) || 0) * 60000;
      this.maxCost = Math.max(0, Number(settings.taskCostLimit) || 0);
      this.inputRate = Math.max(0, Number(settings.inputTokenPrice) || 0) / 1000000;
      this.outputRate = Math.max(0, Number(settings.outputTokenPrice) || 0) / 1000000;
      this.tokens = Math.max(0, Number(previous.tokens) || 0); this.cost = Math.max(0, Number(previous.cost) || 0);
      this.reserved = 0; this.reservedCost = 0;
      this.estimated = previous.estimated === true; this.onEvent = onEvent;
    }
    exceeded(kind) {
      const error = new Error(`Task ${kind} limit reached. Completed actions remain in place; review progress before continuing.`);
      error.budgetExceeded = true; throw error;
    }
    check() {
      if (this.maxMs && Date.now() - this.startedAt >= this.maxMs) this.exceeded('time');
      if (this.maxCost && this.cost + this.reservedCost >= this.maxCost) this.exceeded('cost');
    }
    reserve(body, input) {
      this.check();
      if (!Number.isFinite(input) || input < 0) throw new Error('Invalid input token estimate.');
      input = Math.max(1, Math.ceil(input));
      const requestedOutput = Number(body.max_tokens);
      let output = Number.isFinite(requestedOutput) && requestedOutput > 0 ? Math.max(1, Math.floor(requestedOutput)) : 4096;
      if (this.maxCost) {
        const available = this.maxCost - this.cost - this.reservedCost - input * this.inputRate;
        if (available <= 0) this.exceeded('cost');
        if (this.outputRate) output = Math.min(output, Math.floor(available / this.outputRate));
      }
      if (output < 1) this.exceeded('cost');
      if (this.maxCost || body.max_tokens != null) body.max_tokens = output;
      const ticket = { input, output, tokens: input + output, cost: input * this.inputRate + output * this.outputRate, settled: false };
      this.reserved += ticket.tokens; this.reservedCost += ticket.cost;
      return ticket;
    }
    settle(ticket, completion) {
      if (ticket.settled) return;
      ticket.settled = true;
      this.reserved -= ticket.tokens; this.reservedCost -= ticket.cost;
      const usage = completion?.data?.usage;
      const reported = Number.isSafeInteger(usage?.prompt_tokens) && usage.prompt_tokens >= 0 &&
        Number.isSafeInteger(usage?.completion_tokens) && usage.completion_tokens >= 0;
      // Lost responses may still be billed; account for the full reservation.
      const input = reported ? Math.max(0, usage.prompt_tokens) : ticket.input;
      const output = reported ? Math.max(0, usage.completion_tokens) : completion ?
        Math.ceil(JSON.stringify(completion.data?.choices || []).length / 4) : ticket.output;
      this.estimated ||= !reported;
      this.tokens += input + output;
      this.cost += input * this.inputRate + output * this.outputRate;
      this.onEvent({ type: 'task_usage', tokens: this.tokens, cost: this.inputRate || this.outputRate ? this.cost : null,
        estimated: this.estimated, elapsedMs: Date.now() - this.startedAt });
    }
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { TaskBudget };
  else root.OmniTaskBudget = { TaskBudget };
})(typeof globalThis !== 'undefined' ? globalThis : this);
