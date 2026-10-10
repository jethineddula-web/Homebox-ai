// Builds the Homebox website into ./public.
// Each file in ./pages is the middle of one page. Its first lines are settings:
//   <!-- title: Page title -->
//   <!-- description: One sentence for search results -->
//   <!-- type: page | article | faq | software -->       (optional, default page)
//   <!-- published: 2026-09-30 -->  <!-- updated: 2026-10-01 -->   (articles)
//   <!-- image: screens/home.png -->                     (optional picture for sharing)
//   <!-- category: 3D -->                                (articles, shown on the guides list)
// Placeholders in pages: {{siteName}} {{company}} {{siteUrl}} {{contactEmail}} {{downloadUrl}} {{lastUpdated}}
//   {{author}}, {{articleMeta}} (byline for articles), {{guideList}} (all articles, newest first)
// Run:  node build.js      Then before going live:  node check.js
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const OUT = path.join(ROOT, 'public');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'site.config.json'), 'utf8'));
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const year = new Date().getFullYear();
const hasAds = /^ca-pub-\d{10,}$/.test(cfg.adsenseClient);
const pageUrl = file => `${cfg.siteUrl}/${file.replace(/index\.html$/, '')}`;
const niceDate = d => new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

const NAV = [
  ['features.html', 'Features'], ['apps.html', 'Apps'], ['guide.html', 'How to use'], ['guides/index.html', 'Guides'], ['faq.html', 'FAQ'],
];

// ---------- read every page first, so lists and "related" links can use all of them ----------
const pages = [];
(function read(dir, rel) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const src = path.join(dir, e.name);
    if (e.isDirectory()) { read(src, path.join(rel, e.name)); continue; }
    if (!e.name.endsWith('.html')) continue;
    const raw = fs.readFileSync(src, 'utf8');
    const meta = k => ((raw.match(new RegExp(`<!--\\s*${k}:\\s*(.*?)\\s*-->`)) || [])[1] || '').replace(/\{\{(\w+)\}\}/g, (m, key) => cfg[key] ?? m);
    const body = raw.replace(/^\s*(<!--[\s\S]*?-->\s*)+/, '');
    const words = body.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
    pages.push({
      file: path.posix.join(rel.split(path.sep).join('/'), e.name), rel, name: e.name, body, words,
      title: meta('title'), description: meta('description'), type: meta('type') || 'page',
      published: meta('published'), updated: meta('updated') || meta('published'), image: meta('image'), category: meta('category'),
    });
  }
})(path.join(ROOT, 'pages'), '');
const articles = pages.filter(p => p.type === 'article').sort((a, b) => (b.published || '').localeCompare(a.published || '') || a.title.localeCompare(b.title));

// ---------- pieces ----------
function fill(text, page) {
  const up = page.rel ? '../' : '';
  return text
    .replace(/\{\{siteName\}\}/g, esc(cfg.siteName)).replace(/\{\{company\}\}/g, esc(cfg.company))
    .replace(/\{\{siteUrl\}\}/g, esc(cfg.siteUrl)).replace(/\{\{contactEmail\}\}/g, esc(cfg.contactEmail))
    .replace(/\{\{downloadUrl\}\}/g, esc(cfg.downloadUrl)).replace(/\{\{lastUpdated\}\}/g, esc(niceDate(cfg.lastUpdated)))
    .replace(/\{\{author\}\}/g, esc(cfg.author)).replace(/\{\{jurisdiction\}\}/g, esc(cfg.jurisdiction || '[your country or state]'))
    .replace(/\{\{articleMeta\}\}/g, () => articleMeta(page, up))
    .replace(/\{\{guideList\}\}/g, () => guideList(page));
}
function articleMeta(p, up) {
  const mins = Math.max(2, Math.round(p.words / 220));
  const upd = p.updated && p.updated !== p.published ? ` · Updated ${niceDate(p.updated)}` : '';
  return `<p class="meta">By <a href="${up}about.html#author">${esc(cfg.author)}</a> · ${niceDate(p.published)}${upd} · ${mins} min read</p>`;
}
function guideList(page) {
  const here = page.rel ? '' : 'guides/';
  return `<div class="grid2">${articles.map(a => `<a class="card" href="${here}${a.name}"><span class="tag">${esc(a.category || 'Guide')}</span><h3>${esc(a.title)}</h3><p>${esc(a.description)}</p><span class="muted">${niceDate(a.published)} · ${Math.max(2, Math.round(a.words / 220))} min read</span></a>`).join('')}</div>`;
}
function related(p) {
  const i = articles.indexOf(p);
  const pick = [1, 2, 3].map(k => articles[(i + k) % articles.length]).filter(a => a !== p);
  return `<div class="wrap narrow"><aside class="related"><h2>Related guides</h2><div class="grid3">${pick.map(a => `<a class="card" href="${a.name}"><h3>${esc(a.title)}</h3><p>${esc(a.description)}</p></a>`).join('')}</div></aside></div>`;
}
function breadcrumbs(p) {
  if (p.type !== 'article') return '';
  return `<nav class="crumbs wrap narrow" aria-label="Breadcrumb"><a href="../index.html">Home</a> › <a href="index.html">Guides</a> › <span>${esc(p.title)}</span></nav>`;
}

