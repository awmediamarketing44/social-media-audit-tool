const express = require('express');
const path = require('path');
const { Resend } = require('resend');
const { ApifyClient } = require('apify-client');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// Apify client
const apifyClient = process.env.APIFY_TOKEN
  ? new ApifyClient({ token: process.env.APIFY_TOKEN })
  : null;

if (apifyClient) {
  console.log('Apify scraping enabled');
} else {
  console.log('WARNING: APIFY_TOKEN not set — scraping disabled, will use fallback scoring');
}

// Email via Resend
let resend = null;
if (process.env.RESEND_API_KEY) {
  resend = new Resend(process.env.RESEND_API_KEY);
  console.log('Email notifications enabled via Resend');
} else {
  console.log('Email notifications disabled — set RESEND_API_KEY env var to enable');
}

const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'alex@awmedia.marketing';

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// In-memory stores
const leads = [];
const audits = new Map();

// ============================================================
// ROUTES
// ============================================================

app.get('/', (req, res) => res.render('index'));

// Start audit — accepts lead data + handles, kicks off scraping
app.post('/api/audit/start', async (req, res) => {
  const data = req.body;
  const auditId = uuidv4();

  // Extract platform handles
  const platforms = {};
  Object.keys(data).forEach(key => {
    if (key.startsWith('handle_') && data[key] && data[key].trim()) {
      platforms[key.replace('handle_', '')] = data[key].trim();
    }
  });

  if (Object.keys(platforms).length === 0) {
    return res.status(400).json({ error: 'Please enter at least one social media handle.' });
  }

  // Store lead
  const lead = {
    name: data.name,
    email: data.email,
    business: data.business,
    goal: data.goal,
    platforms,
    submittedAt: new Date().toISOString(),
  };
  leads.push(lead);
  console.log(`New lead: ${data.name} (${data.email}) — scanning ${Object.keys(platforms).join(', ')}`);

  // Create audit session
  const audit = {
    id: auditId,
    leadData: lead,
    platforms,
    platformStatuses: {},
    rawData: {},
    metrics: {},
    results: null,
    status: 'scanning',
    sseClients: [],
    createdAt: new Date(),
  };

  Object.keys(platforms).forEach(p => { audit.platformStatuses[p] = 'pending'; });
  audits.set(auditId, audit);

  // Kick off scraping (non-blocking)
  runAuditScraping(auditId);

  res.json({ auditId });
});

