# URL Content Analyzer & Summarizer MCP Server

A powerful MCP (Model Context Protocol) server that analyzes web content and generates AI-powered summaries with email delivery capabilities. Perfect for n8n workflows and automation.

## 🎯 What This Does

- **Web Content Analysis**: Scrapes and analyzes any URL
- **AI-Powered Summaries**: Uses Cloudflare Workers AI to generate intelligent summaries
- **Email Integration**: Sends beautifully formatted email summaries via Resend
- **Smart Tagging**: Automatically generates relevant content tags
- **Persistent Storage**: Saves all analyses in Cloudflare D1 database
- **n8n Ready**: Perfect webhook endpoints for workflow automation

## 🚀 Quick Start (Use Shared Demo Server)

### Connect to the Live MCP Server

1. **In Fiberplane Codegen Chat:**
   - Use the MCP server connection feature
   - Connect to: `https://f25330579cf6d535790c1106.fp.dev/mcp`
   - Name it: "URL Content Analyzer"

2. **Available MCP Tools:**
   - `analyze_url` - Analyze any URL and get AI summary
   - `get_summaries` - Retrieve stored summaries with filtering
   - `search_content` - Search through analyzed content
   - `get_url_details` - Get detailed info about specific URLs
   - `email_analysis` - Analyze URL and email the summary

### Example Usage in Chat
```
Analyze this URL: https://example.com
```

or

```
Analyze https://example.com and email the summary to user@example.com
```


## 🔗 n8n Integration

### Key Endpoints for n8n Workflows

**Analyze and Email (Recommended)**
```
POST https://f25330579cf6d535790c1106.fp.dev/webhook/analyze-and-email
Content-Type: application/json
```

```json
{
  "url": "https://example.com",
  "email": "user@example.com",
  "subject": "Optional custom subject"
}
```


**Just Analyze**
```
POST https://f25330579cf6d535790c1106.fp.dev/webhook/analyze
Content-Type: application/json
```

```json
{
  "url": "https://example.com",
  "generate_tags": true,
  "summary_length": "medium"
}
```


**Batch Processing**
```
POST https://f25330579cf6d535790c1106.fp.dev/webhook/batch-analyze
Content-Type: application/json
```

```json
{
  "urls": ["https://example1.com", "https://example2.com"],
  "email": "user@example.com",
  "subject_prefix": "Daily Digest"
}
```


### Example n8n Workflows

1. **Simple Content Analysis**
   ```
   Form Input → HTTP Request (analyze-and-email) → Done!
   ```

2. **Daily News Digest**
   ```
   RSS Feed → Extract URLs → Batch Analyze → Email Summary
   ```

3. **Slack Integration**
   ```
   Slack Webhook → Analyze URL → Post Summary Back to Slack
   ```


## 🏗️ Deploy Your Own Instance

### Prerequisites

- Fiberplane Codegen account
- Resend account (free tier: 3,000 emails/month)
- Basic understanding of Cloudflare Workers

### Step 1: Get Your Resend API Key

1. Sign up at [resend.com](https://resend.com)
2. Go to API Keys section
3. Create a new API key
4. Copy the key (starts with `re_`)

### Step 2: Create Your Fiberplane Project

1. **Create New Project** in Fiberplane Codegen
2. **Copy the Code Files:**
   - **SPEC.md** - Copy the complete specification
   - **src/db/schema.ts** - Copy the database schema
   - **src/index.ts** - Copy the main application code

### Step 3: Configure Secrets

In your Fiberplane project, set the secret:
```
RESEND_API_KEY=your_resend_api_key_here
```


### Step 4: Deploy

1. Deploy your project through Fiberplane Codegen
2. Your MCP server will be available at: `https://your-app-id.fp.dev/mcp`
3. API endpoints will be at: `https://your-app-id.fp.dev/webhook/*`

### Step 5: Test Your Deployment

Test the email functionality:
```bash
curl -X POST https://your-app-id.fp.dev/webhook/analyze-and-email \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com",
    "email": "your@email.com"
  }'
```

## 📊 Features & Capabilities

### Content Analysis
- Extracts title, content, and metadata
- Handles various content types (articles, blogs, news)
- Word count and reading time estimation
- Content type detection

### AI Summarization
- Powered by Cloudflare Workers AI
- Configurable summary length (short, medium, long)
- Context-aware summarization
- Automatic tag generation

### Email Features
- Beautiful HTML email templates
- Responsive design
- Content previews
- Batch processing support
- Error handling and delivery confirmation

### Database Storage
- Persistent storage in Cloudflare D1
- Full-text search capabilities
- Duplicate detection
- Status tracking (pending, completed, failed)

## 🔧 Technical Stack

- **Runtime**: Cloudflare Workers
- **Framework**: Hono.js
- **Database**: Cloudflare D1 (SQLite)
- **ORM**: Drizzle ORM
- **AI**: Cloudflare Workers AI
- **Email**: Resend API
- **Protocol**: MCP (Model Context Protocol)

## 📝 API Documentation

Full OpenAPI documentation available at:
```
https://your-app-id.fp.dev/openapi.json
```
## 🤝 Contributing

This project was built for the Fiberplane + n8n hackathon. Feel free to:

- Fork and modify for your needs
- Submit improvements
- Share your n8n workflow examples

## 🏆 Hackathon Context

Built for the Fiberplane + n8n Hackathon to demonstrate:

- MCP server development
- n8n workflow integration
- Cloudflare Workers deployment
- AI-powered content analysis
- Email automation workflows

Perfect for creating automated content analysis pipelines, news digests, research workflows, and more!

