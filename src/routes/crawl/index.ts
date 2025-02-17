import express from "express";
import { crawl_website } from "../../services/crawler";
import { v4 as uuidv4 } from "uuid";
import { redis } from "../../initalizers/redis";
import { executeQuery } from "../../services/postgres";
interface CrawlStatus {
  id: string;
  totalUrls: number;
  processedUrls?: number;
  successfulUrls?: number;
  failedUrls?: number;
  status: "in_progress" | "completed" | "failed";
  startTime?: number;
  endTime?: number;
  duration?: number;
  currentUrl?: string;
  error?: string;
  timestamp?: number;
  progressPercentage?: number;
}

const router = express.Router();

// SSE endpoint for status updates
router.get("/status/:crawlId", (req, res) => {
  const { crawlId } = req.params;

  // Set headers for SSE
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  // Subscribe to Redis channel for this crawl
  const channel = `crawl:${crawlId}`;

  redis.subscribe(channel, (error: any) => {
    if (error) {
      console.error(`Error subscribing to channel ${channel}:`, error);
      res.end();
      return;
    }
  });

  redis.on("message", (channel: string, message: string) => {
    res.write(`data: ${message}\n\n`);

    // If crawl is complete, close the connection
    const data = JSON.parse(message) as CrawlStatus;
    if (data.status === "completed" || data.status === "failed") {
      redis.unsubscribe(channel);
      res.end();
    }
  });

  // Handle client disconnect
  req.on("close", () => {
    redis.unsubscribe(channel);
  });
});

const isGitHubUrl = (url: string): boolean => {
  return url.includes("github.com");
};

// Updated helper functions
const extractRepoName = (url: string): string => {
  const parts = url.split("/").filter((part) => part.trim() !== "");
  const githubIndex = parts.findIndex((p) => p.includes("github.com"));
  return githubIndex >= 0 && parts.length > githubIndex + 2
    ? parts[githubIndex + 2]
    : "unknown";
};

const extractDomainName = (url: string): string => {
  try {
    const parsedUrl = new URL(url);
    const hostParts = parsedUrl.hostname.split(".").filter((p) => p !== "www");
    return hostParts.length > 0 ? hostParts[0] : "unknown";
  } catch {
    return "unknown";
  }
};

