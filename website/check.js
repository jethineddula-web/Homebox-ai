// Pre-launch check for AdSense: node check.js   (run node build.js first)
// FAIL = fix before you apply.  WARN = worth fixing.  Exit code 1 when anything fails.
const fs = require('fs');
const path = require('path');

const ROOT = __dirname, OUT = path.join(ROOT, 'public');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'site.config.json'), 'utf8'));
let fails = 0, warns = 0;
const ok = m => console.log(`  ✓ ${m}`);
const fail = m => { fails++; console.log(`  ✗ FAIL  ${m}`); };
const warn = m => { warns++; console.log(`  ! WARN  ${m}`); };
const text = html => html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/g, ' ');
const words = s => s.split(/\s+/).filter(w => /[a-z0-9]/i.test(w)).length;

if (!fs.existsSync(OUT)) { console.log('Run node build.js first.'); process.exit(1); }
const files = [];
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? walk(p) : files.push(p); } })(OUT);
const pages = files.filter(f => f.endsWith('.html'));
const rel = f => path.relative(OUT, f).split(path.sep).join('/');

console.log('Your details (site.config.json)');
const placeholder = v => /example\.(com|org)|your-?domain|changeme|todo/i.test(String(v));
/^https:\/\//.test(cfg.siteUrl) && !placeholder(cfg.siteUrl) ? ok(`site address: ${cfg.siteUrl}`) : fail(`siteUrl must be your real https:// domain (now "${cfg.siteUrl}")`);
/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(cfg.contactEmail) && !placeholder(cfg.contactEmail) ? ok(`contact email: ${cfg.contactEmail}`) : fail(`contactEmail must be a real address people can write to (now "${cfg.contactEmail}")`);
/^https:\/\//.test(cfg.downloadUrl) && !placeholder(cfg.downloadUrl) ? ok('download link set') : fail(`downloadUrl must point to your real installer (now "${cfg.downloadUrl}")`);
cfg.author && !placeholder(cfg.author) ? ok(`author: ${cfg.author}`) : fail('author is missing');
cfg.jurisdiction && !placeholder(cfg.jurisdiction) ? ok(`terms are governed by the laws of ${cfg.jurisdiction}`) : fail('jurisdiction is empty: set the country or state whose law governs your terms (ask a lawyer which)');
if (!cfg.adsenseClient) warn('adsenseClient is empty. Fine for applying (Google shows you the code), but add your ca-pub-… id and rebuild when AdSense gives it to you, so ads.txt is created');
else if (/^ca-pub-\d{10,}$/.test(cfg.adsenseClient)) { ok('AdSense id format looks right'); fs.existsSync(path.join(OUT, 'ads.txt')) ? ok('ads.txt is in place') : fail('ads.txt is missing'); }
else fail(`adsenseClient should look like ca-pub-1234567890123456 (now "${cfg.adsenseClient}")`);

console.log('Required pages');
for (const [f, why] of [['about.html', 'who runs the site'], ['contact.html', 'a way to reach you'], ['privacy.html', 'privacy policy'], ['terms.html', 'terms'], ['cookies.html', 'cookie policy'], ['disclaimer.html', 'disclaimer'], ['404.html', 'a friendly 404 page']])
  fs.existsSync(path.join(OUT, f)) ? ok(`${f} (${why})`) : fail(`${f} is missing (${why})`);
const privacy = fs.readFileSync(path.join(OUT, 'privacy.html'), 'utf8');
[['Google', /Google/], ['cookies', /cookie/i], ['third-party vendors', /third-party vendors/i], ['opt out of personalised ads (Ads Settings)', /google\.com\/settings\/ads|adssettings\.google/i], ['how to contact you', new RegExp(cfg.contactEmail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))]]
  .forEach(([what, re]) => re.test(privacy) ? ok(`privacy policy covers ${what}`) : fail(`privacy policy must mention ${what}`));

