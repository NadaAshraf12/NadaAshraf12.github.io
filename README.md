# 0xNADA — HTB / pentest writeups

A Jekyll blog for security writeups. Served by GitHub Pages.

## Deploy (user site → https://nadaashraf12.github.io)

1. Create a **public** repo named exactly `NadaAshraf12.github.io`.
2. Push these files to the `main` branch.
3. GitHub Pages serves it automatically within ~1 minute at `https://nadaashraf12.github.io`.

```bash
git init
git add .
git commit -m "init: 0xNADA writeups blog"
git branch -M main
git remote add origin https://github.com/NadaAshraf12/NadaAshraf12.github.io.git
git push -u origin main
```

> Deploying to a **project** repo instead (e.g. `NadaAshraf12/htb`)? Set `baseurl: "/htb"` in `_config.yml`, and enable Pages in the repo's Settings → Pages (source: `main` / root).

## Add a new writeup

Drop one Markdown file in `_posts/` named `YYYY-MM-DD-title.md` with this front matter:

```yaml
---
title: "Owning X — From … to Root"
date: 2026-11-20
platform: htb
slug: boxname
os: Linux            # or Windows
difficulty: Easy     # Easy | Medium | Hard | Insane
target: boxname.htb
ip: 10.10.11.xx
read_time: "~8 min read"
tags: [web, lfi, privesc]
excerpt_text: "One-line summary shown on the home page."
description: "SEO / social description."
---
```

Then write the body in Markdown. Code fences (```bash, ```php, …) are auto-wrapped into terminal windows, and the table of contents builds itself from `##` / `###` headings. For a screenshot placeholder use:

```html
<div class="shot">what the screenshot shows.</div>
```

## Rebrand

Edit the top three lines of `_config.yml` (`title`, `author`, `tagline`) and the accent colors (`--violet`, `--teal`) at the top of `assets/css/style.css`.

## Local preview (optional)

```bash
gem install bundler jekyll
bundle install
bundle exec jekyll serve   # → http://localhost:4000
```
