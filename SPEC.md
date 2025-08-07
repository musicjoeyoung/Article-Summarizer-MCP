# URL Content Analyzer & Summarizer Specification

This document outlines the design and implementation plan for a URL Content Analyzer & Summarizer that integrates with n8n workflows.

The system will accept URLs via webhook endpoints, scrape and analyze web content, generate AI-powered summaries using Cloudflare Workers AI, and provide both HTTP API endpoints and MCP tools for content analysis automation.

The system will be built using Cloudflare Workers with Hono as the API framework, Cloudflare D1 for data persistence, Drizzle ORM for database operations, and Cloudflare Workers AI for content summarization.

## 1. Technology Stack

- **Edge Runtime:** Cloudflare Workers
- **API Framework:** Hono.js (TypeScript-based API framework)
- **Database:** Cloudflare D1 (serverless SQLite)
- **ORM:** Drizzle ORM for type-safe database operations
- **AI/ML:** Cloudflare Workers AI for content summarization
- **Web Scraping:** Cheerio for HTML parsing and content extraction
- **MCP Integration:** @modelcontextprotocol/sdk and @hono/mcp

## 2. Database Schema Design

The database will store analyzed URLs, their extracted content, generated summaries, and metadata for tracking and retrieval.

### 2.1. analyzed_urls Table

- id (INTEGER, Primary Key, Auto Increment)
- url (TEXT, NOT NULL, Unique)
- title (TEXT)
- content (TEXT)
- summary (TEXT)
- word_count (INTEGER)
- analysis_date (TEXT, ISO timestamp)
- status (TEXT, enum: 'pending', 'completed', 'failed')
- error_message (TEXT, nullable)
- content_type (TEXT, e.g., 'article', 'blog', 'news')
- language (TEXT, detected language code)
- created_at (TEXT, ISO timestamp, DEFAULT CURRENT_TIMESTAMP)
- updated_at (TEXT, ISO timestamp, DEFAULT CURRENT_TIMESTAMP)

### 2.2. content_tags Table

- id (INTEGER, Primary Key, Auto Increment)
- url_id (INTEGER, Foreign Key to analyzed_urls.id)
- tag (TEXT, NOT NULL)
- confidence (REAL, 0.0-1.0)
- created_at (TEXT, ISO timestamp, DEFAULT CURRENT_TIMESTAMP)

## 3. API Endpoints

The API will provide endpoints for URL analysis, content retrieval, and n8n webhook integration.

### 3.1. URL Analysis Endpoints

- **POST /analyze**
  - Description: Analyze a single URL and generate summary
  - Expected Payload:
    ```json
    {
      "url": "https://example.com/article",
      "options": {
        "generate_tags": true,
        "summary_length": "medium"
      }
    }
    ```
  - Response: Analysis result with summary and metadata

- **POST /webhook/analyze**
  - Description: n8n webhook endpoint for URL analysis
  - Expected Payload:
    ```json
    {
      "url": "https://example.com/article",
      "callback_url": "https://n8n-instance.com/webhook/callback"
    }
    ```
  - Response: Immediate acknowledgment with analysis ID

- **POST /batch-analyze**
  - Description: Analyze multiple URLs in batch
  - Expected Payload:
    ```json
    {
      "urls": ["https://example1.com", "https://example2.com"],
      "options": {
        "generate_tags": true,
        "summary_length": "short"
      }
    }
    ```

### 3.2. Content Retrieval Endpoints

- **GET /analysis/:id**
  - Description: Get analysis results by ID
  - Response: Complete analysis data including content and summary

- **GET /analyses**
  - Description: List all analyzed URLs with pagination
  - Query Params: page, limit, status, content_type, search

- **GET /summary/:id**
  - Description: Get only the summary for a specific analysis
  - Response: Summary text and metadata

- **DELETE /analysis/:id**
  - Description: Delete an analysis record

### 3.3. Search and Filter Endpoints

- **GET /search**
  - Description: Search analyzed content by keywords
  - Query Params: q (query), content_type, language, date_from, date_to

- **GET /tags**
  - Description: Get all unique tags with usage counts
  - Query Params: min_confidence, limit

### 3.4. MCP Server Endpoint

- **ALL /mcp**
  - Description: MCP server endpoint for tool integration
  - Provides tools for URL analysis, content search, and summary generation

## 4. MCP Tools

The MCP server will provide the following tools for integration with AI assistants and automation workflows:

### 4.1. analyze_url Tool
- **Purpose:** Analyze a single URL and return summary
- **Parameters:** url (required), summary_length (optional)
- **Returns:** Analysis results with content summary and metadata

### 4.2. search_content Tool
- **Purpose:** Search through analyzed content
- **Parameters:** query (required), content_type (optional), limit (optional)
- **Returns:** Matching analysis results

### 4.3. get_recent_analyses Tool
- **Purpose:** Retrieve recently analyzed URLs
- **Parameters:** limit (optional), content_type (optional)
- **Returns:** List of recent analysis results

### 4.4. batch_analyze_urls Tool
- **Purpose:** Analyze multiple URLs at once
- **Parameters:** urls (array, required), options (optional)
- **Returns:** Batch analysis results

## 5. Content Processing Pipeline

### 5.1. URL Validation and Normalization
- Validate URL format and accessibility
- Normalize URLs to prevent duplicates
- Check for supported content types

### 5.2. Content Extraction
- Use Cheerio to parse HTML content
- Extract title, main content, and metadata
- Handle different content structures (articles, blogs, news)
- Detect language and content type

### 5.3. AI Summarization
- Use Cloudflare Workers AI with `@cf/meta/llama-3.1-8b-instruct` model
- Generate summaries of different lengths (short, medium, long)
- Extract key topics and generate tags
- Detect content sentiment and category

### 5.4. Data Storage
- Store original content and generated summaries
- Index content for fast searching
- Track analysis metadata and performance metrics

## 6. Integrations

### 6.1. Cloudflare Workers AI
- Model: `@cf/meta/llama-3.1-8b-instruct` for content summarization
- Direct integration using `c.env.AI` binding
- Custom prompts for different summary lengths and content types

### 6.2. n8n Workflow Integration
- Webhook endpoints for seamless n8n integration
- Support for callback URLs for asynchronous processing
- Standardized response formats for workflow automation

### 6.3. Web Scraping
- Cheerio for HTML parsing and content extraction
- User-agent rotation and rate limiting
- Error handling for inaccessible or malformed content

## 7. Additional Notes

### 7.1. Error Handling
- Comprehensive error handling for invalid URLs, network failures, and parsing errors
- Graceful degradation when AI services are unavailable
- Detailed error logging for debugging and monitoring

### 7.2. Performance Optimization
- Implement caching for frequently analyzed URLs
- Use database indexes for fast content searching
- Optimize AI model usage to stay within usage limits

### 7.3. Content Security
- Sanitize extracted content to prevent XSS attacks
- Implement rate limiting to prevent abuse
- Validate and filter content before storage

## 8. Further Reading

Take inspiration from the project template here: https://github.com/fiberplane/create-honc-app/tree/main/templates/d1