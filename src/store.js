// Workspace config + persisted state for the mock. One JSON workspace file defines users, custom fields,
// projects, issue types, workflows, automation rules and seed issues; state lives in <dataDir>/state.json.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { adfToText, textToAdf, isAdf } from "./adf.js";
import { runJql } from "./jql.js";

export class JiraError extends Error {
  constructor(status, errors = {}, errorMessages = []) {
    super(errorMessages[0] || Object.values(errors)[0] || `HTTP ${status}`);
    this.status = status; this.errors = errors; this.errorMessages = errorMessages;
  }
  toJSON() { return { errorMessages: this.errorMessages, errors: this.errors }; }
}

export const CATEGORY = {
  new: { id: 2, key: "new", name: "To Do", colorName: "blue-gray" },
  indeterminate: { id: 4, key: "indeterminate", name: "In Progress", colorName: "yellow" },
  done: { id: 3, key: "done", name: "Done", colorName: "green" },
};

const SYSTEM_FIELDS = [
  ["summary", "Summary", "string"], ["description", "Description", "doc"], ["status", "Status", "status", true],
  ["issuetype", "Issue Type", "issuetype", true], ["project", "Project", "project", true], ["assignee", "Assignee", "user"],
  ["reporter", "Reporter", "user"], ["labels", "Labels", "labels"], ["parent", "Parent", "parent"],
  ["created", "Created", "datetime", true], ["updated", "Updated", "datetime", true], ["resolutiondate", "Resolved", "datetime", true],
  ["attachment", "Attachment", "attachments", true], ["comment", "Comment", "comments", true], ["subtasks", "Sub-tasks", "subtasks", true],
].map(([id, name, type, readOnly]) => ({ id, key: id, name, type, system: true, readOnly: !!readOnly }));

export const jiraNow = () => new Date().toISOString().replace("Z", "+0000");

export function resolveRef(v) {
  if (typeof v !== "string" || !v.startsWith("env:")) return v;
  const [name, fallback] = v.slice(4).split("|");
  return process.env[name] ?? fallback ?? "";
}

export class Store {
  constructor({ workspaceFile, dataDir, baseUrl }) {
    this.workspaceFile = path.resolve(workspaceFile);
    this.dataDir = path.resolve(dataDir);
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.filesDir = path.join(this.dataDir, "attachments");
    this.stateFile = path.join(this.dataDir, "state.json");
    fs.mkdirSync(this.filesDir, { recursive: true });
    this.listeners = [];
    this.loadWorkspace();
    this.state = this.readState() || this.freshState();
    if (!this.state.seeded) this.seed();
  }

  // ---------- workspace ----------
  loadWorkspace() {
    const ws = JSON.parse(fs.readFileSync(this.workspaceFile, "utf8"));
    this.wsDir = path.dirname(this.workspaceFile);
    ws.site = { name: "Kaiju", ...(ws.site || {}) };
    let nextId = 10000;
    ws.fields = (ws.fields || []).map((f) => {
      const id = f.id || `customfield_${nextId++}`;
      const n = Number(id.replace("customfield_", ""));
      if (n >= nextId) nextId = n + 1;
      return { ...f, id, key: id, custom: true, options: f.options?.map((o, i) => (typeof o === "string" ? { id: String(10100 + i), value: o } : o)) };
    });
    this.customFields = ws.fields;
    this.allFields = [...SYSTEM_FIELDS, ...ws.fields];
    ws.workflows = ws.workflows || {};
    let sid = 10000;
    for (const [name, wf] of Object.entries(ws.workflows)) {
      wf.name = name;
      wf.statuses = wf.statuses.map((s) => (typeof s === "string" ? { name: s, category: "indeterminate" } : s)).map((s) => ({ ...s, id: s.id || String(sid++) }));
      wf.initial = wf.initial || wf.statuses[0].name;
      wf.transitions = (wf.transitions || []).map((t, i) => ({ ...t, id: String(t.id || 11 + i * 10) }));
    }
    ws.projects = (ws.projects || []).map((p, pi) => ({
      ...p, id: String(p.id || 10000 + pi),
      issueTypes: p.issueTypes.map((t, ti) => ({ hierarchyLevel: t.subtask ? -1 : t.epic ? 1 : 0, ...t, id: String(t.id || 10001 + pi * 100 + ti) })),
    }));
    this.tokenFile = path.join(this.dataDir, "tokens.json");
    const saved = fs.existsSync(this.tokenFile) ? JSON.parse(fs.readFileSync(this.tokenFile, "utf8")) : {};
    let changed = false;
    ws.users = (ws.users || []).map((u, i) => {
      const accountId = u.accountId || `mock-${crypto.createHash("sha1").update(u.emailAddress || u.displayName).digest("hex").slice(0, 16)}`;
      let apiToken = resolveRef(u.apiToken);
      if (!apiToken && u.apiAccess !== false) { apiToken = saved[accountId] || `mock_${crypto.randomBytes(18).toString("hex")}`; if (saved[accountId] !== apiToken) { saved[accountId] = apiToken; changed = true; } }
      return { active: true, timeZone: "UTC", ...u, accountId, apiToken, order: i };
    });
    if (changed) fs.writeFileSync(this.tokenFile, JSON.stringify(saved, null, 2));
    ws.automation = ws.automation || [];
    ws.variables = Object.fromEntries(Object.entries(ws.variables || {}).map(([k, v]) => [k, resolveRef(v)]));
    ws.secrets = Object.fromEntries(Object.entries(ws.secrets || {}).map(([k, v]) => [k, resolveRef(v)]));
    this.ws = ws;
  }

