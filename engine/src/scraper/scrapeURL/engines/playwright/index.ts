import { z } from "zod";
import { config } from "../../../../config";
import { EngineScrapeResult } from "..";
import { Meta } from "../..";
import { robustFetch } from "../../lib/fetch";
import { getInnerJson } from "@mendable/firecrawl-rs";

export async function scrapeURLWithPlaywright(
  meta: Meta,
): Promise<EngineScrapeResult> {
  const wantScreenshot = meta.featureFlags.has("screenshot") || meta.featureFlags.has("screenshot@fullScreen");
  const fullPage = meta.featureFlags.has("screenshot@fullScreen");

  const response = await robustFetch({
    url: config.PLAYWRIGHT_MICROSERVICE_URL!,
    headers: {
      "Content-Type": "application/json",
    },
    body: {
      url: meta.rewrittenUrl ?? meta.url,
      wait_after_load: meta.options.waitFor,
      timeout: meta.abort.scrapeTimeout(),
      headers: meta.options.headers,
      skip_tls_verification: meta.options.skipTlsVerification,
      ...(wantScreenshot && { screenshot: true, screenshot_full_page: fullPage }),
    },
    method: "POST",
    logger: meta.logger.child("scrapeURLWithPlaywright/robustFetch"),
    schema: z.object({
      content: z.string(),
      pageStatusCode: z.number(),
      pageError: z.string().optional(),
      contentType: z.string().optional(),
      screenshot: z.string().optional(),
    }),
    mock: meta.mock,
    abort: meta.abort.asSignal(),
  });

  if (response.contentType?.includes("application/json")) {
    response.content = await getInnerJson(response.content);
  }

  return {
    url: meta.rewrittenUrl ?? meta.url, // TODO: impove redirect following
    html: response.content,
    statusCode: response.pageStatusCode,
    error: response.pageError,
    contentType: response.contentType,
    screenshot: response.screenshot,

    proxyUsed: "basic",
  };
}

export function playwrightMaxReasonableTime(meta: Meta): number {
  return (meta.options.waitFor ?? 0) + 30000;
}
