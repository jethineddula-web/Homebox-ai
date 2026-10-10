# Launching the Homebox website and applying for AdSense

Everything **inside** the website is ready. This checklist covers what happens **outside** it. Follow it in order: most AdSense rejections come from applying too early, not from the site itself.

Nobody can guarantee approval, because Google decides. These steps cover everything Google publishes as a requirement, plus the usual reasons sites get rejected.

---

## 1. Get your own domain (day 1)

- Buy a domain such as `homeboxapp.com` from Cloudflare Registrar, Namecheap or Porkbun (about US$10/year).
- Use a normal top-level domain (`.com`, `.app`, `.io`…). Free subdomains such as `something.github.io` are often rejected.

## 2. Put the installer online (day 1)

Your installer is 106 MB, too big for most free website hosts (Cloudflare Pages allows 25 MB per file).

1. Create a GitHub account and a repository called `homebox-releases`.
2. **Releases → Draft a new release**, tag `v2.0.0`, and attach `homebox-app\dist\Homebox-Setup-2.0.0.exe`.
3. Copy the download link: `https://github.com/<you>/homebox-releases/releases/download/v2.0.0/Homebox-Setup-2.0.0.exe`.

## 3. Fill in your details and check (day 1)

Edit `website\site.config.json`:

| Setting | What to put |
|---|---|
| `siteUrl` | `https://www.yourdomain.com`, with no `/` at the end |
| `contactEmail` | An address you read, ideally on your domain (`hello@yourdomain.com`). Cloudflare Email Routing can forward it to your Gmail for free. |
| `downloadUrl` | The GitHub link from step 2 |

Then run, in the `website` folder:

```
node build.js
node check.js
```

`check.js` must end with **"Ready to apply."** It fails on placeholders, thin articles, broken links, missing privacy wording and more.

## 4. Publish the site (day 1)

1. Cloudflare dashboard → **Workers & Pages → Create → Pages → Upload assets**.
2. Upload the **`website\public`** folder (not `website`).
3. **Custom domains** → add `www.yourdomain.com` and `yourdomain.com`. HTTPS turns on automatically.
4. Open the site on your phone and computer and click through the menu, footer and a few guides.

## 5. Tell Google about it (day 1)

1. Open **Google Search Console**, add your domain and verify it (Cloudflare can add the record for you).
2. **Sitemaps** → submit `sitemap.xml`.
3. **URL inspection** → request indexing for the home page and two or three guides.

## 6. Wait and grow a little (2–4 weeks)

Apply only when:

- [ ] Search Console shows most pages as **Indexed** (search `site:yourdomain.com` on Google to check)
- [ ] The site has had some real visitors. Share it where your users are: YouTube, Reddit, Discord or forums for Maya, Blender and AI users.
- [ ] You've added at least one new guide since launch. A growing site looks alive.
- [ ] `node check.js` still says "Ready to apply"

Some countries require the site or domain to be older (Google mentions this for some regions). If AdSense says the site isn't old enough, wait and apply again; it isn't a rejection of the content.

## 7. Apply (week 3–5)

1. Go to **adsense.google.com** and sign up with the site's address.
2. Copy your publisher id (`ca-pub-…`) into `adsenseClient` in `site.config.json`.
3. Run `node build.js` and upload `public` again. This adds the AdSense code to every page and creates **`ads.txt`**.
4. In AdSense, click **Request review**. Reviews usually take from a few days to two weeks.
5. In AdSense, open **Privacy & messaging** and turn on the **European regulations** message (Google's consent banner). Google requires it for visitors from the EU, UK and Switzerland.

## 8. After approval: rules that keep your account safe

- **Never click your own ads**, and never ask anyone to click them.
- **Keep ads away from the Download button**, and never put ads that look like download buttons near it.
- Start with **Auto ads** on a low setting, so the site stays pleasant to read.
- Keep `ads.txt` online, and add a new guide now and then.

## If you're rejected

Google tells you the reason in AdSense. The usual ones:

| Message | What to do |
|---|---|
| Low value content | Add 5+ more original guides from your own experience, wait two weeks, apply again. |
| Site down or unavailable | Make sure both `yourdomain.com` and `www.` work over HTTPS. |
| Policy violations | Read the details. Fix exactly what's named. |
| Site not old enough / not indexed | Wait, keep the site updated, and reapply. |

You can reapply after fixing. Many sites are approved on their second request.
