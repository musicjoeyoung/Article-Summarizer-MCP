import { createFiberplane, createOpenAPISpec } from "@fiberplane/hono";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { eq, desc, like, and, gte, lte } from "drizzle-orm";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { z } from "zod";
import * as schema from "./db/schema";

type Bindings = {
  DB: D1Database;
  AI: Ai;
  RESEND_API_KEY?: string;
};

const app = new Hono<{ Bindings: Bindings }>();

// Helper function to extract content from HTML
function extractContent(html: string): { title: string; content: string; wordCount: number } {
  // Simple HTML parsing without external dependencies
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : "";
  
  // Remove script and style tags
  let cleanHtml = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  cleanHtml = cleanHtml.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
  
  // Extract text content from common content containers
  const contentPatterns = [
    /<article[^>]*>([\s\S]*?)<\/article>/gi,
    /<main[^>]*>([\s\S]*?)<\/main>/gi,
    /<div[^>]*class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/div>/gi,
    /<div[^>]*class="[^"]*post[^"]*"[^>]*>([\s\S]*?)<\/div>/gi,
    /<body[^>]*>([\s\S]*?)<\/body>/gi
  ];
  
  let content = "";
  for (const pattern of contentPatterns) {
    const matches = cleanHtml.match(pattern);
    if (matches && matches[0]) {
      content = matches[0];
      break;
    }
  }
  
  if (!content) {
    content = cleanHtml;
  }
  
  // Remove HTML tags and clean up text
  content = content.replace(/<[^>]+>/g, " ");
  content = content.replace(/\s+/g, " ");
  content = content.replace(/&nbsp;/g, " ");
  content = content.replace(/&amp;/g, "&");
  content = content.replace(/&lt;/g, "<");
  content = content.replace(/&gt;/g, ">");
  content = content.trim();
  
  const wordCount = content.split(/\s+/).filter(word => word.length > 0).length;
  
  return { title, content, wordCount };
}

// Helper function to generate AI summary
async function generateSummary(content: string, ai: Ai, summaryLength: string = "medium"): Promise<{ summary: string; tags: string[] }> {
  const lengthInstructions = {
    short: "in 2-3 sentences",
    medium: "in 1-2 paragraphs",
    long: "in 3-4 paragraphs with detailed analysis"
  };
  
  const instruction = lengthInstructions[summaryLength as keyof typeof lengthInstructions] || lengthInstructions.medium;
  
  const prompt = `Please analyze the following content and provide:
1. A summary ${instruction}
2. 3-5 relevant tags (single words or short phrases)

Content:
${content.substring(0, 4000)}

Format your response as:
SUMMARY: [your summary here]
TAGS: tag1, tag2, tag3, tag4, tag5`;

  try {
    const response = await ai.run("@cf/meta/llama-3.1-8b-instruct", {
      messages: [
        { role: "system", content: "You are a content analyst. Provide concise summaries and relevant tags." },
        { role: "user", content: prompt }
      ],
      max_tokens: 500
    });
    
    const result = response.response || "";
    
    // Extract summary and tags from response
    const summaryMatch = result.match(/SUMMARY:\s*(.*?)(?=TAGS:|$)/s);
    const tagsMatch = result.match(/TAGS:\s*(.*?)$/s);
    
    const summary = summaryMatch ? summaryMatch[1].trim() : result.substring(0, 300);
    const tagsString = tagsMatch ? tagsMatch[1].trim() : "";
    const tags = tagsString.split(",").map(tag => tag.trim()).filter(tag => tag.length > 0).slice(0, 5);
    
    return { summary, tags };
  } catch (error) {
    console.error("AI summarization failed:", error);
    // Fallback to simple truncation
    const summary = content.length > 300 ? content.substring(0, 300) + "..." : content;
    return { summary, tags: [] };
  }
}

