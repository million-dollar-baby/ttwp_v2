// src/tools/performance.ts
// Tools for optimising WordPress performance: image compression,
// caching configuration, database cleanup, and Core Web Vitals checks.

import { WpCliTool } from './wpcli';
import { BrowserTool } from './browser';
import { SiteConfig } from '../types';
import { bus } from '../config';
import Anthropic from '@anthropic-ai/sdk';

export class PerformanceTool {
  private wpCli: WpCliTool;
  private browser: BrowserTool;

  constructor(private config: SiteConfig, environment: 'production' | 'staging' = 'staging') {
    this.wpCli   = new WpCliTool(config, environment);
    this.browser = new BrowserTool(config, environment);
  }

  async disconnect(): Promise<void> {
    await this.wpCli.disconnect();
    await this.browser.close();
  }

  // ─── Database cleanup ────────────────────────────────────

  async cleanDatabase(): Promise<string> {
    const steps: string[] = [];

    // Count and delete post revisions older than 30 days
    const revCount = await this.wpCli.dbQuery(
      `SELECT COUNT(*) as count FROM wp_posts WHERE post_type = 'revision' AND post_date < DATE_SUB(NOW(), INTERVAL 30 DAY)`
    );
    steps.push(`Post revisions (>30 days): ${revCount}`);

    await this.wpCli.dbQuery(
      `DELETE FROM wp_posts WHERE post_type = 'revision' AND post_date < DATE_SUB(NOW(), INTERVAL 30 DAY)`
    );
    steps.push('Deleted old revisions ✓');

    // Delete expired transients
    const transCount = await this.wpCli.dbQuery(
      `SELECT COUNT(*) as count FROM wp_options WHERE option_name LIKE '_transient_timeout_%' AND option_value < UNIX_TIMESTAMP()`
    );
    steps.push(`Expired transients: ${transCount}`);

    await this.wpCli.exec(
      `wp transient delete --expired --path=${this.wpCli.wpPath} --allow-root`
    );
    steps.push('Deleted expired transients ✓');

    // Delete spam and trashed comments
    const spamCount = await this.wpCli.dbQuery(
      `SELECT COUNT(*) as count FROM wp_comments WHERE comment_approved IN ('spam', 'trash')`
    );
    steps.push(`Spam/trash comments: ${spamCount}`);
    await this.wpCli.dbQuery(
      `DELETE FROM wp_comments WHERE comment_approved IN ('spam', 'trash')`
    );
    steps.push('Deleted spam/trash comments ✓');

    // Orphaned postmeta
    const orphanedMeta = await this.wpCli.dbQuery(
      `SELECT COUNT(*) as count FROM wp_postmeta pm LEFT JOIN wp_posts p ON pm.post_id = p.ID WHERE p.ID IS NULL`
    );
    steps.push(`Orphaned postmeta rows: ${orphanedMeta}`);
    await this.wpCli.dbQuery(
      `DELETE pm FROM wp_postmeta pm LEFT JOIN wp_posts p ON pm.post_id = p.ID WHERE p.ID IS NULL`
    );
    steps.push('Deleted orphaned postmeta ✓');

    // Optimise tables
    await this.wpCli.dbOptimize();
    steps.push('Database tables optimised ✓');

    // Get new DB size
    const dbSize = await this.wpCli.dbQuery(
      `SELECT ROUND(SUM(data_length + index_length) / 1024 / 1024, 2) AS size_mb FROM information_schema.tables WHERE table_schema = DATABASE()`
    );
    steps.push(`Current database size: ${dbSize} MB`);

    return steps.join('\n');
  }

  // ─── Image optimisation check ────────────────────────────
  // Reports images that could be optimised (oversized or missing dimensions)

