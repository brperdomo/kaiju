// A practical JQL subset: AND / OR / NOT / parentheses; = != ~ !~ > < >= <= IN, NOT IN, IS [NOT] EMPTY;
// fields project, key, issuetype, status, statusCategory, parent, assignee, reporter, summary, description,
// text, labels, created, updated, resolved, cf[10001] or a custom field name; currentUser(); ORDER BY.

const KEYWORDS = new Set(["AND", "OR", "NOT", "IN", "IS", "EMPTY", "NULL", "ORDER", "BY", "ASC", "DESC"]);

export class JqlError extends Error {}

function tokenize(s) {
  const out = []; let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1; let v = "";
      while (j < s.length && s[j] !== c) { if (s[j] === "\\") j++; v += s[j++] ?? ""; }
      if (j >= s.length) throw new JqlError("Unterminated string in JQL");
      out.push({ t: "str", v }); i = j + 1; continue;
    }
    if ("(),".includes(c)) { out.push({ t: c }); i++; continue; }
    const op = s.slice(i).match(/^(!=|!~|>=|<=|=|~|>|<)/);
    if (op) { out.push({ t: "op", v: op[1] }); i += op[1].length; continue; }
    const w = s.slice(i).match(/^[^\s(),=!~<>"']+/);
    if (!w) throw new JqlError(`Unexpected character '${c}' in JQL`);
    i += w[0].length;
    const up = w[0].toUpperCase();
    out.push(KEYWORDS.has(up) ? { t: "kw", v: up } : { t: "word", v: w[0] });
  }
  return out;
}

export function parseJql(q) {
  const toks = tokenize(q || ""); let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];
  const isKw = (v) => peek()?.t === "kw" && peek().v === v;
  const expect = (t) => { const k = next(); if (!k || k.t !== t) throw new JqlError(`Expected '${t}' in JQL`); };
  const value = () => {
    const k = next();
    if (!k) throw new JqlError("Expected a value in JQL");
    if (k.t === "str") return k.v;
    if (k.t === "kw" && (k.v === "EMPTY" || k.v === "NULL")) return null;
    if (k.t === "word") {
      if (peek()?.t === "(") {
        next(); const args = [];
        while (peek() && peek().t !== ")") { const a = next(); if (a.t !== ",") args.push(a.v); }
        expect(")");
        return { fn: k.v.toLowerCase(), args };
      }
      return k.v;
    }
    throw new JqlError(`Unexpected '${k.v ?? k.t}' in JQL`);
  };
  const clause = () => {
    const f = next();
    if (!f || (f.t !== "word" && f.t !== "str")) throw new JqlError("Expected a field name in JQL");
    let op;
    if (peek()?.t === "op") op = next().v;
    else if (isKw("IN")) { next(); op = "in"; }
    else if (isKw("NOT")) { next(); if (!isKw("IN")) throw new JqlError("Expected IN after NOT"); next(); op = "not in"; }
    else if (isKw("IS")) { next(); if (isKw("NOT")) { next(); op = "is not"; } else op = "is"; }
    else throw new JqlError(`Expected an operator after '${f.v}'`);
    let v;
    if (op === "in" || op === "not in") {
      expect("("); v = [];
      while (peek() && peek().t !== ")") { if (peek().t === ",") { next(); continue; } v.push(value()); }
      expect(")");
    } else v = value();
    return { field: f.v, op, value: v };
  };
  const unary = () => {
    if (isKw("NOT")) { next(); return { not: unary() }; }
    if (peek()?.t === "(") { next(); const e = or(); expect(")"); return e; }
    return clause();
  };
  const and = () => { let l = unary(); while (isKw("AND")) { next(); l = { and: [l, unary()] }; } return l; };
  const or = () => { let l = and(); while (isKw("OR")) { next(); l = { or: [l, and()] }; } return l; };
  let where = null; const order = [];
  if (toks.length && !isKw("ORDER")) where = or();
  if (isKw("ORDER")) {
    next(); if (!isKw("BY")) throw new JqlError("Expected BY after ORDER"); next();
    while (peek()) {
      const f = next(); if (f.t === ",") continue;
      let dir = "ASC"; if (isKw("ASC") || isKw("DESC")) dir = next().v;
      order.push({ field: f.v, dir });
    }
  }
  if (p < toks.length) throw new JqlError(`Unexpected '${toks[p].v ?? toks[p].t}' in JQL`);
  return { where, order };
}

const lc = (x) => String(x).toLowerCase();
const isNum = (x) => x !== null && x !== "" && !Number.isNaN(Number(x));

function cmp(a, b) {
  if (isNum(a) && isNum(b)) return Number(a) - Number(b);
  const da = Date.parse(a); const db = Date.parse(b);
  if (!Number.isNaN(da) && !Number.isNaN(db)) return da - db;
  return lc(a).localeCompare(lc(b));
}

// get(issue, fieldName) returns a value or an array of equivalent values (e.g. accountId, email, name).
export function runJql(q, issues, get, me) {
  const { where, order } = parseJql(q);
  const cands = (issue, f) => { const v = get(issue, f); return (Array.isArray(v) ? v : [v]).map((x) => (x && typeof x === "object" && "value" in x ? x.value : x)); };
  const expand = (v) => (v && typeof v === "object" && v.fn === "currentuser" ? [me?.accountId, me?.emailAddress].filter(Boolean) : [v]);
  const eq = (a, b) => a != null && b != null && lc(a) === lc(b);
  const test = (issue, n) => {
    if (!n) return true;
    if (n.and) return test(issue, n.and[0]) && test(issue, n.and[1]);
    if (n.or) return test(issue, n.or[0]) || test(issue, n.or[1]);
    if (n.not) return !test(issue, n.not);
    const c = cands(issue, n.field);
    const empty = c.every((x) => x == null || x === "" || (Array.isArray(x) && !x.length));
    const vals = (Array.isArray(n.value) ? n.value : [n.value]).flatMap(expand);
    const any = (fn) => c.some((a) => a != null && vals.some((b) => b != null && fn(a, b)));
    switch (n.op) {
      case "=": return n.value === null ? empty : any(eq);
      case "!=": return n.value === null ? !empty : !any(eq);
      case "in": return any(eq);
      case "not in": return !any(eq);
      case "is": return empty;
      case "is not": return !empty;
      case "~": return any((a, b) => lc(a).includes(lc(b).replace(/\*/g, "")));
      case "!~": return !any((a, b) => lc(a).includes(lc(b).replace(/\*/g, "")));
      case ">": return any((a, b) => cmp(a, b) > 0);
      case "<": return any((a, b) => cmp(a, b) < 0);
      case ">=": return any((a, b) => cmp(a, b) >= 0);
      case "<=": return any((a, b) => cmp(a, b) <= 0);
      default: throw new JqlError(`Unsupported operator ${n.op}`);
    }
  };
  const out = issues.filter((i) => test(i, where));
  const sortBy = order.length ? order : [{ field: "created", dir: "DESC" }];
  out.sort((a, b) => {
    for (const o of sortBy) {
      const keyField = /^(key|issuekey)$/i.test(o.field);
      const pick = (i) => { const v = cands(i, o.field)[0]; return keyField && v ? Number(String(v).split("-").pop()) : v; };
      const va = pick(a); const vb = pick(b);
      const r = va == null && vb == null ? 0 : va == null ? 1 : vb == null ? -1 : cmp(va, vb);
      if (r) return o.dir === "DESC" ? -r : r;
    }
    return 0;
  });
  return out;
}