// Helper function to analyze a URL
async function analyzeUrl(url: string, db: ReturnType<typeof drizzle>, ai: Ai, options: { generate_tags?: boolean; summary_length?: string } = {}): Promise<any> {
  let urlRecord: any = null;
  
  try {
    // Check if URL already exists
    const [existing] = await db.select().from(schema.analyzedUrls).where(eq(schema.analyzedUrls.url, url));
    if (existing && existing.status === "completed") {
      return existing;
    }
    
    // Create or update record with pending status
    if (existing) {
      await db.update(schema.analyzedUrls)
        .set({ 
          status: "pending", 
          updatedAt: new Date().toISOString(),
          errorMessage: null 
        })
        .where(eq(schema.analyzedUrls.id, existing.id));
      urlRecord = { ...existing, status: "pending" };
    } else {
      [urlRecord] = await db.insert(schema.analyzedUrls)
        .values({
          url,
          status: "pending",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        })
        .returning();
    }
    
    // Fetch and analyze content
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; URL-Analyzer/1.0)'
      }
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const html = await response.text();
    const { title, content, wordCount } = extractContent(html);
    
    if (!content || content.length < 50) {
      throw new Error("Insufficient content extracted from URL");
    }
    
    // Generate AI summary and tags
    const { summary, tags } = await generateSummary(content, ai, options.summary_length);
    
    // Detect content type (simple heuristic)
    let contentType = "article";
    if (url.includes("blog")) contentType = "blog";
    else if (url.includes("news")) contentType = "news";
    
    // Update record with results
    const [updatedRecord] = await db.update(schema.analyzedUrls)
      .set({
        title,
        content,
        summary,
        wordCount,
        analysisDate: new Date().toISOString(),
        status: "completed",
        contentType,
        language: "en", // Simple default
        updatedAt: new Date().toISOString()
      })
      .where(eq(schema.analyzedUrls.id, urlRecord.id))
      .returning();
    
    // Insert tags if requested
    if (options.generate_tags && tags.length > 0) {
      for (const tag of tags) {
        await db.insert(schema.contentTags)
          .values({
            urlId: updatedRecord.id,
            tag,
            confidence: 0.8,
            createdAt: new Date().toISOString()
          });
      }
    }
    
    return updatedRecord;
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    
    // Update record with error status
    if (urlRecord) {
      await db.update(schema.analyzedUrls)
        .set({
          status: "failed",
          errorMessage,
          updatedAt: new Date().toISOString()
        })
        .where(eq(schema.analyzedUrls.id, urlRecord.id));
    } else {
      await db.insert(schema.analyzedUrls)
        .values({
          url,
          status: "failed",
          errorMessage,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
    }
    
    throw error;
  }
}