  // ---------- state ----------
  freshState() {
    return { issues: {}, counters: {}, nextIssueId: 10000, nextAttachmentId: 10000, nextCommentId: 10000, nextChangeId: 10000, nextAuditId: 1, audit: [], disabledRules: [], seeded: false };
  }
  readState() { try { return JSON.parse(fs.readFileSync(this.stateFile, "utf8")); } catch { return null; } }
  save() { fs.writeFileSync(this.stateFile, JSON.stringify(this.state)); }
  reset() {
    for (const f of fs.readdirSync(this.filesDir)) fs.rmSync(path.join(this.filesDir, f), { force: true });
    this.loadWorkspace();
    this.state = this.freshState();
    this.seed();
  }
  on(fn) { this.listeners.push(fn); }
  emit(ev) { for (const fn of this.listeners) { try { fn(ev); } catch (e) { console.error(e); } } }

  seed() {
    const refs = {};
    const system = this.ws.users[0];
    for (const s of this.ws.seed?.issues || []) {
      const issue = this.createIssue({
        project: s.project || this.ws.projects[0].key,
        issueType: s.issueType, summary: s.summary,
        description: s.description ? textToAdf(s.description) : null,
        parent: s.parent ? refs[s.parent] || s.parent : undefined,
        assignee: this.user(s.assignee)?.accountId || null,
        reporter: this.user(s.reporter)?.accountId || system?.accountId,
        labels: s.labels, fields: s.fields, status: s.status,
      }, system, { silent: true, trusted: true });
      if (s.ref) refs[s.ref] = issue.key;
      for (const a of s.attachments || []) {
        const file = path.resolve(this.wsDir, a);
        if (fs.existsSync(file)) this.addAttachment(issue, { filename: path.basename(file), mimeType: mimeOf(file), buffer: fs.readFileSync(file) }, system, { silent: true });
        else console.warn(`seed attachment not found: ${file}`);
      }
      for (const c of s.comments || []) this.addComment(issue, c.body || c, this.user(c.author) || system, { silent: true });
    }
    this.state.seeded = true;
    this.save();
  }

