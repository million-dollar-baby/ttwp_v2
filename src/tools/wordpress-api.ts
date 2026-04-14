// src/tools/wordpress-api.ts
// Manages WordPress content via the REST API (no SSH needed).
// Uses WP Application Passwords for authentication.

import axios, { AxiosInstance } from 'axios';
import { SiteConfig } from '../types';
import { bus } from '../config';
import Anthropic from '@anthropic-ai/sdk';

export class WordPressApiTool {
  private client: AxiosInstance;
  private baseUrl: string;

  constructor(private config: SiteConfig, environment: 'production' | 'staging' = 'production') {
    this.baseUrl = (
      environment === 'staging' && config.stagingUrl
        ? config.stagingUrl
        : config.url
    ).replace(/\/$/, '');

    this.client = axios.create({
      baseURL: `${this.baseUrl}/wp-json/wp/v2`,
      auth: {
        username: config.wpUser,
        password: config.wpAppPassword,
      },
      headers: { 'Content-Type': 'application/json' },
      timeout: 30_000,
    });
  }

  // ─── Site info ────────────────────────────────────────────

  async getSiteInfo(): Promise<string> {
    const res = await this.client.get('/');
    return JSON.stringify({
      name: res.data.name,
      description: res.data.description,
      url: res.data.url,
      home: res.data.home,
      namespaces: res.data.namespaces,
    }, null, 2);
  }

  // ─── Posts ────────────────────────────────────────────────

  async listPosts(params: {
    per_page?: number;
    status?: string;
    search?: string;
    categories?: number[];
    page?: number;
  } = {}): Promise<string> {
    const res = await this.client.get('/posts', {
      params: { per_page: 20, ...params },
    });
    return JSON.stringify(res.data.map((p: Record<string, unknown>) => ({
      id: p.id, slug: p.slug,
      title: (p.title as { rendered: string }).rendered,
      status: p.status,
      date: p.date,
      link: p.link,
    })), null, 2);
  }

  async getPost(id: number): Promise<string> {
    const res = await this.client.get(`/posts/${id}`);
    return JSON.stringify({
      id: res.data.id,
      title: res.data.title.rendered,
      content: res.data.content.rendered.slice(0, 3000),
      excerpt: res.data.excerpt.rendered,
      status: res.data.status,
      slug: res.data.slug,
      categories: res.data.categories,
      tags: res.data.tags,
      meta: res.data.meta,
      date: res.data.date,
      modified: res.data.modified,
    }, null, 2);
  }

  async createPost(data: {
    title: string;
    content: string;
    status?: string;
    slug?: string;
    excerpt?: string;
    categories?: number[];
    tags?: number[];
  }): Promise<string> {
    const res = await this.client.post('/posts', {
      title: data.title,
      content: data.content,
      status: data.status || 'publish',
      slug: data.slug,
      excerpt: data.excerpt,
      categories: data.categories,
      tags: data.tags,
    });
    bus.log('success', `Created post "${data.title}" (id: ${res.data.id})`, 'builder');
    return JSON.stringify({ id: res.data.id, link: res.data.link, slug: res.data.slug });
  }

  async updatePost(id: number, data: Partial<{
    title: string;
    content: string;
    status: string;
    slug: string;
    excerpt: string;
  }>): Promise<string> {
    const res = await this.client.post(`/posts/${id}`, data);
    return JSON.stringify({ id: res.data.id, status: res.data.status, link: res.data.link });
  }

  async deletePost(id: number, force = false): Promise<string> {
    const res = await this.client.delete(`/posts/${id}`, { params: { force } });
    return JSON.stringify({ deleted: res.data.deleted, id });
  }

  // ─── Pages ────────────────────────────────────────────────

  async listPages(params: { per_page?: number; status?: string; search?: string } = {}): Promise<string> {
    const res = await this.client.get('/pages', {
      params: { per_page: 50, ...params },
    });
    return JSON.stringify(res.data.map((p: Record<string, unknown>) => ({
      id: p.id, slug: p.slug,
      title: (p.title as { rendered: string }).rendered,
      status: p.status, link: p.link,
      parent: p.parent, menu_order: p.menu_order,
    })), null, 2);
  }

  async getPage(id: number): Promise<string> {
    const res = await this.client.get(`/pages/${id}`);
    return JSON.stringify({
      id: res.data.id,
      title: res.data.title.rendered,
      content: res.data.content.rendered.slice(0, 4000),
      status: res.data.status,
      slug: res.data.slug,
      parent: res.data.parent,
      template: res.data.template,
      link: res.data.link,
    }, null, 2);
  }

