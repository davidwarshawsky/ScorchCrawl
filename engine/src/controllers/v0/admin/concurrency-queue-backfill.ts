import { logger as _logger } from "../../../lib/logger";
import { Request, Response } from "express";
import { getRedisConnection } from "../../../services/queue-service";
import { scrapeQueue } from "../../../services/worker/nuq";
import {
  pushConcurrencyLimitedJob,
  pushConcurrencyLimitActiveJob,
  getConcurrencyLimitActiveJobs,
} from "../../../lib/concurrency-limit";
import { RateLimiterMode } from "../../../types";
import { getACUCTeam } from "../../auth";

export async function concurrencyQueueBackfillController(
  req: Request,
  res: Response,
) {
  const logger = _logger.child({
    module: "concurrencyQueueBackfillController",
  });

  logger.info("Starting concurrency queue backfill");

  const backloggedOwnerIDs = req.query.teamId
    ? [req.query.teamId as string]
    : await scrapeQueue.getBackloggedOwnerIDs(logger);

  for (const ownerId of backloggedOwnerIDs) {
    logger.info("Backfilling concurrency queue for team", { teamId: ownerId });

    const backloggedJobIDs = new Set(
      await scrapeQueue.getBackloggedJobIDsOfOnwer(ownerId, logger),
    );
    const queuedJobIDs = new Set<string>();

    let cursor = "0";

    do {
      const result = await getRedisConnection().zscan(
        `concurrency-limit-queue:${ownerId}`,
        cursor,
        "COUNT",
        20,
      );
      cursor = result[0];
      const results = result[1];

      // zscan returns [member1, score1, member2, score2, ...]
      // Only parse members (even indices), skip scores (odd indices)
      for (let i = 0; i < results.length; i += 2) {
        queuedJobIDs.add(JSON.parse(results[i]).id);
      }
    } while (cursor !== "0");

    const jobIDsToAdd = new Set(
      [...backloggedJobIDs].filter(x => !queuedJobIDs.has(x)),
    );

    logger.info("Team statistics", {
      teamId: ownerId,
      backloggedJobIDs: backloggedJobIDs.size,
      queuedJobIDs: queuedJobIDs.size,
      jobIDsToAdd: jobIDsToAdd.size,
    });

    const jobsToAdd = await scrapeQueue.getJobsFromBacklog(
      Array.from(jobIDsToAdd),
      logger,
    );

    // Get concurrency limits for both job types
    const maxCrawlConcurrency =
      (await getACUCTeam(ownerId, false, true, RateLimiterMode.Crawl))
        ?.concurrency ?? 2;
    const maxExtractConcurrency =
      (await getACUCTeam(ownerId, false, true, RateLimiterMode.Extract))
        ?.concurrency ?? 2;

    const currentActiveConcurrency = (
      await getConcurrencyLimitActiveJobs(ownerId)
    ).length;

    const jobsToStart: typeof jobsToAdd = [];
    const jobsToQueue: typeof jobsToAdd = [];

    let activeCount = currentActiveConcurrency;
    for (const job of jobsToAdd) {
      const isExtract = "is_extract" in job.data && job.data.is_extract;
      const limit = isExtract ? maxExtractConcurrency : maxCrawlConcurrency;

      if (activeCount < limit) {
        jobsToStart.push(job);
        activeCount++;
      } else {
        jobsToQueue.push(job);
      }
    }

    for (const job of jobsToQueue) {
      await pushConcurrencyLimitedJob(
        ownerId,
        {
          id: job.id,
          data: job.data,
          priority: job.priority,
          listenable: job.listenChannelId !== undefined,
        },
        Infinity,
      );
    }

    for (const job of jobsToStart) {
      await scrapeQueue.promoteJobFromBacklogOrAdd(job.id, job.data, {
        priority: job.priority,
        listenable: job.listenChannelId !== undefined,
        ownerId: job.data.team_id ?? undefined,
        groupId: job.data.crawl_id ?? undefined,
      });

      await pushConcurrencyLimitActiveJob(ownerId, job.id, 60 * 1000);
    }

    logger.info("Started jobs for team", {
      teamId: ownerId,
      startedCount: jobsToStart.length,
    });

    logger.info("Finished backfilling concurrency queue for team", {
      teamId: ownerId,
    });
  }

  logger.info("Finished backfilling all teams");

  res.json({ ok: true });
}
