// src/agents/content-agent.ts
// Content agent: manages posts, pages, media, categories via REST API + WP-CLI.
// Extends the builder's capability with a dedicated content-management focus.

import Anthropic from '@anthropic-ai/sdk';
import { BaseAgent } from './base';
import { AgentName, SiteConfig } from '../types';
import { wpCliToolDefinitions, WpCliTool, dispatchWpCliTool } from '../tools/wpcli';
import { wpApiToolDefinitions, WordPressApiTool, dispatchWpApiTool } from '../tools/wordpress-api';

export class ContentAgent extends BaseAgent {
  name: AgentName = 'builder'; // content work belongs to builder domain
  private wpCli: WpCliTool;
  private wpApi: WordPressApiTool;

  systemPrompt = `You are the Content agent in a WordPress maintenance system.
You specialise in managing all WordPress content: posts, pages, media, categories, tags, menus, and custom post types.

You have TWO sets of tools:
- REST API tools (api_*): Faster for reading and writing content without SSH. Use these first.
- WP-CLI tools (wp_*): For operations not available in REST API, bulk operations, or when REST fails.

CONTENT TASKS YOU HANDLE:
- Creating new posts and pages with correct HTML/Gutenberg content
- Editing existing posts (title, content, status, categories, tags)
- Managing page hierarchy (parent/child pages)
- Bulk content operations (e.g. update all posts in a category)
- Creating and managing categories and tags
- Finding and updating images missing alt text (for SEO/accessibility)
- Managing custom post types
- Searching and auditing existing content
- Updating site settings (title, tagline, timezone)

CONTENT WRITING RULES:
- Write valid HTML for content fields — use <p>, <h2>, <h3>, <ul>, <strong> etc.
- Gutenberg blocks are valid: <!-- wp:paragraph --><p>Text</p><!-- /wp:paragraph -->
- Always confirm the post/page was created by checking the returned ID and link
- For bulk updates, list items first, then update one by one with confirmation

NEVER: publish content with placeholder text, create duplicate posts without checking first.`;

  toolDefinitions: Anthropic.Tool[] = [
    ...wpApiToolDefinitions,
    ...wpCliToolDefinitions,
  ];

  constructor(config: SiteConfig, environment: 'production' | 'staging' = 'staging') {
    super();
    this.wpCli = new WpCliTool(config, environment);
    this.wpApi = new WordPressApiTool(config, environment);
  }

  protected async executeTool(toolName: string, input: Record<string, unknown>): Promise<string> {
    if (toolName.startsWith('api_')) {
      return dispatchWpApiTool(this.wpApi, toolName, input);
    }
    return dispatchWpCliTool(this.wpCli, toolName, input);
  }

  async cleanup(): Promise<void> {
    await this.wpCli.disconnect();
  }
}