// Helper function to send email with Resend API
async function sendSummaryEmail(
  resendApiKey: string,
  to: string,
  subject: string,
  summary: any,
  options: { includeFullContent?: boolean } = {}
): Promise<{ success: boolean; emailId?: string; error?: string }> {
  try {
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #333;">URL Analysis Summary</h2>
        
        <div style="background: #f5f5f5; padding: 15px; border-radius: 5px; margin: 15px 0;">
          <h3 style="margin-top: 0; color: #555;">📄 ${summary.title || 'Untitled'}</h3>
          <p style="margin: 5px 0;"><strong>URL:</strong> <a href="${summary.url}" target="_blank">${summary.url}</a></p>
          <p style="margin: 5px 0;"><strong>Word Count:</strong> ${summary.wordCount || 'N/A'}</p>
          <p style="margin: 5px 0;"><strong>Content Type:</strong> ${summary.contentType || 'N/A'}</p>
          <p style="margin: 5px 0;"><strong>Analyzed:</strong> ${new Date(summary.createdAt).toLocaleString()}</p>
        </div>
        
        <div style="margin: 20px 0;">
          <h4 style="color: #333;">📝 AI Summary:</h4>
          <div style="background: white; padding: 15px; border-left: 4px solid #007cba; margin: 10px 0;">
            ${summary.summary || 'No summary available'}
          </div>
        </div>
        
        ${summary.tags ? `
        <div style="margin: 20px 0;">
          <h4 style="color: #333;">🏷️ Tags:</h4>
          <div style="margin: 10px 0;">
            ${summary.tags.split(',').map((tag: string) => 
              `<span style="background: #e1f5fe; color: #01579b; padding: 4px 8px; border-radius: 12px; font-size: 12px; margin-right: 5px; display: inline-block;">${tag.trim()}</span>`
            ).join('')}
          </div>
        </div>
        ` : ''}
        
        ${options.includeFullContent && summary.content ? `
        <div style="margin: 20px 0;">
          <h4 style="color: #333;">📖 Full Content:</h4>
          <div style="background: #fafafa; padding: 15px; border-radius: 5px; max-height: 300px; overflow-y: auto; font-size: 14px; line-height: 1.5;">
            ${summary.content.substring(0, 2000)}${summary.content.length > 2000 ? '...' : ''}
          </div>
        </div>
        ` : ''}
        
        <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; font-size: 12px; color: #666;">
          <p>This summary was generated by the URL Content Analyzer & Summarizer.</p>
        </div>
      </div>
    `;
    
    // Use Resend API directly with fetch
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'onboarding@resend.dev',
        to,
        subject,
        html,
      }),
    });
    
    if (!response.ok) {
      const errorData = await response.text();
      return { success: false, error: `Resend API error: ${response.status} ${errorData}` };
    }
    
    const data = await response.json() as { id: string };
    return { success: true, emailId: data.id };
    
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Unknown email error' 
    };
  }
}

// Create MCP server
function createMcpServer(env: Bindings) {
  const server = new McpServer({
    name: "url-analyzer-mcp",
    version: "1.0.0",
    description: "MCP server for URL content analysis and summarization"
  });
  
  const db = drizzle(env.DB);
  
  // Tool: Analyze URL
  server.tool(
    "analyze_url",
    {
      url: z.string().url().describe("URL to analyze"),
      summary_length: z.enum(["short", "medium", "long"]).default("medium").describe("Length of summary to generate")
    },
    async ({ url, summary_length }) => {
      try {
        const result = await analyzeUrl(url, db, env.AI, { 
          generate_tags: true, 
          summary_length 
        });
        
        return {
          content: [{
            type: "text",
            text: `Analysis completed for: ${url}\n\nTitle: ${result.title}\nSummary: ${result.summary}\nWord Count: ${result.wordCount}\nStatus: ${result.status}`
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Error analyzing URL: ${error instanceof Error ? error.message : "Unknown error"}`
          }],
          isError: true
        };
      }
    }
  );
  
  // Tool: Get summaries
  server.tool(
    "get_summaries",
    {
      limit: z.number().min(1).max(50).default(10).describe("Number of summaries to retrieve"),
      content_type: z.enum(["article", "blog", "news"]).optional().describe("Filter by content type")
    },
    async ({ limit, content_type }) => {
      try {
        let query = db.select().from(schema.analyzedUrls)
          .where(eq(schema.analyzedUrls.status, "completed"))
          .orderBy(desc(schema.analyzedUrls.createdAt))
          .limit(limit);
        
        if (content_type) {
          query = db.select().from(schema.analyzedUrls)
            .where(and(
              eq(schema.analyzedUrls.status, "completed"),
              eq(schema.analyzedUrls.contentType, content_type)
            ))
            .orderBy(desc(schema.analyzedUrls.createdAt))
            .limit(limit);
        }
        
        const results = await query;
        
        const summariesText = results.map(r => 
          `URL: ${r.url}\nTitle: ${r.title}\nSummary: ${r.summary}\nDate: ${r.analysisDate}\n---`
        ).join("\n\n");
        
        return {
          content: [{
            type: "text",
            text: summariesText || "No summaries found"
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Error retrieving summaries: ${error instanceof Error ? error.message : "Unknown error"}`
          }],
          isError: true
        };
      }
    }
  );
  
  // Tool: Search content
  server.tool(
    "search_content",
    {
      query: z.string().min(1).describe("Search query"),
      limit: z.number().min(1).max(20).default(5).describe("Number of results to return")
    },
    async ({ query, limit }) => {
      try {
        const results = await db.select().from(schema.analyzedUrls)
          .where(and(
            eq(schema.analyzedUrls.status, "completed"),
            like(schema.analyzedUrls.content, `%${query}%`)
          ))
          .orderBy(desc(schema.analyzedUrls.createdAt))
          .limit(limit);
        
        const searchResults = results.map(r => 
          `URL: ${r.url}\nTitle: ${r.title}\nSummary: ${r.summary}\nRelevant content: ${r.content?.substring(0, 200)}...\n---`
        ).join("\n\n");
        
        return {
          content: [{
            type: "text",
            text: searchResults || `No results found for query: ${query}`
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Error searching content: ${error instanceof Error ? error.message : "Unknown error"}`
          }],
          isError: true
        };
      }
    }
  );
  
  // Tool: Get URL details
  server.tool(
    "get_url_details",
    {
      url: z.string().url().describe("URL to get details for")
    },
    async ({ url }) => {
      try {
        const [result] = await db.select().from(schema.analyzedUrls)
          .where(eq(schema.analyzedUrls.url, url));
        
        if (!result) {
          return {
            content: [{
              type: "text",
              text: `No analysis found for URL: ${url}`
            }]
          };
        }
        
        // Get tags for this URL
        const tags = await db.select().from(schema.contentTags)
          .where(eq(schema.contentTags.urlId, result.id));
        
        const tagsList = tags.map(t => t.tag).join(", ");
        
        return {
          content: [{
            type: "text",
            text: `URL: ${result.url}\nTitle: ${result.title}\nSummary: ${result.summary}\nWord Count: ${result.wordCount}\nContent Type: ${result.contentType}\nLanguage: ${result.language}\nTags: ${tagsList}\nStatus: ${result.status}\nAnalysis Date: ${result.analysisDate}`
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Error getting URL details: ${error instanceof Error ? error.message : "Unknown error"}`
          }],
          isError: true
        };
      }
    }
  );
  
  // Tool: Send analysis via email
  server.tool(
    "email_analysis",
    {
      url: z.string().url().describe("URL to analyze and email"),
      email: z.string().email().describe("Email address to send the analysis to"),
      subject: z.string().optional().describe("Custom email subject"),
      include_full_content: z.boolean().default(false).describe("Include full content in email")
    },
    async ({ url, email, subject, include_full_content }) => {
      try {
        if (!env.RESEND_API_KEY) {
          return {
            content: [{
              type: "text",
              text: "Email functionality is not configured. Please set RESEND_API_KEY."
            }],
            isError: true
          };
        }
        
        // Analyze the URL first
        const analysis = await analyzeUrl(url, db, env.AI, { generate_tags: true });
        
        // Send email with the analysis
        const emailSubject = subject || `📄 Analysis: ${analysis.title || 'Web Content'}`;
        const emailResult = await sendSummaryEmail(
          env.RESEND_API_KEY,
          email,
          emailSubject,
          analysis,
          { includeFullContent: include_full_content }
        );
        
        if (!emailResult.success) {
          return {
            content: [{
              type: "text",
              text: `Failed to send email: ${emailResult.error}`
            }],
            isError: true
          };
        }
        
        return {
          content: [{
            type: "text",
            text: `✅ Analysis completed and emailed successfully!\n\nURL: ${analysis.url}\nTitle: ${analysis.title}\nSummary: ${analysis.summary}\n\n📧 Email sent to: ${email}\nEmail ID: ${emailResult.emailId}`
          }]
        };
        
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Error analyzing and emailing URL: ${error instanceof Error ? error.message : "Unknown error"}`
          }],
          isError: true
        };
      }
    }
  );
  
  return server;
}

