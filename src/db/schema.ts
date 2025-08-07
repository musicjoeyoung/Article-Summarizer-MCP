import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, real, index } from "drizzle-orm/sqlite-core";
import { relations } from "drizzle-orm";

export const analyzedUrls = sqliteTable("analyzed_urls", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  url: text("url").notNull().unique(),
  title: text("title"),
  content: text("content"),
  summary: text("summary"),
  wordCount: integer("word_count"),
  analysisDate: text("analysis_date"),
  status: text("status", { enum: ["pending", "completed", "failed"] }).notNull().default("pending"),
  errorMessage: text("error_message"),
  contentType: text("content_type"),
  language: text("language"),
  createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
  updatedAt: text("updated_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
}, (t) => [
  index("analyzed_urls_url_idx").on(t.url),
  index("analyzed_urls_status_idx").on(t.status),
  index("analyzed_urls_content_type_idx").on(t.contentType),
  index("analyzed_urls_created_at_idx").on(t.createdAt),
]);

export const contentTags = sqliteTable("content_tags", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  urlId: integer("url_id").notNull().references(() => analyzedUrls.id, { onDelete: "cascade" }),
  tag: text("tag").notNull(),
  confidence: real("confidence"),
  createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
}, (t) => [
  index("content_tags_url_id_idx").on(t.urlId),
  index("content_tags_tag_idx").on(t.tag),
  index("content_tags_confidence_idx").on(t.confidence),
]);

export const analyzedUrlsRelations = relations(analyzedUrls, ({ many }) => ({
  tags: many(contentTags),
}));

export const contentTagsRelations = relations(contentTags, ({ one }) => ({
  analyzedUrl: one(analyzedUrls, {
    fields: [contentTags.urlId],
    references: [analyzedUrls.id],
  }),
}));