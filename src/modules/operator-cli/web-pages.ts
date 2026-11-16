import { WebPages } from "../web-pages/main.ts";
import { respond } from "./output.ts";

function webArgs(args: string[]) {
  if (args[0] !== "web" || args[1] !== "open") return null;
  const seen = new Set<string>();
  const rest = args.slice(2).values();
  let url: string | undefined;
  for (const flag of rest) {
    if (seen.has(flag)) return null;
    seen.add(flag);
    if (flag === "--person-requested" || flag === "--json") continue;
    if (flag !== "--url") return null;
    url = rest.next().value;
    if (url === undefined || url.startsWith("--")) return null;
  }
  if (url === undefined) return null;
  return { url, personRequested: seen.has("--person-requested") };
}

export async function runWebPages(args: string[], json: boolean) {
  const parsed = webArgs(args);
  if (parsed === null) return false;
  const result = await WebPages.open(parsed);
  respond({
    operation: "web_open",
    result,
    exitCodes: {
      web_page_not_requested: 4,
      web_page_url_invalid: 2,
      web_page_capability_limited: 3,
      web_page_opener_unavailable: 3,
      web_page_opener_failed: 1,
      web_page_opener_no_answer: 5,
    },
    defect: "web_page_defect",
    json,
  });
  return true;
}