  // ---------- lookups ----------
  user(ref) {
    if (!ref) return null;
    if (typeof ref === "object") ref = ref.accountId || ref.emailAddress || ref.id || ref.name;
    const r = String(ref).toLowerCase();
    return this.ws.users.find((u) => u.accountId.toLowerCase() === r || (u.emailAddress || "").toLowerCase() === r || u.displayName.toLowerCase() === r) || null;
  }
  userByToken(email, token) {
    return this.ws.users.find((u) => u.apiToken && u.apiToken === token && (!email || (u.emailAddress || "").toLowerCase() === email.toLowerCase())) || null;
  }
  project(ref) { if (!ref) return null; const r = String(typeof ref === "object" ? ref.key || ref.id : ref).toLowerCase(); return this.ws.projects.find((p) => p.key.toLowerCase() === r || p.id === r) || null; }
  issueType(project, ref) {
    const p = this.project(project); if (!p || !ref) return null;
    const r = String(typeof ref === "object" ? ref.name || ref.id : ref).toLowerCase();
    return p.issueTypes.find((t) => t.name.toLowerCase() === r || t.id === r) || null;
  }
  typeOf(issue) { return this.issueType(issue.project, issue.issueType); }
  workflow(type) { return this.ws.workflows[type.workflow] || Object.values(this.ws.workflows)[0]; }
  statusDef(issue) { return this.workflow(this.typeOf(issue)).statuses.find((s) => s.name === issue.status) || { id: "1", name: issue.status, category: "indeterminate" }; }
  statusCategory(issue) { return this.statusDef(issue).category || "indeterminate"; }
  fieldById(id) { return this.allFields.find((f) => f.id === id) || null; }
  fieldByName(name) { const n = String(name).toLowerCase(); return this.allFields.find((f) => f.name.toLowerCase() === n) || null; }
  fieldRef(ref) { const m = String(ref).match(/^cf\[(\d+)\]$/i); return m ? this.fieldById(`customfield_${m[1]}`) : this.fieldById(ref) || this.fieldByName(ref); }
  issue(ref) {
    if (!ref) return null;
    const r = String(typeof ref === "object" ? ref.key || ref.id : ref).toUpperCase();
    return this.state.issues[r] || Object.values(this.state.issues).find((i) => i.id === r) || null;
  }
  children(key) { return Object.values(this.state.issues).filter((i) => i.parent === key).sort((a, b) => Number(a.id) - Number(b.id)); }
  subtasks(key) { return this.children(key).filter((i) => this.typeOf(i)?.subtask); }
  search(jql, me) { return runJql(jql, Object.values(this.state.issues), (i, f) => this.jqlGet(i, f), me); }
  attachmentUrl(a) { return `${this.baseUrl}/rest/api/3/attachment/content/${a.id}`; }
  findAttachment(id) { for (const i of Object.values(this.state.issues)) { const a = i.attachments.find((x) => x.id === String(id)); if (a) return { issue: i, att: a }; } return null; }

  // ---------- mutations ----------
  createIssue(input, actor, opts = {}) {
    const proj = this.project(input.project);
    if (!proj) throw new JiraError(400, { project: "Specify a valid project ID or key" });
    const type = this.issueType(proj, input.issueType);
    if (!type) throw new JiraError(400, { issuetype: "Specify a valid issue type" });
    if (!input.summary || !String(input.summary).trim()) throw new JiraError(400, { summary: "You must specify a summary of the issue." });
    let parent = null;
    if (input.parent) {
      parent = this.issue(input.parent);
      if (!parent) throw new JiraError(400, { parent: "Given parent work item does not belong to appropriate hierarchy." });
    }
    if (type.subtask && (!parent || this.typeOf(parent).subtask)) throw new JiraError(400, { parent: "A subtask needs a parent that is not itself a subtask." });
    const n = (this.state.counters[proj.key] || 0) + 1;
    this.state.counters[proj.key] = n;
    const wf = this.workflow(type);
    const status = input.status && wf.statuses.some((s) => s.name === input.status) ? input.status : wf.initial;
    const t = jiraNow();
    const issue = {
      id: String(this.state.nextIssueId++), key: `${proj.key}-${n}`, project: proj.key, issueType: type.name,
      summary: String(input.summary).trim(), description: input.description ? (isAdf(input.description) ? input.description : textToAdf(input.description)) : null,
      status, assignee: input.assignee || null, reporter: input.reporter || actor?.accountId || null, creator: actor?.accountId || null,
      labels: input.labels || [], parent: parent?.key || null, fields: {}, comments: [], attachments: [], changelog: [],
      created: t, updated: t, resolutiondate: null,
    };
    this.state.issues[issue.key] = issue;
    if (input.fields && Object.keys(input.fields).length) this.applyFields(issue, input.fields, actor, { silent: true, trusted: opts.trusted, noHistory: true });
    if (this.statusCategory(issue) === "done") issue.resolutiondate = t;
    this.save();
    if (!opts.silent) this.emit({ type: "issue_created", issue: issue.key, actor });
    return issue;
  }

