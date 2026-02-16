import { describe, it, expect } from 'vitest';
import * as cheerio from 'cheerio';
import { detectSPASkeleton } from '../src/local-scraper';

function detect(html: string): string | null {
  const $ = cheerio.load(html);
  const bodyText = $('body').text() || '';
  return detectSPASkeleton(html, bodyText, $);
}

describe('detectSPASkeleton', () => {
  describe('returns null for real content pages', () => {
    it('normal page with substantial text', () => {
      const html = `<html><body>
        <h1>Welcome to My Blog</h1>
        <p>${'Lorem ipsum dolor sit amet. '.repeat(20)}</p>
        <p>This is a real article with real content that a user would want to read.</p>
      </body></html>`;
      expect(detect(html)).toBeNull();
    });

    it('page with navigation and body content', () => {
      const html = `<html><body>
        <nav><a href="/">Home</a><a href="/about">About</a></nav>
        <main>
          <h1>Article Title</h1>
          <p>${'Real content paragraph with meaningful text. '.repeat(10)}</p>
        </main>
        <footer>Copyright 2024</footer>
      </body></html>`;
      expect(detect(html)).toBeNull();
    });

    it('page with scripts but also substantial text', () => {
      const html = `<html><body>
        <div id="root">
          <h1>Dashboard</h1>
          <p>${'Important dashboard data and metrics displayed here. '.repeat(10)}</p>
        </div>
        <script>console.log("analytics")</script>
      </body></html>`;
      expect(detect(html)).toBeNull();
    });
  });

  describe('detects React SPA shells', () => {
    it('empty #root div', () => {
      const html = `<!DOCTYPE html><html><head>
        <title>My App</title>
      </head><body>
        <div id="root"></div>
        <script src="/static/js/bundle.js"></script>
      </body></html>`;
      const reason = detect(html);
      expect(reason).not.toBeNull();
      expect(reason).toContain('#root');
    });

    it('#root with only a spinner', () => {
      const html = `<!DOCTYPE html><html><body>
        <div id="root"><div class="spinner">Loading...</div></div>
        <script src="/static/js/main.js"></script>
      </body></html>`;
      const reason = detect(html);
      expect(reason).not.toBeNull();
    });
  });

  describe('detects Vue SPA shells', () => {
    it('empty #app div', () => {
      const html = `<!DOCTYPE html><html><body>
        <div id="app"></div>
        <script type="module" src="/src/main.ts"></script>
      </body></html>`;
      const reason = detect(html);
      expect(reason).not.toBeNull();
      expect(reason).toContain('#app');
    });
  });

  describe('detects Next.js SPA shells', () => {
    it('empty #__next div', () => {
      const html = `<!DOCTYPE html><html><body>
        <div id="__next"></div>
        <script src="/_next/static/chunks/main.js"></script>
      </body></html>`;
      const reason = detect(html);
      expect(reason).not.toBeNull();
      expect(reason).toContain('#__next');
    });
  });

  describe('detects Angular SPA shells', () => {
    it('empty app-root element', () => {
      const html = `<!DOCTYPE html><html><body>
        <app-root></app-root>
        <script src="runtime.js"></script>
        <script src="polyfills.js"></script>
        <script src="main.js"></script>
      </body></html>`;
      const reason = detect(html);
      expect(reason).not.toBeNull();
    });
  });

  describe('detects loading indicators', () => {
    it('"Loading..." text in short page', () => {
      const html = `<html><body><div>Loading...</div></body></html>`;
      expect(detect(html)).toContain('loading...');
    });

    it('"Please wait" text', () => {
      const html = `<html><body><p>Please wait while we load your content</p></body></html>`;
      expect(detect(html)).toContain('please wait');
    });

    it('"enable javascript" message', () => {
      const html = `<html><body>
        <noscript>You need to enable JavaScript to run this app.</noscript>
        <div id="root"></div>
      </body></html>`;
      expect(detect(html)).not.toBeNull();
    });

    it('"Checking your browser" (Cloudflare-style)', () => {
      const html = `<html><body>
        <div>Checking your browser before accessing the site...</div>
      </body></html>`;
      expect(detect(html)).toContain('checking your browser');
    });

    it('"just a moment" text', () => {
      const html = `<html><body><h1>Just a moment...</h1></body></html>`;
      expect(detect(html)).toContain('just a moment');
    });
  });

  describe('detects near-empty pages', () => {
    it('completely empty body', () => {
      const html = `<html><body></body></html>`;
      const reason = detect(html);
      expect(reason).not.toBeNull();
      expect(reason).toContain('Near-empty body');
    });

    it('body with only whitespace', () => {
      const html = `<html><body>   \n\n\t  </body></html>`;
      const reason = detect(html);
      expect(reason).not.toBeNull();
      expect(reason).toContain('Near-empty body');
    });
  });

  describe('detects script-heavy pages', () => {
    it('page that is mostly inline scripts with little text', () => {
      const bigScript = 'var a=' + JSON.stringify('x'.repeat(5000)) + ';';
      const html = `<html><body>
        <div id="root">Hi</div>
        <script>${bigScript}</script>
        <script>${bigScript}</script>
      </body></html>`;
      const reason = detect(html);
      expect(reason).not.toBeNull();
    });

    it('script-heavy page without SPA root container', () => {
      const bigScript = 'var a=' + JSON.stringify('x'.repeat(5000)) + ';';
      // ~80 chars of visible text: enough to avoid near-empty (>50) but below meaningful (200)
      const html = `<html><body>
        <div>Welcome to our site. We hope you enjoy your visit here today.</div>
        <script>${bigScript}</script>
        <script>${bigScript}</script>
      </body></html>`;
      const reason = detect(html);
      expect(reason).not.toBeNull();
      expect(reason).toContain('Script-heavy');
    });
  });

  describe('edge cases', () => {
    it('Gatsby shell', () => {
      const html = `<!DOCTYPE html><html><body>
        <div id="___gatsby"></div>
        <script src="/app.js"></script>
      </body></html>`;
      const reason = detect(html);
      expect(reason).not.toBeNull();
      expect(reason).toContain('#___gatsby');
    });

    it('Nuxt shell', () => {
      const html = `<!DOCTYPE html><html><body>
        <div id="__nuxt"></div>
        <script src="/_nuxt/entry.js"></script>
      </body></html>`;
      const reason = detect(html);
      expect(reason).not.toBeNull();
      expect(reason).toContain('#__nuxt');
    });

    it('SvelteKit shell', () => {
      const html = `<!DOCTYPE html><html><body>
        <div id="svelte"></div>
        <script type="module" src="/_app/entry.js"></script>
      </body></html>`;
      const reason = detect(html);
      expect(reason).not.toBeNull();
      expect(reason).toContain('#svelte');
    });

    it('does not false-positive on pages with "loading" in article text', () => {
      const html = `<html><body>
        <h1>How Loading Times Affect User Experience</h1>
        <p>${'This comprehensive article discusses how loading times and page speed impact user experience across modern web applications. '.repeat(5)}</p>
        <p>Studies show that loading speed is a critical factor in user retention and engagement metrics.</p>
      </body></html>`;
      expect(detect(html)).toBeNull();
    });

    it('does not false-positive on a short but real 404 page', () => {
      // A real 404 page might be short but has no SPA indicators
      const html = `<html><body>
        <h1>404 - Page Not Found</h1>
        <p>The page you were looking for could not be found. Please check the URL or go back to the homepage.</p>
        <a href="/">Go Home</a>
      </body></html>`;
      // This is borderline — 100-150 chars of text without SPA indicators
      // Should NOT trigger SPA detection since there are no SPA root containers or loading patterns
      const reason = detect(html);
      expect(reason).toBeNull();
    });
  });
});