// Webhook endpoint for n8n integration - analyze single URL
app.post("/webhook/analyze", async (c) => {
  const db = drizzle(c.env.DB);
  
  try {
    const { url, options = {}, callback_url } = await c.req.json();
    
    if (!url) {
      return c.json({ error: "URL is required" }, 400);
    }
    
    // Start analysis (async if callback_url provided)
    if (callback_url) {
      // Return immediate response and process in background
      const [record] = await db.insert(schema.analyzedUrls)
        .values({
          url,
          status: "pending",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        })
        .returning();
      
      // Process in background (simplified - in production use queues)
      c.executionCtx.waitUntil(
        analyzeUrl(url, db, c.env.AI, options)
          .then(result => {
            // Send callback (simplified)
            fetch(callback_url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ analysis_id: result.id, status: "completed", result })
            }).catch(console.error);
          })
          .catch(error => {
            fetch(callback_url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ analysis_id: record.id, status: "failed", error: error.message })
            }).catch(console.error);
          })
      );
      
      return c.json({ 
        analysis_id: record.id, 
        status: "pending",
        message: "Analysis started, callback will be sent when complete"
      });
    } else {
      // Synchronous processing
      const result = await analyzeUrl(url, db, c.env.AI, options);
      return c.json({ analysis_id: result.id, status: result.status, result });
    }
  } catch (error) {
    return c.json({ 
      error: "Analysis failed", 
      message: error instanceof Error ? error.message : "Unknown error" 
    }, 500);
  }
});

