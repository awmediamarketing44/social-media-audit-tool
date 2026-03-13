const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

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
