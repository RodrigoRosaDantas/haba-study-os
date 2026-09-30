# Error sync backend

`worker.mjs` is the authenticated edge boundary for the private Error Lab database. It keeps the Notion writer credential on the backend, restricts browser calls to the GitHub Pages origin, enforces a Durable Object request limit, rejects oversized batches, validates stable Question IDs, and upserts by the Notion title property `Erro`.

The worker uses the existing Caderno de erros data source ID `7cdc74b5-d395-4286-9337-4b2457771be5` and the current schema. It does not add or rename Notion properties. The stable Question ID is stored as the `Erro` title. It reads the complete remote caderno after writes so the browser can merge updates from Notion.

Deploy only after creating a separate Notion integration with write access to the Caderno de erros database and sharing that database with the integration. Keep the GitHub Actions read-only integration separate.

```sh
cd backend
npx wrangler secret put HABA_STUDY_OS_NOTION_WRITE
openssl rand -base64 32
npx wrangler secret put HABA_STUDY_OS_SYNC_ACCESS_KEY
npx wrangler deploy
```

Generate the access key once with `openssl rand -base64 32`, keep that value, and enter the same value when Wrangler prompts for `HABA_STUDY_OS_SYNC_ACCESS_KEY`. Configure the deployed `workers.dev` HTTPS endpoint and that access key in the app Settings page. The app holds this browser credential in session storage only; backups exclude it. The Notion writer token remains a Worker secret.

Local checks:

```sh
node --test ../tests/worker.test.mjs
```