router.post("/", async (req, res) => {
  try {
    const {
      urls: rawUrls,
      maxDepth = 7,
      batchSize = 10,
      concurrency = 5,
    } = req.body;

    if (!rawUrls) {
      return res.status(400).json({ error: "URLs are required" });
    }

    // Process URL entries with validation
    const urlEntries = rawUrls
      .map((entry: any) => {
        const url = entry.url?.trim().replace(/\/$/, "") || "";
        let type = entry.type;

        if (!type) {
          type = isGitHubUrl(url)
            ? extractRepoName(url)
            : extractDomainName(url);
          if (type === "unknown") {
            console.error(`Skipping URL with invalid format: ${url}`);
            return null;
          }
        }

        return {
          url,
          organization_id: type,
          type: type,
        };
      })
      .filter(Boolean);

    if (urlEntries.length === 0) {
      return res
        .status(400)
        .json({ error: "No valid URLs provided after filtering" });
    }

    // Check and insert teams if necessary
    for (const entry of urlEntries) {
      const teamExists = await executeQuery(async (client) => {
        const res = await client.query(`SELECT 1 FROM teams WHERE name = $1`, [
          entry.type,
        ]);
        return res?.rows?.length > 0;
      });

      if (!teamExists) {
        await executeQuery(async (client) => {
          await client.query(
            `INSERT INTO teams (name, domain_url, created_at, updated_at) VALUES ($1, $2, NOW(), NOW())`,
            [entry.type, new URL(entry.url).origin]
          );
        });
      }
    }

    // Generate crawl ID and initial status
    const crawlId = uuidv4();
    const initialStatus: CrawlStatus = {
      id: crawlId,
      totalUrls: urlEntries.length,
      processedUrls: 0,
      successfulUrls: 0,
      failedUrls: 0,
      status: "in_progress",
      startTime: Date.now(),
    };

    // Store initial status in Redis
    await redis.set(`crawl:${crawlId}:status`, JSON.stringify(initialStatus));

    // Start crawling with processed entries
    process.nextTick(async () => {
      try {
        const batches = [];
        for (let i = 0; i < urlEntries.length; i += batchSize) {
          batches.push(urlEntries.slice(i, i + batchSize));
        }

        let processedCount = 0;
        let successCount = 0;
        let failedCount = 0;

        for (const batch of batches) {
          const batchPromises = batch.map((entry: any) => {
            return crawl_website(
              entry.url,
              maxDepth,
              entry.organization_id,
              entry.type
            )
              .then((result) => {
                processedCount++;
                if (result && result.length >= 0) {
                  successCount++;
                } else {
                  failedCount++;
                }

                // Publish progress update
                const progress: CrawlStatus = {
                  id: crawlId,
                  totalUrls: urlEntries.length,
                  processedUrls: processedCount,
                  successfulUrls: successCount,
                  failedUrls: failedCount,
                  status: "in_progress",
                  currentUrl: entry.url,
                  timestamp: Date.now(),
                  progressPercentage: Math.round(
                    (processedCount / urlEntries.length) * 100
                  ),
                };

                redis.publish(`crawl:${crawlId}`, JSON.stringify(progress));
                return result;
              })
              .catch((error: Error) => {
                console.error(`Crawling failed for ${entry.url}:`, error);
                processedCount++;
                failedCount++;

                // Publish error update
                const errorUpdate: CrawlStatus = {
                  id: crawlId,
                  totalUrls: urlEntries.length,
                  processedUrls: processedCount,
                  successfulUrls: successCount,
                  failedUrls: failedCount,
                  status: "in_progress",
                  error: error.message,
                  currentUrl: entry.url,
                  timestamp: Date.now(),
                };

                redis.publish(`crawl:${crawlId}`, JSON.stringify(errorUpdate));
                return null;
              });
          });

          // Process batch with concurrency limit
          await Promise.all(
            batchPromises
              .reduce(
                (
                  acc: Promise<any>[][],
                  promise: Promise<any>,
                  index: number
                ) => {
                  if (index % concurrency === 0) {
                    acc.push([]);
                  }
                  acc[acc.length - 1].push(promise);
                  return acc;
                },
                []
              )
              .map((group: Promise<any>[]) => Promise.all(group))
          );
        }

        // Publish completion status
        const finalStatus: CrawlStatus = {
          id: crawlId,
          totalUrls: urlEntries.length,
          processedUrls: processedCount,
          successfulUrls: successCount,
          failedUrls: failedCount,
          status: "completed",
          endTime: Date.now(),
          duration: Date.now() - (initialStatus.startTime || 0),
        };

        redis.publish(`crawl:${crawlId}`, JSON.stringify(finalStatus));
        redis.set(`crawl:${crawlId}:status`, JSON.stringify(finalStatus));
      } catch (error) {
        // Publish error status
        const errorStatus: CrawlStatus = {
          id: crawlId,
          totalUrls: urlEntries.length,
          status: "failed",
          error: error instanceof Error ? error.message : "Unknown error",
          endTime: Date.now(),
          duration: Date.now() - (initialStatus.startTime || 0),
        };

        redis.publish(`crawl:${crawlId}`, JSON.stringify(errorStatus));
        redis.set(`crawl:${crawlId}:status`, JSON.stringify(errorStatus));
      }
    });

    return res.json({
      message: "Crawling started successfully",
      crawlId,
      statusEndpoint: `/api/crawl/status/${crawlId}`,
      totalUrls: urlEntries.length,
      processedUrls: 0,
      progressPercentage: 0,
    });
  } catch (error: any) {
    res.status(500).json({
      error: "Failed to start crawling",
      message: error.message,
    });
  }
});

// Get current status of a crawl
router.get("/status/:crawlId/current", async (req, res) => {
  try {
    const { crawlId } = req.params;
    const status = await redis.get(`crawl:${crawlId}:status`);

    if (!status) {
      return res.status(404).json({ error: "Crawl status not found" });
    }

    res.json(JSON.parse(status));
  } catch (error: any) {
    res.status(500).json({
      error: "Failed to get crawl status",
      message: error.message,
    });
  }
});

export default router;
