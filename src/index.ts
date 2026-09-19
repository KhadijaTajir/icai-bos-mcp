import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const BASE = "https://boslive.icai.org";

interface ChapterLink {
  title: string;
  url: string;
  isPdf: boolean;
}

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    },
  });
  if (!res.ok) {
    throw new Error(`Fetch failed: ${url} -> ${res.status}`);
  }
  return res.text();
}

// Very light HTML link scraper (no DOM in Workers by default).
// Pulls <a href="..."> ... </a> pairs and their inner text.
function extractLinks(html: string, base: string): ChapterLink[] {
  const links: ChapterLink[] = [];
  const anchorRe = /<a\b[^>]href=["']([^"']+)["'][^>]>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchorRe.exec(html)) !== null) {
    const rawHref = match[1].trim();
    const text = match[2]
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!rawHref || rawHref.startsWith("#") || rawHref.startsWith("javascript:")) {
      continue;
    }
    let absolute: string;
    try {
      absolute = new URL(rawHref, base).toString();
    } catch {
      continue;
    }
    links.push({
      title: text || absolute,
      url: absolute,
      isPdf: /\.pdf($|\?)/i.test(absolute),
    });
  }
  return links;
}

export class IcaiBosMCP extends McpAgent {
  server = new McpServer({
    name: "icai-bos-mcp",
    version: "1.0.0",
  });

  async init() {
    this.server.tool(
      "list_chapters",
      "List chapters/units for an ICAI BOS subject page. Give it a subject listing URL " +
        "(e.g. https://boslive.icai.org/sm_chapter_details.php?p_id=X&m_id=Y). Returns every " +
        "link found on the page, flagging which ones are direct PDFs vs. further unit pages.",
      {
        url: z
          .string()
          .url()
          .describe("Full sm_chapter_details.php (or similar) listing URL on boslive.icai.org"),
      },
      async ({ url }) => {
        const html = await fetchHtml(url);
        const links = extractLinks(html, url).filter((l) => l.url.includes("icai.org"));
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  source: url,
                  count: links.length,
                  links,
                },
                null,
                2
              ),
            },
          ],
        };
      }
    );

    this.server.tool(
      "resolve_pdf",
      "Follow an ICAI BOS unit-details page one hop to find the actual PDF link. Use this " +
        "when list_chapters returns a non-PDF sm_unit_details.php page instead of a direct PDF.",
      {
        url: z
          .string()
          .url()
          .describe("A sm_unit_details.php (or similar) intermediate page URL"),
      },
      async ({ url }) => {
        const html = await fetchHtml(url);
        const links = extractLinks(html, url);
        const pdfLinks = links.filter((l) => l.isPdf);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  source: url,
                  pdfCount: pdfLinks.length,
                  pdfLinks,
                  allLinks: pdfLinks.length === 0 ? links : undefined,
                },
                null,
                2
              ),
            },
          ],
        };
      }
    );
  }
}

export default {
  async fetch(request: Request, env: unknown, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === "/sse" || url.pathname === "/sse/message") {
      // @ts-expect-error - McpAgent typing for static handlers
      return IcaiBosMCP.serveSSE("/sse").fetch(request, env, ctx);
    }

    if (url.pathname === "/mcp") {
      // @ts-expect-error - McpAgent typing for static handlers
      return IcaiBosMCP.serve("/mcp").fetch(request, env, ctx);
    }

    return new Response("icai-bos-mcp is running. Connect at /mcp or /sse.", {
      status: 200,
    });
  },
};