// structured data, so search engines understand what each page is
function jsonLd(p) {
  const org = { '@type': 'Organization', '@id': `${cfg.siteUrl}/#org`, name: cfg.company, url: cfg.siteUrl, logo: `${cfg.siteUrl}/assets/icon.png`, email: cfg.contactEmail };
  const graph = [org, { '@type': 'WebSite', '@id': `${cfg.siteUrl}/#site`, url: cfg.siteUrl, name: cfg.siteName, publisher: { '@id': `${cfg.siteUrl}/#org` } }];
  const image = `${cfg.siteUrl}/assets/${p.image || 'screens/home.png'}`;
  if (p.type === 'software' || p.file === 'index.html') {
    graph.push({
      '@type': 'SoftwareApplication', name: cfg.siteName, operatingSystem: 'Windows 10, Windows 11', applicationCategory: 'DeveloperApplication',
      softwareVersion: cfg.version, downloadUrl: cfg.downloadUrl, url: pageUrl('download.html'), image, screenshot: `${cfg.siteUrl}/assets/screens/approvals.png`,
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' }, publisher: { '@id': `${cfg.siteUrl}/#org` }, description: p.description,
    });
  }
  if (p.type === 'article') {
    graph.push({
      '@type': 'TechArticle', headline: p.title, description: p.description, image, datePublished: p.published, dateModified: p.updated,
      author: { '@type': 'Person', name: cfg.author, url: `${cfg.siteUrl}/about.html#author` }, publisher: { '@id': `${cfg.siteUrl}/#org` },
      mainEntityOfPage: pageUrl(p.file),
    });
    graph.push({ '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${cfg.siteUrl}/` },
      { '@type': 'ListItem', position: 2, name: 'Guides', item: `${cfg.siteUrl}/guides/` },
      { '@type': 'ListItem', position: 3, name: p.title, item: pageUrl(p.file) },
    ] });
  }
  if (p.type === 'faq') {
    const qa = [...p.body.matchAll(/<details><summary>([\s\S]*?)<\/summary><div>([\s\S]*?)<\/div><\/details>/g)]
      .map(m => ({ '@type': 'Question', name: m[1].replace(/<[^>]+>/g, '').trim(), acceptedAnswer: { '@type': 'Answer', text: m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() } }));
    if (qa.length) graph.push({ '@type': 'FAQPage', mainEntity: qa });
  }
  return `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }).replace(/</g, '\\u003c')}</script>`;
}