  async auditImages(): Promise<string> {
    const result = await this.wpCli.dbQuery(`
      SELECT p.ID, p.post_title, pm.meta_value as metadata
      FROM wp_posts p
      LEFT JOIN wp_postmeta pm ON p.ID = pm.post_id AND pm.meta_key = '_wp_attachment_metadata'
      WHERE p.post_type = 'attachment' AND p.post_mime_type LIKE 'image/%'
      ORDER BY p.post_date DESC
      LIMIT 50
    `);

    const lines: string[] = [];
    lines.push('Recent images audit (last 50):');

    // Count total images
    const totalCount = await this.wpCli.dbQuery(
      `SELECT COUNT(*) as count FROM wp_posts WHERE post_type = 'attachment' AND post_mime_type LIKE 'image/%'`
    );
    lines.push(`Total images in media library: ${totalCount}`);

    // Count images missing alt text
    const noAlt = await this.wpCli.dbQuery(`
      SELECT COUNT(*) as count FROM wp_posts p
      WHERE p.post_type = 'attachment' AND p.post_mime_type LIKE 'image/%'
      AND p.ID NOT IN (
        SELECT post_id FROM wp_postmeta WHERE meta_key = '_wp_attachment_image_alt' AND meta_value != ''
      )
    `);
    lines.push(`Images missing alt text: ${noAlt} (SEO/accessibility issue)`);

    // Check if an image optimisation plugin is active
    const plugins = JSON.parse(await this.wpCli.listPlugins());
    const optPlugins = ['smush', 'imagify', 'short-pixel', 'ewww-image-optimizer', 'tinypng', 'kraken-image-optimizer'];
    const activeOptPlugin = plugins.find((p: { name: string; status: string }) =>
      optPlugins.some(op => p.name.toLowerCase().includes(op)) && p.status === 'active'
    );

    if (activeOptPlugin) {
      lines.push(`Image optimisation plugin active: ${activeOptPlugin.name} ✓`);
    } else {
      lines.push('No image optimisation plugin detected. Recommend: Smush, Imagify, or ShortPixel');
    }

    return lines.join('\n');
  }

  // ─── Caching check ───────────────────────────────────────

  async auditCaching(): Promise<string> {
    const lines: string[] = [];

    const plugins = JSON.parse(await this.wpCli.listPlugins());

    const cachePlugins = ['w3-total-cache', 'wp-super-cache', 'litespeed-cache', 'wp-rocket', 'wp-fastest-cache', 'autoptimize'];
    const activeCachePlugin = plugins.find((p: { name: string; status: string }) =>
      cachePlugins.some(cp => p.name.toLowerCase().includes(cp)) && p.status === 'active'
    );

    if (activeCachePlugin) {
      lines.push(`Caching plugin active: ${activeCachePlugin.name} ✓`);
    } else {
      lines.push('No caching plugin detected. Recommend: WP Rocket, W3 Total Cache, or LiteSpeed Cache');
    }

    // Check if object cache (Redis/Memcached) is configured
    try {
      const objectCache = await this.wpCli.exec(`ls ${this.wpCli.wpPath}/wp-content/object-cache.php 2>/dev/null && echo "found" || echo "not found"`);
      lines.push(`Object cache (Redis/Memcached): ${objectCache.trim()}`);
    } catch { /* ignore */ }

    // Check gzip compression via headers
    try {
      const url = this.config.url;
      const result = await this.wpCli.exec(`curl -sI -H "Accept-Encoding: gzip" "${url}" | grep -i "content-encoding" || echo "gzip not detected"`);
      lines.push(`Gzip compression: ${result.trim()}`);
    } catch { /* ignore */ }

    return lines.join('\n');
  }

  // ─── Core Web Vitals via Playwright ─────────────────────

