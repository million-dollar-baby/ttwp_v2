// src/tools/browser.ts
import { chromium, Browser, Page, BrowserContext } from 'playwright';
import path from 'path';
import fs from 'fs';
import { SiteConfig } from '../types';
import { bus } from '../config';

const SCREENSHOT_DIR = path.join(process.cwd(), 'data', 'screenshots');

export class BrowserTool {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private baseUrl: string;

  constructor(private config: SiteConfig, environment: 'production' | 'staging' = 'production') {
    this.baseUrl = (environment === 'staging' && config.stagingUrl
      ? config.stagingUrl
      : config.url).replace(/\/$/, '');
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  }

  private async getPage(): Promise<Page> {
    if (!this.browser) {
      this.browser = await chromium.launch({ headless: true });
      this.context = await this.browser.newContext({
        viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (WP-Agent/1.0)',
      });
      this.page = await this.context.newPage();
    }
    return this.page!;
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page = null;
      this.context = null;
    }
  }

  async navigateTo(url: string): Promise<string> {
    const fullUrl = url.startsWith('http') ? url : `${this.baseUrl}${url}`;
    const page = await this.getPage();
    const response = await page.goto(fullUrl, { waitUntil: 'networkidle', timeout: 30_000 });
    const status = response?.status() ?? 0;
    const title = await page.title();
    bus.log('debug', `Navigated to ${fullUrl} → ${status} "${title}"`, 'tester');
    return JSON.stringify({ url: fullUrl, status, title, currentUrl: page.url() });
  }

  async takeScreenshot(name: string): Promise<string> {
    const page = await this.getPage();
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = path.join(SCREENSHOT_DIR, `${name}-${ts}.png`);
    await page.screenshot({ path: filePath, fullPage: true });
    bus.log('debug', `Screenshot saved: ${filePath}`, 'tester');
    return filePath;
  }

  async getPageContent(): Promise<string> {
    const page = await this.getPage();
    // Return visible text, not raw HTML, to keep context window manageable
    const text = await page.evaluate(() => {
      const el = document.body;
      return el ? el.innerText.slice(0, 8000) : '';
    });
    return text;
  }

  async getConsoleErrors(): Promise<string> {
    const page = await this.getPage();
    const errors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    page.on('pageerror', err => errors.push(err.message));
    // Re-navigate to capture errors
    await page.reload({ waitUntil: 'networkidle' });
    return errors.length > 0 ? errors.join('\n') : 'No console errors detected';
  }

  async clickElement(selector: string): Promise<string> {
    const page = await this.getPage();
    try {
      await page.click(selector, { timeout: 10_000 });
      await page.waitForLoadState('networkidle');
      const title = await page.title();
      return `Clicked "${selector}". New page title: "${title}", URL: ${page.url()}`;
    } catch (err) {
      return `Could not click "${selector}": ${err}`;
    }
  }

  async fillForm(fields: Record<string, string>, submitSelector?: string): Promise<string> {
    const page = await this.getPage();
    const results: string[] = [];

    for (const [selector, value] of Object.entries(fields)) {
      try {
        await page.fill(selector, value);
        results.push(`Filled ${selector}`);
      } catch (err) {
        results.push(`Failed to fill ${selector}: ${err}`);
      }
    }

    if (submitSelector) {
      try {
        await page.click(submitSelector);
        await page.waitForLoadState('networkidle');
        results.push(`Submitted form. URL: ${page.url()}`);
      } catch (err) {
        results.push(`Submit failed: ${err}`);
      }
    }

    return results.join('\n');
  }

  async checkLinks(url?: string): Promise<string> {
    const page = await this.getPage();
    if (url) await page.goto(url, { waitUntil: 'networkidle' });

    const links = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a[href]'))
        .map(a => (a as HTMLAnchorElement).href)
        .filter(href => href.startsWith('http'))
        .slice(0, 50)
    );

    const results: Array<{ url: string; status: number; ok: boolean }> = [];

    for (const link of links) {
      try {
        const response = await page.request.get(link, { timeout: 10_000 });
        results.push({ url: link, status: response.status(), ok: response.ok() });
      } catch {
        results.push({ url: link, status: 0, ok: false });
      }
    }

    const broken = results.filter(r => !r.ok);
    return JSON.stringify({ total: results.length, broken: broken.length, brokenLinks: broken });
  }

  async measurePageSpeed(url: string): Promise<string> {
    const fullUrl = url.startsWith('http') ? url : `${this.baseUrl}${url}`;
    const page = await this.getPage();

    const start = Date.now();
    await page.goto(fullUrl, { waitUntil: 'load' });
    const loadTime = Date.now() - start;

    const metrics = await page.evaluate(() => {
      const perf = window.performance.timing;
      return {
        domContentLoaded: perf.domContentLoadedEventEnd - perf.navigationStart,
        loadComplete: perf.loadEventEnd - perf.navigationStart,
        firstByte: perf.responseStart - perf.navigationStart,
      };
    });

    return JSON.stringify({ url: fullUrl, loadTimeMs: loadTime, ...metrics });
  }

  async testUserFlow(steps: Array<{ action: string; selector?: string; value?: string; url?: string }>): Promise<string> {
    const results: string[] = [];

    for (const step of steps) {
      try {
        const page = await this.getPage();
        switch (step.action) {
          case 'navigate':
            await this.navigateTo(step.url || '/');
            results.push(`✓ Navigated to ${step.url}`);
            break;
          case 'click':
            await page.click(step.selector!, { timeout: 10_000 });
            await page.waitForLoadState('networkidle');
            results.push(`✓ Clicked ${step.selector}`);
            break;
          case 'fill':
            await page.fill(step.selector!, step.value || '');
            results.push(`✓ Filled ${step.selector}`);
            break;
          case 'screenshot':
            const p = await this.takeScreenshot(step.value || 'step');
            results.push(`✓ Screenshot: ${p}`);
            break;
          case 'assert_text':
            const text = await page.textContent(step.selector || 'body') || '';
            if (!text.includes(step.value || '')) {
              results.push(`✗ Text assertion failed: "${step.value}" not found in ${step.selector}`);
            } else {
              results.push(`✓ Text "${step.value}" found`);
            }
            break;
          case 'assert_url':
            if (!page.url().includes(step.value || '')) {
              results.push(`✗ URL assertion failed: expected "${step.value}", got "${page.url()}"`);
            } else {
              results.push(`✓ URL matches "${step.value}"`);
            }
            break;
        }
      } catch (err) {
        results.push(`✗ Step "${step.action}" failed: ${err}`);
      }
    }

    return results.join('\n');
  }

  async loginToWordPress(): Promise<string> {
    const page = await this.getPage();
    await page.goto(`${this.baseUrl}/wp-login.php`, { waitUntil: 'networkidle' });
    await page.fill('#user_login', this.config.wpUser);
    await page.fill('#user_pass', this.config.wpAppPassword);
    await page.click('#wp-submit');
    await page.waitForLoadState('networkidle');
    const success = page.url().includes('wp-admin');
    return success ? `Logged in to WP admin. URL: ${page.url()}` : `Login failed. URL: ${page.url()}`;
  }

  async checkAdminErrors(): Promise<string> {
    const page = await this.getPage();
    if (!page.url().includes('wp-admin')) {
      await this.loginToWordPress();
    }
    await page.goto(`${this.baseUrl}/wp-admin/`, { waitUntil: 'networkidle' });

    const notices = await page.evaluate(() => {
      const els = document.querySelectorAll('.notice, .error, .update-nag, .wp-die-message');
      return Array.from(els).map(el => (el as HTMLElement).innerText.trim()).filter(Boolean);
    });

    return notices.length > 0
      ? `Admin notices found:\n${notices.join('\n')}`
      : 'No admin notices or errors';
  }
}

