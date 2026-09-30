// A practical subset of Jira automation smart values.
//
//   {{issue.key}}  {{issue.summary}}  {{issue.status}}  {{issue.Field Name}}  {{issue.customfield_10001}}
//   {{issue.parent.key}}  {{issue.assignee.emailAddress}}  {{issue.attachments.last.content}}
//   {{webResponse.status}}  {{webResponse.body.some.path}}  {{var.NAME}}  {{secret.NAME}}  {{now}}
//   Methods: .plus(n) .minus(n) .multiply(n) .divide(n) .format("0") .asNumber .jsonEncode .asJsonString
//            .urlEncode .toLowerCase .toUpperCase .trim .size .first .last .isEmpty .isNotEmpty
//            .substring(a,b) .replace("a","b")
//   Lists:   {{#issue.subtasks}}{{key}}{{^last}},{{/}}{{/}}
//   Math:    {{#=}}{{issue.Revision}} - 1{{/}}
//
// Like Jira, number fields render with one decimal ("2.0"); use .format("0") for an integer.

export class JiraNumber {
  constructor(n) { this.n = Number(n); }
  get __str() { return Number.isFinite(this.n) && Number.isInteger(this.n) ? this.n.toFixed(1) : String(this.n); }
  valueOf() { return this.n; }
}

export function toStr(v) {
  if (v == null) return "";
  if (v instanceof JiraNumber) return v.__str;
  if (Array.isArray(v)) return v.map(toStr).join(", ");
  if (typeof v === "object") return "__str" in v ? String(v.__str ?? "") : JSON.stringify(stripMeta(v));
  return String(v);
}

function stripMeta(v) {
  if (Array.isArray(v)) return v.map(stripMeta);
  if (v instanceof JiraNumber) return v.n;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([k]) => k !== "__str").map(([k, x]) => [k, stripMeta(x)]));
  return v;
}

const num = (v) => (v instanceof JiraNumber ? v.n : Number(toStr(v)));

