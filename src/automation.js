// Jira-style automation: rules with a trigger, conditions and actions, run one at a time, each run written
// to an audit log. Mirrors Jira Cloud semantics that trip people up:
//   - rules do not fire on changes made by other rules unless "allowRuleTrigger": true
//   - smart values read a snapshot taken when the rule started; use {"type":"refetch"} after an edit
//   - a failing web request stops the rule unless "continueOnError": true
import { render, JiraNumber, toStr } from "./smart.js";
import { adfToText } from "./adf.js";
import { jiraNow } from "./store.js";

class StopRule extends Error {}

const AUTOMATION_ACTOR = { accountId: "automation", displayName: "Automation for Jira", automation: true };

function compare(a, op, b) {
  const num = (x) => (x instanceof JiraNumber ? x.n : x === "" || x == null ? NaN : Number(toStr(x)));
  const s = (x) => toStr(x).toLowerCase();
  const bothNum = !Number.isNaN(num(a)) && !Number.isNaN(num(b));
  switch (String(op).toLowerCase()) {
    case "=": case "equals": return bothNum ? num(a) === num(b) : s(a) === s(b);
    case "!=": case "not_equals": return bothNum ? num(a) !== num(b) : s(a) !== s(b);
    case ">": case "greater_than": return num(a) > num(b);
    case "<": case "less_than": return num(a) < num(b);
    case ">=": return num(a) >= num(b);
    case "<=": return num(a) <= num(b);
    case "contains": return s(a).includes(s(b));
    case "not_contains": return !s(a).includes(s(b));
    case "in": return [].concat(b).map(s).includes(s(a));
    case "not_in": return ![].concat(b).map(s).includes(s(a));
    case "is_empty": return toStr(a) === "";
    case "is_not_empty": return toStr(a) !== "";
    case "matches": return new RegExp(toStr(b)).test(toStr(a));
    default: throw new StopRule(`Unknown comparison '${op}'`);
  }
}

export class Automation {
  constructor(store) {
    this.store = store;
    this.queue = Promise.resolve();
    store.on((ev) => this.onEvent(ev));
  }

  get rules() { return this.store.ws.automation; }
  rule(id) { return this.rules.find((r) => r.id === id) || null; }
  enabled(rule) { return rule.enabled !== false && !this.store.state.disabledRules.includes(rule.id); }
  toggle(id, on) {
    const d = this.store.state.disabledRules.filter((x) => x !== id);
    if (!on) d.push(id);
    this.store.state.disabledRules = d; this.store.save();
  }

  onEvent(ev) {
    for (const rule of this.rules) {
      if (!this.enabled(rule) || !this.matches(rule, ev)) continue;
      if (ev.actor?.automation && !rule.allowRuleTrigger) { this.skipped(rule, ev); continue; }
      this.enqueue(rule, ev.issue, ev);
    }
  }

  scopeOk(rule, issue) {
    const t = rule.trigger || {};
    if (!issue) return false;
    if (rule.project && ![].concat(rule.project).includes(issue.project)) return false;
    if (t.issueTypes && !t.issueTypes.includes(issue.issueType)) return false;
    return true;
  }

  matches(rule, ev) {
    const t = rule.trigger || {};
    const issue = this.store.issue(ev.issue);
    if (!this.scopeOk(rule, issue)) return false;
    const inList = (v, list) => !list || [].concat(list).map((x) => x.toLowerCase()).includes(String(v).toLowerCase());
    switch (t.type) {
      case "issue_created": return ev.type === "issue_created";
      case "issue_transitioned": return ev.type === "issue_transitioned" && inList(ev.to, t.to) && inList(ev.from, t.from);
      case "field_value_changed": return ev.type === "field_changed" && [].concat(t.fields || t.field).some((f) => this.store.fieldRef(f)?.id === ev.fieldId);
      case "comment_added": return ev.type === "comment_added";
      case "attachment_added": return ev.type === "attachment_added";
      default: return false; // manual and incoming_webhook rules are started explicitly
    }
  }