  normalize(def, value, { trusted, errors }) {
    const fail = (msg) => { errors[def.id] = msg; return undefined; };
    if (value === null || value === undefined || value === "") {
      if (def.id === "summary") return fail("You must specify a summary of the issue.");
      return null;
    }
    switch (def.type) {
      case "string": case "url": case "text": return String(typeof value === "object" && "value" in value ? value.value : value);
      case "doc": return isAdf(value) ? value : textToAdf(value);
      case "number": { const n = Number(value instanceof Object && "value" in value ? value.value : value); return Number.isFinite(n) ? n : fail("Operation value must be a number"); }
      case "select": {
        const opt = typeof value === "object" ? def.options.find((o) => (value.id && o.id === String(value.id)) || (value.value !== undefined && o.value === value.value))
          : trusted ? def.options.find((o) => o.value.toLowerCase() === String(value).toLowerCase()) : null;
        if (!opt) return fail(typeof value === "object" ? `Option value '${value.value ?? value.id}' is not valid` : `Specify a valid 'id' or 'name' for ${def.name}`);
        return { id: opt.id, value: opt.value };
      }
      case "user": { const u = this.user(value); return u ? u.accountId : fail(`Specify a valid value for ${def.name}`); }
      case "labels": return (Array.isArray(value) ? value : String(value).split(/[\s,]+/)).map(String).filter(Boolean);
      case "date": case "datetime": return String(value);
      case "parent": { const p = this.issue(value); return p ? p.key : fail("Given parent work item does not belong to appropriate hierarchy."); }
      default: return value;
    }
  }

  applyFields(issue, input, actor, opts = {}) {
    const errors = {}; const changes = [];
    for (const [ref, raw] of Object.entries(input || {})) {
      const def = this.fieldRef(ref);
      if (!def || def.readOnly) { errors[ref] = `Field '${ref}' cannot be set. It is not on the appropriate screen, or unknown.`; continue; }
      const v = this.normalize(def, raw, { trusted: opts.trusted, errors });
      if (errors[def.id]) continue;
      const system = def.system;
      const old = system ? issue[def.id] : issue.fields[def.id];
      if (JSON.stringify(old ?? null) === JSON.stringify(v ?? null)) continue;
      if (system) issue[def.id] = v; else issue.fields[def.id] = v;
      changes.push({ fieldId: def.id, name: def.name, type: def.type, from: old ?? null, to: v ?? null });
    }
    if (Object.keys(errors).length) throw new JiraError(400, errors);
    if (!changes.length) return changes;
    issue.updated = jiraNow();
    if (!opts.noHistory) this.history(issue, actor, changes.map((c) => ({ field: c.name, fieldId: c.fieldId, from: c.from, to: c.to, fromString: this.display(c, c.from), toString: this.display(c, c.to) })));
    this.save();
    if (!opts.silent) for (const c of changes) this.emit({ type: "field_changed", issue: issue.key, fieldId: c.fieldId, from: c.from, to: c.to, actor });
    return changes;
  }

  display(def, v) {
    if (v == null) return null;
    if (def.type === "select") return v.value;
    if (def.type === "user") return this.user(v)?.displayName || v;
    if (def.type === "doc") return adfToText(v).trim();
    if (Array.isArray(v)) return v.join(" ");
    return String(v);
  }

  history(issue, actor, items) {
    issue.changelog.push({ id: String(this.state.nextChangeId++), author: actor?.accountId || "automation", authorName: actor?.displayName, created: jiraNow(), items });
  }

  transitions(issue) {
    const wf = this.workflow(this.typeOf(issue));
    return wf.transitions.filter((t) => !t.from || t.from === "*" || [].concat(t.from).includes(issue.status));
  }

