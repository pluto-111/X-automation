// Enhanced Twitter Automation with Auto-Posting
const express = require("express");
const bodyParser = require("body-parser");
const puppeteer = require("puppeteer");
const axios = require("axios");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { TwitterApi } = require('twitter-api-v2');

const app = express();
app.use(bodyParser.json());

// 🔐 Configuration - Add Twitter API credentials
const dotenv = require("dotenv");
dotenv.config();
const GEMINI_API_KEY = process.env.GEMINI_API_KEY // "your_gemini_api_key";
const ZAP2_WEBHOOK_URL = process.env.ZAP2_WEBHOOK_URL // "your_zapier_webhook_url";
const TARGET_PROFILE = process.env.TARGET_PROFILE // "target_profile_name";

// 🐦 Twitter API Configuration
const TWITTER_CONFIG = {
  appKey: process.env.TWITTER_API_KEY || 'your_twitter_api_key',
  appSecret: process.env.TWITTER_API_SECRET || 'your_twitter_api_secret',
  accessToken: process.env.TWITTER_ACCESS_TOKEN || 'your_access_token',
  accessSecret: process.env.TWITTER_ACCESS_SECRET || 'your_access_secret',
};

// Initialize clients
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const twitterClient = new TwitterApi(TWITTER_CONFIG);

// 🛡️ Safety and control settings
const POSTING_CONFIG = {
  autoPostEnabled: process.env.AUTO_POST_ENABLED === 'true' || false,
  requireApproval: process.env.REQUIRE_APPROVAL !== 'false', // Default to true
  maxPostsPerHour: parseInt(process.env.MAX_POSTS_PER_HOUR) || 5,
  minDelayBetweenPosts: parseInt(process.env.MIN_DELAY_SECONDS) || 60, // seconds
  dryRun: process.env.DRY_RUN === 'true' || false
};

// 📊 In-memory tracking (use database in production)
const postingStats = {
  postsThisHour: 0,
  lastPostTime: 0,
  totalPosts: 0,
  totalErrors: 0,
  pendingApprovals: [],
  recentPosts: []
};

// ✅ Enhanced home route with posting status
app.get("/", (req, res) => {
  res.json({
    status: "🚀 Twitter Automation Server with Auto-Posting",
    postingEnabled: POSTING_CONFIG.autoPostEnabled,
    requireApproval: POSTING_CONFIG.requireApproval,
    dryRun: POSTING_CONFIG.dryRun,
    stats: {
      postsThisHour: postingStats.postsThisHour,
      totalPosts: postingStats.totalPosts,
      pendingApprovals: postingStats.pendingApprovals.length
    },
    endpoints: {
      webhook: "/webhook - Main automation endpoint",
      approve: "/approve/:id - Approve pending posts",
      reject: "/reject/:id - Reject pending posts",
      stats: "/stats - Posting statistics",
      pending: "/pending - View pending approvals"
    },
    lastRun: new Date().toISOString()
  });
});

// 📊 Stats endpoint
app.get("/stats", (req, res) => {
  res.json({
    ...postingStats,
    config: POSTING_CONFIG,
    hourlyRateLimit: {
      current: postingStats.postsThisHour,
      max: POSTING_CONFIG.maxPostsPerHour,
      resetTime: new Date(Date.now() + (60 - new Date().getMinutes()) * 60000).toISOString()
    }
  });
});

// 📋 Pending approvals endpoint
app.get("/pending", (req, res) => {
  res.json({
    count: postingStats.pendingApprovals.length,
    pending: postingStats.pendingApprovals
  });
});

// ✅ Approve pending post
app.post("/approve/:id", async (req, res) => {
  const { id } = req.params;
  const pendingPost = postingStats.pendingApprovals.find(p => p.id === id);
  
  if (!pendingPost) {
    return res.status(404).json({ error: "Pending post not found" });
  }

  try {
    const result = await postReplyToTwitter(
      pendingPost.originalTweetId,
      pendingPost.replyText,
      pendingPost.originalTweetURL
    );

    // Remove from pending and add to recent
    postingStats.pendingApprovals = postingStats.pendingApprovals.filter(p => p.id !== id);
    postingStats.recentPosts.unshift({
      ...pendingPost,
      postedAt: new Date().toISOString(),
      twitterResponse: result,
      status: 'approved_and_posted'
    });

    res.json({
      message: "✅ Post approved and published",
      tweetId: result.tweetId,
      pendingPost
    });

  } catch (error) {
    res.status(500).json({
      error: "Failed to post after approval",
      message: error.message
    });
  }
});

