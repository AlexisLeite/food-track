import type { Root, Element, RootContent } from "hast";

/** Stable word spans fade only when inserted; fenced/inline code retains its highlighter. */
export function revealTextTokens() {
  return (tree: Root) => {
    function visit(node: Root | Element) {
      if (node.type === "element" && ["pre", "code", "script", "style"].includes(node.tagName)) return;
      const children: RootContent[] = node.children;
      const next = children.flatMap<RootContent>(child => {
        if (child.type === "element") { visit(child); return [child]; }
        if (child.type !== "text") return [child];
        return (child.value.match(/\S+\s*|\s+/g) || []).map(value => /^\s+$/.test(value)
          ? { type: "text" as const, value }
          : { type: "element" as const, tagName: "span", properties: { className: ["assistant-token-enter"] }, children: [{ type: "text" as const, value }] });
      });
      if(node.type === "root") node.children = next;
      else node.children = next.filter((child): child is Exclude<RootContent, {type:"doctype"}> => child.type !== "doctype");
    }
    visit(tree);
  };
}