  findTransition(issue, ref, byStatus = false) {
    const r = String(ref).toLowerCase();
    const list = this.transitions(issue);
    return list.find((t) => t.id === String(ref)) || list.find((t) => t.name.toLowerCase() === r) || (byStatus ? list.find((t) => t.to.toLowerCase() === r) : null) || null;
  }

  doTransition(issue, ref, actor, { comment, fields, silent } = {}) {
    const t = this.findTransition(issue, ref);
    if (!t) throw new JiraError(400, {}, [`Transition id '${ref}' is not valid for this issue.`]);
    if (fields && Object.keys(fields).length) this.applyFields(issue, fields, actor, { silent });
    const from = issue.status;
    issue.status = t.to;
    const cat = this.statusCategory(issue);
    issue.resolutiondate = cat === "done" ? jiraNow() : null;
    issue.updated = jiraNow();
    this.history(issue, actor, [{ field: "status", fieldId: "status", from, to: t.to, fromString: from, toString: t.to }]);
    if (comment) this.addComment(issue, comment, actor, { silent: true });
    this.save();
    if (!silent) this.emit({ type: "issue_transitioned", issue: issue.key, from, to: t.to, transition: t.name, actor });
    return { from, to: t.to, transition: t };
  }

  addComment(issue, body, actor, { silent } = {}) {
    const doc = isAdf(body) ? body : textToAdf(body);
    const t = jiraNow();
    const c = { id: String(this.state.nextCommentId++), author: actor?.accountId || "automation", authorName: actor?.displayName, body: doc, created: t, updated: t };
    issue.comments.push(c); issue.updated = t;
    this.save();
    if (!silent) this.emit({ type: "comment_added", issue: issue.key, comment: c.id, actor });
    return c;
  }

  addAttachment(issue, { filename, mimeType, buffer }, actor, { silent } = {}) {
    const id = String(this.state.nextAttachmentId++);
    fs.writeFileSync(path.join(this.filesDir, id), buffer);
    const a = { id, filename, mimeType: mimeType || mimeOf(filename), size: buffer.length, created: jiraNow(), author: actor?.accountId || "automation" };
    issue.attachments.push(a); issue.updated = a.created;
    this.history(issue, actor, [{ field: "Attachment", fieldId: "attachment", from: null, to: id, fromString: null, toString: filename }]);
    this.save();
    if (!silent) this.emit({ type: "attachment_added", issue: issue.key, attachment: id, actor });
    return a;
  }

  attachmentPath(a) { return path.join(this.filesDir, a.id); }

  deleteIssue(issue, { deleteSubtasks = true } = {}) {
    const kids = this.children(issue.key);
    if (kids.length && !deleteSubtasks) throw new JiraError(400, {}, ["The issue has subtasks; set deleteSubtasks=true."]);
    for (const k of kids) this.deleteIssue(k);
    for (const a of issue.attachments) fs.rmSync(this.attachmentPath(a), { force: true });
    delete this.state.issues[issue.key];
    this.save();
  }

  // ---------- JSON shapes ----------
  userJson(ref, { includeEmail = true } = {}) {
    const u = this.user(ref);
    if (!u) return ref === "automation" ? { accountId: "automation", displayName: "Automation for Jira", accountType: "app", active: true } : null;
    return {
      self: `${this.baseUrl}/rest/api/3/user?accountId=${u.accountId}`, accountId: u.accountId, accountType: "atlassian",
      ...(includeEmail && u.emailVisible !== false && u.emailAddress ? { emailAddress: u.emailAddress } : {}),
      displayName: u.displayName, active: u.active, timeZone: u.timeZone,
      avatarUrls: Object.fromEntries(["48x48", "24x24", "16x16", "32x32"].map((s) => [s, `${this.baseUrl}/_mock/avatar/${u.accountId}.svg`])),
    };
  }

  statusJson(issue) {
    const s = this.statusDef(issue);
    return { self: `${this.baseUrl}/rest/api/3/status/${s.id}`, id: s.id, name: s.name, statusCategory: CATEGORY[s.category || "indeterminate"] };
  }