function layout(p, body) {
  const up = p.rel ? '../' : '';
  const url = pageUrl(p.file);
  const fullTitle = p.file === 'index.html' ? `${cfg.siteName} · Let AI work on your computer, with you in control` : `${p.title} · ${cfg.siteName}`;
  const nav = NAV.map(([href, label]) => `<a href="${up}${href}"${href === p.file ? ' aria-current="page"' : ''}>${label}</a>`).join('');
  const image = `${cfg.siteUrl}/assets/${p.image || 'screens/home.png'}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(fullTitle)}</title>
<meta name="description" content="${esc(p.description)}">
<meta name="robots" content="${p.name === '404.html' ? 'noindex' : 'index, follow, max-image-preview:large'}">
<link rel="canonical" href="${esc(url)}">
<meta property="og:type" content="${p.type === 'article' ? 'article' : 'website'}">
<meta property="og:site_name" content="${esc(cfg.siteName)}">
<meta property="og:title" content="${esc(fullTitle)}">
<meta property="og:description" content="${esc(p.description)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${esc(image)}">
<meta name="twitter:card" content="summary_large_image">
${p.type === 'article' ? `<meta property="article:published_time" content="${esc(p.published)}">\n<meta property="article:modified_time" content="${esc(p.updated)}">\n<meta name="author" content="${esc(cfg.author)}">\n` : ''}<link rel="icon" href="${up}assets/icon.png">
<link rel="stylesheet" href="${up}assets/style.css">
${jsonLd(p)}
${hasAds ? `<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${cfg.adsenseClient}" crossorigin="anonymous"></script>` : '<!-- AdSense: put your ca-pub-… id in site.config.json and run node build.js -->'}
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="site-hd">
  <div class="wrap hd-in">
    <a class="logo" href="${up}index.html"><img src="${up}assets/icon.png" alt="" width="32" height="32"><span>${esc(cfg.siteName)}</span></a>
    <button class="menu-btn" aria-expanded="false" aria-controls="nav" aria-label="Menu"><span></span><span></span><span></span></button>
    <nav id="nav" aria-label="Main">${nav}<a class="btn primary small" href="${up}download.html">Download</a></nav>
  </div>
</header>
<main id="main">
${breadcrumbs(p)}
${body}
${p.type === 'article' ? related(p) : ''}
</main>
<footer class="site-ft">
  <div class="wrap ft-grid">
    <div class="ft-brand"><a class="logo" href="${up}index.html"><img src="${up}assets/icon.png" alt="" width="28" height="28"><span>${esc(cfg.siteName)}</span></a>
      <p>Let AI from any chat website work in one folder on your computer and in your creative apps. You stay in control of every step.</p></div>
    <div><h4>Product</h4><a href="${up}download.html">Download</a><a href="${up}features.html">Features</a><a href="${up}apps.html">Supported apps</a><a href="${up}safety.html">Safety</a><a href="${up}changelog.html">What's new</a></div>
    <div><h4>Learn</h4><a href="${up}guide.html">How to use</a><a href="${up}guides/index.html">Guides</a><a href="${up}faq.html">FAQ</a><a href="${up}troubleshooting.html">Troubleshooting</a><a href="${up}glossary.html">Glossary</a></div>
    <div><h4>Company</h4><a href="${up}about.html">About</a><a href="${up}contact.html">Contact</a><a href="${up}privacy.html">Privacy policy</a><a href="${up}terms.html">Terms of use</a><a href="${up}disclaimer.html">Disclaimer</a><a href="${up}cookies.html">Cookie policy</a></div>
  </div>
  <div class="wrap ft-bottom"><span>© ${year} ${esc(cfg.company)}. All rights reserved.</span><span>Homebox is not affiliated with OpenAI, Anthropic, Google, Autodesk, Adobe, Microsoft or any other company named on this site.</span></div>
</footer>
<script src="${up}assets/site.js" defer></script>
</body>
</html>
`;
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    e.isDirectory() ? copyDir(s, d) : fs.copyFileSync(s, d);
  }
}

// ---------- write everything ----------
fs.rmSync(OUT, { recursive: true, force: true });
copyDir(path.join(ROOT, 'assets'), path.join(OUT, 'assets'));
for (const p of pages) {
  fs.mkdirSync(path.join(OUT, p.rel), { recursive: true });
  fs.writeFileSync(path.join(OUT, p.rel, p.name), layout(p, fill(p.body, p)));
}
const listed = pages.filter(p => p.name !== '404.html');
fs.writeFileSync(path.join(OUT, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${listed.sort((a, b) => a.file.localeCompare(b.file)).map(p => `  <url><loc>${pageUrl(p.file)}</loc><lastmod>${p.updated || cfg.lastUpdated}</lastmod></url>`).join('\n')}
</urlset>
`);
fs.writeFileSync(path.join(OUT, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${cfg.siteUrl}/sitemap.xml\n`);
if (hasAds) fs.writeFileSync(path.join(OUT, 'ads.txt'), `google.com, ${cfg.adsenseClient.replace('ca-', '')}, DIRECT, f08c47fec0942fa0\n`);
console.log(`Built ${listed.length} pages (${articles.length} guides) into ${OUT}${hasAds ? ' (with AdSense)' : ' (AdSense id not set yet)'}`);
