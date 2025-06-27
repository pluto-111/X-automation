// index.js - AI-Powered Twitter Automation System
const express = require("express");
const bodyParser = require("body-parser");
const puppeteer = require("puppeteer");
const axios = require("axios");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
app.use(bodyParser.json());

// 🔐 Configuration - Use environment variables in production
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "AIzaSyAig1QzEEACMImEcIAAHfTMYz4WKIpxs8k";
const ZAP2_WEBHOOK_URL = process.env.ZAP2_WEBHOOK_URL || "https://hooks.zapier.com/hooks/catch/23556079/ubroa98/";
const TARGET_PROFILE = process.env.TARGET_PROFILE || "sundarpichai";

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// ✅ Home route with status information
app.get("/", (req, res) => {
  res.json({
    status: "🚀 Twitter Automation Server Running",
    endpoints: {
      webhook: "/webhook - Main automation endpoint",
      health: "/health - Server health check"
    },
    lastRun: new Date().toISOString()
  });
});

// 🏥 Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// ✨ Enhanced Gemini reply generation with better prompting
async function generateReply(tweetText, retries = 2) {
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

  const prompt = `
You are a thoughtful and engaging social media commenter. Generate a natural, constructive reply to this tweet.

Guidelines:
- Keep it conversational and authentic (1-2 sentences max)
- Add value or insight, don't just agree
- Use relevant emojis sparingly
- Avoid controversial topics
- Be supportive but not overly promotional

Tweet to reply to:
"${tweetText}"

Reply:`;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const result = await model.generateContent(prompt);
      const response = await result.response;
      const text = response.text().trim();
      
      // Basic quality check
      if (text.length > 10 && text.length < 280) {
        return text;
      }
      
      if (attempt === retries) {
        return "🤖 Thanks for sharing this insight!";
      }
    } catch (err) {
      console.error(`❌ Gemini API attempt ${attempt + 1} failed:`, err.message);
      
      if (attempt === retries) {
        return "🤖 Interesting perspective - thanks for sharing!";
      }
      
      // Wait before retry
      await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
}

// 🕸️ Enhanced scraping function with better error handling
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

    // Enhanced browser simulation
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );
    
    await page.setViewport({ width: 1366, height: 768 });
    
    await page.setExtraHTTPHeaders({
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
    });

    const nitterUrl = `https://nitter.net/${profileName}`;
    console.log(`🔍 Navigating to: ${nitterUrl}`);

    await page.goto(nitterUrl, {
      waitUntil: "networkidle2",
      timeout: 30000
    });

    // Wait for content to load
    await page.waitForSelector(".timeline-item", { timeout: 20000 });

    // Scroll to load more content
    await page.evaluate(async () => {
      for (let i = 0; i < 3; i++) {
        window.scrollBy(0, window.innerHeight);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    });

    // Extract tweets with improved selector strategy
    const tweets = await page.$$eval(".timeline-item", (nodes, maxCount) => {
      return nodes.slice(0, maxCount).map((node, index) => {
        const contentElement = node.querySelector('.tweet-content');
        const linkElement = node.querySelector("a[href*='/status/']");
        
        const content = contentElement ? contentElement.innerText.trim() : node.innerText.trim();
        const link = linkElement ? "https://nitter.net" + linkElement.getAttribute("href") : null;
        
        // Extract additional metadata
        const username = node.querySelector('.username')?.innerText || profileName;
        const timestamp = node.querySelector('.tweet-date')?.getAttribute('title') || new Date().toISOString();
        
        return {
          index: index + 1,
          content: content.substring(0, 500), // Limit content length
          link,
          username,
          timestamp,
          wordCount: content.split(' ').length
        };
      }).filter(tweet => tweet.content.length > 10); // Filter out very short/empty tweets
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

// 📤 Enhanced Zapier webhook sender with retry logic
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
      
      // Exponential backoff
      await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt)));
    }
  }
}

// 🚀 Main webhook endpoint with comprehensive error handling
app.post("/webhook", async (req, res) => {
  const startTime = Date.now();
  console.log("🎯 Webhook triggered at", new Date().toISOString());
  console.log("📥 Request body:", req.body);

  try {
    // Extract parameters from request body
    const {
      profile = TARGET_PROFILE,
      maxTweets = 2,
      generateReplies = true
    } = req.body;

    console.log(`🔍 Starting scrape for profile: ${profile}`);

    // Step 1: Scrape tweets
    const tweets = await scrapeNitterProfile(profile, maxTweets);

    if (tweets.length === 0) {
      return res.status(200).json({
        message: "No tweets found to process",
        profile,
        processingTime: Date.now() - startTime
      });
    }

    const replies = [];

    // Step 2: Generate replies and send to Zapier
    for (const [index, tweet] of tweets.entries()) {
      console.log(`🤖 Processing tweet ${index + 1}/${tweets.length}`);
      
      let replyText = "No reply generated";
      
      if (generateReplies && tweet.content) {
        replyText = await generateReply(tweet.content);
        console.log(`💬 Generated reply: ${replyText.substring(0, 50)}...`);
      }

      const replyData = {
        profile,
        tweetIndex: index + 1,
        originalTweetURL: tweet.link,
        originalText: tweet.content,
        originalUsername: tweet.username,
        originalTimestamp: tweet.timestamp,
        replyText,
        generatedAt: new Date().toISOString(),
        wordCount: tweet.wordCount,
        processingTime: Date.now() - startTime
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

      // Add delay between requests to be respectful
      if (index < tweets.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    const processingTime = Date.now() - startTime;

    res.status(200).json({
      message: "✅ Processing completed successfully",
      profile,
      tweetsProcessed: tweets.length,
      repliesGenerated: replies.filter(r => !r.zapierError).length,
      errors: replies.filter(r => r.zapierError).length,
      processingTime: `${processingTime}ms`,
      replies: replies.map(r => ({
        url: r.originalTweetURL,
        reply: r.replyText.substring(0, 100) + (r.replyText.length > 100 ? '...' : ''),
        success: !r.zapierError
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

// 🎛️ Manual test endpoint
app.post("/test", async (req, res) => {
  try {
    const testTweet = "Exciting developments in AI technology are transforming how we work and live.";
    const reply = await generateReply(testTweet);
    
    res.json({
      status: "✅ Test completed",
      originalTweet: testTweet,
      generatedReply: reply,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      error: "Test failed",
      message: error.message
    });
  }
});

// 🛡️ Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({
    error: 'Something went wrong!',
    timestamp: new Date().toISOString()
  });
});

// 🔊 Start server with enhanced logging
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`🚀 Twitter Automation Server started`);
  console.log(`📍 Server URL: http://localhost:${port}`);
  console.log(`🎯 Target Profile: ${TARGET_PROFILE}`);
  console.log(`🔗 Zapier Webhook: ${ZAP2_WEBHOOK_URL ? 'Configured' : 'Not configured'}`);
  console.log(`🕐 Started at: ${new Date().toISOString()}`);
});

// 🛑 Graceful shutdown
process.on('SIGTERM', () => {
  console.log('👋 SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('👋 SIGINT received, shutting down gracefully');
  process.exit(0);
});