// ─── Tool definitions ─────────────────────────────────────────

export const browserToolDefinitions = [
  {
    name: 'browser_navigate',
    description: 'Navigate to a URL in the browser and return page status, title',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full URL or path like /about' },
      },
      required: ['url'],
    },
  },
  {
    name: 'browser_screenshot',
    description: 'Take a full-page screenshot of the current page',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'File name prefix' } },
      required: ['name'],
    },
  },
  {
    name: 'browser_get_content',
    description: 'Get the visible text content of the current page',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'browser_get_console_errors',
    description: 'Reload the page and capture any JS console errors',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'browser_click',
    description: 'Click an element by CSS selector',
    input_schema: {
      type: 'object',
      properties: { selector: { type: 'string' } },
      required: ['selector'],
    },
  },
  {
    name: 'browser_fill_form',
    description: 'Fill form fields and optionally submit',
    input_schema: {
      type: 'object',
      properties: {
        fields: {
          type: 'object',
          description: 'Map of CSS selector → value',
          additionalProperties: { type: 'string' },
        },
        submit_selector: { type: 'string', description: 'CSS selector for submit button' },
      },
      required: ['fields'],
    },
  },
  {
    name: 'browser_check_links',
    description: 'Check all links on the current page for broken URLs',
    input_schema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Optional URL to navigate to first' } },
      required: [],
    },
  },
  {
    name: 'browser_measure_speed',
    description: 'Measure page load time and performance timing',
    input_schema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
  },
  {
    name: 'browser_test_flow',
    description: 'Execute a multi-step user flow test (navigate, click, fill, assert)',
    input_schema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['navigate', 'click', 'fill', 'screenshot', 'assert_text', 'assert_url'] },
              selector: { type: 'string' },
              value: { type: 'string' },
              url: { type: 'string' },
            },
            required: ['action'],
          },
        },
      },
      required: ['steps'],
    },
  },
  {
    name: 'browser_wp_login',
    description: 'Log in to the WordPress admin dashboard',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'browser_check_admin_errors',
    description: 'Log in to WP admin and check for admin notices or error messages',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
];

export async function dispatchBrowserTool(
  browser: BrowserTool,
  name: string,
  input: Record<string, unknown>
): Promise<string> {
  switch (name) {
    case 'browser_navigate':       return browser.navigateTo(input.url as string);
    case 'browser_screenshot':     return browser.takeScreenshot(input.name as string);
    case 'browser_get_content':    return browser.getPageContent();
    case 'browser_get_console_errors': return browser.getConsoleErrors();
    case 'browser_click':          return browser.clickElement(input.selector as string);
    case 'browser_fill_form':
      return browser.fillForm(
        input.fields as Record<string, string>,
        input.submit_selector as string | undefined
      );
    case 'browser_check_links':    return browser.checkLinks(input.url as string | undefined);
    case 'browser_measure_speed':  return browser.measurePageSpeed(input.url as string);
    case 'browser_test_flow':
      return browser.testUserFlow(input.steps as Array<{ action: string; selector?: string; value?: string; url?: string }>);
    case 'browser_wp_login':       return browser.loginToWordPress();
    case 'browser_check_admin_errors': return browser.checkAdminErrors();
    default:
      throw new Error(`Unknown browser tool: ${name}`);
  }
}