// Webhook endpoint for batch analysis
app.post("/webhook/batch-analyze", async (c) => {
  const db = drizzle(c.env.DB);
  
  try {
    const { urls, options = {}, callback_url } = await c.req.json();
    
    if (!urls || !Array.isArray(urls) || urls.length === 0) {
      return c.json({ error: "URLs array is required" }, 400);
    }
    
    if (urls.length > 10) {
      return c.json({ error: "Maximum 10 URLs per batch" }, 400);
    }
    
    const results = [];
    
    for (const url of urls) {
      try {
        const result = await analyzeUrl(url, db, c.env.AI, options);
        results.push({ url, status: "completed", analysis_id: result.id });
      } catch (error) {
        results.push({ 
          url, 
          status: "failed", 
          error: error instanceof Error ? error.message : "Unknown error" 
        });
      }
    }
    
    if (callback_url) {
      // Send callback with batch results
      c.executionCtx.waitUntil(
        fetch(callback_url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ batch_results: results })
        }).catch(console.error)
      );
    }
    
    return c.json({ batch_results: results });
  } catch (error) {
    return c.json({ 
      error: "Batch analysis failed", 
      message: error instanceof Error ? error.message : "Unknown error" 
    }, 500);
  }
});

// API endpoint to get summaries
app.get("/api/summaries", async (c) => {
  const db = drizzle(c.env.DB);
  
  try {
    const page = Number.parseInt(c.req.query("page") || "1");
    const limit = Number.parseInt(c.req.query("limit") || "20");
    const status = c.req.query("status");
    const contentType = c.req.query("content_type");
    const search = c.req.query("search");
    
    const offset = (page - 1) * limit;
    
    const conditions: any[] = [];
    if (status) conditions.push(eq(schema.analyzedUrls.status, status as any));
    if (contentType) conditions.push(eq(schema.analyzedUrls.contentType, contentType as any));
    if (search) conditions.push(like(schema.analyzedUrls.content, `%${search}%`));
    
    let whereClause: any = undefined;
    if (conditions.length === 1) {
      whereClause = conditions[0];
    } else if (conditions.length === 2) {
      whereClause = and(conditions[0], conditions[1]);
    } else if (conditions.length === 3) {
      whereClause = and(conditions[0], conditions[1], conditions[2]);
    }
    
    const results = whereClause 
      ? await db.select().from(schema.analyzedUrls)
          .where(whereClause)
          .orderBy(desc(schema.analyzedUrls.createdAt))
          .limit(limit)
          .offset(offset)
      : await db.select().from(schema.analyzedUrls)
          .orderBy(desc(schema.analyzedUrls.createdAt))
          .limit(limit)
          .offset(offset);
    
    return c.json({ 
      summaries: results,
      pagination: { page, limit, total: results.length }
    });
  } catch (error) {
    return c.json({ 
      error: "Failed to retrieve summaries", 
      message: error instanceof Error ? error.message : "Unknown error" 
    }, 500);
  }
});