// ❌ Reject pending post
app.post("/reject/:id", (req, res) => {
  const { id } = req.params;
  const pendingPost = postingStats.pendingApprovals.find(p => p.id === id);
  
  if (!pendingPost) {
    return res.status(404).json({ error: "Pending post not found" });
  }

  postingStats.pendingApprovals = postingStats.pendingApprovals.filter(p => p.id !== id);
  
  res.json({
    message: "❌ Post rejected and removed",
    rejectedPost: pendingPost
  });
});

// ⏰ Rate limiting check
function canPostNow() {
  const now = Date.now();
  const oneHourAgo = now - (60 * 60 * 1000);
  
  // Reset hourly counter if needed
  if (postingStats.lastPostTime < oneHourAgo) {
    postingStats.postsThisHour = 0;
  }
  
  // Check rate limits
  if (postingStats.postsThisHour >= POSTING_CONFIG.maxPostsPerHour) {
    return { canPost: false, reason: "Hourly rate limit exceeded" };
  }
  
  if (now - postingStats.lastPostTime < POSTING_CONFIG.minDelayBetweenPosts * 1000) {
    return { canPost: false, reason: "Too soon since last post" };
  }
  
  return { canPost: true };
}

// 🐦 Extract Twitter ID from URL
function extractTweetId(tweetUrl) {
  if (!tweetUrl) return null;
  
  // Handle both nitter.net and x.com URLs
  const match = tweetUrl.match(/\/status\/(\d+)/);
  return match ? match[1] : null;
}

// 🚀 Main Twitter posting function
async function postReplyToTwitter(originalTweetId, replyText, originalUrl) {
  if (POSTING_CONFIG.dryRun) {
    console.log("🧪 DRY RUN - Would post:", { originalTweetId, replyText });
    return {
      success: true,
      dryRun: true,
      tweetId: 'dry_run_' + Date.now(),
      originalTweetId,
      replyText
    };
  }

  try {
    // Post reply to Twitter
    const tweet = await twitterClient.v2.reply(replyText, originalTweetId);
    
    console.log("✅ Successfully posted reply to Twitter:", tweet.data.id);
    
    // Update stats
    postingStats.totalPosts++;
    postingStats.postsThisHour++;
    postingStats.lastPostTime = Date.now();
    
    return {
      success: true,
      tweetId: tweet.data.id,
      originalTweetId,
      replyText,
      postedAt: new Date().toISOString()
    };
    
  } catch (error) {
    console.error("❌ Failed to post to Twitter:", error.message);
    postingStats.totalErrors++;
    
    throw new Error(`Twitter API Error: ${error.message}`);
  }
}

// ✨ Enhanced Gemini reply generation (same as before)
async function generateReply(tweetText, retries = 2) {
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

  const prompt = `
You are a thoughtful and engaging social media commenter. Generate a natural, constructive reply to this tweet.

Guidelines:
- Keep it conversational and authentic (1-2 sentences max)
- Add value or insight, don't just agree
- Use relevant emojis sparingly (max 1-2)
- Avoid controversial topics
- Be supportive but not overly promotional
- Make it feel human and genuine

Tweet to reply to:
"${tweetText}"

Reply:`;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const result = await model.generateContent(prompt);
      const response = await result.response;
      const text = response.text().trim();
      
      if (text.length > 10 && text.length < 280) {
        return text;
      }
      
      if (attempt === retries) {
        return "Thanks for sharing this insight! 🤔";
      }
    } catch (err) {
      console.error(`❌ Gemini API attempt ${attempt + 1} failed:`, err.message);
      
      if (attempt === retries) {
        return "Interesting perspective - thanks for sharing! 💭";
      }
      
      await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
}