  async createPage(data: {
    title: string;
    content: string;
    status?: string;
    slug?: string;
    parent?: number;
    template?: string;
  }): Promise<string> {
    const res = await this.client.post('/pages', {
      title: data.title,
      content: data.content,
      status: data.status || 'publish',
      slug: data.slug,
      parent: data.parent,
      template: data.template,
    });
    bus.log('success', `Created page "${data.title}" (id: ${res.data.id})`, 'builder');
    return JSON.stringify({ id: res.data.id, link: res.data.link, slug: res.data.slug });
  }

  async updatePage(id: number, data: Partial<{
    title: string;
    content: string;
    status: string;
    slug: string;
    parent: number;
    template: string;
  }>): Promise<string> {
    const res = await this.client.post(`/pages/${id}`, data);
    return JSON.stringify({ id: res.data.id, status: res.data.status, link: res.data.link });
  }

  async deletePage(id: number, force = false): Promise<string> {
    const res = await this.client.delete(`/pages/${id}`, { params: { force } });
    return JSON.stringify({ deleted: res.data.deleted, id });
  }

  // ─── Media ────────────────────────────────────────────────

  async listMedia(params: { per_page?: number; search?: string; media_type?: string } = {}): Promise<string> {
    const res = await this.client.get('/media', {
      params: { per_page: 20, ...params },
    });
    return JSON.stringify(res.data.map((m: Record<string, unknown>) => ({
      id: m.id, slug: m.slug,
      title: (m.title as { rendered: string }).rendered,
      source_url: m.source_url,
      media_type: m.media_type,
      date: m.date,
      alt_text: m.alt_text,
    })), null, 2);
  }

  async updateMediaAlt(id: number, altText: string): Promise<string> {
    const res = await this.client.post(`/media/${id}`, { alt_text: altText });
    return JSON.stringify({ id: res.data.id, alt_text: res.data.alt_text });
  }

  // ─── Categories & Tags ────────────────────────────────────

  async listCategories(): Promise<string> {
    const res = await this.client.get('/categories', { params: { per_page: 100 } });
    return JSON.stringify(res.data.map((c: Record<string, unknown>) => ({
      id: c.id, name: c.name, slug: c.slug, count: c.count, parent: c.parent,
    })), null, 2);
  }

  async createCategory(data: { name: string; slug?: string; parent?: number; description?: string }): Promise<string> {
    const res = await this.client.post('/categories', data);
    return JSON.stringify({ id: res.data.id, name: res.data.name, slug: res.data.slug });
  }

  async listTags(): Promise<string> {
    const res = await this.client.get('/tags', { params: { per_page: 100 } });
    return JSON.stringify(res.data.map((t: Record<string, unknown>) => ({
      id: t.id, name: t.name, slug: t.slug, count: t.count,
    })), null, 2);
  }

  // ─── Users ────────────────────────────────────────────────

  async listUsers(): Promise<string> {
    const res = await this.client.get('/users', { params: { per_page: 50 } });
    return JSON.stringify(res.data.map((u: Record<string, unknown>) => ({
      id: u.id, name: u.name, slug: u.slug,
      email: u.email, roles: u.roles, registered_date: u.registered_date,
    })), null, 2);
  }

  // ─── Menus (requires REST API plugin or WP 5.9+) ─────────

  async listMenus(): Promise<string> {
    try {
      // Try Gutenberg/FSE menus endpoint
      const res = await axios.get(`${this.baseUrl}/wp-json/wp/v2/navigation`, {
        auth: { username: this.config.wpUser, password: this.config.wpAppPassword },
      });
      return JSON.stringify(res.data, null, 2);
    } catch {
      return 'Navigation REST endpoint not available. Use WP-CLI: wp menu list';
    }
  }

  // ─── Custom post types ────────────────────────────────────

  async listCustomPostTypes(): Promise<string> {
    const res = await axios.get(`${this.baseUrl}/wp-json/wp/v2/types`, {
      auth: { username: this.config.wpUser, password: this.config.wpAppPassword },
    });
    return JSON.stringify(Object.keys(res.data), null, 2);
  }

  async listPostsByType(postType: string, params: { per_page?: number; status?: string } = {}): Promise<string> {
    const res = await this.client.get(`/${postType}`, {
      params: { per_page: 20, ...params },
    });
    return JSON.stringify(res.data.map((p: Record<string, unknown>) => ({
      id: p.id, slug: p.slug,
      title: (p.title as { rendered: string })?.rendered || p.id,
      status: p.status, link: p.link,
    })), null, 2);
  }

