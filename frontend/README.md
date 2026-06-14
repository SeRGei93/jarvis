# jarvis-admin-web

Admin Telegram Mini App (Vite + React + TypeScript + Mantine). Authenticates via
Telegram `initData` (`Authorization: tma <initData>`) against the backend admin API.

```bash
npm install
npm run dev      # http://localhost:5173 — needs the backend on :8080 (dev proxy forwards /admin/api and /health)
npm run build    # tsc -b && vite build → dist/
npm run typecheck
```

Open through Telegram (or a tunnel) so `initData` is present; outside Telegram the
app shows the "Нет доступа" screen. Navigation sections live in `src/nav.tsx`.