// 🕸️ Scraping function (same as before)
async function scrapeNitterProfile(profileName, maxTweets = 2) {
  let browser;
  
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run'
      ]
    });

    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );
    
    await page.setViewport({ width: 1366, height: 768 });
    
    const nitterUrl = `https://nitter.net/${TARGET_PROFILE}`;
    console.log(`🔍 Navigating to: ${nitterUrl}`);

    await page.goto(nitterUrl, {
      waitUntil: "networkidle2",
      timeout: 30000
    });

    await page.waitForSelector(".timeline-item", { timeout: 20000 });

    await page.evaluate(async () => {
      for (let i = 0; i < 3; i++) {
        window.scrollBy(0, window.innerHeight);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    });

    const tweets = await page.$$eval(".timeline-item", (nodes, maxCount) => {
      return nodes.slice(0, maxCount).map((node, index) => {
        const contentElement = node.querySelector('.tweet-content');
        const linkElement = node.querySelector("a[href*='/status/']");
        
        const content = contentElement ? contentElement.innerText.trim() : node.innerText.trim();
        const link = linkElement ? "https://nitter.net" + linkElement.getAttribute("href") : null;
        
        const username = node.querySelector('.username')?.innerText || profileName;
        const timestamp = node.querySelector('.tweet-date')?.getAttribute('title') || new Date().toISOString();
        
        return {
          index: index + 1,
          content: content.substring(0, 500),
          link,
          username,
          timestamp,
          wordCount: content.split(' ').length
        };
      }).filter(tweet => tweet.content.length > 10);
    }, maxTweets);

    await browser.close();
    
    console.log(`✅ Successfully scraped ${tweets.length} tweets from ${profileName}`);
    return tweets;

  } catch (error) {
    if (browser) {
      await browser.close().catch(() => {});
    }
    throw error;
  }
}

// 📤 Enhanced Zapier sender (same as before)
async function sendToZapier(data, retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await axios.post(ZAP2_WEBHOOK_URL, data, {
        timeout: 10000,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'TwitterBot/1.0'
        }
      });
      
      console.log(`✅ Successfully sent to Zapier (attempt ${attempt + 1})`);
      return response.data;
      
    } catch (error) {
      console.error(`❌ Zapier send attempt ${attempt + 1} failed:`, error.message);
      
      if (attempt === retries) {
        throw new Error(`Failed to send to Zapier after ${retries + 1} attempts`);
      }
      
      await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt)));
    }
  }
}

