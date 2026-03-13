const express = require('express');
const path = require('path');
const nodemailer = require('nodemailer');
const app = express();
const PORT = process.env.PORT || 3000;

// Email transporter — configure via environment variables
let transporter = null;
if (process.env.SMTP_HOST) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
  console.log('Email notifications enabled via SMTP');
} else if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });
  console.log('Email notifications enabled via Gmail');
} else {
  console.log('Email notifications disabled — set SMTP or Gmail env vars to enable');
}

const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'alex@awmedia.marketing';

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// In-memory lead storage (swap for a DB in production)
const leads = [];

app.get('/', (req, res) => {
  res.render('index');
});

app.post('/audit', (req, res) => {
  const data = req.body;

  // Store lead
  leads.push({
    name: data.name,
    email: data.email,
    business: data.business,
    submittedAt: new Date().toISOString(),
  });

  console.log(`New lead: ${data.name} (${data.email})`);

  // Run scoring algorithm
  const results = scoreAudit(data);

  // Send email notification (non-blocking)
  sendLeadNotification(data, results);

  res.render('results', { results, data });
});

// API endpoint to view leads (protect this in production)
app.get('/api/leads', (req, res) => {
  const key = req.query.key;
  if (key !== process.env.ADMIN_KEY && key !== 'alwaysontime2026') {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.json(leads);
});

async function sendLeadNotification(data, results) {
  if (!transporter) return;

  const goalLabels = {
    brand_awareness: 'Brand Awareness',
    lead_generation: 'Lead Generation',
    direct_sales: 'Direct Sales',
    community: 'Community Building',
    thought_leadership: 'Thought Leadership',
  };

  const platforms = Array.isArray(data.platforms) ? data.platforms : [data.platforms];
  const platformList = platforms.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(', ');

  const platformScores = Object.entries(results.platforms).map(([name, s]) => {
    const pName = name.charAt(0).toUpperCase() + name.slice(1);
    return `
      <tr>
        <td style="padding:8px 12px;font-weight:bold;color:#fff;">${pName}</td>
        <td style="padding:8px 12px;color:${ratingColor(s.profileOptimization.rating)}">${s.profileOptimization.rating}</td>
        <td style="padding:8px 12px;color:${ratingColor(s.contentQuality.rating)}">${s.contentQuality.rating}</td>
        <td style="padding:8px 12px;color:${ratingColor(s.postingConsistency.rating)}">${s.postingConsistency.rating}</td>
        <td style="padding:8px 12px;color:${ratingColor(s.engagementHealth.rating)}">${s.engagementHealth.rating}</td>
        <td style="padding:8px 12px;color:${ratingColor(s.growthSignals.rating)}">${s.growthSignals.rating}</td>
      </tr>`;
  }).join('');

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#0a0a0a;color:#fff;padding:32px;border-radius:12px;">
      <h1 style="color:#F92672;margin:0 0 4px;">New Audit Lead</h1>
      <p style="color:#888;margin:0 0 24px;font-size:14px;">${new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' })}</p>

      <table style="width:100%;margin-bottom:24px;">
        <tr><td style="color:#888;padding:4px 0;">Name</td><td style="padding:4px 0;"><strong>${data.name}</strong></td></tr>
        <tr><td style="color:#888;padding:4px 0;">Email</td><td style="padding:4px 0;"><a href="mailto:${data.email}" style="color:#F92672;">${data.email}</a></td></tr>
        <tr><td style="color:#888;padding:4px 0;">Business</td><td style="padding:4px 0;">${data.business}</td></tr>
        <tr><td style="color:#888;padding:4px 0;">Goal</td><td style="padding:4px 0;">${goalLabels[data.goal] || data.goal}</td></tr>
        <tr><td style="color:#888;padding:4px 0;">Platforms</td><td style="padding:4px 0;">${platformList}</td></tr>
      </table>

      <div style="background:#111;border-radius:8px;padding:20px;margin-bottom:24px;text-align:center;">
        <p style="color:#888;margin:0 0 4px;font-size:13px;">OVERALL SCORE</p>
        <p style="font-size:48px;font-weight:bold;margin:0;color:#F92672;">${results.overallScore}/100</p>
        <p style="font-size:24px;margin:4px 0 0;color:#fff;">Grade: ${results.grade}</p>
      </div>

      <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:24px;">
        <thead>
          <tr style="background:#1a1a1a;">
            <th style="padding:8px 12px;text-align:left;color:#888;">Platform</th>
            <th style="padding:8px 12px;text-align:left;color:#888;">Profile</th>
            <th style="padding:8px 12px;text-align:left;color:#888;">Content</th>
            <th style="padding:8px 12px;text-align:left;color:#888;">Consistency</th>
            <th style="padding:8px 12px;text-align:left;color:#888;">Engagement</th>
            <th style="padding:8px 12px;text-align:left;color:#888;">Growth</th>
          </tr>
        </thead>
        <tbody>${platformScores}</tbody>
      </table>

      <div style="background:#1a1a1a;border-left:3px solid #F92672;padding:16px;border-radius:0 8px 8px 0;">
        <p style="margin:0;font-size:13px;color:#ccc;">This lead scored <strong>${results.overallScore}/100</strong> — ${results.overallScore < 50 ? 'a strong candidate for AW-LWAYS On Time.' : results.overallScore < 70 ? 'could benefit from consistent graphics support.' : 'doing well but may want to level up visuals.'}</p>
      </div>

      <p style="margin:24px 0 0;text-align:center;">
        <a href="mailto:${data.email}?subject=Your%20Social%20Media%20Audit%20Results&body=Hi%20${encodeURIComponent(data.name.split(' ')[0])}%2C%0A%0AThanks%20for%20completing%20the%20social%20media%20audit!" style="display:inline-block;background:#F92672;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:bold;">Reply to ${data.name.split(' ')[0]}</a>
      </p>
    </div>
  `;

  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.GMAIL_USER || 'noreply@awmedia.marketing',
      to: NOTIFY_EMAIL,
      subject: `New Audit Lead: ${data.name} (${results.overallScore}/100)`,
      html,
    });
    console.log(`Email notification sent for ${data.name}`);
  } catch (err) {
    console.error('Failed to send email notification:', err.message);
  }
}

function ratingColor(rating) {
  if (rating === 'Strong') return '#22c55e';
  if (rating === 'Needs Work') return '#eab308';
  return '#ef4444';
}

function scoreAudit(data) {
  // Normalize platforms to always be an array (single checkbox = string)
  let rawPlatforms = data.platforms || [];
  if (typeof rawPlatforms === 'string') rawPlatforms = [rawPlatforms];
  const platforms = rawPlatforms.map(p => p.toLowerCase());
  const scores = {};

  // Platform benchmarks for posting frequency
  const frequencyBenchmarks = {
    instagram: 4,
    tiktok: 5,
    linkedin: 4,
    twitter: 7,
    facebook: 4,
    youtube: 1,
    pinterest: 7,
  };

  platforms.forEach(platform => {
    const s = {};

    // --- Dimension 1: Profile Optimization ---
    let profileScore = 0;
    const bioClarity = parseInt(data[`bio_clarity_${platform}`]) || 1;
    const hasLink = data[`has_link_${platform}`] === 'yes';
    const profilePhotoQuality = parseInt(data[`photo_quality_${platform}`]) || 1;
    const hasPinnedContent = data[`pinned_content_${platform}`] === 'yes';

    profileScore += bioClarity; // 1-3
    profileScore += hasLink ? 3 : 0;
    profileScore += profilePhotoQuality; // 1-3
    profileScore += hasPinnedContent ? 2 : 0;
    // Max: 11
    s.profileOptimization = categorize(profileScore, 8, 5);

    // --- Dimension 2: Content Quality ---
    let contentScore = 0;
    const visualConsistency = parseInt(data[`visual_consistency_${platform}`]) || 1;
    const captionQuality = parseInt(data[`caption_quality_${platform}`]) || 1;
    const contentMix = parseInt(data[`content_mix_${platform}`]) || 1;

    contentScore += visualConsistency; // 1-3
    contentScore += captionQuality; // 1-3
    contentScore += contentMix; // 1-3
    // Max: 9
    s.contentQuality = categorize(contentScore, 7, 4);

    // --- Dimension 3: Posting Consistency ---
    let consistencyScore = 0;
    const frequency = parseInt(data[`frequency_${platform}`]) || 0;
    const benchmark = frequencyBenchmarks[platform] || 3;
    const frequencyRatio = frequency / benchmark;

    if (frequencyRatio >= 0.8) consistencyScore += 3;
    else if (frequencyRatio >= 0.4) consistencyScore += 2;
    else consistencyScore += 1;

    const hasGaps = data[`has_gaps_${platform}`] === 'yes';
    const usesScheduler = data[`uses_scheduler_${platform}`] === 'yes';
    consistencyScore += hasGaps ? 0 : 3;
    consistencyScore += usesScheduler ? 2 : 0;
    // Max: 8
    s.postingConsistency = categorize(consistencyScore, 6, 3);

    // --- Dimension 4: Engagement Health ---
    let engagementScore = 0;
    const repliesSpeed = parseInt(data[`replies_speed_${platform}`]) || 1;
    const outboundEngagement = parseInt(data[`outbound_engagement_${platform}`]) || 1;
    const usesCTAs = data[`uses_ctas_${platform}`] === 'yes';

    engagementScore += repliesSpeed; // 1-3
    engagementScore += outboundEngagement; // 1-3
    engagementScore += usesCTAs ? 3 : 0;
    // Max: 9
    s.engagementHealth = categorize(engagementScore, 7, 4);

    // --- Dimension 5: Growth Signals ---
    let growthScore = 0;
    const followerTrend = parseInt(data[`follower_trend_${platform}`]) || 1;
    const knowsTopContent = data[`knows_top_content_${platform}`] === 'yes';
    const usesHashtags = data[`uses_hashtags_${platform}`] === 'yes';
    const crossPromotes = data[`cross_promotes_${platform}`] === 'yes';

    growthScore += followerTrend; // 1-3
    growthScore += knowsTopContent ? 2 : 0;
    growthScore += usesHashtags ? 2 : 0;
    growthScore += crossPromotes ? 2 : 0;
    // Max: 9
    s.growthSignals = categorize(growthScore, 7, 4);

    // Overall platform score
    const dimensionScores = [s.profileOptimization, s.contentQuality, s.postingConsistency, s.engagementHealth, s.growthSignals];
    const strongCount = dimensionScores.filter(d => d.rating === 'Strong').length;
    const needsWorkCount = dimensionScores.filter(d => d.rating === 'Needs Work').length;
    const missingCount = dimensionScores.filter(d => d.rating === 'Missing').length;

    s.overallScore = Math.round(((strongCount * 3 + needsWorkCount * 1.5) / 15) * 100);
    s.strongCount = strongCount;
    s.needsWorkCount = needsWorkCount;
    s.missingCount = missingCount;

    scores[platform] = s;
  });

  // Generate insights
  const insights = generateInsights(scores, data);

  // Calculate overall score across all platforms
  const platformScores = Object.values(scores).map(s => s.overallScore);
  const overallScore = Math.round(platformScores.reduce((a, b) => a + b, 0) / platformScores.length);

  return {
    platforms: scores,
    insights,
    overallScore,
    grade: getGrade(overallScore),
  };
}

function categorize(score, strongThreshold, needsWorkThreshold) {
  if (score >= strongThreshold) return { rating: 'Strong', score };
  if (score >= needsWorkThreshold) return { rating: 'Needs Work', score };
  return { rating: 'Missing', score };
}

function getGrade(score) {
  if (score >= 85) return 'A';
  if (score >= 70) return 'B';
  if (score >= 55) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

function generateInsights(scores, data) {
  const wins = [];
  const gaps = [];
  const quickWins = [];

  Object.entries(scores).forEach(([platform, s]) => {
    const pName = platform.charAt(0).toUpperCase() + platform.slice(1);

    // Wins
    if (s.profileOptimization.rating === 'Strong') {
      wins.push({ platform: pName, text: `Your ${pName} profile is well-optimized with a clear bio, quality photo, and working link. First impressions are covered.` });
    }
    if (s.contentQuality.rating === 'Strong') {
      wins.push({ platform: pName, text: `Your ${pName} content quality is solid — consistent visuals, strong captions, and a good mix of value-driven posts.` });
    }
    if (s.postingConsistency.rating === 'Strong') {
      wins.push({ platform: pName, text: `You're posting consistently on ${pName}, which means the algorithm is working in your favor.` });
    }
    if (s.engagementHealth.rating === 'Strong') {
      wins.push({ platform: pName, text: `Your ${pName} engagement game is strong — you're responding, engaging outbound, and using CTAs effectively.` });
    }

    // Quick wins — generate for both Missing AND Needs Work
    if (s.profileOptimization.rating !== 'Strong') {
      quickWins.push({ platform: pName, text: `Rewrite your ${pName} bio with a clear value proposition — say what you do, who you help, and include a call-to-action.` });
    }
    if (s.contentQuality.rating !== 'Strong') {
      quickWins.push({ platform: pName, text: `Define 3 content pillars for ${pName} so every post reinforces your expertise and your audience knows what to expect.` });
    }
    if (s.postingConsistency.rating !== 'Strong') {
      quickWins.push({ platform: pName, text: `Set up a content scheduler for ${pName} and commit to a minimum posting frequency — consistency beats volume.` });
    }
    if (s.engagementHealth.rating !== 'Strong') {
      quickWins.push({ platform: pName, text: `Start a 10-minute daily engagement routine on ${pName} — comment on 5 accounts in your niche before you post.` });
    }
    if (s.growthSignals.rating !== 'Strong') {
      quickWins.push({ platform: pName, text: `Pin your best-performing post to the top of your ${pName} profile so new visitors see your strongest content first.` });
    }
    if (s.profileOptimization.rating !== 'Strong') {
      quickWins.push({ platform: pName, text: `Update your ${pName} profile photo and add a link-in-bio tool with your top 3 links.` });
    }
    if (s.engagementHealth.rating !== 'Strong') {
      quickWins.push({ platform: pName, text: `Add a specific call-to-action to every ${pName} post — ask a question, direct to a link, or invite a DM.` });
    }
    if (s.growthSignals.rating !== 'Strong') {
      quickWins.push({ platform: pName, text: `Research 5-10 niche-specific hashtags for ${pName} and use them consistently — ditch the generic ones.` });
    }
  });

  // Limit results
  return {
    wins: wins.slice(0, 3),
    quickWins: quickWins.slice(0, 2), // Show 2 in teaser
    totalQuickWins: quickWins.length,
  };
}

app.listen(PORT, () => {
  console.log(`Social Media Audit Tool running on http://localhost:${PORT}`);
});
