# Curling Vote

"Twitch Plays" style crowd voting for curling. Players scan a QR code shown at the
venue and vote on the next shot in real time.

## Pages

| URL | Who uses it |
|-----|-------------|
| `/display.html` | Big screen TV / projector at the venue |
| `/admin.html` | Organizer's device (phone/tablet/laptop) |
| `/vote?t=TOKEN` | Participants (linked via QR code) |

## Quick Start (local / no HTTPS)

```bash
cp .env.example .env
# Edit .env — set ADMIN_TOKEN and PUBLIC_URL=http://your-ip
npm install
node server.js
```

Open `http://your-ip/display.html` on the TV, `http://your-ip/admin.html` on your
device.

---

## Deployment on a Digital Ocean Droplet

### 1. Provision a droplet

Ubuntu 22.04 LTS, any size. Open ports **80** and **443** in the firewall.

### 2. Install Node.js

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

### 3. Deploy the app

```bash
git clone <your-repo> /srv/curling-vote
cd /srv/curling-vote
npm install
```

### 4. Point a domain at the droplet

Add an **A record** in your DNS pointing `yourdomain.com` → droplet IP.
Wait a few minutes for DNS to propagate.

### 5. Get an SSL certificate

```bash
sudo apt install -y certbot
sudo certbot certonly --standalone -d yourdomain.com
```

Certbot places certs in `/etc/letsencrypt/live/yourdomain.com/`.

### 6. Configure environment

```bash
cp .env.example .env
nano .env   # fill in ADMIN_TOKEN, PUBLIC_URL, SSL_KEY, SSL_CERT
```

### 7. Run (with PM2 for auto-restart)

```bash
sudo npm install -g pm2
sudo pm2 start server.js --name curling-vote
sudo pm2 startup        # makes PM2 start on boot
sudo pm2 save
```

> Running on port 443 requires root (or `sudo pm2`). Alternatively:
> `sudo setcap 'cap_net_bind_service=+ep' $(which node)` then run without sudo.

### 8. Renew SSL automatically

```bash
sudo certbot renew --dry-run   # test renewal
# certbot installs a cron job automatically
```

---

## How a Session Works

1. **Admin** opens `/admin.html`, logs in with the `ADMIN_TOKEN`.
2. **Setup screen:** pick sheet count and naming (letters A–Z or numbers 1–48).
3. Display screen shows a QR code — participants scan it with their phones.
4. **Each end:**
   - Admin selects a countdown (15/30/45/60 s) and clicks **Start End**.
   - Voters pick **Shot Type · Handle · Line** on their phones (live, can change until timer ends).
   - Display and admin show live vote bars + countdown.
   - When time's up, the winning call is shown on the display.
   - Admin clicks **✓ Throw Complete** after the stone is delivered.
   - Repeat.
5. **Rotate QR** at any time to generate a new token and kick current voters.
6. **Reset Everything** ends the session and returns to the setup screen.

---

## Vote Categories

| Category  | Options |
|-----------|---------|
| Shot Type | Guard · Draw · Takeout |
| Handle    | In Turn (L) · Out Turn (R) |
| Line      | 12' · 8' · 4' · 2' |

Winners are determined **per category** — the most-voted option in each row wins.
Ties show the first-encountered leader (no tiebreaker round).