  async measureCoreWebVitals(url: string): Promise<string> {
    const fullUrl = url.startsWith('http') ? url : `${this.config.url}${url}`;
    const page = await (this.browser as unknown as { getPage: () => Promise<import('playwright').Page> }).getPage();

    await page.goto(fullUrl, { waitUntil: 'load' });

    // Run inside browser context — all types are 'any' to avoid Node/DOM conflicts
    const metrics = await page.evaluate(() => {
      return new Promise<Record<string, number>>((resolve) => {
        const result: Record<string, number> = {};

        try {
          // LCP
          new (window as any).PerformanceObserver((list: any) => {
            const entries = list.getEntries();
            if (entries.length) result.lcp = entries[entries.length - 1].startTime;
          }).observe({ type: 'largest-contentful-paint', buffered: true });

          // CLS
          let cls = 0;
          new (window as any).PerformanceObserver((list: any) => {
            for (const entry of list.getEntries()) {
              if (!entry.hadRecentInput) cls += (entry.value || 0);
            }
            result.cls = cls;
          }).observe({ type: 'layout-shift', buffered: true });
        } catch (_) { /* observer not supported */ }

        // Navigation timing
        try {
          const navEntries = (window as any).performance.getEntriesByType('navigation');
          const nav = navEntries && navEntries[0];
          if (nav) {
            result.ttfb = nav.responseStart  - nav.requestStart;
            result.fcp  = nav.domContentLoadedEventEnd - nav.startTime;
            result.load = nav.loadEventEnd   - nav.startTime;
          }
        } catch (_) { /* timing not available */ }

        setTimeout(() => resolve(result), 3000);
      });
    }) as Record<string, number>;

    const gradeMetric = (name: string, value: number): string => {
      const thresholds: Record<string, [number, number]> = {
        lcp:  [2500, 4000],
        cls:  [0.1, 0.25],
        ttfb: [800, 1800],
        fcp:  [1800, 3000],
        load: [3000, 5000],
      };
      const [good, poor] = thresholds[name] || [1000, 2000];
      const grade = value <= good ? '✅ Good' : value <= poor ? '⚠️  Needs improvement' : '🔴 Poor';
      return `${name.toUpperCase()}: ${Math.round(value)}ms — ${grade}`;
    };

    const lines = [
      `Core Web Vitals for ${fullUrl}:`,
      ...Object.entries(metrics).map(([k, v]) => gradeMetric(k, v)),
    ];

    return lines.join('\n');
  }

  // ─── Full performance report ─────────────────────────────

  async fullPerformanceReport(): Promise<string> {
    const sections: string[] = [];

    sections.push('=== DATABASE ===');
    sections.push(await this.cleanDatabase());

    sections.push('\n=== IMAGES ===');
    sections.push(await this.auditImages());

    sections.push('\n=== CACHING ===');
    sections.push(await this.auditCaching());

    sections.push('\n=== CORE WEB VITALS (homepage) ===');
    try {
      sections.push(await this.measureCoreWebVitals('/'));
    } catch (err) {
      sections.push(`Could not measure: ${err}`);
    }

    return sections.join('\n');
  }
}

// ─── Tool definitions ─────────────────────────────────────────

export const performanceToolDefinitions: Anthropic.Tool[] = [
  {
    name: 'perf_clean_database',
    description: 'Clean the WordPress database: remove old revisions, expired transients, spam comments, orphaned postmeta, and optimise tables',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'perf_audit_images',
    description: 'Audit images in the media library: count images, find missing alt text, check for image optimisation plugins',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'perf_audit_caching',
    description: 'Check caching configuration: active caching plugins, object cache, gzip compression',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'perf_core_web_vitals',
    description: 'Measure Core Web Vitals (LCP, CLS, TTFB, FCP, load time) for a page using a real browser',
    input_schema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'Full URL or path like /about' },
      },
      required: ['url'],
    },
  },
  {
    name: 'perf_full_report',
    description: 'Run a complete performance audit: database cleanup + image audit + caching check + Core Web Vitals',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
];

export async function dispatchPerformanceTool(
  perf: PerformanceTool,
  name: string,
  input: Record<string, unknown>
): Promise<string> {
  switch (name) {
    case 'perf_clean_database':    return perf.cleanDatabase();
    case 'perf_audit_images':      return perf.auditImages();
    case 'perf_audit_caching':     return perf.auditCaching();
    case 'perf_core_web_vitals':   return perf.measureCoreWebVitals(input.url as string);
    case 'perf_full_report':       return perf.fullPerformanceReport();
    default:
      throw new Error(`Unknown performance tool: ${name}`);
  }
}