// SSE progress endpoint
app.get('/api/audit/progress/:id', (req, res) => {
  const audit = audits.get(req.params.id);
  if (!audit) return res.status(404).json({ error: 'Audit not found' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  // Send current state
  Object.entries(audit.platformStatuses).forEach(([platform, status]) => {
    res.write(`data: ${JSON.stringify({ platform, status })}\n\n`);
  });

  if (audit.status === 'complete') {
    res.write(`data: ${JSON.stringify({ type: 'complete', auditId: audit.id })}\n\n`);
    return res.end();
  }

  audit.sseClients.push(res);
  req.on('close', () => {
    audit.sseClients = audit.sseClients.filter(c => c !== res);
  });
});

// Polling fallback
app.get('/api/audit/status/:id', (req, res) => {
  const audit = audits.get(req.params.id);
  if (!audit) return res.status(404).json({ error: 'Audit not found' });
  res.json({
    status: audit.status,
    platformStatuses: audit.platformStatuses,
  });
});

// Loading page
app.get('/audit/loading', (req, res) => {
  const auditId = req.query.id;
  const audit = audits.get(auditId);
  if (!audit) return res.redirect('/');
  res.render('loading', { auditId, platforms: Object.keys(audit.platforms) });
});

// Results page
app.get('/audit/results/:id', (req, res) => {
  const audit = audits.get(req.params.id);
  if (!audit) return res.redirect('/');
  if (audit.status !== 'complete') return res.redirect(`/audit/loading?id=${req.params.id}`);
  res.render('results', {
    results: audit.results,
    metrics: audit.metrics,
    data: audit.leadData,
  });
});

// Test email endpoint
app.get('/api/test-email', async (req, res) => {
  const key = req.query.key;
  if (key !== process.env.ADMIN_KEY && key !== 'alwaysontime2026') {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!resend) {
    return res.json({
      success: false,
      error: 'Resend not configured',
      env: { RESEND_API_KEY: process.env.RESEND_API_KEY ? 'set (hidden)' : 'MISSING', NOTIFY_EMAIL: NOTIFY_EMAIL },
    });
  }

  try {
    const { data, error } = await resend.emails.send({
      from: 'Social Media Audit <noreply@awmedia.marketing>',
      to: [NOTIFY_EMAIL],
      subject: 'Test Email — Social Media Audit Tool',
      html: `
        <div style="font-family:Arial,sans-serif;padding:20px;background:#0a0a0a;color:#fff;border-radius:12px;">
          <h2 style="color:#F92672;">Email is working!</h2>
          <p>This is a test email from your Social Media Audit Tool.</p>
          <p style="color:#888;">Sent at: ${new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' })}</p>
          <p style="color:#888;">Provider: Resend</p>
        </div>
      `,
    });
    if (error) throw new Error(JSON.stringify(error));
    res.json({ success: true, message: `Test email sent to ${NOTIFY_EMAIL}`, id: data.id });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Leads API
app.get('/api/leads', (req, res) => {
  const key = req.query.key;
  if (key !== process.env.ADMIN_KEY && key !== 'alwaysontime2026') {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.json(leads);
});

// ============================================================
// APIFY SCRAPING
// ============================================================

function normalizeHandle(platform, input) {
  input = input.trim();
  switch (platform) {
    case 'instagram':
      return input.replace('@', '').replace(/https?:\/\/(www\.)?instagram\.com\//, '').replace(/\/$/, '');
    case 'tiktok':
      return input.replace('@', '').replace(/https?:\/\/(www\.)?tiktok\.com\/@?/, '').replace(/\/$/, '');
    case 'twitter':
      return input.replace('@', '').replace(/https?:\/\/(www\.)?(twitter|x)\.com\//, '').replace(/\/$/, '');
    case 'facebook':
      if (!input.startsWith('http')) return `https://www.facebook.com/${input}`;
      return input;
    case 'linkedin':
      if (!input.startsWith('http')) return `https://www.linkedin.com/${input}`;
      return input;
    case 'youtube':
      if (input.startsWith('@')) return `https://www.youtube.com/${input}`;
      if (!input.startsWith('http')) return `https://www.youtube.com/@${input}`;
      return input;
    case 'pinterest':
      if (input.startsWith('@')) return `https://www.pinterest.com/${input.replace('@', '')}/`;
      if (!input.startsWith('http')) return `https://www.pinterest.com/${input}/`;
      return input;
    default:
      return input;
  }
}

const scrapers = {
  instagram: async (handle) => {
    const username = normalizeHandle('instagram', handle);
    const run = await apifyClient.actor('apify/instagram-profile-scraper').call({
      usernames: [username],
    }, { timeout: 120 });
    const { items } = await apifyClient.dataset(run.defaultDatasetId).listItems();
    if (!items.length) throw new Error('No data returned');
    const p = items[0];
    const recentPosts = (p.latestPosts || []).slice(0, 12);
    return {
      username: p.username || username,
      bio: p.biography || '',
      followers: p.followersCount || 0,
      following: p.followingCount || 0,
      postCount: p.postsCount || 0,
      profilePic: p.profilePicUrl || null,
      externalUrl: p.externalUrl || null,
      isVerified: p.verified || false,
      recentPosts: recentPosts.map(post => ({
        likes: post.likesCount || 0,
        comments: post.commentsCount || 0,
        timestamp: post.timestamp,
        type: post.type || 'image',
        caption: post.caption || '',
        hashtags: (post.hashtags || []),
      })),
    };
  },

  tiktok: async (handle) => {
    const username = normalizeHandle('tiktok', handle);
    const run = await apifyClient.actor('clockworks/tiktok-scraper').call({
      profiles: [username],
      resultsPerPage: 12,
      shouldDownloadVideos: false,
    }, { timeout: 120 });
    const { items } = await apifyClient.dataset(run.defaultDatasetId).listItems();
    if (!items.length) throw new Error('No data returned');
    // TikTok scraper returns individual videos; profile info is in authorMeta
    const firstItem = items[0];
    const author = firstItem.authorMeta || {};
    return {
      username: author.name || username,
      bio: author.signature || '',
      followers: author.fans || 0,
      following: author.following || 0,
      totalLikes: author.heart || 0,
      profilePic: author.avatar || null,
      isVerified: author.verified || false,
      recentPosts: items.slice(0, 12).map(v => ({
        likes: v.diggCount || v.likes || 0,
        comments: v.commentCount || v.comments || 0,
        shares: v.shareCount || v.shares || 0,
        views: v.playCount || v.plays || 0,
        timestamp: v.createTimeISO || v.createTime,
        caption: v.text || '',
        hashtags: (v.hashtags || []).map(h => h.name || h),
      })),
    };
  },

  facebook: async (url) => {
    const pageUrl = normalizeHandle('facebook', url);
    const run = await apifyClient.actor('apify/facebook-pages-scraper').call({
      startUrls: [{ url: pageUrl }],
      maxPagesPerQuery: 1,
    }, { timeout: 120 });
    const { items } = await apifyClient.dataset(run.defaultDatasetId).listItems();
    if (!items.length) throw new Error('No data returned');
    const p = items[0];
    // Try to get posts too
    let recentPosts = [];
    try {
      const postsRun = await apifyClient.actor('apify/facebook-posts-scraper').call({
        startUrls: [{ url: pageUrl }],
        resultsLimit: 12,
      }, { timeout: 120 });
      const postsData = await apifyClient.dataset(postsRun.defaultDatasetId).listItems();
      recentPosts = (postsData.items || []).slice(0, 12).map(post => ({
        likes: post.likes || 0,
        comments: post.comments || 0,
        shares: post.shares || 0,
        timestamp: post.time,
        caption: post.text || '',
      }));
    } catch (e) {
      console.log('Facebook posts scrape failed, continuing with page data only');
    }
    return {
      username: p.name || '',
      bio: p.about || p.description || '',
      followers: p.followers || p.likes || 0,
      pageLikes: p.likes || 0,
      profilePic: p.profilePhoto || null,
      externalUrl: p.website || null,
      recentPosts,
    };
  },

  linkedin: async (url) => {
    const profileUrl = normalizeHandle('linkedin', url);
    const isCompany = profileUrl.includes('/company/');
    const actorName = isCompany ? 'dev_fusion/Linkedin-Company-Scraper' : 'dev_fusion/Linkedin-Profile-Scraper';
    const run = await apifyClient.actor(actorName).call({
      urls: [profileUrl],
    }, { timeout: 120 });
    const { items } = await apifyClient.dataset(run.defaultDatasetId).listItems();
    if (!items.length) throw new Error('No data returned');
    const p = items[0];
    if (isCompany) {
      return {
        username: p.name || '',
        bio: p.description || '',
        followers: p.followerCount || 0,
        employeeCount: p.employeeCount || 0,
        profilePic: p.logo || null,
        externalUrl: p.website || null,
        industry: p.industry || '',
        recentPosts: [],
      };
    }
    return {
      username: p.fullName || p.name || '',
      bio: p.summary || p.headline || '',
      followers: p.connectionsCount || p.connections || 0,
      profilePic: p.profilePicture || p.profilePic || null,
      headline: p.headline || '',
      recentPosts: [],
    };
  },

  youtube: async (handle) => {
    const channelUrl = normalizeHandle('youtube', handle);
    const run = await apifyClient.actor('streamers/youtube-scraper').call({
      startUrls: [{ url: channelUrl }],
      maxResults: 12,
      type: 'channel',
    }, { timeout: 120 });
    const { items } = await apifyClient.dataset(run.defaultDatasetId).listItems();
    if (!items.length) throw new Error('No data returned');
    // First item might be channel info, rest are videos
    const channelItem = items.find(i => i.type === 'channel') || items[0];
    const videos = items.filter(i => i.type === 'video' || i.url?.includes('/watch'));
    return {
      username: channelItem.channelName || channelItem.title || '',
      bio: channelItem.channelDescription || channelItem.description || '',
      followers: channelItem.subscriberCount || channelItem.numberOfSubscribers || 0,
      totalViews: channelItem.viewCount || 0,
      videoCount: channelItem.videosCount || 0,
      profilePic: channelItem.channelThumbnail || null,
      recentPosts: videos.slice(0, 12).map(v => ({
        views: v.viewCount || v.views || 0,
        likes: v.likes || 0,
        comments: v.commentsCount || v.comments || 0,
        timestamp: v.date || v.uploadDate,
        caption: v.title || '',
      })),
    };
  },

  twitter: async (handle) => {
    const username = normalizeHandle('twitter', handle);
    const run = await apifyClient.actor('apidojo/tweet-scraper').call({
      startUrls: [`https://twitter.com/${username}`],
      tweetsDesired: 20,
      addUserInfo: true,
    }, { timeout: 120 });
    const { items } = await apifyClient.dataset(run.defaultDatasetId).listItems();
    if (!items.length) throw new Error('No data returned');
    const author = items[0].author || {};
    return {
      username: author.userName || username,
      bio: author.description || '',
      followers: author.followers || 0,
      following: author.following || 0,
      tweetCount: author.statusesCount || 0,
      profilePic: author.profilePicture || null,
      isVerified: author.isVerified || false,
      recentPosts: items.slice(0, 12).map(t => ({
        likes: t.likeCount || 0,
        comments: t.replyCount || 0,
        retweets: t.retweetCount || 0,
        timestamp: t.createdAt,
        caption: t.text || '',
        hashtags: (t.hashtags || []),
      })),
    };
  },

  pinterest: async (handle) => {
    const profileUrl = normalizeHandle('pinterest', handle);
    const run = await apifyClient.actor('danielmilevski9/pinterest-crawler').call({
      startUrls: [{ url: profileUrl }],
      maxItems: 12,
    }, { timeout: 120 });
    const { items } = await apifyClient.dataset(run.defaultDatasetId).listItems();
    if (!items.length) throw new Error('No data returned');
    const profileItem = items[0];
    return {
      username: profileItem.username || profileItem.name || '',
      bio: profileItem.about || profileItem.description || '',
      followers: profileItem.followerCount || profileItem.followers || 0,
      following: profileItem.followingCount || 0,
      pinCount: profileItem.pinCount || items.length,
      profilePic: profileItem.profileImage || null,
      recentPosts: items.slice(0, 12).map(pin => ({
        likes: pin.saveCount || pin.saves || 0,
        comments: pin.commentCount || pin.comments || 0,
        timestamp: pin.createdAt,
        caption: pin.description || pin.title || '',
      })),
    };
  },
};

function notifySSE(audit, data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  audit.sseClients.forEach(client => {
    try { client.write(msg); } catch (e) { /* client disconnected */ }
  });
}

async function runAuditScraping(auditId) {
  const audit = audits.get(auditId);

  const scrapePromises = Object.entries(audit.platforms).map(async ([platform, handle]) => {
    audit.platformStatuses[platform] = 'scanning';
    notifySSE(audit, { platform, status: 'scanning' });

    try {
      if (!apifyClient) throw new Error('Apify not configured');
      const data = await scrapers[platform](handle);
      audit.rawData[platform] = data;
      audit.platformStatuses[platform] = 'complete';
      notifySSE(audit, { platform, status: 'complete' });
      console.log(`Scraped ${platform} for ${audit.leadData.name}`);
    } catch (err) {
      console.error(`Scrape failed for ${platform}:`, err.message);
      audit.rawData[platform] = null;
      audit.platformStatuses[platform] = 'failed';
      notifySSE(audit, { platform, status: 'failed', error: err.message });
    }
  });

  await Promise.allSettled(scrapePromises);

  // Score from scraped data
  const { scores, metrics } = scoreFromScrapedData(audit.rawData);
  const insights = generateDataDrivenInsights(scores, metrics, audit.rawData);

  const platformScores = Object.values(scores).map(s => s.overallScore);
  const overallScore = platformScores.length
    ? Math.round(platformScores.reduce((a, b) => a + b, 0) / platformScores.length)
    : 0;

  audit.metrics = metrics;
  audit.results = {
    platforms: scores,
    insights,
    overallScore,
    grade: getGrade(overallScore),
  };
  audit.status = 'complete';

  notifySSE(audit, { type: 'complete', auditId: audit.id });
  audit.sseClients.forEach(c => { try { c.end(); } catch (e) {} });
  audit.sseClients = [];

  // Send email
  sendLeadNotification(audit.leadData, audit.results, metrics);

  // Auto-expire after 2 hours
  setTimeout(() => audits.delete(auditId), 7200000);
}

// ============================================================
// SCORING FROM REAL DATA
// ============================================================

const FREQUENCY_BENCHMARKS = {
  instagram: 4, tiktok: 5, linkedin: 3, twitter: 7,
  facebook: 3, youtube: 1, pinterest: 5,
};

const ENGAGEMENT_BENCHMARKS = {
  instagram: { good: 1, strong: 3 },
  tiktok: { good: 3, strong: 7 },
  linkedin: { good: 2, strong: 4 },
  twitter: { good: 0.5, strong: 1.5 },
  facebook: { good: 0.5, strong: 2 },
  youtube: { good: 3, strong: 6 },
  pinterest: { good: 0.2, strong: 1 },
};

function scoreFromScrapedData(rawData) {
  const scores = {};
  const metrics = {};

  Object.entries(rawData).forEach(([platform, data]) => {
    if (!data) {
      // Platform failed — give it a neutral placeholder
      scores[platform] = {
        profileOptimization: { rating: 'N/A', score: 0 },
        contentQuality: { rating: 'N/A', score: 0 },
        postingConsistency: { rating: 'N/A', score: 0 },
        engagementHealth: { rating: 'N/A', score: 0 },
        growthSignals: { rating: 'N/A', score: 0 },
        overallScore: 0,
        failed: true,
      };
      metrics[platform] = { failed: true };
      return;
    }

    const posts = data.recentPosts || [];
    const m = {};

    // Calculate metrics
    m.followers = data.followers || 0;
    m.following = data.following || 0;
    m.postCount = data.postCount || data.videoCount || data.pinCount || data.tweetCount || posts.length;
    m.bio = data.bio || '';
    m.bioLength = m.bio.length;
    m.hasProfilePic = !!data.profilePic;
    m.hasExternalUrl = !!(data.externalUrl);
    m.isVerified = data.isVerified || false;
    m.username = data.username || '';

    // Engagement metrics
    if (posts.length > 0) {
      const totalLikes = posts.reduce((sum, p) => sum + (p.likes || 0), 0);
      const totalComments = posts.reduce((sum, p) => sum + (p.comments || 0), 0);
      const totalViews = posts.reduce((sum, p) => sum + (p.views || 0), 0);
      m.avgLikes = Math.round(totalLikes / posts.length);
      m.avgComments = Math.round(totalComments / posts.length);
      m.avgViews = totalViews > 0 ? Math.round(totalViews / posts.length) : null;
      m.engagementRate = m.followers > 0
        ? parseFloat(((totalLikes + totalComments) / posts.length / m.followers * 100).toFixed(2))
        : 0;

      // Posting frequency
      const timestamps = posts
        .map(p => new Date(p.timestamp))
        .filter(d => !isNaN(d.getTime()))
        .sort((a, b) => b - a);

      if (timestamps.length >= 2) {
        const newestPost = timestamps[0];
        const oldestPost = timestamps[timestamps.length - 1];
        const daySpan = Math.max(1, (newestPost - oldestPost) / (1000 * 60 * 60 * 24));
        m.postsPerWeek = parseFloat((timestamps.length / daySpan * 7).toFixed(1));
        m.daysSinceLastPost = Math.round((Date.now() - newestPost) / (1000 * 60 * 60 * 24));

        // Check for gaps > 14 days
        let maxGap = 0;
        for (let i = 0; i < timestamps.length - 1; i++) {
          const gap = (timestamps[i] - timestamps[i + 1]) / (1000 * 60 * 60 * 24);
          if (gap > maxGap) maxGap = gap;
        }
        m.maxGapDays = Math.round(maxGap);
      } else {
        m.postsPerWeek = posts.length > 0 ? 0.5 : 0;
        m.daysSinceLastPost = null;
        m.maxGapDays = null;
      }

      // Avg caption length
      const captions = posts.map(p => p.caption || '').filter(c => c.length > 0);
      m.avgCaptionLength = captions.length > 0
        ? Math.round(captions.reduce((sum, c) => sum + c.length, 0) / captions.length)
        : 0;

      // Hashtag usage
      const hashtagPosts = posts.filter(p => (p.hashtags && p.hashtags.length > 0) || (p.caption && p.caption.includes('#')));
      m.hashtagUsageRate = parseFloat((hashtagPosts.length / posts.length * 100).toFixed(0));

      // Content type variety (if available)
      const types = new Set(posts.map(p => p.type).filter(Boolean));
      m.contentTypes = types.size;

      // Engagement trend: first half vs second half
      const half = Math.floor(posts.length / 2);
      if (half >= 2) {
        const recentEng = posts.slice(0, half).reduce((s, p) => s + (p.likes || 0) + (p.comments || 0), 0) / half;
        const olderEng = posts.slice(half).reduce((s, p) => s + (p.likes || 0) + (p.comments || 0), 0) / (posts.length - half);
        m.engagementTrend = olderEng > 0 ? parseFloat(((recentEng / olderEng - 1) * 100).toFixed(0)) : 0;
      } else {
        m.engagementTrend = 0;
      }
    } else {
      m.avgLikes = 0;
      m.avgComments = 0;
      m.avgViews = null;
      m.engagementRate = 0;
      m.postsPerWeek = 0;
      m.daysSinceLastPost = null;
      m.maxGapDays = null;
      m.avgCaptionLength = 0;
      m.hashtagUsageRate = 0;
      m.contentTypes = 0;
      m.engagementTrend = 0;
    }

    metrics[platform] = m;

    // --- SCORING ---
    const s = {};
    const bench = ENGAGEMENT_BENCHMARKS[platform] || { good: 1, strong: 3 };
    const freqBench = FREQUENCY_BENCHMARKS[platform] || 3;

    // Dimension 1: Profile Optimization (0-100)
    let profileScore = 0;
    if (m.bioLength > 50) profileScore += 25;
    else if (m.bioLength > 20) profileScore += 15;
    else if (m.bioLength > 0) profileScore += 5;
    // Bio has CTA keywords
    const ctaKeywords = /link|book|dm|contact|shop|click|free|download|sign up|enquir/i;
    if (ctaKeywords.test(m.bio)) profileScore += 15;
    if (m.hasProfilePic) profileScore += 25;
    if (m.hasExternalUrl) profileScore += 20;
    if (m.isVerified) profileScore += 15;
    s.profileOptimization = categorize100(Math.min(profileScore, 100));

    // Dimension 2: Content Quality (0-100)
    let contentScore = 0;
    if (posts.length >= 6) contentScore += 25;
    else if (posts.length >= 3) contentScore += 15;
    else if (posts.length > 0) contentScore += 5;
    if (m.contentTypes >= 3) contentScore += 25;
    else if (m.contentTypes >= 2) contentScore += 15;
    else if (m.contentTypes >= 1) contentScore += 5;
    if (m.avgCaptionLength > 100) contentScore += 25;
    else if (m.avgCaptionLength > 50) contentScore += 15;
    else if (m.avgCaptionLength > 10) contentScore += 5;
    if (m.hashtagUsageRate > 60) contentScore += 25;
    else if (m.hashtagUsageRate > 30) contentScore += 15;
    else if (m.hashtagUsageRate > 0) contentScore += 5;
    s.contentQuality = categorize100(Math.min(contentScore, 100));

    // Dimension 3: Posting Consistency (0-100)
    let consistencyScore = 0;
    const freqRatio = m.postsPerWeek / freqBench;
    if (freqRatio >= 0.8) consistencyScore += 40;
    else if (freqRatio >= 0.4) consistencyScore += 25;
    else if (freqRatio > 0) consistencyScore += 10;
    if (m.maxGapDays !== null) {
      if (m.maxGapDays <= 7) consistencyScore += 30;
      else if (m.maxGapDays <= 14) consistencyScore += 15;
    }
    if (m.daysSinceLastPost !== null) {
      if (m.daysSinceLastPost <= 3) consistencyScore += 30;
      else if (m.daysSinceLastPost <= 7) consistencyScore += 20;
      else if (m.daysSinceLastPost <= 14) consistencyScore += 10;
    }
    s.postingConsistency = categorize100(Math.min(consistencyScore, 100));

    // Dimension 4: Engagement Health (0-100)
    let engagementScore = 0;
    if (m.engagementRate >= bench.strong) engagementScore += 50;
    else if (m.engagementRate >= bench.good) engagementScore += 30;
    else if (m.engagementRate > 0) engagementScore += 10;
    // Comments to likes ratio (conversations)
    const commentRatio = m.avgLikes > 0 ? m.avgComments / m.avgLikes : 0;
    if (commentRatio > 0.05) engagementScore += 25;
    else if (commentRatio > 0.02) engagementScore += 15;
    else if (commentRatio > 0) engagementScore += 5;
    // Engagement trend
    if (m.engagementTrend > 10) engagementScore += 25;
    else if (m.engagementTrend > -10) engagementScore += 15;
    else engagementScore += 5;
    s.engagementHealth = categorize100(Math.min(engagementScore, 100));

    // Dimension 5: Growth Signals (0-100)
    let growthScore = 0;
    if (m.followers > 10000) growthScore += 25;
    else if (m.followers > 1000) growthScore += 20;
    else if (m.followers > 100) growthScore += 10;
    // Follower to following ratio
    const ffRatio = m.following > 0 ? m.followers / m.following : m.followers > 0 ? 5 : 0;
    if (ffRatio >= 2) growthScore += 20;
    else if (ffRatio >= 1) growthScore += 12;
    else if (ffRatio > 0) growthScore += 5;
    // Engagement trending up
    if (m.engagementTrend > 10) growthScore += 25;
    else if (m.engagementTrend > 0) growthScore += 15;
    else growthScore += 5;
    // Cross-platform (bonus from total platforms — handled at overall level)
    const totalPlatforms = Object.values(rawData).filter(d => d !== null).length;
    if (totalPlatforms >= 4) growthScore += 30;
    else if (totalPlatforms >= 2) growthScore += 20;
    else growthScore += 10;
    s.growthSignals = categorize100(Math.min(growthScore, 100));

    // Overall platform score
    const dims = [s.profileOptimization, s.contentQuality, s.postingConsistency, s.engagementHealth, s.growthSignals];
    s.overallScore = Math.round(dims.reduce((sum, d) => sum + d.score, 0) / dims.length);
    s.failed = false;

    scores[platform] = s;
  });

  return { scores, metrics };
}

function categorize100(score) {
  const rating = score >= 70 ? 'Strong' : score >= 40 ? 'Needs Work' : 'Missing';
  return { rating, score };
}

function getGrade(score) {
  if (score >= 85) return 'A';
  if (score >= 70) return 'B';
  if (score >= 55) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

function platformName(p) {
  const names = { instagram: 'Instagram', tiktok: 'TikTok', facebook: 'Facebook', linkedin: 'LinkedIn', youtube: 'YouTube', twitter: 'X/Twitter', pinterest: 'Pinterest' };
  return names[p] || p.charAt(0).toUpperCase() + p.slice(1);
}

function formatNumber(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

function generateDataDrivenInsights(scores, metrics, rawData) {
  const wins = [];
  const quickWins = [];

  Object.entries(scores).forEach(([platform, s]) => {
    if (s.failed) return;
    const pName = platformName(platform);
    const m = metrics[platform];
    const bench = ENGAGEMENT_BENCHMARKS[platform] || { good: 1, strong: 3 };

    // Wins — with real numbers
    if (s.profileOptimization.rating === 'Strong') {
      wins.push({ platform: pName, text: `Your ${pName} profile is well-optimized — clear bio, profile photo, and external link all in place.` });
    }
    if (s.engagementHealth.rating === 'Strong') {
      wins.push({ platform: pName, text: `Your ${pName} engagement rate is ${m.engagementRate}% — that's above the ${bench.good}% industry average. Your audience is actively interacting with your content.` });
    }
    if (s.postingConsistency.rating === 'Strong') {
      wins.push({ platform: pName, text: `You're posting ${m.postsPerWeek}x per week on ${pName} — consistent enough for the algorithm to favour your content.` });
    }
    if (s.contentQuality.rating === 'Strong') {
      wins.push({ platform: pName, text: `Your ${pName} content quality is solid — averaging ${m.avgCaptionLength} chars per caption with good hashtag usage.` });
    }

    // Quick wins — data-driven
    if (s.profileOptimization.rating !== 'Strong') {
      if (m.bioLength < 20) {
        quickWins.push({ platform: pName, text: `Your ${pName} bio is only ${m.bioLength} characters. Rewrite it to clearly state what you do, who you help, and include a call-to-action.` });
      } else if (!m.hasExternalUrl) {
        quickWins.push({ platform: pName, text: `Add a link to your ${pName} profile — you're missing out on driving traffic to your website or booking page.` });
      }
    }
    if (s.postingConsistency.rating !== 'Strong') {
      if (m.daysSinceLastPost && m.daysSinceLastPost > 7) {
        quickWins.push({ platform: pName, text: `You haven't posted on ${pName} in ${m.daysSinceLastPost} days. The algorithm penalises inactivity — get a post out this week.` });
      } else if (m.postsPerWeek < FREQUENCY_BENCHMARKS[platform]) {
        quickWins.push({ platform: pName, text: `You're posting ${m.postsPerWeek}x/week on ${pName} — the benchmark is ${FREQUENCY_BENCHMARKS[platform]}x. A content scheduler would close that gap.` });
      }
    }
    if (s.engagementHealth.rating !== 'Strong') {
      quickWins.push({ platform: pName, text: `Your ${pName} engagement rate is ${m.engagementRate}% (benchmark: ${bench.good}%+). Start a 10-min daily routine — comment on 5 accounts in your niche before you post.` });
    }
    if (s.contentQuality.rating !== 'Strong') {
      if (m.avgCaptionLength < 50) {
        quickWins.push({ platform: pName, text: `Your ${pName} captions average only ${m.avgCaptionLength} characters. Longer, value-driven captions with hooks and CTAs drive significantly more engagement.` });
      }
      if (m.hashtagUsageRate < 30) {
        quickWins.push({ platform: pName, text: `Only ${m.hashtagUsageRate}% of your ${pName} posts use hashtags. Research 5-10 niche-specific tags and use them consistently.` });
      }
    }
    if (s.growthSignals.rating !== 'Strong') {
      quickWins.push({ platform: pName, text: `Pin your best-performing post to the top of your ${pName} profile so new visitors see your strongest content first.` });
    }
  });

  return {
    wins: wins.slice(0, 3),
    quickWins: quickWins.slice(0, 2),
    totalQuickWins: quickWins.length,
  };
}

// ============================================================
// EMAIL NOTIFICATION
// ============================================================

function ratingColor(rating) {
  if (rating === 'Strong') return '#22c55e';
  if (rating === 'Needs Work') return '#eab308';
  if (rating === 'N/A') return '#666';
  return '#ef4444';
}

async function sendLeadNotification(leadData, results, metrics) {
  if (!resend) return;

  const goalLabels = {
    brand_awareness: 'Brand Awareness',
    lead_generation: 'Lead Generation',
    direct_sales: 'Direct Sales',
    community: 'Community Building',
    thought_leadership: 'Thought Leadership',
  };

  const platformList = Object.keys(leadData.platforms || {}).map(p => platformName(p)).join(', ');

  const metricsRows = Object.entries(metrics || {}).map(([p, m]) => {
    if (m.failed) return `<tr><td style="padding:6px 12px;color:#fff;">${platformName(p)}</td><td colspan="4" style="padding:6px 12px;color:#ef4444;">Scrape failed</td></tr>`;
    return `<tr>
      <td style="padding:6px 12px;font-weight:bold;color:#fff;">${platformName(p)}</td>
      <td style="padding:6px 12px;color:#ccc;">${formatNumber(m.followers)} followers</td>
      <td style="padding:6px 12px;color:#ccc;">${m.engagementRate}% eng rate</td>
      <td style="padding:6px 12px;color:#ccc;">${m.postsPerWeek}/week</td>
      <td style="padding:6px 12px;color:#ccc;">${m.daysSinceLastPost != null ? m.daysSinceLastPost + 'd ago' : 'N/A'}</td>
    </tr>`;
  }).join('');

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#0a0a0a;color:#fff;padding:32px;border-radius:12px;">
      <h1 style="color:#F92672;margin:0 0 4px;">New Audit Lead</h1>
      <p style="color:#888;margin:0 0 24px;font-size:14px;">${new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' })}</p>
      <table style="width:100%;margin-bottom:24px;">
        <tr><td style="color:#888;padding:4px 0;">Name</td><td style="padding:4px 0;"><strong>${leadData.name}</strong></td></tr>
        <tr><td style="color:#888;padding:4px 0;">Email</td><td style="padding:4px 0;"><a href="mailto:${leadData.email}" style="color:#F92672;">${leadData.email}</a></td></tr>
        <tr><td style="color:#888;padding:4px 0;">Business</td><td style="padding:4px 0;">${leadData.business}</td></tr>
        <tr><td style="color:#888;padding:4px 0;">Goal</td><td style="padding:4px 0;">${goalLabels[leadData.goal] || leadData.goal}</td></tr>
        <tr><td style="color:#888;padding:4px 0;">Platforms</td><td style="padding:4px 0;">${platformList}</td></tr>
      </table>
      <div style="background:#111;border-radius:8px;padding:20px;margin-bottom:24px;text-align:center;">
        <p style="color:#888;margin:0 0 4px;font-size:13px;">OVERALL SCORE</p>
        <p style="font-size:48px;font-weight:bold;margin:0;color:#F92672;">${results.overallScore}/100</p>
        <p style="font-size:24px;margin:4px 0 0;color:#fff;">Grade: ${results.grade}</p>
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:24px;">
        <thead><tr style="background:#1a1a1a;">
          <th style="padding:6px 12px;text-align:left;color:#888;">Platform</th>
          <th style="padding:6px 12px;text-align:left;color:#888;">Followers</th>
          <th style="padding:6px 12px;text-align:left;color:#888;">Engagement</th>
          <th style="padding:6px 12px;text-align:left;color:#888;">Frequency</th>
          <th style="padding:6px 12px;text-align:left;color:#888;">Last Post</th>
        </tr></thead>
        <tbody>${metricsRows}</tbody>
      </table>
      <div style="background:#1a1a1a;border-left:3px solid #F92672;padding:16px;border-radius:0 8px 8px 0;">
        <p style="margin:0;font-size:13px;color:#ccc;">This lead scored <strong>${results.overallScore}/100</strong> — ${results.overallScore < 50 ? 'a strong candidate for AW-LWAYS On Time.' : results.overallScore < 70 ? 'could benefit from consistent graphics support.' : 'doing well but may want to level up visuals.'}</p>
      </div>
      <p style="margin:24px 0 0;text-align:center;">
        <a href="mailto:${leadData.email}?subject=Your%20Social%20Media%20Audit%20Results&body=Hi%20${encodeURIComponent(leadData.name.split(' ')[0])}%2C%0A%0AThanks%20for%20completing%20the%20social%20media%20audit!" style="display:inline-block;background:#F92672;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:bold;">Reply to ${leadData.name.split(' ')[0]}</a>
      </p>
    </div>`;

  try {
    const { data, error } = await resend.emails.send({
      from: 'Social Media Audit <noreply@awmedia.marketing>',
      to: [NOTIFY_EMAIL],
      subject: `New Audit Lead: ${leadData.name} (${results.overallScore}/100)`,
      html,
    });
    if (error) throw new Error(error.message);
    console.log(`Email notification sent for ${leadData.name}`, data);
  } catch (err) {
    console.error('Failed to send email notification:', err.message);
  }
}

// ============================================================
app.listen(PORT, () => {
  console.log(`Social Media Audit Tool running on http://localhost:${PORT}`);
});