  typeJson(project, type) {
    return { self: `${this.baseUrl}/rest/api/3/issuetype/${type.id}`, id: type.id, name: type.name, description: type.description || "", subtask: !!type.subtask, hierarchyLevel: type.hierarchyLevel, iconUrl: `${this.baseUrl}/_mock/icon/${encodeURIComponent(type.icon || type.name)}.svg` };
  }

  projectJson(p) {
    return { self: `${this.baseUrl}/rest/api/3/project/${p.id}`, id: p.id, key: p.key, name: p.name, projectTypeKey: "software", simplified: p.style !== "company-managed", style: p.style === "company-managed" ? "classic" : "next-gen", issueTypes: p.issueTypes.map((t) => this.typeJson(p, t)), lead: this.userJson(p.lead || this.ws.users[0]?.accountId) };
  }

  attachmentJson(a) {
    return { self: `${this.baseUrl}/rest/api/3/attachment/${a.id}`, id: a.id, filename: a.filename, author: this.userJson(a.author), created: a.created, size: a.size, mimeType: a.mimeType, content: this.attachmentUrl(a) };
  }

  commentJson(issue, c, v = 3) {
    return { self: `${this.baseUrl}/rest/api/${v}/issue/${issue.id}/comment/${c.id}`, id: c.id, author: this.userJson(c.author), updateAuthor: this.userJson(c.author), body: v === 2 ? adfToText(c.body).trim() : c.body, created: c.created, updated: c.updated, jsdPublic: true };
  }

  issueRef(i) {
    const p = this.project(i.project);
    return { id: i.id, key: i.key, self: `${this.baseUrl}/rest/api/3/issue/${i.id}`, fields: { summary: i.summary, status: this.statusJson(i), priority: null, issuetype: this.typeJson(p, this.typeOf(i)) } };
  }

  toJira(issue, { v = 3, expand = [], fields } = {}) {
    const p = this.project(issue.project);
    const all = {
      summary: issue.summary,
      description: v === 2 ? (issue.description ? adfToText(issue.description).trim() : null) : issue.description,
      status: this.statusJson(issue), issuetype: this.typeJson(p, this.typeOf(issue)),
      project: { self: `${this.baseUrl}/rest/api/3/project/${p.id}`, id: p.id, key: p.key, name: p.name, projectTypeKey: "software", simplified: p.style !== "company-managed" },
      assignee: this.userJson(issue.assignee), reporter: this.userJson(issue.reporter), creator: this.userJson(issue.creator),
      labels: issue.labels, created: issue.created, updated: issue.updated, resolutiondate: issue.resolutiondate,
      statuscategorychangedate: issue.updated,
      parent: issue.parent ? this.issueRef(this.issue(issue.parent)) : undefined,
      subtasks: this.subtasks(issue.key).map((s) => this.issueRef(s)),
      attachment: issue.attachments.map((a) => this.attachmentJson(a)),
      comment: { comments: issue.comments.map((c) => this.commentJson(issue, c, v)), self: `${this.baseUrl}/rest/api/${v}/issue/${issue.id}/comment`, maxResults: issue.comments.length, total: issue.comments.length, startAt: 0 },
    };
    for (const f of this.customFields) {
      const val = issue.fields[f.id];
      all[f.id] = val == null ? null : f.type === "select" ? { self: `${this.baseUrl}/rest/api/3/customFieldOption/${val.id}`, value: val.value, id: val.id } : f.type === "user" ? this.userJson(val) : val;
    }
    if (!all.parent) delete all.parent;
    let out = all;
    const want = (fields || []).flatMap((f) => String(f).split(",")).map((f) => f.trim()).filter(Boolean);
    if (want.length && !want.includes("*all") && !want.includes("*navigable")) {
      out = {};
      for (const f of want) { const def = this.fieldRef(f); const k = def?.id || f; if (k in all) out[k] = all[k]; }
    }
    const res = { expand: "renderedFields,names,schema,operations,editmeta,changelog,versionedRepresentations", id: issue.id, self: `${this.baseUrl}/rest/api/${v}/issue/${issue.id}`, key: issue.key, fields: out };
    const ex = [].concat(expand).flatMap((e) => String(e).split(","));
    if (ex.includes("names")) res.names = Object.fromEntries(this.allFields.map((f) => [f.id, f.name]));
    if (ex.includes("schema")) res.schema = Object.fromEntries(this.customFields.map((f) => [f.id, { type: f.type === "select" ? "option" : f.type, custom: `mock:${f.type}`, customId: Number(f.id.replace("customfield_", "")) }]));
    if (ex.includes("transitions")) res.transitions = this.transitions(issue).map((t) => this.transitionJson(issue, t));
    if (ex.includes("changelog")) res.changelog = this.changelogJson(issue);
    return res;
  }

