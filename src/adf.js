// Atlassian Document Format (ADF) helpers. Jira Cloud v3 uses ADF for descriptions and comments; v2 uses plain text.

const BLOCKS = new Set(["paragraph", "heading", "listItem", "codeBlock", "blockquote", "rule", "panel", "tableRow"]);

export function adfToText(node) {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(adfToText).join("");
  if (node.type === "text") return node.text || "";
  if (node.type === "hardBreak") return "\n";
  if (node.type === "mention") return node.attrs?.text || "@user";
  if (node.type === "emoji") return node.attrs?.text || node.attrs?.shortName || "";
  if (node.type === "inlineCard") return node.attrs?.url || "";
  const inner = adfToText(node.content || []);
  return BLOCKS.has(node.type) ? inner + "\n" : inner;
}

export function textToAdf(text) {
  const paragraphs = String(text ?? "").replace(/\r\n/g, "\n").split(/\n{2,}/);
  return {
    type: "doc",
    version: 1,
    content: paragraphs.map((p) => ({
      type: "paragraph",
      content: p.split("\n").flatMap((line, i, all) => [
        ...(line ? [{ type: "text", text: line }] : []),
        ...(i < all.length - 1 ? [{ type: "hardBreak" }] : []),
      ]),
    })),
  };
}

export function isAdf(v) {
  return v && typeof v === "object" && v.type === "doc" && Array.isArray(v.content);
}
