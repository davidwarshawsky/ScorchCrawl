/**
 * Re-export of the Firecrawl JS SDK (MIT-licensed, @mendable/firecrawl-js).
 * This is the HTTP client that talks to our local engine API.
 * We re-export here so our source files import from a local path
 * without referencing the upstream package name.
 */
import FirecrawlApp from '@mendable/firecrawl-js';
export default FirecrawlApp;
export { FirecrawlApp as ScorchClient };
