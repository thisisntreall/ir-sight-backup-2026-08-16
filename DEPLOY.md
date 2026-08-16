# Deploy IR Sight → drughelp.co/hidden-camera-detector

Static SPA. Lives in `ship/`.

```bash
cd ship
npm install
npm run build
```

Output is `ship/dist/`. Serve that folder at `/hidden-camera-detector/`.

## nginx (preferred)

```nginx
location = /hidden-camera-detector {
  return 308 /hidden-camera-detector/;
}

location /hidden-camera-detector/ {
  alias /var/www/hidden-camera-detector/;
  try_files $uri $uri/ /hidden-camera-detector/index.html;
}
```

Copy `dist/*` into `/var/www/hidden-camera-detector/`.

`alias` + trailing slashes matter. Do not use `root` for this path or assets 404.

## Cloudflare Worker (optional)

`drughelp-ir-sight.js` — only if you want to proxy instead of serving static files.

## Notes

- HTTPS required (camera / getUserMedia).
- iPhone Safari: Add to Home Screen works as a PWA-ish page.
- No backend required for the scanner itself.