  // ─── Site settings ────────────────────────────────────────

  async getSiteSettings(): Promise<string> {
    const res = await axios.get(`${this.baseUrl}/wp-json/wp/v2/settings`, {
      auth: { username: this.config.wpUser, password: this.config.wpAppPassword },
    });
    return JSON.stringify(res.data, null, 2);
  }

  async updateSiteSettings(settings: Record<string, unknown>): Promise<string> {
    const res = await axios.post(`${this.baseUrl}/wp-json/wp/v2/settings`, settings, {
      auth: { username: this.config.wpUser, password: this.config.wpAppPassword },
    });
    return JSON.stringify(res.data, null, 2);
  }

  // ─── Search ───────────────────────────────────────────────

  async search(query: string, type = 'post'): Promise<string> {
    const res = await axios.get(`${this.baseUrl}/wp-json/wp/v2/search`, {
      params: { search: query, type, per_page: 10 },
      auth: { username: this.config.wpUser, password: this.config.wpAppPassword },
    });
    return JSON.stringify(res.data, null, 2);
  }
}

// ─── Tool definitions ─────────────────────────────────────────

export const wpApiToolDefinitions: Anthropic.Tool[] = [
  {
    name: 'api_get_site_info',
    description: 'Get WordPress site name, description, and REST API info',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'api_list_posts',
    description: 'List blog posts via REST API',
    input_schema: {
      type: 'object' as const,
      properties: {
        per_page: { type: 'number', default: 20 },
        status: { type: 'string', description: 'publish|draft|private|any', default: 'publish' },
        search: { type: 'string' },
        page: { type: 'number', default: 1 },
      },
      required: [],
    },
  },
  {
    name: 'api_get_post',
    description: 'Get a post by ID including its full content',
    input_schema: {
      type: 'object' as const,
      properties: { id: { type: 'number' } },
      required: ['id'],
    },
  },
  {
    name: 'api_create_post',
    description: 'Create a new blog post',
    input_schema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string' },
        content: { type: 'string', description: 'HTML content' },
        status: { type: 'string', default: 'publish' },
        slug: { type: 'string' },
        excerpt: { type: 'string' },
        categories: { type: 'array', items: { type: 'number' } },
        tags: { type: 'array', items: { type: 'number' } },
      },
      required: ['title', 'content'],
    },
  },
  {
    name: 'api_update_post',
    description: 'Update an existing blog post',
    input_schema: {
      type: 'object' as const,
      properties: {
        id: { type: 'number' },
        title: { type: 'string' },
        content: { type: 'string' },
        status: { type: 'string' },
        slug: { type: 'string' },
        excerpt: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'api_delete_post',
    description: 'Delete a blog post',
    input_schema: {
      type: 'object' as const,
      properties: {
        id: { type: 'number' },
        force: { type: 'boolean', description: 'Permanently delete, skip trash', default: false },
      },
      required: ['id'],
    },
  },
  {
    name: 'api_list_pages',
    description: 'List all pages on the WordPress site',
    input_schema: {
      type: 'object' as const,
      properties: {
        per_page: { type: 'number', default: 50 },
        status: { type: 'string', default: 'any' },
        search: { type: 'string' },
      },
      required: [],
    },
  },
  {
    name: 'api_get_page',
    description: 'Get a page by ID including its full content',
    input_schema: {
      type: 'object' as const,
      properties: { id: { type: 'number' } },
      required: ['id'],
    },
  },
  {
    name: 'api_create_page',
    description: 'Create a new WordPress page',
    input_schema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string' },
        content: { type: 'string', description: 'HTML or Gutenberg block content' },
        status: { type: 'string', default: 'publish' },
        slug: { type: 'string' },
        parent: { type: 'number', description: 'Parent page ID for nested pages' },
        template: { type: 'string', description: 'Page template filename' },
      },
      required: ['title', 'content'],
    },
  },
  {
    name: 'api_update_page',
    description: 'Update an existing WordPress page',
    input_schema: {
      type: 'object' as const,
      properties: {
        id: { type: 'number' },
        title: { type: 'string' },
        content: { type: 'string' },
        status: { type: 'string' },
        slug: { type: 'string' },
        template: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'api_delete_page',
    description: 'Delete a WordPress page',
    input_schema: {
      type: 'object' as const,
      properties: {
        id: { type: 'number' },
        force: { type: 'boolean', default: false },
      },
      required: ['id'],
    },
  },
  {
    name: 'api_list_media',
    description: 'List media library items (images, documents, etc.)',
    input_schema: {
      type: 'object' as const,
      properties: {
        per_page: { type: 'number', default: 20 },
        search: { type: 'string' },
        media_type: { type: 'string', description: 'image|video|audio|application' },
      },
      required: [],
    },
  },
  {
    name: 'api_update_media_alt',
    description: 'Update the alt text of a media item for accessibility/SEO',
    input_schema: {
      type: 'object' as const,
      properties: {
        id: { type: 'number' },
        alt_text: { type: 'string' },
      },
      required: ['id', 'alt_text'],
    },
  },
  {
    name: 'api_list_categories',
    description: 'List all post categories',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'api_create_category',
    description: 'Create a new post category',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string' },
        slug: { type: 'string' },
        parent: { type: 'number' },
        description: { type: 'string' },
      },
      required: ['name'],
    },
  },
  {
    name: 'api_list_tags',
    description: 'List all post tags',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'api_list_users',
    description: 'List WordPress users and their roles',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'api_list_custom_post_types',
    description: 'List all registered custom post types',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'api_list_posts_by_type',
    description: 'List posts of a specific custom post type',
    input_schema: {
      type: 'object' as const,
      properties: {
        post_type: { type: 'string', description: 'The REST API base for the post type (e.g. "products", "events")' },
        per_page: { type: 'number', default: 20 },
        status: { type: 'string', default: 'any' },
      },
      required: ['post_type'],
    },
  },
  {
    name: 'api_get_site_settings',
    description: 'Read WordPress site settings (title, tagline, timezone, etc.)',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'api_update_site_settings',
    description: 'Update WordPress site settings',
    input_schema: {
      type: 'object' as const,
      properties: {
        settings: {
          type: 'object' as const,
          description: 'Settings to update e.g. { "title": "My Site", "description": "Tagline" }',
          additionalProperties: true,
        },
      },
      required: ['settings'],
    },
  },
  {
    name: 'api_search',
    description: 'Search posts, pages, and custom post types by keyword',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string' },
        type: { type: 'string', default: 'post' },
      },
      required: ['query'],
    },
  },
];