  transitionJson(issue, t) {
    const wf = this.workflow(this.typeOf(issue));
    const s = wf.statuses.find((x) => x.name === t.to) || { id: "1", name: t.to, category: "indeterminate" };
    return { id: t.id, name: t.name, to: { self: `${this.baseUrl}/rest/api/3/status/${s.id}`, id: s.id, name: s.name, statusCategory: CATEGORY[s.category || "indeterminate"] }, hasScreen: false, isGlobal: !t.from || t.from === "*", isInitial: false, isAvailable: true, isConditional: false, isLooped: false };
  }

  changelogJson(issue) {
    const histories = [...issue.changelog].reverse().map((h) => ({ id: h.id, author: this.userJson(h.author), created: h.created, items: h.items.map((i) => ({ field: i.field, fieldtype: String(i.fieldId).startsWith("customfield_") ? "custom" : "jira", fieldId: i.fieldId, from: i.from == null ? null : typeof i.from === "object" ? i.from.id ?? null : String(i.from), fromString: i.fromString, to: i.to == null ? null : typeof i.to === "object" ? i.to.id ?? null : String(i.to), toString: i.toString })) }));
    return { startAt: 0, maxResults: histories.length, total: histories.length, histories };
  }

  fieldJson(f) {
    const schema = f.system ? { type: f.type, system: f.id } : { type: f.type === "select" ? "option" : f.type === "url" || f.type === "text" ? "string" : f.type, custom: `mock:${f.type}`, customId: Number(f.id.replace("customfield_", "")) };
    return { id: f.id, key: f.id, name: f.name, custom: !f.system, orderable: !f.readOnly, navigable: true, searchable: true, clauseNames: f.system ? [f.id] : [`cf[${f.id.replace("customfield_", "")}]`, f.name], schema };
  }

  jqlGet(issue, f) {
    const k = String(f).toLowerCase();
    switch (k) {
      case "project": return [issue.project, this.project(issue.project)?.name, this.project(issue.project)?.id];
      case "key": case "issuekey": case "id": return [issue.key, issue.id];
      case "issuetype": case "type": return issue.issueType;
      case "status": return issue.status;
      case "statuscategory": return CATEGORY[this.statusCategory(issue)].name;
      case "parent": return issue.parent ? [issue.parent, this.issue(issue.parent)?.id] : null;
      case "assignee": case "reporter": { const u = this.user(issue[k]); return u ? [u.accountId, u.emailAddress, u.displayName] : null; }
      case "summary": return issue.summary;
      case "description": return adfToText(issue.description);
      case "text": return [issue.summary, adfToText(issue.description), ...issue.comments.map((c) => adfToText(c.body))].join("\n");
      case "comment": return issue.comments.map((c) => adfToText(c.body)).join("\n");
      case "labels": return issue.labels;
      case "created": case "updated": return issue[k];
      case "resolved": case "resolutiondate": return issue.resolutiondate;
    }
    const def = this.fieldRef(f);
    if (!def) throw new JiraError(400, {}, [`Field '${f}' does not exist or you do not have permission to view it.`]);
    const v = issue.fields[def.id];
    if (def.type === "user") { const u = this.user(v); return u ? [u.accountId, u.emailAddress, u.displayName] : null; }
    return v && typeof v === "object" && "value" in v ? v.value : v;
  }
}

export function mimeOf(file) {
  const ext = path.extname(String(file)).toLowerCase();
  return { ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml", ".txt": "text/plain", ".md": "text/markdown", ".json": "application/json", ".xml": "application/xml", ".xfdf": "application/vnd.adobe.xfdf", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".csv": "text/csv", ".zip": "application/zip" }[ext] || "application/octet-stream";
}