  skipped(rule, ev) {
    // Jira does not log these, but it is the most common "why didn't my rule run?" question, so record it.
    this.pushAudit({ ruleId: rule.id, ruleName: rule.name, issueKey: ev.issue, trigger: this.describe(rule, ev), status: "SKIPPED", items: [{ kind: "note", ok: true, message: "Triggered by another rule's change and \"allowRuleTrigger\" is off, so the rule did not run." }], started: new Date().toISOString(), finished: new Date().toISOString(), durationMs: 0 });
  }

  enqueue(rule, issueKey, ev) {
    const p = this.queue.then(() => this.run(rule, issueKey, ev));
    this.queue = p.catch(() => {});
    return p;
  }

  runManual(ruleId, issueKey, actor) {
    const rule = this.rule(ruleId);
    if (!rule || rule.trigger?.type !== "manual") throw new Error(`No manual rule '${ruleId}'`);
    if (!this.enabled(rule)) throw new Error(`Rule '${rule.name}' is disabled`);
    const issue = this.store.issue(issueKey);
    if (!this.scopeOk(rule, issue)) throw new Error(`Rule '${rule.name}' does not apply to ${issueKey}`);
    return this.enqueue(rule, issue.key, { type: "manual", issue: issue.key, actor });
  }

  async runWebhook(ruleId, token, body) {
    const rule = this.rule(ruleId);
    if (!rule || rule.trigger?.type !== "incoming_webhook") return { status: 404 };
    if (!this.enabled(rule)) return { status: 409, message: "rule disabled" };
    if (rule.trigger.token && rule.trigger.token !== token) return { status: 401 };
    const keys = Array.isArray(body?.issues) ? body.issues.map((x) => (typeof x === "object" ? x.key || x.id : x)) : rule.trigger.jql ? this.store.search(rule.trigger.jql).map((i) => i.key) : [null];
    const audits = [];
    for (const k of keys) audits.push(await this.enqueue(rule, k, { type: "incoming_webhook", issue: k, webhookData: body, actor: AUTOMATION_ACTOR }));
    return { status: 200, audits };
  }

  describe(rule, ev) {
    const t = rule.trigger || {};
    switch (ev.type) {
      case "issue_transitioned": return `Work item transitioned: ${ev.from} → ${ev.to}`;
      case "field_changed": return `Field value changed: ${this.store.fieldById(ev.fieldId)?.name || ev.fieldId}`;
      case "issue_created": return "Work item created";
      case "manual": return `Manual trigger by ${ev.actor?.displayName || "user"}`;
      case "incoming_webhook": return "Incoming webhook";
      default: return t.type || ev.type;
    }
  }

  pushAudit(a) {
    const st = this.store.state;
    a.id = String(st.nextAuditId++);
    st.audit.unshift(a);
    if (st.audit.length > 500) st.audit.length = 500;
    this.store.save();
  }

  // ---------- smart-value context ----------
  userSnap(ref) {
    const u = this.store.user(ref);
    if (!u) return ref === "automation" ? { accountId: "automation", displayName: "Automation for Jira", __str: "Automation for Jira" } : null;
    return { accountId: u.accountId, displayName: u.displayName, emailAddress: u.emailVisible === false ? undefined : u.emailAddress, __str: u.displayName };
  }