function fmt(n, pattern = "0") {
  if (!Number.isFinite(n)) return "";
  const decimals = (String(pattern).split(".")[1] || "").replace(/[^0#]/g, "").length;
  const fixed = n.toFixed(decimals);
  if (!String(pattern).includes(",")) return fixed;
  const [a, b] = fixed.split(".");
  return a.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (b ? "." + b : "");
}

const METHODS = {
  plus: (v, n) => new JiraNumber(num(v) + Number(n)),
  minus: (v, n) => new JiraNumber(num(v) - Number(n)),
  multiply: (v, n) => new JiraNumber(num(v) * Number(n)),
  divide: (v, n) => new JiraNumber(num(v) / Number(n)),
  format: (v, p) => fmt(num(v), p),
  asNumber: (v) => new JiraNumber(num(v)),
  jsonEncode: (v) => JSON.stringify(toStr(v)).slice(1, -1),
  asJsonString: (v) => JSON.stringify(toStr(v)),
  urlEncode: (v) => encodeURIComponent(toStr(v)),
  toLowerCase: (v) => toStr(v).toLowerCase(),
  toUpperCase: (v) => toStr(v).toUpperCase(),
  trim: (v) => toStr(v).trim(),
  size: (v) => (Array.isArray(v) ? v.length : toStr(v).length),
  first: (v) => (Array.isArray(v) ? v[0] : v),
  last: (v) => (Array.isArray(v) ? v[v.length - 1] : v),
  isEmpty: (v) => v == null || (Array.isArray(v) ? v.length === 0 : toStr(v) === ""),
  isNotEmpty: (v) => !(v == null || (Array.isArray(v) ? v.length === 0 : toStr(v) === "")),
  substring: (v, a, b) => toStr(v).substring(Number(a), b === undefined ? undefined : Number(b)),
  replace: (v, a, b) => toStr(v).split(String(a)).join(String(b ?? "")),
};

// Split "a.b(1,'x.y').c" on top-level dots.
function splitPath(expr) {
  const out = []; let cur = ""; let depth = 0; let q = null;
  for (const ch of expr) {
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "." && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter((s) => s !== "");
}

function parseArgs(s) {
  const args = []; let cur = ""; let q = null;
  for (const ch of s) {
    if (q) { if (ch === q) q = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; continue; }
    if (ch === ",") { args.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim() !== "" || args.length) args.push(cur.trim());
  return args;
}

export function getProp(obj, name) {
  if (obj == null) return undefined;
  if (typeof obj === "object" || typeof obj === "function") {
    if (name in obj) return obj[name];
    if (obj.fields && typeof obj.fields === "object" && name in obj.fields) return obj.fields[name];
    const lower = name.toLowerCase();
    const k = Object.keys(obj).find((x) => x.toLowerCase() === lower);
    if (k) return obj[k];
    if (obj.fields) { const f = Object.keys(obj.fields).find((x) => x.toLowerCase() === lower); if (f) return obj.fields[f]; }
  }
  return undefined;
}

function evalExpr(expr, scopes) {
  const segs = splitPath(expr);
  if (!segs.length) return undefined;
  let v;
  const first = segs[0];
  for (let i = scopes.length - 1; i >= 0; i--) {
    const got = getProp(scopes[i], first);
    if (got !== undefined) { v = got; break; }
  }
  for (const seg of segs.slice(1)) {
    const m = seg.match(/^([A-Za-z_][\w]*)\((.*)\)$/s);
    if (m && METHODS[m[1]]) { v = METHODS[m[1]](v, ...parseArgs(m[2])); continue; }
    if (METHODS[seg] && getProp(v, seg) === undefined) { v = METHODS[seg](v); continue; }
    v = getProp(v, seg);
  }
  return v;
}

function parse(tpl) {
  const root = { children: [] }; const stack = [root];
  const re = /{{\s*([#^/]?)([\s\S]*?)\s*}}/g; let last = 0; let m;
  while ((m = re.exec(tpl))) {
    if (m.index > last) stack.at(-1).children.push({ text: tpl.slice(last, m.index) });
    const [, sigil, body] = m;
    if (sigil === "#" || sigil === "^") { const node = { section: body.trim(), inverted: sigil === "^", children: [] }; stack.at(-1).children.push(node); stack.push(node); }
    else if (sigil === "/") { if (stack.length > 1) stack.pop(); }
    else stack.at(-1).children.push({ expr: body.trim() });
    last = re.lastIndex;
  }
  if (last < tpl.length) stack.at(-1).children.push({ text: tpl.slice(last) });
  return root.children;
}

function renderNodes(nodes, scopes) {
  let out = "";
  for (const n of nodes) {
    if ("text" in n) { out += n.text; continue; }
    if ("expr" in n) { out += toStr(evalExpr(n.expr, scopes)); continue; }
    if (n.section === "=") {
      const math = renderNodes(n.children, scopes).trim();
      if (/^[\d+\-*/().\s]+$/.test(math)) { try { const r = Function(`"use strict";return (${math})`)(); out += Number.isInteger(r) ? String(r) : String(Number(r.toFixed(10))); } catch { out += ""; } }
      continue;
    }
    const v = evalExpr(n.section, scopes);
    const empty = v == null || v === false || v === "" || (Array.isArray(v) && v.length === 0);
    if (n.inverted) { if (empty) out += renderNodes(n.children, scopes); continue; }
    if (empty) continue;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        const meta = { first: i === 0, last: i === v.length - 1, index: i };
        out += renderNodes(n.children, [...scopes, item && typeof item === "object" ? item : { value: item }, meta]);
      });
    } else {
      out += renderNodes(n.children, typeof v === "object" ? [...scopes, v] : scopes);
    }
  }
  return out;
}

export function render(tpl, scope) {
  if (tpl == null) return "";
  return renderNodes(parse(String(tpl)), Array.isArray(scope) ? scope : [scope]);
}

export function evaluate(expr, scope) {
  return evalExpr(expr, Array.isArray(scope) ? scope : [scope]);
}