// API endpoint to search content
app.get("/api/search", async (c) => {
  const db = drizzle(c.env.DB);
  
  try {
    const query = c.req.query("q");
    const contentType = c.req.query("content_type");
    const language = c.req.query("language");
    const dateFrom = c.req.query("date_from");
    const dateTo = c.req.query("date_to");
    const limit = Number.parseInt(c.req.query("limit") || "10");
    
    if (!query) {
      return c.json({ error: "Search query (q) is required" }, 400);
    }
    
    const conditions = [
      eq(schema.analyzedUrls.status, "completed"),
      like(schema.analyzedUrls.content, `%${query}%`)
    ];
    
    if (contentType) conditions.push(eq(schema.analyzedUrls.contentType, contentType));
    if (language) conditions.push(eq(schema.analyzedUrls.language, language));
    if (dateFrom) conditions.push(gte(schema.analyzedUrls.createdAt, dateFrom));
    if (dateTo) conditions.push(lte(schema.analyzedUrls.createdAt, dateTo));
    
    const results = await db.select().from(schema.analyzedUrls)
      .where(and(...conditions))
      .orderBy(desc(schema.analyzedUrls.createdAt))
      .limit(limit);
    
    return c.json({ results, query });
  } catch (error) {
    return c.json({ 
      error: "Search failed", 
      message: error instanceof Error ? error.message : "Unknown error" 
    }, 500);
  }
});

// Get analysis by ID
app.get("/api/analysis/:id", async (c) => {
  const db = drizzle(c.env.DB);
  
  try {
    const id = Number.parseInt(c.req.param("id"));
    
    const [result] = await db.select().from(schema.analyzedUrls)
      .where(eq(schema.analyzedUrls.id, id));
    
    if (!result) {
      return c.json({ error: "Analysis not found" }, 404);
    }
    
    // Get tags
    const tags = await db.select().from(schema.contentTags)
      .where(eq(schema.contentTags.urlId, id));
    
    return c.json({ ...result, tags });
  } catch (error) {
    return c.json({ 
      error: "Failed to retrieve analysis", 
      message: error instanceof Error ? error.message : "Unknown error" 
    }, 500);
  }
});

// Delete analysis
app.delete("/api/analysis/:id", async (c) => {
  const db = drizzle(c.env.DB);
  
  try {
    const id = Number.parseInt(c.req.param("id"));
    
    await db.delete(schema.analyzedUrls)
      .where(eq(schema.analyzedUrls.id, id));
    
    return c.json({ message: "Analysis deleted successfully" });
  } catch (error) {
    return c.json({ 
      error: "Failed to delete analysis", 
      message: error instanceof Error ? error.message : "Unknown error" 
    }, 500);
  }
});