  snapshot(i, depth = 1) {
    const s = this.store;
    const type = s.typeOf(i);
    const snap = {
      id: i.id, key: i.key, __str: i.key, summary: i.summary, description: adfToText(i.description).trim(),
      status: { name: i.status, __str: i.status, category: s.statusCategory(i) },
      issueType: { name: i.issueType, __str: i.issueType, subtask: !!type?.subtask }, issuetype: { name: i.issueType, __str: i.issueType },
      project: { key: i.project, name: s.project(i.project)?.name, __str: i.project },
      assignee: this.userSnap(i.assignee), reporter: this.userSnap(i.reporter), creator: this.userSnap(i.creator),
      labels: i.labels, created: i.created, updated: i.updated, resolutiondate: i.resolutiondate, url: `${s.baseUrl}/browse/${i.key}`,
      attachments: i.attachments.map((a) => ({ id: a.id, filename: a.filename, mimeType: a.mimeType, size: a.size, created: a.created, content: s.attachmentUrl(a), __str: a.filename })),
      comments: i.comments.map((c) => ({ id: c.id, body: adfToText(c.body).trim(), author: this.userSnap(c.author), created: c.created, __str: adfToText(c.body).trim() })),
      fields: {},
    };
    snap.attachment = snap.attachments; // Jira exposes the list as issue.attachment
    for (const f of s.customFields) {
      const raw = i.fields[f.id];
      const v = raw == null ? null : f.type === "number" ? new JiraNumber(raw) : f.type === "select" ? { value: raw.value, id: raw.id, __str: raw.value } : f.type === "user" ? this.userSnap(raw) : raw;
      snap.fields[f.id] = v; snap.fields[f.name] = v;
      if (!(f.name in snap)) snap[f.name] = v;
      snap[f.id] = v;
    }
    if (i.parent) snap.parent = depth > 0 ? this.snapshot(s.issue(i.parent), 0) : { key: i.parent, __str: i.parent };
    snap.subtasks = depth > 0 ? s.subtasks(i.key).map((x) => this.snapshot(x, 0)) : [];
    snap.children = depth > 0 ? s.children(i.key).map((x) => this.snapshot(x, 0)) : [];
    return snap;
  }

  scopes(ctx) {
    const secrets = this.store.ws.secrets;
    const secretProxy = new Proxy({}, { get: (_, k) => { if (typeof k !== "string" || !(k in secrets)) return undefined; if (secrets[k]) ctx.secrets.add(secrets[k]); return secrets[k]; }, has: (_, k) => k in secrets });
    return [{
      issue: ctx.issue, triggerIssue: ctx.triggerIssue, webResponse: ctx.webResponse, webhookData: ctx.trigger?.webhookData,
      var: this.store.ws.variables, secret: secretProxy, now: { __str: jiraNow(), iso: new Date().toISOString() },
      rule: { name: ctx.rule.name, id: ctx.rule.id, __str: ctx.rule.name }, initiator: this.userSnap(ctx.trigger?.actor?.accountId),
      fromStatus: ctx.trigger?.from, toStatus: ctx.trigger?.to, baseUrl: this.store.baseUrl,
    }];
  }