console.log('Content');
const articles = pages.filter(f => rel(f).startsWith('guides/') && !rel(f).endsWith('index.html'));
articles.length >= 15 ? ok(`${articles.length} in-depth guides`) : warn(`${articles.length} guides. 15 or more original articles gives a stronger first application`);
let total = 0;
for (const f of pages) {
  const r = rel(f), html = fs.readFileSync(f, 'utf8'), main = (html.match(/<main[\s\S]*?<\/main>/) || [''])[0], n = words(text(main));
  total += n;
  const isArticle = articles.includes(f), light = ['404.html', 'contact.html', 'download.html', 'guides/index.html', 'changelog.html', 'cookies.html', 'disclaimer.html'].includes(r);
  if (isArticle && n < 600) fail(`${r} has only ${n} words (articles need 600+ to not look thin)`);
  else if (!isArticle && !light && n < 300) warn(`${r} has only ${n} words`);
  const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
  const desc = (html.match(/<meta name="description" content="([^"]*)"/) || [])[1] || '';
  if (title.length < 10 || title.length > 70) warn(`${r}: title is ${title.length} characters (aim for 10-70)`);
  if (r !== '404.html' && (desc.length < 50 || desc.length > 170)) warn(`${r}: description is ${desc.length} characters (aim for 50-170)`);
  if ((main.match(/<h1[\s>]/g) || []).length !== 1) fail(`${r} should have exactly one main heading (h1)`);
  if (/\{\{\w+\}\}|lorem ipsum|TODO|coming soon|under construction/i.test(main)) fail(`${r} contains placeholder or unfinished text`);
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) { try { JSON.parse(m[1]); } catch { fail(`${r}: structured data is not valid JSON`); } }
}
ok(`${pages.length} pages, about ${total.toLocaleString('en')} words in total`);

console.log('Links and images');
let broken = 0, imgs = 0;
for (const f of pages) {
  const html = fs.readFileSync(f, 'utf8');
  for (const m of html.matchAll(/(href|src)="([^"#?]+)/g)) {
    const u = m[2];
    if (/^(https?:|mailto:|data:)/.test(u)) continue;
    const target = u.startsWith('/') ? path.join(OUT, u) : path.join(path.dirname(f), u);
    if (!fs.existsSync(target)) { broken++; fail(`${rel(f)} links to missing ${u}`); }
  }
  for (const m of html.matchAll(/<img\b[^>]*>/g)) {
    imgs++;
    const tag = m[0];
    if (!/\balt="/.test(tag)) fail(`${rel(f)}: an image has no alt text`);
    if (!/\bwidth="\d+"/.test(tag) || !/\bheight="\d+"/.test(tag)) warn(`${rel(f)}: an image has no width/height (the page jumps while loading)`);
  }
}
broken ? null : ok('no broken internal links');
ok(`${imgs} images checked`);
for (const f of files.filter(f => /\.(png|jpe?g|webp|gif)$/i.test(f))) { const kb = fs.statSync(f).size / 1024; if (kb > 400) warn(`${rel(f)} is ${Math.round(kb)} KB (big images slow the site)`); }

console.log('Crawling');
fs.existsSync(path.join(OUT, 'sitemap.xml')) && fs.readFileSync(path.join(OUT, 'sitemap.xml'), 'utf8').includes(cfg.siteUrl) ? ok('sitemap.xml lists your pages') : fail('sitemap.xml is missing or has the wrong address');
fs.existsSync(path.join(OUT, 'robots.txt')) && !/Disallow:\s*\/\s*$/m.test(fs.readFileSync(path.join(OUT, 'robots.txt'), 'utf8')) ? ok('robots.txt lets Google in') : fail('robots.txt blocks Google');
pages.some(f => !rel(f).startsWith('404') && /noindex/.test(fs.readFileSync(f, 'utf8'))) ? fail('a normal page is marked noindex') : ok('no page is hidden from Google by mistake');

console.log(fails ? `\n${fails} problem(s) to fix before applying, ${warns} warning(s).` : `\nReady to apply. ${warns} warning(s) to consider.`);
process.exit(fails ? 1 : 0);