// Get tags
app.get("/api/tags", async (c) => {
  const db = drizzle(c.env.DB);
  
  try {
    const minConfidence = Number.parseFloat(c.req.query("min_confidence") || "0");
    const limit = Number.parseInt(c.req.query("limit") || "50");
    
    const tags = await db.select().from(schema.contentTags)
      .where(gte(schema.contentTags.confidence, minConfidence))
      .limit(limit);
    
    // Group by tag and count occurrences
    const tagCounts = tags.reduce((acc, tag) => {
      acc[tag.tag] = (acc[tag.tag] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    
    const sortedTags = Object.entries(tagCounts)
      .sort(([,a], [,b]) => b - a)
      .map(([tag, count]) => ({ tag, count }));
    
    return c.json({ tags: sortedTags });
  } catch (error) {
    return c.json({ 
      error: "Failed to retrieve tags", 
      message: error instanceof Error ? error.message : "Unknown error" 
    }, 500);
  }
});

// Webhook endpoints for n8n integration

// Webhook: Analyze single URL
app.post("/webhook/analyze", async (c) => {
  const db = drizzle(c.env.DB);
  
  try {
    const { url, email, subject, generate_tags, summary_length, include_full_content } = await c.req.json();
    
    if (!url) {
      return c.json({ error: "URL is required" }, 400);
    }
    
    // Analyze the URL
    const result = await analyzeUrl(url, db, c.env.AI, { generate_tags, summary_length });
    
    // If email is provided, send the summary
    if (email && c.env.RESEND_API_KEY) {
      const emailSubject = subject || `Analysis Summary: ${result.title || 'Untitled'}`;
      const emailResult = await sendSummaryEmail(
        c.env.RESEND_API_KEY,
        email,
        emailSubject,
        result,
        { includeFullContent: include_full_content }
      );
      
      return c.json({
        success: true,
        analysis: result,
        email: emailResult
      });
    }
    
    return c.json({
      success: true,
      analysis: result
    });
    
  } catch (error) {
    return c.json({
      error: "Failed to analyze URL",
      message: error instanceof Error ? error.message : "Unknown error"
    }, 500);
  }
});

// Webhook: Analyze and email (simplified endpoint for n8n)
app.post("/webhook/analyze-and-email", async (c) => {
  const db = drizzle(c.env.DB);
  
  try {
    const { url, email, subject } = await c.req.json();
    
    if (!url || !email) {
      return c.json({ error: "URL and email are required" }, 400);
    }
    
    if (!c.env.RESEND_API_KEY) {
      return c.json({ error: "Email functionality not configured" }, 500);
    }
    
    // Analyze the URL
    const result = await analyzeUrl(url, db, c.env.AI, { generate_tags: true });
    
    // Send email with summary
    const emailSubject = subject || `📄 Analysis: ${result.title || 'Web Content'}`;
    const emailResult = await sendSummaryEmail(
      c.env.RESEND_API_KEY,
      email,
      emailSubject,
      result
    );
    
    if (!emailResult.success) {
      return c.json({
        success: false,
        analysis: result,
        email: { error: emailResult.error }
      }, 500);
    }
    
    return c.json({
      success: true,
      message: "URL analyzed and summary emailed successfully",
      analysis: {
        url: result.url,
        title: result.title,
        summary: result.summary,
        wordCount: result.wordCount,
        status: result.status
      },
      email: {
        sent: true,
        emailId: emailResult.emailId,
        recipient: email
      }
    });
    
  } catch (error) {
    return c.json({
      error: "Failed to analyze and email",
      message: error instanceof Error ? error.message : "Unknown error"
    }, 500);
  }
});

// Webhook: Batch analyze URLs
app.post("/webhook/batch-analyze", async (c) => {
  const db = drizzle(c.env.DB);
  
  try {
    const { urls, email, subject_prefix } = await c.req.json();
    
    if (!urls || !Array.isArray(urls) || urls.length === 0) {
      return c.json({ error: "URLs array is required" }, 400);
    }
    
    if (urls.length > 10) {
      return c.json({ error: "Maximum 10 URLs per batch" }, 400);
    }
    
    // Analyze all URLs
    const results = [];
    for (const url of urls) {
      try {
        const result = await analyzeUrl(url, db, c.env.AI, { generate_tags: true });
        results.push({ success: true, url, analysis: result });
      } catch (error) {
        results.push({ 
          success: false, 
          url, 
          error: error instanceof Error ? error.message : "Unknown error" 
        });
      }
    }
    
    // If email is provided, send batch summary
    if (email && c.env.RESEND_API_KEY) {
      const successful = results.filter(r => r.success);
      const failed = results.filter(r => !r.success);
      
      const emailSubject = `${subject_prefix || 'Batch Analysis'} - ${successful.length} URLs processed`;
      
      // Create batch email content
      const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>📊 Batch URL Analysis Results</h2>
          <p><strong>Total URLs:</strong> ${urls.length} | <strong>Successful:</strong> ${successful.length} | <strong>Failed:</strong> ${failed.length}</p>
          
          ${successful.length > 0 ? `
          <h3>✅ Successfully Analyzed:</h3>
          ${successful.map(r => `
            <div style="border: 1px solid #ddd; margin: 10px 0; padding: 15px; border-radius: 5px;">
              <h4><a href="${r.url}" target="_blank">${r.analysis.title || 'Untitled'}</a></h4>
              <p><strong>Summary:</strong> ${r.analysis.summary}</p>
              <p><strong>Word Count:</strong> ${r.analysis.wordCount} | <strong>Type:</strong> ${r.analysis.contentType}</p>
            </div>
          `).join('')}
          ` : ''}
          
          ${failed.length > 0 ? `
          <h3>❌ Failed to Analyze:</h3>
          ${failed.map(r => `
            <div style="border: 1px solid #ffebee; background: #ffebee; margin: 10px 0; padding: 15px; border-radius: 5px;">
              <p><strong>URL:</strong> ${r.url}</p>
              <p><strong>Error:</strong> ${r.error}</p>
            </div>
          `).join('')}
          ` : ''}
        </div>
      `;
      
      try {
        const response = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${c.env.RESEND_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: 'onboarding@resend.dev',
            to: email,
            subject: emailSubject,
            html,
          }),
        });
        
        if (!response.ok) {
          const errorData = await response.text();
          return c.json({
            success: true,
            results,
            email: { sent: false, error: `Resend API error: ${response.status} ${errorData}` }
          });
        }
        
        const data = await response.json() as { id: string };
        return c.json({
          success: true,
          results,
          email: { sent: true, emailId: data.id }
        });
      } catch (emailError) {
        return c.json({
          success: true,
          results,
          email: { 
            sent: false, 
            error: emailError instanceof Error ? emailError.message : "Email failed" 
          }
        });
      }
    }
    
    return c.json({
      success: true,
      results
    });
    
  } catch (error) {
    return c.json({
      error: "Failed to batch analyze",
      message: error instanceof Error ? error.message : "Unknown error"
    }, 500);
  }
});

// MCP endpoint
app.all("/mcp", async (c) => {
  const mcpServer = createMcpServer(c.env);
  const transport = new StreamableHTTPTransport();
  
  await mcpServer.connect(transport);
  return transport.handleRequest(c);
});

// Root endpoint
app.get("/", (c) => {
  return c.json({
    name: "URL Content Analyzer & Summarizer",
    version: "1.0.0",
    description: "Analyze and summarize web content with AI-powered insights",
    endpoints: {
      webhook: {
        analyze: "POST /webhook/analyze",
        analyze_and_email: "POST /webhook/analyze-and-email",
        batch_analyze: "POST /webhook/batch-analyze"
      },
      api: {
        summaries: "GET /api/summaries",
        search: "GET /api/search",
        analysis: "GET /api/analysis/:id",
        tags: "GET /api/tags"
      },
      mcp: "ALL /mcp"
    }
  });
});

// OpenAPI specification
app.get("/openapi.json", c => {
  return c.json(createOpenAPISpec(app, {
    info: {
      title: "URL Content Analyzer & Summarizer API",
      version: "1.0.0",
      description: "API for analyzing and summarizing web content with AI-powered insights"
    },
  }));
});

// Fiberplane explorer
app.use("/fp/*", createFiberplane({
  app,
  openapi: { url: "/openapi.json" }
}));

export default app;