  render(tpl, ctx) { return render(tpl, this.scopes(ctx)); }
  renderDeep(v, ctx) {
    if (typeof v === "string") return this.render(v, ctx);
    if (Array.isArray(v)) return v.map((x) => this.renderDeep(x, ctx));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, this.renderDeep(x, ctx)]));
    return v;
  }

  mask(detail, ctx) {
    let s = JSON.stringify(detail);
    for (const secret of ctx.secrets) if (secret && secret.length >= 4) s = s.split(JSON.stringify(secret).slice(1, -1)).join("******");
    s = s.replace(/eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, "eyJ…(jwt)");
    return JSON.parse(s);
  }

  // ---------- run ----------
  async run(rule, issueKey, ev) {
    const s = this.store;
    const audit = { ruleId: rule.id, ruleName: rule.name, issueKey, trigger: this.describe(rule, ev), actor: ev.actor?.displayName, started: new Date().toISOString(), items: [], status: "SUCCESS" };
    const issue = issueKey ? s.issue(issueKey) : null;
    const ctx = { rule, audit, secrets: new Set(), trigger: ev, webResponse: null, issue: issue ? this.snapshot(issue) : null };
    ctx.triggerIssue = ctx.issue;
    try {
      if (!(await this.checkAll(rule.conditions || [], ctx))) audit.status = "NO_ACTIONS_PERFORMED";
      else await this.runActions(rule.actions || [], ctx);
    } catch (e) {
      audit.status = "FAILURE";
      if (!(e instanceof StopRule)) audit.items.push({ kind: "error", ok: false, message: e.message });
    }
    audit.finished = new Date().toISOString();
    audit.durationMs = Date.parse(audit.finished) - Date.parse(audit.started);
    this.pushAudit(audit);
    return audit;
  }

  async checkAll(conditions, ctx) {
    for (const c of conditions) {
      let ok;
      try { ok = await this.check(c, ctx); } catch (e) { ctx.audit.items.push({ kind: "condition", ok: false, message: e.message }); throw new StopRule(e.message); }
      ctx.audit.items.push({ kind: "condition", ok, message: `${c.label || this.describeCondition(c)}: ${ok ? "passed" : "not met"}` });
      if (!ok) return false;
    }
    return true;
  }

  describeCondition(c) {
    switch (c.type) {
      case "from_status": return `From status in [${[].concat(c.in).join(", ")}]`;
      case "status": return `Status in [${[].concat(c.in).join(", ")}]`;
      case "issue_type": return `Work type in [${[].concat(c.in).join(", ")}]`;
      case "field": return `${c.field} ${c.op || "="} ${c.value ?? ""}`.trim();
      case "subtasks": case "children": return `${c.match || "all"} ${c.type} in [${[].concat(c.status).join(", ")}]`;
      case "compare": return `Compare ${c.first} ${c.op || "equals"} ${c.second ?? ""}`;
      case "jql": return `JQL: ${c.jql}`;
      default: return c.type;
    }
  }

  async check(c, ctx) {
    const s = this.store;
    const iss = ctx.issue ? s.issue(ctx.issue.key) : null;
    const need = () => { if (!iss) throw new StopRule("Condition needs a work item"); return iss; };
    switch (c.type) {
      case "from_status": return [].concat(c.in).includes(ctx.trigger?.from);
      case "status": return [].concat(c.in).includes(need().status);
      case "issue_type": return [].concat(c.in).includes(need().issueType);
      case "field": {
        const def = s.fieldRef(c.field); if (!def) throw new StopRule(`Unknown field '${c.field}'`);
        const raw = def.system ? need()[def.id] : need().fields[def.id];
        return compare(raw && typeof raw === "object" && "value" in raw ? raw.value : raw, c.op || "=", c.value);
      }
      case "subtasks": case "children": {
        const list = c.type === "subtasks" ? s.subtasks(need().key) : s.children(need().key);
        const hit = (x) => [].concat(c.status).includes(x.status);
        const m = c.match || "all";
        if (!list.length) return m === "none" || !!c.passWhenEmpty;
        return m === "all" ? list.every(hit) : m === "any" ? list.some(hit) : !list.some(hit);
      }
      case "compare": return compare(this.render(c.first, ctx), c.op || "equals", Array.isArray(c.second) ? c.second : this.render(c.second ?? "", ctx));
      case "jql": return s.search(`key = ${need().key} AND (${this.render(c.jql, ctx)})`).length > 0;
      default: throw new StopRule(`Unknown condition type '${c.type}'`);
    }
  }

  async runActions(actions, ctx) { for (const a of actions) await this.act(a, ctx); }

  coerce(ref, value) {
    const def = this.store.fieldRef(ref);
    if (!def || typeof value !== "string") return value;
    if (value === "") return null;
    if (def.type === "number") return Number(value);
    if (def.type === "labels") return value.split(/[\s,]+/).filter(Boolean);
    return value;
  }

  async act(a, ctx) {
    const s = this.store;
    const push = (ok, message, detail) => {
      ctx.audit.items.push({ kind: a.type, ok, message, ...(detail ? { detail: this.mask(detail, ctx) } : {}) });
      if (!ok && ctx.audit.status === "SUCCESS") ctx.audit.status = "SOME_ERRORS";
    };
    const fail = (message, detail) => { push(false, message, detail); if (!a.continueOnError) throw new StopRule(message); };
    const target = () => { const i = ctx.issue ? s.issue(ctx.issue.key) : null; if (!i) throw new StopRule("This action needs a work item"); return i; };
    switch (a.type) {
      case "log": push(true, this.render(a.message, ctx)); return;
      case "refetch": { const i = target(); ctx.issue = this.snapshot(i); push(true, `Re-fetched work item data for ${i.key}`); return; }
      case "edit_issue": {
        const i = target();
        const fields = Object.fromEntries(Object.entries(a.fields || {}).map(([k, v]) => [k, this.coerce(k, this.renderDeep(v, ctx))]));
        try { const ch = s.applyFields(i, fields, AUTOMATION_ACTOR, { trusted: true }); push(true, `Edited ${i.key}: ${ch.map((c) => c.name).join(", ") || "no changes"}`, { fields }); }
        catch (e) { fail(`Editing ${i.key} failed: ${e.message}`, { fields, errors: e.errors }); }
        return;
      }
      case "transition_issue": {
        const i = target();
        const to = this.render(a.to || a.transition, ctx);
        const t = s.findTransition(i, to, true);
        if (!t) return fail(`${i.key}: no transition from '${i.status}' to '${to}'`);
        const from = i.status;
        s.doTransition(i, t.id, AUTOMATION_ACTOR, { comment: a.comment ? this.render(a.comment, ctx) : undefined });
        push(true, `${i.key}: ${from} → ${t.to}`);
        return;
      }
      case "comment": { const i = target(); s.addComment(i, this.render(a.body, ctx), AUTOMATION_ACTOR); push(true, `Commented on ${i.key}`); return; }
      case "create_issue": {
        const base = ctx.issue ? s.issue(ctx.issue.key) : null;
        const spec = this.renderDeep(a, ctx);
        const fields = Object.fromEntries(Object.entries(spec.fields || {}).map(([k, v]) => [k, this.coerce(k, v)]));
        try {
          const n = s.createIssue({ project: spec.project || base?.project, issueType: spec.issueType, summary: spec.summary, description: spec.description, parent: spec.parent === "{{trigger}}" ? base?.key : spec.parent, assignee: s.user(spec.assignee)?.accountId, fields }, AUTOMATION_ACTOR, { trusted: true });
          ctx.createdIssue = this.snapshot(n);
          push(true, `Created ${n.key}`);
        } catch (e) { fail(`Create failed: ${e.message}`, { errors: e.errors }); }
        return;
      }
      case "branch": {
        const base = target();
        let list;
        if (a.on === "subtasks") list = s.subtasks(base.key);
        else if (a.on === "children") list = s.children(base.key);
        else if (a.on === "parent") list = base.parent ? [s.issue(base.parent)] : [];
        else if (a.on === "jql") list = s.search(this.render(a.jql, ctx));
        else throw new StopRule(`Unknown branch '${a.on}'`);
        push(true, `Branch on ${a.on}: ${list.map((x) => x.key).join(", ") || "no work items"}`);
        for (const x of list) {
          const sub = { ...ctx, issue: this.snapshot(x) };
          try { if (await this.checkAll(a.conditions || [], sub)) await this.runActions(a.actions || [], sub); }
          catch (e) { if (!(e instanceof StopRule)) push(false, `${x.key}: ${e.message}`); }
        }
        return;
      }
      case "if": {
        const ok = await this.checkAll(a.conditions || [], ctx);
        await this.runActions(ok ? a.then || [] : a.else || [], ctx);
        return;
      }
      case "send_web_request": {
        const url = this.render(a.url, ctx);
        const method = (a.method || "POST").toUpperCase();
        const headers = Object.fromEntries(Object.entries(a.headers || {}).map(([k, v]) => [k, this.render(v, ctx)]));
        let body;
        if (a.body != null && method !== "GET" && method !== "HEAD") {
          body = typeof a.body === "string" ? this.render(a.body, ctx) : JSON.stringify(this.renderDeep(a.body, ctx));
          if (!Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) headers["Content-Type"] = "application/json";
        }
        let parsedBody = body; try { parsedBody = body ? JSON.parse(body) : body; } catch { /* keep text */ }
        const t0 = Date.now();
        let res; let text; let json;
        try {
          res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(a.timeoutMs || 30000) });
          text = await res.text();
          try { json = JSON.parse(text); } catch { /* not JSON */ }
        } catch (e) { return fail(`${method} ${url} failed: ${e.cause?.code || e.message}`, { request: { url, method, headers, body: parsedBody } }); }
        ctx.webResponse = { status: res.status, body: json ?? text, headers: Object.fromEntries(res.headers) };
        const detail = { request: { url, method, headers, body: parsedBody }, response: { status: res.status, body: json ?? (text || "").slice(0, 4000) } };
        if (res.ok) push(true, `${method} ${url} → ${res.status} (${Date.now() - t0} ms)`, detail);
        else fail(`${method} ${url} → ${res.status} (${Date.now() - t0} ms)`, detail);
        return;
      }
      default: throw new StopRule(`Unknown action type '${a.type}'`);
    }
  }
}