// ─── Dispatcher ───────────────────────────────────────────────

export async function dispatchWpApiTool(
  api: WordPressApiTool,
  name: string,
  input: Record<string, unknown>
): Promise<string> {
  switch (name) {
    case 'api_get_site_info':        return api.getSiteInfo();
    case 'api_list_posts':           return api.listPosts(input as Parameters<typeof api.listPosts>[0]);
    case 'api_get_post':             return api.getPost(input.id as number);
    case 'api_create_post':          return api.createPost(input as Parameters<typeof api.createPost>[0]);
    case 'api_update_post': {
      const { id, ...data } = input as { id: number } & Parameters<typeof api.updatePost>[1];
      return api.updatePost(id, data);
    }
    case 'api_delete_post':          return api.deletePost(input.id as number, input.force as boolean);
    case 'api_list_pages':           return api.listPages(input as Parameters<typeof api.listPages>[0]);
    case 'api_get_page':             return api.getPage(input.id as number);
    case 'api_create_page':          return api.createPage(input as Parameters<typeof api.createPage>[0]);
    case 'api_update_page': {
      const { id, ...data } = input as { id: number } & Parameters<typeof api.updatePage>[1];
      return api.updatePage(id, data);
    }
    case 'api_delete_page':          return api.deletePage(input.id as number, input.force as boolean);
    case 'api_list_media':           return api.listMedia(input as Parameters<typeof api.listMedia>[0]);
    case 'api_update_media_alt':     return api.updateMediaAlt(input.id as number, input.alt_text as string);
    case 'api_list_categories':      return api.listCategories();
    case 'api_create_category':      return api.createCategory(input as Parameters<typeof api.createCategory>[0]);
    case 'api_list_tags':            return api.listTags();
    case 'api_list_users':           return api.listUsers();
    case 'api_list_custom_post_types': return api.listCustomPostTypes();
    case 'api_list_posts_by_type':   return api.listPostsByType(input.post_type as string, input as Parameters<typeof api.listPostsByType>[1]);
    case 'api_get_site_settings':    return api.getSiteSettings();
    case 'api_update_site_settings': return api.updateSiteSettings(input.settings as Record<string, unknown>);
    case 'api_search':               return api.search(input.query as string, input.type as string);
    default:
      throw new Error(`Unknown WP API tool: ${name}`);
  }
}