// 🚀 Enhanced main webhook with auto-posting
app.post("/webhook", async (req, res) => {
  const startTime = Date.now();
  console.log("🎯 Webhook triggered at", new Date().toISOString());

  try {
    const {
      profile = TARGET_PROFILE,
      maxTweets = 2,
      generateReplies = true,
      autoPost = POSTING_CONFIG.autoPostEnabled
    } = req.body;

    console.log(`🔍 Starting scrape for profile: ${profile}`);
    console.log(`🤖 Auto-posting: ${autoPost ? 'ENABLED' : 'DISABLED'}`);

    const tweets = await scrapeNitterProfile(profile, maxTweets);

    if (tweets.length === 0) {
      return res.status(200).json({
        message: "No tweets found to process",
        profile,
        processingTime: Date.now() - startTime
      });
    }

    const replies = [];

    for (const [index, tweet] of tweets.entries()) {
      console.log(`🤖 Processing tweet ${index + 1}/${tweets.length}`);
      
      let replyText = "No reply generated";
      let postingResult = null;
      let pendingApprovalId = null;
      
      if (generateReplies && tweet.content) {
        replyText = await generateReply(tweet.content);
        console.log(`💬 Generated reply: ${replyText.substring(0, 50)}...`);
      }

      // Handle auto-posting logic
      if (autoPost && replyText !== "No reply generated") {
        const tweetId = extractTweetId(tweet.link);
        
        if (tweetId) {
          const rateLimitCheck = canPostNow();
          
          if (rateLimitCheck.canPost) {
            if (POSTING_CONFIG.requireApproval) {
              // Add to pending approvals
              pendingApprovalId = `approval_${Date.now()}_${index}`;
              postingStats.pendingApprovals.push({
                id: pendingApprovalId,
                originalTweetId: tweetId,
                originalTweetURL: tweet.link,
                originalText: tweet.content,
                replyText,
                createdAt: new Date().toISOString(),
                profile
              });
              
              console.log(`⏳ Added to pending approvals: ${pendingApprovalId}`);
              postingResult = { 
                status: 'pending_approval', 
                approvalId: pendingApprovalId,
                approveUrl: `http://localhost:3000/approve/${pendingApprovalId}`
              };
              
            } else {
              // Auto-post immediately
              try {
                postingResult = await postReplyToTwitter(tweetId, replyText, tweet.link);
                console.log(`🐦 Auto-posted reply: ${postingResult.tweetId}`);
              } catch (postError) {
                console.error(`❌ Auto-posting failed: ${postError.message}`);
                postingResult = { 
                  status: 'posting_failed', 
                  error: postError.message 
                };
              }
            }
          } else {
            console.log(`⏰ Rate limit check failed: ${rateLimitCheck.reason}`);
            postingResult = { 
              status: 'rate_limited', 
              reason: rateLimitCheck.reason 
            };
          }
        } else {
          console.log(`❌ Could not extract tweet ID from: ${tweet.link}`);
          postingResult = { 
            status: 'invalid_tweet_id', 
            url: tweet.link 
          };
        }
      }

      const replyData = {
        profile,
        tweetIndex: index + 1,
        originalTweetURL: tweet.link,
        originalTweetId: extractTweetId(tweet.link),
        originalText: tweet.content,
        originalUsername: tweet.username,
        originalTimestamp: tweet.timestamp,
        replyText,
        generatedAt: new Date().toISOString(),
        wordCount: tweet.wordCount,
        autoPostEnabled: autoPost,
        postingResult,
        pendingApprovalId
      };

      replies.push(replyData);

      // Send to Zapier
      try {
        await sendToZapier(replyData);
        console.log(`✅ Tweet ${index + 1} sent to Zapier successfully`);
      } catch (zapierError) {
        console.error(`❌ Failed to send tweet ${index + 1} to Zapier:`, zapierError.message);
        replyData.zapierError = zapierError.message;
      }

      if (index < tweets.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    const processingTime = Date.now() - startTime;
    const postedCount = replies.filter(r => r.postingResult?.status === 'posted' || r.postingResult?.success).length;
    const pendingCount = replies.filter(r => r.postingResult?.status === 'pending_approval').length;

    res.status(200).json({
      message: "✅ Processing completed successfully",
      profile,
      tweetsProcessed: tweets.length,
      repliesGenerated: replies.filter(r => r.replyText !== "No reply generated").length,
      autoPostingEnabled: POSTING_CONFIG.autoPostEnabled,
      posted: postedCount,
      pendingApproval: pendingCount,
      rateLimited: replies.filter(r => r.postingResult?.status === 'rate_limited').length,
      errors: replies.filter(r => r.zapierError || r.postingResult?.status === 'posting_failed').length,
      processingTime: `${processingTime}ms`,
      replies: replies.map(r => ({
        url: r.originalTweetURL,
        reply: r.replyText.substring(0, 100) + (r.replyText.length > 100 ? '...' : ''),
        postingStatus: r.postingResult?.status || 'not_attempted',
        approvalUrl: r.pendingApprovalId ? `http://localhost:3000/approve/${r.pendingApprovalId}` : null
      }))
    });

  } catch (error) {
    console.error("💥 Critical error in webhook:", error);
    
    res.status(500).json({
      error: "Internal server error",
      message: error.message,
      processingTime: Date.now() - startTime,
      timestamp: new Date().toISOString()
    });
  }
});

// 🔊 Start server
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`🚀 Twitter Automation Server with Auto-Posting`);
  console.log(`📍 Server URL: http://localhost:${port}`);
  console.log(`🎯 Target Profile: ${TARGET_PROFILE}`);
  console.log(`🐦 Auto-Posting: ${POSTING_CONFIG.autoPostEnabled ? 'ENABLED' : 'DISABLED'}`);
  console.log(`🛡️ Approval Required: ${POSTING_CONFIG.requireApproval ? 'YES' : 'NO'}`);
  console.log(`🧪 Dry Run Mode: ${POSTING_CONFIG.dryRun ? 'ON' : 'OFF'}`);
  console.log(`⏰ Rate Limit: ${POSTING_CONFIG.maxPostsPerHour} posts/hour`);
  console.log(`🕐 Started at: ${new Date().toISOString()}`);
});

process.on('SIGTERM', () => {
  console.log('👋 SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('👋 SIGINT received, shutting down gracefully');
  process.exit(0);
});